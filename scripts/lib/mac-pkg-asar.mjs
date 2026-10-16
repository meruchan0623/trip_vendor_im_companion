import {createHash} from 'node:crypto';

export const sha256 = data => createHash('sha256').update(data).digest('hex');
// ASAR uses two Chromium pickles followed by the original packed file bytes.
// Retaining that byte region preserves every vendor file, unpack flag and offset.
export function readAsar(input) {
  if (input.length < 16 || input.readUInt32LE(0) !== 4) throw new Error('INVALID_ASAR_HEADER');
  const headerSize = input.readUInt32LE(4), payloadSize = input.readUInt32LE(8), stringSize = input.readUInt32LE(12);
  if (headerSize < 8 || headerSize > 64 * 1024 * 1024 || payloadSize + 4 !== headerSize || stringSize > payloadSize - 4 || 8 + headerSize > input.length) throw new Error('INVALID_ASAR_HEADER');
  const headerString = input.toString('utf8', 16, 16 + stringSize), header = JSON.parse(headerString);
  if (!header.files || typeof header.files !== 'object') throw new Error('INVALID_ASAR_HEADER');
  return {header, headerString, data: input.subarray(8 + headerSize)};
}
export function asarFile(input, name) {
  const {header, data} = readAsar(input);
  let info = header;
  for (const part of name.split('/')) info = info.files?.[part];
  if (!info || info.unpacked || info.link || !/^\d+$/.test(info.offset) || !Number.isSafeInteger(info.size) || info.size < 0 || Number(info.offset) + info.size > data.length) throw new Error('UNSUPPORTED_ASAR_FILE ' + name);
  return data.subarray(Number(info.offset), Number(info.offset) + info.size);
}
function headerBuffer(header) {
  const text = Buffer.from(JSON.stringify(header)), padded = Math.ceil(text.length / 4) * 4, result = Buffer.alloc(16 + padded);
  result.writeUInt32LE(4, 0); result.writeUInt32LE(8 + padded, 4); result.writeUInt32LE(4 + padded, 8); result.writeUInt32LE(text.length, 12); text.copy(result, 16);
  return result;
}
function fileEntry(bytes, offset) {
  const blocks = [];
  for (let i = 0; i < bytes.length; i += 4194304) blocks.push(sha256(bytes.subarray(i, i + 4194304)));
  return {size: bytes.length, integrity: {algorithm: 'SHA256', hash: sha256(bytes), blockSize: 4194304, blocks}, offset: String(offset)};
}
export function patchVendorAsar(input, bootstrap) {
  const {header, data} = readAsar(input), pkg = JSON.parse(asarFile(input, 'package.json').toString('utf8'));
  if (typeof pkg.main !== 'string' || !pkg.main || pkg.main.startsWith('/') || pkg.main.split(/[\\/]/).includes('..') || header.files['trip-vendor-bootstrap.cjs'] || header.files['companion-vendor-original-main.json']) throw new Error('UNSUPPORTED_VENDOR_MAIN');
  const originalMain = pkg.main;
  pkg.main = 'trip-vendor-bootstrap.cjs';
  const appended = [Buffer.from(JSON.stringify(pkg, null, 2) + '\n'), Buffer.from(bootstrap), Buffer.from(JSON.stringify({main: originalMain}) + '\n')];
  let offset = data.length;
  for (const [index, name] of ['package.json', 'trip-vendor-bootstrap.cjs', 'companion-vendor-original-main.json'].entries()) {
    header.files[name] = fileEntry(appended[index], offset); offset += appended[index].length;
  }
  const prefix = headerBuffer(header), archive = Buffer.concat([prefix, data, ...appended]);
  return {archive, asarSha256: sha256(archive), headerSha256: sha256(JSON.stringify(header)), originalMain};
}
