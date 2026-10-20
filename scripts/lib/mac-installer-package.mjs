import {createHash} from 'node:crypto';
import {lstat, readdir, readlink, open} from 'node:fs/promises';
import {join, resolve} from 'node:path';

// Must match native/macos-installer/Engine.swift. Ignore xattrs, resource forks,
// ownership and timestamps; preserve executable modes, file bytes and symlinks.
export async function injectorTreeDigest(root) {
  const hash = createHash('sha256');
  async function visit(folder, prefix = '') {
    const names = (await readdir(folder)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const name of names) {
      const file = join(folder, name), relative = prefix + name, info = await lstat(file);
      if (info.isSymbolicLink()) hash.update(`L\0${relative}\0${await readlink(file)}\0`);
      else if (info.isDirectory()) { hash.update(`D\0${relative}\0`); await visit(file, relative + '/'); }
      else if (info.isFile()) {
        hash.update(`F\0${relative}\0${info.mode & 0o777}\0`);
        const handle = await open(file, 'r');
        try { for await (const data of handle.createReadStream()) hash.update(data); }
        finally { await handle.close(); }
      } else throw new Error('UNSUPPORTED_BUNDLE_ENTRY ' + relative);
    }
  }
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('REAL_APP_DIRECTORY_REQUIRED');
  await visit(resolve(root)); return hash.digest('hex');
}
