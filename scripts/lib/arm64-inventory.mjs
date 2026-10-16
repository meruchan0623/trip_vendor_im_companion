import { openSync, closeSync, readSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function walk(root) {
  const files = [];
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) files.push(...walk(path));
    else if (item.isFile()) files.push(path);
  }
  return files;
}
export async function nativeInventory(root) {
  const result = [];
  for (const path of walk(root)) {
    if (statSync(path).size < 4) continue;
    const header = Buffer.alloc(4), fd = openSync(path, 'r');
    try { readSync(fd, header, 0, 4, 0); } finally { closeSync(fd); }
    if (!['cefaedfe', 'cffaedfe', 'feedface', 'feedfacf', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(header.toString('hex'))) continue;
    const description = execFileSync('/usr/bin/file', ['-b', path], { encoding: 'utf8' }).trim();
    const architectures = execFileSync('/usr/bin/lipo', ['-archs', path], { encoding: 'utf8' }).trim().split(/\s+/);
    result.push({ path: relative(root, path), architectures, description, sha256: await sha256(path) });
  }
  return result;
}
