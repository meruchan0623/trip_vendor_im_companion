// Compile the real installer engine and adapter; every bundle is synthetic and temporary.
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';

if (process.platform !== 'darwin') {
  console.log('SKIP macOS injector transaction integration requires macOS; no installed client was examined.');
} else {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tsim-injector-transactions-')));
  const run = (file, args) => new Promise((resolveRun, reject) => {
    const child = spawn(file, args, {stdio: 'inherit'});
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 120000);
    timer.unref();
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      code === 0 && !timedOut ? resolveRun() : reject(Error(`transaction fixture failed code=${code} signal=${signal} timeout=${timedOut}`));
    });
  });
  try {
    const binary = join(directory, 'transaction-tests');
    await run('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(directory, 'module-cache'), '-D', 'INSTALLER_TESTING',
      resolve('native/macos-installer/Engine.swift'), resolve('native/macos-installer/Injection.swift'),
      resolve('tests/macos-injector-transaction.swift'), '-o', binary]);
    await run(binary, [directory]);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}
