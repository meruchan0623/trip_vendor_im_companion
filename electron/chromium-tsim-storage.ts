import {open, readdir, lstat} from 'node:fs/promises';
import {join, isAbsolute} from 'node:path';

// Read-only legacy Chromium localStorage LevelDB. No database is opened or copied,
// and no credential is retained between calls. Unsupported/corrupt/busy stores
// deliberately return null instead of falling back to obsolete table contents.
const MAX_FILE = 64 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;
const MAX_RECORD = 16 * 1024 * 1024;
const MAX_FILES = 4096;
const MAX_SEQUENCE = (1n << 56n) - 1n;
const PREFIX = Buffer.from('_https://csagent.tsim.tech\0', 'utf8');
const TOKEN_KEYS = [Buffer.concat([PREFIX, Buffer.from([1]), Buffer.from('agent_token', 'latin1')]),
  Buffer.concat([PREFIX, Buffer.from([0]), Buffer.from('agent_token', 'utf16le')])];
const MAGIC = 0xdb4775248b80fb57n;
const invalid = (): never => {throw new Error('Unsupported or unstable local storage');};

class Cursor {
  offset = 0;
  constructor(readonly data: Buffer) {}
  byte(): number {if (this.offset >= this.data.length) invalid(); return this.data[this.offset++];}
  varint(): bigint {
    let result = 0n;
    for (let i = 0; i < 10; i++) {
      const b = this.byte();
      if (i === 9 && b > 1) invalid();
      result |= BigInt(b & 127) << BigInt(i * 7);
      if (!(b & 128)) return result;
    }
    return invalid();
  }
  number(max = MAX_RECORD): number {const n = this.varint(); if (n > BigInt(max)) invalid(); return Number(n);}
  take(n: number): Buffer {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.data.length - this.offset) invalid();
    const result = this.data.subarray(this.offset, this.offset + n); this.offset += n; return result;
  }
  slice(): Buffer {return this.take(this.number());}
  done(): boolean {return this.offset === this.data.length;}
}

const CRC_TABLE = Array.from({length: 256}, (_, index) => {
  let n = index; for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0x82f63b78 : 0); return n >>> 0;
});
function checksum(parts: readonly Buffer[]): number {
  let crc = 0xffffffff;
  for (const data of parts) for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}

function* logRecords(data: Buffer): Generator<Buffer> {
  let offset = 0; let fragments: Buffer[] | null = null; let length = 0;
  while (offset < data.length) {
    const remaining = 32768 - (offset % 32768);
    if (remaining < 7) {
      const trailer = data.subarray(offset, Math.min(data.length, offset + remaining));
      if (trailer.some(byte => byte !== 0)) invalid(); offset += trailer.length; continue;
    }
    // A torn tail may hide a newer deletion, so never recover an older token.
    if (data.length - offset < 7) invalid();
    const crc = data.readUInt32LE(offset); const size = data.readUInt16LE(offset + 4); const type = data[offset + 6];
    if (size + 7 > remaining || size + 7 > data.length - offset || type < 1 || type > 4) invalid();
    const body = data.subarray(offset + 7, offset + 7 + size);
    if (checksum([data.subarray(offset + 6, offset + 7), body]) !== crc) invalid();
    offset += 7 + size;
    if (type === 1) {if (fragments) invalid(); if (size > MAX_RECORD) invalid(); yield body; continue;}
    if (type === 2) {if (fragments) invalid(); fragments = []; length = 0;}
    if (!fragments) invalid();
    length += size; if (length > MAX_RECORD) invalid(); fragments!.push(body);
    if (type === 4) {yield Buffer.concat(fragments!, length); fragments = null;}
  }
  if (fragments) invalid();
}

function snappy(data: Buffer): Buffer {
  const c = new Cursor(data); const size = c.number(MAX_RECORD); const result = Buffer.alloc(size); let written = 0;
  while (!c.done()) {
    const tag = c.byte(); let length: number; let distance: number;
    if ((tag & 3) === 0) {
      const n = tag >>> 2;
      if (n < 60) length = n + 1;
      else {
        const bytes = c.take(n - 59); let value = 0;
        for (let i = 0; i < bytes.length; i++) value += bytes[i] * 2 ** (i * 8);
        length = value + 1;
      }
      if (length > size - written) invalid(); c.take(length).copy(result, written); written += length; continue;
    }
    if ((tag & 3) === 1) {length = 4 + ((tag >>> 2) & 7); distance = ((tag & 0xe0) << 3) | c.byte();}
    else if ((tag & 3) === 2) {length = 1 + (tag >>> 2); distance = c.take(2).readUInt16LE();}
    else {length = 1 + (tag >>> 2); distance = c.take(4).readUInt32LE();}
    if (distance === 0 || distance > written || length > size - written) invalid();
    // Snappy copies may overlap: every newly written byte becomes a source.
    for (let i = 0; i < length; i++) {result[written] = result[written - distance]; written++;}
  }
  if (written !== size) invalid(); return result;
}

function* blockEntries(data: Buffer): Generator<[Buffer, Buffer]> {
  if (data.length < 8) invalid();
  const count = data.readUInt32LE(data.length - 4);
  if (count < 1 || count > (data.length - 4) / 4) invalid();
  const end = data.length - 4 - count * 4; const restarts = new Set<number>(); let previousRestart = -1;
  for (let i = 0; i < count; i++) {
    const restart = data.readUInt32LE(end + i * 4);
    if ((i === 0 && restart !== 0) || restart <= previousRestart || restart > end || (restart === end && end !== 0)) invalid();
    restarts.add(restart); previousRestart = restart;
  }
  const c = new Cursor(data.subarray(0, end)); let previous: Buffer = Buffer.alloc(0);
  while (!c.done()) {
    const entryStart = c.offset; const shared = c.number(); const nonshared = c.number(); const valueLength = c.number();
    if (shared > previous.length || shared + nonshared > MAX_RECORD || (restarts.has(entryStart) && shared !== 0)) invalid();
    restarts.delete(entryStart);
    const key = Buffer.concat([previous.subarray(0, shared), c.take(nonshared)]);
    const value = c.take(valueLength); previous = key; yield [key, value];
  }
  if (end === 0) restarts.delete(0);
  if (restarts.size) invalid();
}

function internalKey(key: Buffer): {user: Buffer; sequence: bigint; type: number} {
  if (key.length < 8) return invalid();
  const tag = key.readBigUInt64LE(key.length - 8); const type = Number(tag & 255n);
  if (type !== 0 && type !== 1) invalid();
  return {user: key.subarray(0, -8), sequence: tag >> 8n, type};
}
function compareInternal(a: Buffer, b: Buffer): number {
  const x = internalKey(a); const y = internalKey(b); const order = Buffer.compare(x.user, y.user);
  if (order) return order;
  const xt = (x.sequence << 8n) | BigInt(x.type); const yt = (y.sequence << 8n) | BigInt(y.type);
  return xt > yt ? -1 : xt < yt ? 1 : 0;
}
type Table = {number: bigint; size: number; smallest: Buffer; largest: Buffer; level: number};
type Version = {tables: Map<bigint, Table>; log: bigint; previousLog: bigint; sequence: bigint};
function manifest(data: Buffer): Version {
  const version: Version = {tables: new Map(), log: 0n, previousLog: 0n, sequence: 0n};
  let hasLog = false; let hasSequence = false; let hasComparator = false;
  for (const record of logRecords(data)) {
    const c = new Cursor(record);
    while (!c.done()) {
      const tag = c.number(9);
      if (tag === 1) {if (c.slice().toString('ascii') !== 'leveldb.BytewiseComparator') invalid(); hasComparator = true;}
      else if (tag === 2) {version.log = c.varint(); hasLog = true;}
      else if (tag === 3) c.varint();
      else if (tag === 4) {const n = c.varint(); if (n > MAX_SEQUENCE || n < version.sequence) invalid(); version.sequence = n; hasSequence = true;}
      else if (tag === 5) {c.number(6); internalKey(c.slice());}
      else if (tag === 6) {
        const level = c.number(6); const number = c.varint(); const existing = version.tables.get(number);
        if (existing && existing.level !== level) invalid(); version.tables.delete(number);
      } else if (tag === 7) {
        const level = c.number(6); const number = c.varint(); const size = c.number(MAX_FILE);
        const smallest = c.slice(); const largest = c.slice();
        if (number === 0n || size < 48 || version.tables.has(number) || compareInternal(smallest, largest) > 0) invalid();
        version.tables.set(number, {number, size, smallest, largest, level});
        if (version.tables.size > MAX_FILES) invalid();
      } else if (tag === 9) version.previousLog = c.varint();
      else invalid();
    }
  }
  if (!hasLog || !hasSequence || !hasComparator) invalid(); return version;
}

type Candidate = {sequence: bigint; value: Buffer | null};
class Target {
  current: Candidate | null = null;
  add(key: Buffer, sequence: bigint, type: number, value: Buffer): void {
    if (!TOKEN_KEYS.some(target => target.equals(key))) return;
    if (value.length > 32769) invalid();
    const next = type === 0 ? null : Buffer.from(value);
    if (this.current && sequence === this.current.sequence) {
      if ((next === null) !== (this.current.value === null) || (next && !next.equals(this.current.value!))) invalid();
    }
    if (!this.current || sequence > this.current.sequence) this.current = {sequence, value: next};
  }
  token(): string | null {
    const value = this.current?.value; if (!value || value.length < 2) return null;
    let result: string;
    if (value[0] === 1) result = value.subarray(1).toString('latin1');
    else if (value[0] === 0 && value.length % 2 === 1) result = value.subarray(1).toString('utf16le');
    else return null;
    if (result.length > 16384 || !result || /[\x00-\x20\x7f-\uffff]/.test(result)) return null;
    return result;
  }
}

function tableContents(data: Buffer, meta: Table, target: Target, lastSequence: bigint, budget: {remaining: number}): void {
  if (data.length !== meta.size || data.length < 48 || data.readBigUInt64LE(data.length - 8) !== MAGIC) invalid();
  const footer = new Cursor(data.subarray(data.length - 48, data.length - 8));
  const handle = (c: Cursor): [number, number] => [c.number(MAX_FILE), c.number(MAX_RECORD)];
  const metaHandle = handle(footer); const indexHandle = handle(footer);
  if (footer.take(40 - footer.offset).some(byte => byte !== 0)) invalid();
  const readBlock = ([offset, length]: [number, number]): Buffer => {
    if (offset > data.length - 48 - 5 || length > data.length - 48 - 5 - offset) return invalid();
    const bytes = data.subarray(offset, offset + length); const compression = data[offset + length];
    if (checksum([bytes, data.subarray(offset + length, offset + length + 1)]) !== data.readUInt32LE(offset + length + 1)) invalid();
    const decoded = compression === 0 ? bytes : compression === 1 ? snappy(bytes) : invalid();
    budget.remaining -= decoded.length; if (budget.remaining < 0) invalid(); return decoded;
  };
  // Validate the metaindex even though filters are not needed for a scoped scan.
  for (const _entry of blockEntries(readBlock(metaHandle))) { /* intentionally no value decoding */ }
  let first: Buffer | null = null; let last: Buffer | null = null; let previousIndex: Buffer | null = null;
  let previousBlockEnd = 0;
  for (const [indexKey, value] of blockEntries(readBlock(indexHandle))) {
    internalKey(indexKey);
    if (previousIndex && compareInternal(previousIndex, indexKey) >= 0) invalid(); previousIndex = indexKey;
    const c = new Cursor(value); const h = handle(c); if (!c.done() || h[0] < previousBlockEnd || h[0] + h[1] + 5 > metaHandle[0]) invalid();
    previousBlockEnd = h[0] + h[1] + 5;
    for (const [key, entryValue] of blockEntries(readBlock(h))) {
      if (last && compareInternal(last, key) >= 0) invalid();
      if (compareInternal(key, indexKey) > 0) invalid();
      first ??= key; last = key;
      const parsed = internalKey(key);
      if (parsed.sequence > lastSequence || (parsed.type === 0 && entryValue.length !== 0)) invalid();
      target.add(parsed.user, parsed.sequence, parsed.type, entryValue);
    }
  }
  if (!first || !last || !first.equals(meta.smallest) || !last.equals(meta.largest)) invalid();
}

function writeBatch(data: Buffer, target: Target): void {
  if (data.length < 12) invalid(); const sequence = data.readBigUInt64LE(0); const count = data.readUInt32LE(8);
  if (count > MAX_RECORD / 2 || sequence > MAX_SEQUENCE || (count && sequence + BigInt(count - 1) > MAX_SEQUENCE)) invalid();
  const c = new Cursor(data.subarray(12));
  for (let i = 0; i < count; i++) {
    const type = c.byte(); if (type !== 0 && type !== 1) invalid();
    const key = c.slice(); const value = type === 1 ? c.slice() : Buffer.alloc(0);
    target.add(key, sequence + BigInt(i), type, value);
  }
  if (!c.done()) invalid();
}

type Snapshot = {name: string; data: Buffer; signature: string};
async function attempt(directory: string): Promise<string | null> {
  const observed: Snapshot[] = []; let total = 0;
  const signature = (s: {dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint}) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  const read = async (name: string, limit = MAX_FILE): Promise<Snapshot> => {
    const path = join(directory, name); const link = await lstat(path); if (!link.isFile() || link.isSymbolicLink()) invalid();
    const file = await open(path, 'r');
    try {
      const before = await file.stat({bigint: true});
      if (!before.isFile() || before.size > BigInt(limit) || before.size < 0n) invalid();
      total += Number(before.size); if (total > MAX_TOTAL) invalid();
      const data = Buffer.alloc(Number(before.size)); let offset = 0;
      while (offset < data.length) {const {bytesRead} = await file.read(data, offset, data.length - offset, offset); if (!bytesRead) invalid(); offset += bytesRead;}
      if (signature(before) !== signature(await file.stat({bigint: true}))) invalid();
      return {name, data, signature: signature(before)};
    } finally {await file.close();}
  };
  let verificationBuffer: Buffer | undefined;
  // Compare every byte again without allocating a second file-sized snapshot.
  // The initial snapshots remain authoritative; identity and read budgets stay unchanged.
  const verifySnapshot = async (snapshot: Snapshot): Promise<void> => {
    const path = join(directory, snapshot.name); const link = await lstat(path); if (!link.isFile() || link.isSymbolicLink()) invalid();
    const file = await open(path, 'r');
    try {
      const before = await file.stat({bigint: true});
      if (!before.isFile() || before.size > BigInt(MAX_FILE) || before.size < 0n) invalid();
      total += Number(before.size); if (total > MAX_TOTAL) invalid();
      if (signature(before) !== snapshot.signature || before.size !== BigInt(snapshot.data.length)) invalid();
      let offset = 0;
      while (offset < snapshot.data.length) {
        const buffer = verificationBuffer ??= Buffer.alloc(64 * 1024);
        const length = Math.min(buffer.length, snapshot.data.length - offset);
        const {bytesRead} = await file.read(buffer, 0, length, offset);
        if (!bytesRead || !buffer.subarray(0, bytesRead).equals(snapshot.data.subarray(offset, offset + bytesRead))) invalid();
        offset += bytesRead;
      }
      if (signature(await file.stat({bigint: true})) !== snapshot.signature) invalid();
    } finally {await file.close();}
  };
  const current = await read('CURRENT', 256); observed.push(current);
  const currentName = current.data.toString('ascii'); if (!/^MANIFEST-[0-9]{6,20}\n$/.test(currentName)) invalid();
  const descriptor = await read(currentName.trim()); observed.push(descriptor);
  const version = manifest(descriptor.data); const target = new Target(); const budget = {remaining: MAX_TOTAL};
  const names = await readdir(directory); if (names.length > MAX_FILES) invalid();
  const logs: {name: string; number: bigint}[] = [];
  for (const name of names) {
    const match = /^(\d{6,20})\.log$/.exec(name); if (!match) continue; const number = BigInt(match[1]);
    if (number >= version.log || number === version.previousLog) logs.push({name, number});
  }
  if (version.log > 0n && !logs.some(log => log.number >= version.log)) invalid();
  logs.sort((a, b) => a.number < b.number ? -1 : a.number > b.number ? 1 : 0);
  for (const meta of version.tables.values()) {
    const stem = meta.number.toString().padStart(6, '0'); const options = [`${stem}.ldb`, `${stem}.sst`].filter(name => names.includes(name));
    if (options.length !== 1) invalid(); const snapshot = await read(options[0]); observed.push(snapshot);
    tableContents(snapshot.data, meta, target, version.sequence, budget);
  }
  for (const log of logs) {
    const snapshot = await read(log.name); observed.push(snapshot);
    for (const record of logRecords(snapshot.data)) writeBatch(record, target);
  }
  // Re-read every selected file, including WAL bytes and manifest, and re-list
  // files before returning. An append, compaction, replacement or torn read
  // invalidates the whole attempt; we never publish a partially recovered token.
  for (const snapshot of observed) await verifySnapshot(snapshot);
  const afterNames = await readdir(directory);
  if (names.slice().sort().join('\0') !== afterNames.sort().join('\0')) invalid();
  // Control files are checked last too: a compaction may change the manifest
  // while the remaining table/WAL snapshots are being verified.
  for (const snapshot of [current, descriptor]) await verifySnapshot(snapshot);
  return target.token();
}

/** Main-process internal API. The caller supplies only a discovered Local Storage/leveldb path. */
export async function readTsimToken(storageDirectory: string): Promise<string | null> {
  if (!isAbsolute(storageDirectory)) return null;
  for (let retry = 0; retry < 3; retry++) {
    try {return await attempt(storageDirectory);} catch { /* No file paths, contents or credentials in diagnostics. */ }
  }
  return null;
}
