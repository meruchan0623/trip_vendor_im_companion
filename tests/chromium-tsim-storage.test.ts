import {afterEach, describe, expect, it, vi} from 'vitest';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readTsimToken} from '../electron/chromium-tsim-storage';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {...actual, open: vi.fn(actual.open)};
});
const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

// Every profile in this suite is constructed here. No actual browser paths,
// browser processes, real localStorage values or credentials are accessed.
const dirs: string[] = [];
afterEach(async () => {vi.mocked(fs.open).mockReset().mockImplementation(realFs.open); await Promise.all(dirs.splice(0).map(path => fs.rm(path, {recursive: true, force: true})));});
const bytes = (...parts: (Buffer | number[])[]) => Buffer.concat(parts.map(part => Buffer.from(part)));
function v(value: number | bigint): Buffer {
  let n = BigInt(value); const output = [];
  do {const byte = Number(n & 127n); n >>= 7n; output.push(byte | (n ? 128 : 0));} while (n);
  return Buffer.from(output);
}
const slice = (value: Buffer) => bytes(v(value.length), value);
function crc(data: Buffer): number {
  let n = 0xffffffff;
  for (const b of data) {n ^= b; for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ (n & 1 ? 0x82f63b78 : 0);}
  n = (n ^ 0xffffffff) >>> 0; return (((n >>> 15) | (n << 17)) + 0xa282ead8) >>> 0;
}
function physical(type: number, body: Buffer): Buffer {
  const header = Buffer.alloc(7); header.writeUInt32LE(crc(bytes([type], body))); header.writeUInt16LE(body.length, 4); header[6] = type;
  return bytes(header, body);
}
function wal(records: Buffer[]): Buffer {
  const chunks: Buffer[] = []; let offset = 0;
  for (const record of records) {
    let cursor = 0; let first = true;
    do {
      const remain = 32768 - offset % 32768;
      if (remain < 7) {chunks.push(Buffer.alloc(remain)); offset += remain; continue;}
      const length = Math.min(remain - 7, record.length - cursor); const last = cursor + length === record.length;
      const chunk = physical(first ? last ? 1 : 2 : last ? 4 : 3, record.subarray(cursor, cursor + length));
      chunks.push(chunk); cursor += length; offset += chunk.length; first = false;
    } while (cursor < record.length);
  }
  return bytes(...chunks);
}
const key = (name = 'agent_token', origin = 'https://csagent.tsim.tech', wide = false) => bytes(Buffer.from(`_${origin}\0`), [wide ? 0 : 1], Buffer.from(name, wide ? 'utf16le' : 'latin1'));
const value = (text: string, wide = false) => bytes([wide ? 0 : 1], Buffer.from(text, wide ? 'utf16le' : 'latin1'));
type Entry = {key: Buffer; value: Buffer; seq: number; type?: number};
const token = (text: string, seq: number, extra: Partial<Entry> = {}): Entry => ({key: key(), value: value(text), seq, ...extra});
function batch(entries: Entry[]): Buffer {
  const header = Buffer.alloc(12); header.writeBigUInt64LE(BigInt(entries[0]?.seq ?? 0)); header.writeUInt32LE(entries.length, 8);
  return bytes(header, ...entries.map(entry => bytes([entry.type ?? 1], slice(entry.key), ...(entry.type === 0 ? [] : [slice(entry.value)]))));
}
function internal(entry: Entry): Buffer {const tag = Buffer.alloc(8); tag.writeBigUInt64LE((BigInt(entry.seq) << 8n) | BigInt(entry.type ?? 1)); return bytes(entry.key, tag);}
function block(entries: [Buffer, Buffer][]): Buffer {
  const output: Buffer[] = []; let previous: Buffer = Buffer.alloc(0); let offset = 0; const restarts = [0];
  entries.forEach(([key, value], index) => {
    let shared = 0; if (index % 2) while (shared < Math.min(previous.length, key.length) && previous[shared] === key[shared]) shared++;
    else if (index) restarts.push(offset);
    const row = bytes(v(shared), v(key.length - shared), v(value.length), key.subarray(shared), value);
    output.push(row); offset += row.length; previous = key;
  });
  const tail = Buffer.alloc(4 * (restarts.length + 1)); restarts.forEach((restart, i) => tail.writeUInt32LE(restart, i * 4)); tail.writeUInt32LE(restarts.length, restarts.length * 4);
  return bytes(...output, tail);
}
function literal(input: Buffer): Buffer {
  if (!input.length) return Buffer.alloc(0);
  if (input.length < 61) return bytes([(input.length - 1) << 2], input);
  const count = input.length < 257 ? 1 : input.length < 65537 ? 2 : 3;
  const length = Buffer.alloc(count); for (let i = 0; i < count; i++) length[i] = ((input.length - 1) >>> (i * 8)) & 255;
  return bytes([(59 + count) << 2], length, input);
}
function compressed(input: Buffer, badDistance = false): Buffer {
  // Explicit overlapping copy from one 'a' to build the rest of a long run.
  const start = input.indexOf(Buffer.from('a'.repeat(100)));
  if (start < 0) throw new Error('Synthetic test requires a repeat');
  const runs: Buffer[] = [v(input.length), literal(input.subarray(0, start + 1))];
  let count = 99; while (count) {const n = Math.min(count, 64); runs.push(bytes([((n - 1) << 2) | 2, badDistance ? 0 : 1, 0])); count -= n;}
  return bytes(...runs, literal(input.subarray(start + 100)));
}
function storedBlock(input: Buffer, compression = 0): Buffer {
  const trailer = Buffer.alloc(5); trailer[0] = compression; trailer.writeUInt32LE(crc(bytes(input, [compression])), 1); return bytes(input, trailer);
}
function sst(entries: Entry[], compress = false, badDistance = false): {data: Buffer; smallest: Buffer; largest: Buffer} {
  const rows = entries.slice().sort((a, b) => Buffer.compare(a.key, b.key) || b.seq - a.seq || (b.type ?? 1) - (a.type ?? 1));
  const dataPlain = block(rows.map(entry => [internal(entry), entry.type === 0 ? Buffer.alloc(0) : entry.value]));
  const dataRaw = compress ? compressed(dataPlain, badDistance) : dataPlain; const data = storedBlock(dataRaw, compress ? 1 : 0);
  const metaRaw = block([]); const meta = storedBlock(metaRaw);
  const indexRaw = block([[internal(rows.at(-1)!), bytes(v(0), v(dataRaw.length))]]); const index = storedBlock(indexRaw);
  const footer = Buffer.alloc(48); const handles = bytes(v(data.length), v(metaRaw.length), v(data.length + meta.length), v(indexRaw.length)); handles.copy(footer); footer.writeBigUInt64LE(0xdb4775248b80fb57n, 40);
  return {data: bytes(data, meta, index, footer), smallest: internal(rows[0]), largest: internal(rows.at(-1)!)};
}
type SyntheticTable = ReturnType<typeof sst> & {number: number; level?: number};
const add = (table: SyntheticTable) => bytes(v(7), v(table.level ?? 0), v(table.number), v(table.data.length), slice(table.smallest), slice(table.largest));
const remove = (number: number, level = 0) => bytes(v(6), v(level), v(number));
const metadata = (log = 3, seq = 100, prev = 0) => bytes(v(1), slice(Buffer.from('leveldb.BytewiseComparator')), v(2), v(log), v(9), v(prev), v(4), v(seq));
async function profile(tables: SyntheticTable[] = [], logs: [number, Buffer][] = [], edits: Buffer[] = [], first = metadata()): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'synthetic-tsim-leveldb-')); dirs.push(dir);
  await fs.writeFile(join(dir, 'CURRENT'), 'MANIFEST-000001\n');
  await fs.writeFile(join(dir, 'MANIFEST-000001'), wal([bytes(first, ...tables.map(add)), ...edits]));
  for (const table of tables) await fs.writeFile(join(dir, `${String(table.number).padStart(6, '0')}.ldb`), table.data);
  for (const [number, data] of logs) await fs.writeFile(join(dir, `${String(number).padStart(6, '0')}.log`), data);
  if (!logs.length) await fs.writeFile(join(dir, '000003.log'), Buffer.alloc(0));
  return dir;
}

describe('strict scoped Chromium localStorage reader with synthetic profiles', () => {
  it('reads only exact HTTPS origin and agent_token, across Latin1 and UTF16 DOMStrings', async () => {
    const dir = await profile([], [[3, wal([
      batch([token('wrong-origin', 1, {key: key('agent_token', 'https://csagent.tsim.tech.evil')})]),
      batch([token('wrong-http', 2, {key: key('agent_token', 'http://csagent.tsim.tech')})]),
      batch([token('business-secret', 3, {key: key('business_token')})]),
      batch([token('synthetic-wide', 4, {key: key('agent_token', undefined, true), value: value('synthetic-wide', true)})]),
    ])]]);
    expect(await readTsimToken(dir)).toBe('synthetic-wide');
  });
  it('selects newest table/WAL value by sequence rather than file enumeration', async () => {
    const dir = await profile([{...sst([token('older-table', 9)]), number: 2}, {...sst([token('newer-table', 10)]), number: 4}], [[3, wal([batch([token('newest-wal', 11)])])]]);
    expect(await readTsimToken(dir)).toBe('newest-wal');
  });
  it('honors newer tombstones in WAL and SST without resurrecting older values', async () => {
    const older = {...sst([token('obsolete', 8)]), number: 2};
    const dir = await profile([older], [[3, wal([batch([token('', 9, {type: 0})])])]]);
    expect(await readTsimToken(dir)).toBeNull();
    const second = await profile([older, {...sst([token('', 9, {type: 0})]), number: 4}]);
    expect(await readTsimToken(second)).toBeNull();
  });
  it('ignores a table removed by manifest compaction, even if obsolete file remains', async () => {
    const old = {...sst([token('must-not-resurrect', 20)]), number: 2};
    const dir = await profile([old], [], [remove(2)]);
    expect(await readTsimToken(dir)).toBeNull();
    // The removed file is deliberately unreadable garbage; it is still ignored.
    await fs.writeFile(join(dir, '000002.ldb'), 'garbage');
    expect(await readTsimToken(dir)).toBeNull();
  });
  it('includes previous-log and newer recovery logs but excludes obsolete logs', async () => {
    const dir = await profile([], [[2, wal([batch([token('previous', 30)])])], [3, Buffer.alloc(0)], [1, wal([batch([token('obsolete-log', 99)])])]], [], metadata(3, 10, 2));
    expect(await readTsimToken(dir)).toBe('previous');
    await fs.writeFile(join(dir, '000004.log'), wal([batch([token('', 31, {type: 0})])]));
    expect(await readTsimToken(dir)).toBeNull();
  });
  it('handles fragmented WAL with restart-compressed table blocks', async () => {
    const unrelated = token('x'.repeat(70_000), 40, {key: key('unrelated')});
    const dir = await profile([{...sst([token('base', 2), token('other', 3, {key: key('zzzz')})]), number: 2}], [[3, wal([batch([unrelated, token('fragmented-synthetic', 41)])])]]);
    expect(await readTsimToken(dir)).toBe('fragmented-synthetic');
  });
  it('decodes Snappy overlapping copies and rejects invalid copy distance', async () => {
    const good = await profile([{...sst([token('a'.repeat(100), 10)], true), number: 2}]);
    expect(await readTsimToken(good)).toBe('a'.repeat(100));
    const bad = await profile([{...sst([token('a'.repeat(100), 10)], true, true), number: 2}]);
    expect(await readTsimToken(bad)).toBeNull();
  });
  it('fails closed for corrupt CRC and torn WAL tails, including after a valid old value', async () => {
    const original = wal([batch([token('older', 1)]), batch([token('', 2, {type: 0})])]);
    const torn = await profile([], [[3, original.subarray(0, -1)]]); expect(await readTsimToken(torn)).toBeNull();
    const corrupt = Buffer.from(original); corrupt[0] ^= 1;
    const bad = await profile([], [[3, corrupt]]); expect(await readTsimToken(bad)).toBeNull();
    const fragmented = wal([batch([token('x'.repeat(70_000), 1, {key: key('irrelevant')})])]);
    await fs.writeFile(join(torn, '000003.log'), fragmented.subarray(0, 32768));
    expect(await readTsimToken(torn)).toBeNull();
  });
  it('rejects damaged SST checksums/footer, malformed lengths and unsafe CURRENT paths', async () => {
    const table = {...sst([token('synthetic', 5)]), number: 2}; const dir = await profile([table]);
    const damaged = Buffer.from(table.data); damaged[1] ^= 1; await fs.writeFile(join(dir, '000002.ldb'), damaged);
    expect(await readTsimToken(dir)).toBeNull();
    const footer = Buffer.from(table.data); footer[footer.length - 1] ^= 1; await fs.writeFile(join(dir, '000002.ldb'), footer);
    expect(await readTsimToken(dir)).toBeNull();
    await fs.writeFile(join(dir, 'CURRENT'), '../MANIFEST-000001\n'); expect(await readTsimToken(dir)).toBeNull();
    const malformed = await profile([], [[3, wal([bytes(Buffer.alloc(8), [1, 0, 0, 0, 1, 255, 255, 255, 255, 127])])]]);
    expect(await readTsimToken(malformed)).toBeNull();
    expect(await readTsimToken('relative/path')).toBeNull();
  });
  it('rejects malformed restart arrays and decompression bounds even with valid block CRCs', async () => {
    const original = sst([token('synthetic', 5)]);
    // The synthetic data block ends immediately before its checksum trailer and
    // empty meta block. Derive it from the known serialized block itself.
    const plain = block([[internal(token('synthetic', 5)), value('synthetic')]]);
    const broken = Buffer.from(original.data); broken.writeUInt32LE(1, plain.length - 8);
    broken.writeUInt32LE(crc(bytes(broken.subarray(0, plain.length), [0])), plain.length + 1);
    const badRestart = await profile([{...original, data: broken, number: 2}]);
    expect(await readTsimToken(badRestart)).toBeNull();
    const huge = Buffer.from([255, 255, 255, 255, 15]);
    const snappyTable = sst([token('a'.repeat(100), 5)], true);
    const compressedPlain = compressed(block([[internal(token('a'.repeat(100), 5)), value('a'.repeat(100))]]));
    const badSize = Buffer.from(snappyTable.data); huge.copy(badSize, 0);
    badSize.writeUInt32LE(crc(bytes(badSize.subarray(0, compressedPlain.length), [1])), compressedPlain.length + 1);
    const oversized = await profile([{...snappyTable, data: badSize, number: 2}]);
    expect(await readTsimToken(oversized)).toBeNull();
  });
  it('fails closed when a required table is missing, metadata bounds disagree or sequence conflicts', async () => {
    const table = {...sst([token('synthetic', 5)]), number: 2}; const dir = await profile([table]);
    await fs.unlink(join(dir, '000002.ldb')); expect(await readTsimToken(dir)).toBeNull();
    const wrongBounds = await profile([{...table, smallest: internal(token('other', 4))}]); expect(await readTsimToken(wrongBounds)).toBeNull();
    const conflict = await profile([table], [[3, wal([batch([token('', 5, {type: 0})])])]]); expect(await readTsimToken(conflict)).toBeNull();
  });
  it('does not read unrelated files or removed tables and never writes to a profile', async () => {
    const dir = await profile([], [[3, wal([batch([token('synthetic', 1)])])]]);
    await fs.writeFile(join(dir, 'Cookies'), 'unrelated-data'); await fs.writeFile(join(dir, '000001.log'), 'obsolete');
    const opening = vi.mocked(fs.open); opening.mockClear();
    expect(await readTsimToken(dir)).toBe('synthetic');
    expect(opening.mock.calls.every(([path, mode]) => !String(path).endsWith('Cookies') && !String(path).endsWith('000001.log') && mode === 'r')).toBe(true);
  });
  it('rejects a WAL append during a read and retries from CURRENT before accepting a stable snapshot', async () => {
    const dir = await profile([], [[3, wal([batch([token('synthetic', 1)])])]]); const originalOpen = realFs.open;
    let changes = 0;
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith('000003.log') && changes++ === 0) {
        return new Proxy(handle, {get(target, property) {
          if (property === 'read') return async (...readArgs: unknown[]) => {
            const result = await Reflect.apply(target.read, target, readArgs);
            await fs.appendFile(join(dir, '000003.log'), wal([batch([token('', 2, {type: 0})])]));
            return result;
          };
          const member = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member;
        }});
      }
      return handle;
    });
    expect(await readTsimToken(dir)).toBeNull();
    expect(changes).toBeGreaterThan(1);
  });
  it('stops after three attempts when WAL changes continuously', async () => {
    const dir = await profile([], [[3, wal([batch([token('synthetic', 1)])])]]); let changes = 0; let currentReads = 0;
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realFs.open(...args);
      if (String(args[0]).endsWith('CURRENT')) currentReads++;
      if (!String(args[0]).endsWith('000003.log')) return handle;
      return new Proxy(handle, {get(target, property) {
        if (property === 'read') return async (...readArgs: unknown[]) => {
          const result = await Reflect.apply(target.read, target, readArgs);
          await fs.appendFile(join(dir, '000003.log'), wal([batch([token('', 2 + changes++, {type: 0})])])); return result;
        };
        const member = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member;
      }});
    });
    expect(await readTsimToken(dir)).toBeNull(); expect(changes).toBe(3); expect(currentReads).toBe(3);
  });
  it('rechecks multi-block SST and WAL using one bounded buffer including final control checks', async () => {
    const large = token('x'.repeat(150_000), 1, {key:key('unrelated')});
    const dir = await profile([{...sst([large,token('table-token',2)]),number:2}], [[3,wal([batch([{...large,seq:3},token('final-token',4)])])]]);
    const opens=new Map<string,number>(), buffers=new Set<Buffer>(), lengths:number[]=[], positions:number[]=[];
    vi.mocked(fs.open).mockImplementation(async (...args:Parameters<typeof fs.open>)=>{
      const handle=await realFs.open(...args),name=String(args[0]),count=(opens.get(name)??0)+1;opens.set(name,count);
      if(count===1)return handle;
      return new Proxy(handle,{get(target,property){
        if(property==='read')return async (...readArgs:unknown[])=>{buffers.add(readArgs[0] as Buffer);lengths.push(readArgs[2] as number);positions.push(readArgs[3] as number);return Reflect.apply(target.read,target,readArgs);};
        const member=Reflect.get(target,property);return typeof member==='function'?member.bind(target):member;
      }});
    });
    expect(await readTsimToken(dir)).toBe('final-token');
    expect(buffers.size).toBe(1);expect([...buffers][0].length).toBe(65536);expect(Math.max(...lengths)).toBe(65536);expect(positions).toContain(131072);
    expect(opens.get(join(dir,'CURRENT'))).toBe(3);expect(opens.get(join(dir,'MANIFEST-000001'))).toBe(3);
    expect(opens.get(join(dir,'000002.ldb'))).toBe(2);expect(opens.get(join(dir,'000003.log'))).toBe(2);
  });
  it.each([65535,65536,65537])('rejects second-pass byte changes at %i even when all metadata stays identical',async changedAt=>{
    const dir=await profile([],[[3,wal([batch([token('x'.repeat(150_000),1,{key:key('unrelated')}),token('synthetic',2)])])]]);let opens=0,mutations=0;
    vi.mocked(fs.open).mockImplementation(async(...args:Parameters<typeof fs.open>)=>{
      const handle=await realFs.open(...args);if(!String(args[0]).endsWith('000003.log')||++opens%2!==0)return handle;
      return new Proxy(handle,{get(target,property){
        if(property==='read')return async(...readArgs:unknown[])=>{const result=await Reflect.apply(target.read,target,readArgs),position=readArgs[3] as number;if(changedAt>=position&&changedAt<position+result.bytesRead){(readArgs[0] as Buffer)[(readArgs[1] as number)+changedAt-position]^=1;mutations++;}return result;};
        const member=Reflect.get(target,property);return typeof member==='function'?member.bind(target):member;
      }});
    });
    expect(await readTsimToken(dir)).toBeNull();expect(mutations).toBe(3);expect(opens).toBe(6);
  });
  it.each([false,true])('handles second-pass short reads and fails on premature EOF (EOF=%s)',async eof=>{
    const dir=await profile([],[[3,wal([batch([token('x'.repeat(150_000),1,{key:key('unrelated')}),token('synthetic',2)])])]]);let opens=0,shortReads=0;
    vi.mocked(fs.open).mockImplementation(async(...args:Parameters<typeof fs.open>)=>{
      const handle=await realFs.open(...args);if(!String(args[0]).endsWith('000003.log')||++opens%2!==0)return handle;
      return new Proxy(handle,{get(target,property){
        if(property==='read')return async(...readArgs:unknown[])=>{if(eof&&(readArgs[3] as number)>=65536)return {bytesRead:0,buffer:readArgs[0]};readArgs[2]=Math.min(readArgs[2] as number,4093);shortReads++;return Reflect.apply(target.read,target,readArgs);};
        const member=Reflect.get(target,property);return typeof member==='function'?member.bind(target):member;
      }});
    });
    expect(await readTsimToken(dir)).toBe(eof?null:'synthetic');expect(shortReads).toBeGreaterThan(2);expect(opens).toBe(eof?6:2);
  });
  it.each(['before','after'])('rejects identity changes %s the second-pass read',async stage=>{
    const dir=await profile([],[[3,wal([batch([token('synthetic',1)])])]]);let opens=0,mutations=0;
    vi.mocked(fs.open).mockImplementation(async(...args:Parameters<typeof fs.open>)=>{
      const handle=await realFs.open(...args);if(!String(args[0]).endsWith('000003.log')||++opens%2!==0)return handle;let stats=0;
      return new Proxy(handle,{get(target,property){
        if(property==='stat')return async(...statArgs:unknown[])=>{const result=await Reflect.apply(target.stat,target,statArgs);if(++stats===(stage==='before'?1:2)){mutations++;return {...result,ino:result.ino+1n,isFile:()=>true};}return result;};
        const member=Reflect.get(target,property);return typeof member==='function'?member.bind(target):member;
      }});
    });
    expect(await readTsimToken(dir)).toBeNull();expect(mutations).toBe(3);expect(opens).toBe(6);
  });
  it.each(['CURRENT','MANIFEST-000001'])('still rejects a changed %s in the final control-file pass',async name=>{
    const dir=await profile([],[[3,wal([batch([token('synthetic',1)])])]]);let opens=0,mutations=0;
    vi.mocked(fs.open).mockImplementation(async(...args:Parameters<typeof fs.open>)=>{
      const handle=await realFs.open(...args);if(String(args[0])!==join(dir,name)||++opens%3!==0)return handle;
      return new Proxy(handle,{get(target,property){
        if(property==='read')return async(...readArgs:unknown[])=>{const result=await Reflect.apply(target.read,target,readArgs);if(result.bytesRead){(readArgs[0] as Buffer)[readArgs[1] as number]^=1;mutations++;}return result;};
        const member=Reflect.get(target,property);return typeof member==='function'?member.bind(target):member;
      }});
    });
    expect(await readTsimToken(dir)).toBeNull();expect(mutations).toBe(3);expect(opens).toBe(9);
  });
});
