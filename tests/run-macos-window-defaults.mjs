import {mkdtemp, mkdir, copyFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';

if (process.platform !== 'darwin') {
  console.log('SKIP macOS native startup window fixture requires macOS');
} else {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--runtime-app' || !args[1].endsWith('.app'))) {
    throw new Error('USAGE: run-macos-window-defaults.mjs [--runtime-app <official .app>]');
  }
  const directory = await mkdtemp(join(tmpdir(), 'tsim-mac-window-'));
  const run = (command, commandArgs, env = process.env, expectWindowResult = false) => new Promise((resolveRun, reject) => {
    console.log(JSON.stringify({command, args: commandArgs}));
    const child = spawn(command, commandArgs, {stdio: ['ignore', 'pipe', 'inherit'], env});
    let stdout = '';
    child.stdout.on('data', chunk => {process.stdout.write(chunk); stdout += chunk;});
    const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`WINDOW_FIXTURE_FAILED code=${code} signal=${signal}`));
      if (expectWindowResult && !stdout.split('\n').some(line => {
        try {return JSON.parse(line).event === 'macos_window_defaults_ok';} catch {return false;}
      })) return reject(new Error('WINDOW_FIXTURE_RESULT_MISSING'));
      resolveRun();
    });
  });
  try {
    const fixture = resolve('tests/macos-window-defaults.fixture.cjs');
    let executable = createRequire(import.meta.url)('electron'), launchArgs = [fixture];
    if (args.length) {
      // Copy the runtime into a private directory, then replace ALL vendor application code.
      const app = join(directory, 'WindowFixture.app');
      await run('/usr/bin/ditto', ['--noqtn', resolve(args[1]), app]);
      const contents = join(app, 'Contents'), resources = join(contents, 'Resources');
      await rm(resources, {recursive: true});
      const fixtureApp = join(resources, 'app');
      await mkdir(fixtureApp, {recursive: true});
      await copyFile(fixture, join(fixtureApp, 'main.cjs'));
      await writeFile(join(fixtureApp, 'package.json'), JSON.stringify({name: 'tsim-window-fixture', version: '1.0.0', main: 'main.cjs'}));
      await run('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', 'tech.tsim.window-fixture', join(contents, 'Info.plist')]);
      // Official source is read only; ad-hoc signing applies solely to this disposable copy.
      await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
      executable = join(contents, 'MacOS', '旅游商家桌面版'); launchArgs = [];
    }
    await run(executable, launchArgs, {...process.env, TMC_WINDOW_TEST_DIRECTORY: directory,
      TMC_WINDOW_TEST_BOOTSTRAP: resolve('scripts/lib/macos-vendor-bootstrap.cjs')}, true);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}
