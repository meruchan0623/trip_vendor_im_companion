import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {preflightMacPkg, installMacPkg, rollbackMacPkg} from './mac-pkg-installer.mjs';
// Electron's Node mode normally virtualizes .asar paths. Installation hashes and patches raw archives.
process.noAsar = true;
const payload = dirname(process.argv[1]);
(async () => { try {
  const manifest = JSON.parse(await readFile(join(payload, 'manifest.json'), 'utf8'));
  const command = process.argv[2];
  const action = {check: preflightMacPkg, install: installMacPkg, rollback: rollbackMacPkg}[command];
  if (!action || process.argv.length !== 3) throw new Error('USAGE check|install|rollback');
  console.log(JSON.stringify(await action({payload, manifest}), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; } })();
