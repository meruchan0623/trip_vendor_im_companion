import {lstat, mkdir, mkdtemp, rename, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';

const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

// The PKG transaction patches an official bundle and owns its receipt/backup schema.
// Direct injection instead installs an already signed bundle: keep its replacement
// transaction separate so legacy PKG receipts and original backups remain intact.
export async function installInjectedMacApp({source, target, copy, verify, beforeSwap = async () => {}, prepare = async () => {}, move = rename}) {
  const lock = join(dirname(target), '.trip-vendor-inject.lock');
  await mkdir(lock, {mode: 0o700});
  let root, backup, stage, hadOriginal = false, backedUp = false, installed = false, completed = false;
  try {
    if (await exists(target)) {
      const stat = await lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UNSAFE_INSTALLED_APP');
      hadOriginal = true;
    }
    root = await mkdtemp(join(dirname(target), '.trip-vendor-inject-'));
    stage = join(root, 'stage.app'); backup = join(root, 'previous.app');
    await copy(source, stage);
    await prepare(stage);
    await verify(stage);
    await beforeSwap();
    if (hadOriginal) { await move(target, backup); backedUp = true; }
    await move(stage, target); installed = true;
    await verify(target);
    // Keep the complete previous bundle, including any old integration receipts.
    completed = true;
    return {target, backup: hadOriginal ? backup : null};
  } catch (error) {
    try {
      if (installed) await move(target, join(root, 'failed.app'));
      if (backedUp) { await move(backup, target); backedUp = false; }
      if (root) await rm(root, {recursive: true, force: true});
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError], `INSTALL_RECOVERY_REQUIRED: preserved transaction at ${root}`);
    }
    throw error;
  } finally {
    // On success retain only a transaction containing an original app.
    if (root && !hadOriginal && completed) await rm(root, {recursive: true, force: true});
    await rm(lock, {recursive: true, force: true});
  }
}
