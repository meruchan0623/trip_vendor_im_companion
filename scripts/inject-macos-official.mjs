#!/usr/bin/env node
// Injects the companion directly into the official macOS client, without a PKG.
//   node scripts/inject-macos-official.mjs [--official <official .dmg|.app>] [--install]
//   node scripts/inject-macos-official.mjs --install-built
// Without --install it only builds work/mac-inject/旅游商家桌面版.app; --install-built installs that
// earlier build without rebuilding. Both install options replace
// /Applications/旅游商家桌面版.app (asking for an administrator password only when the installed copy is not writable).
import {build} from 'esbuild';
import {access, mkdir, readFile, rm, writeFile, mkdtemp} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {homedir, userInfo} from 'node:os';
import {launcherSource} from './install-macos-companion.mjs';
import {patchVendorAsar, sha256} from './lib/mac-pkg-asar.mjs';
import {inspectMacPageBuild} from './lib/macos-page-build.mjs';
import {OFFICIAL_REQUIREMENT} from './lib/mac-pkg-installer.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('APPLE_SILICON_BUILD_HOST_REQUIRED');
const TARGET = '/Applications/旅游商家桌面版.app', APP_NAME = '旅游商家桌面版.app', HELPER = '旅游商家助手.app';
const args = process.argv.slice(2), options = {official: 'work/mac-arm64/official-apple.dmg', install: false, build: true};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--install') options.install = true;
  else if (args[i] === '--install-built') { options.install = true; options.build = false; }
  else if (args[i] === '--official' && args[i + 1] && !args[i + 1].startsWith('--')) options.official = args[++i];
  else throw new Error('USAGE: inject-macos-official.mjs [--official <official .dmg|.app>] [--install] | --install-built');
}
// Supported official build: 旅游商家桌面版 1.2.12 / ares 1.2.15 (Intel, official Team ID signature).
const support = {
  bundleId: 'com.ctrip.vbooking', version: '1.2.12', executable: '旅游商家桌面版',
  executableSha256: '0db3c283d0bb58a1e314b89cd2d4f54089c86cdc1ee0c22ecfe1550ade2ff0c2',
  asarSha256: 'e6e1a4547e3609ac858d8d71f69a982a46d6f04a8a7f4197bf4ba63ed39abb24',
  files: {
    'Contents/Resources/app.asar.unpacked/dist/src/pages/imPlus/index.html': 'a91c9fcd232a132a0441c7ed4d785fa39b4cc52d2205afc7db571489336d7b0f',
    'Contents/Resources/app.asar.unpacked/dist/js/imWindow-BnMVlw3I.js': '80f0a342ddc9cced51b20138bb41554e583490714085d0eaeb027aa882877aa7',
    'Contents/Resources/app.asar.unpacked/dist/src/pages/main/index.html': 'e32baaf2caeddf331de3a20eed37cfd259cdc20aeb2b6ab38aed96291494a4fd',
    'Contents/Resources/app.asar.unpacked/dist/js/mainWindow-2v9P5wjR.js': 'c4114938c13e12bc057a8ef0931676f8b0f68cc34db46d7d3c504badd77c81a6',
  },
};
function run(command, commandArgs, env = process.env) {
  console.log(JSON.stringify({command, args: commandArgs}));
  const result = spawnSync(command, commandArgs, {stdio: 'inherit', env});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`COMMAND_FAILED ${command} ${result.status}`);
}
function read(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {encoding: 'utf8'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`COMMAND_FAILED ${command} ${result.status} ${result.stderr.trim()}`);
  return result.stdout.trim();
}
const plist = (app, key) => read('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(app, 'Contents/Info.plist')]);
function assertIdle() {
  for (const line of read('/bin/ps', ['-axww', '-o', 'comm=']).split('\n')) {
    const path = line.normalize('NFC');
    if (path.startsWith(TARGET.normalize('NFC') + '/') || path.includes('vbk-electron-updater') || path.includes(`/${HELPER}/Contents/`)) throw new Error('QUIT_VENDOR_AND_COMPANION_FIRST: 请先完全退出旅游商家桌面版及旅游商家助手。');
  }
}
async function verifyOfficial(app) {
  for (const [key, value] of Object.entries({CFBundleIdentifier: support.bundleId, CFBundleVersion: support.version, CFBundleShortVersionString: support.version, CFBundleExecutable: support.executable})) if (plist(app, key) !== value) throw new Error('UNSUPPORTED_OFFICIAL_IDENTITY ' + key);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--test-requirement', OFFICIAL_REQUIREMENT, app]);
  const versions = JSON.parse(await readFile(join(app, 'Contents/Resources/app.asar.unpacked/dist/packageVersion.json'), 'utf8'));
  if (versions.pkgVersion !== '1.2.12' || versions.aresVersion !== '1.2.15') throw new Error('UNSUPPORTED_VENDOR_PACKAGE_VERSION');
  if (sha256(await readFile(join(app, 'Contents/MacOS', support.executable))) !== support.executableSha256 || sha256(await readFile(join(app, 'Contents/Resources/app.asar'))) !== support.asarSha256) throw new Error('UNSUPPORTED_OFFICIAL_HASH');
  for (const [relative, expected] of Object.entries(support.files)) if (sha256(await readFile(join(app, relative))) !== expected) throw new Error('UNSUPPORTED_OFFICIAL_RESOURCE ' + relative);
}

const work = resolve('work/mac-inject'), staged = join(work, APP_NAME), manifestPath = join(work, 'runtime-manifest.json');
const compiled = await build({entryPoints: ['runtime/macho-fingerprint.ts'], bundle: true, platform: 'node', format: 'esm', write: false});
const {fingerprintMacExecutable} = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const fingerprintMatches = async (app, manifest) => await fingerprintMacExecutable(join(app, 'Contents/MacOS', support.executable)) === manifest.executableSha256 && sha256(await readFile(join(app, 'Contents/Resources/app.asar'))) === manifest.asarSha256;
let runtimeManifest;
if (options.build) {
await rm(work, {recursive: true, force: true}); await mkdir(work, {recursive: true});
// 1. Copy the verified official app out of the DMG (or the given unmodified .app).
const source = resolve(options.official);
let mount;
try {
  let official = source;
  if (source.endsWith('.dmg')) {
    mount = await mkdtemp(join(work, 'dmg-'));
    run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, source]);
    official = join(mount, APP_NAME);
  } else if (!source.endsWith('.app')) throw new Error('OFFICIAL_DMG_OR_APP_REQUIRED');
  await verifyOfficial(official);
  run('/usr/bin/ditto', [official, staged]);
} finally { if (mount) { spawnSync('/usr/bin/hdiutil', ['detach', mount], {stdio: 'inherit'}); await rm(mount, {recursive: true, force: true}); } }
await verifyOfficial(staged);

// 2. The helper only attaches to this exact patched client: compile its fingerprint into the build.
const contents = join(staged, 'Contents'), exe = join(contents, 'MacOS', support.executable), archivePath = join(contents, 'Resources/app.asar');
const bootstrap = await readFile('scripts/lib/macos-vendor-bootstrap.cjs');
const patched = patchVendorAsar(await readFile(archivePath), bootstrap);
const pageBuild = await inspectMacPageBuild(homedir());
runtimeManifest = {executableSha256: await fingerprintMacExecutable(exe), asarSha256: patched.asarSha256, ...(pageBuild ? {pageBuild} : {})};
await writeFile(manifestPath, JSON.stringify(runtimeManifest, null, 2) + '\n');
const env = {...process.env, TMC_RUNTIME_PLATFORM: 'darwin', TMC_MACOS_MANIFEST: manifestPath};
run('npm', ['run', 'build:native:mac'], env); run('npm', ['run', 'build'], env);
run('npx', ['electron-builder', '--mac', 'dir', '--arm64', '-c.directories.output=work/mac-inject/helper'], env);
const helper = join(work, 'helper/mac-arm64', HELPER), companionExecutable = plist(helper, 'CFBundleExecutable');

// 3. Inject the helper, launcher and bootstrap, then re-sign the whole bundle ad hoc.
const launcherSwift = join(work, 'Launcher.swift'); await writeFile(launcherSwift, launcherSource);
run('/usr/bin/xcrun', ['swiftc', '-O', '-target', 'arm64-apple-macos11', '-o', join(contents, 'MacOS/TripVendorLauncher'), launcherSwift]);
const resources = join(contents, 'Resources/companion'); await mkdir(resources);
run('/usr/bin/ditto', [helper, join(resources, HELPER)]);
await writeFile(join(resources, 'launcher.json'), JSON.stringify({vendorExecutable: support.executable, companionExecutable}));
await writeFile(archivePath, patched.archive);
run('/usr/bin/plutil', ['-replace', 'ElectronAsarIntegrity.Resources/app\\.asar.hash', '-string', patched.headerSha256, join(contents, 'Info.plist')]);
run('/usr/bin/plutil', ['-replace', 'CFBundleExecutable', '-string', 'TripVendorLauncher', join(contents, 'Info.plist')]);
run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', staged]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
if (!await fingerprintMatches(staged, runtimeManifest)) throw new Error('INJECTED_FINGERPRINT_DRIFT');
console.log(JSON.stringify({event: 'mac_inject_built', app: staged, runtimeManifest}));
} else {
  // Reuse an earlier build only if it still matches the fingerprint its helper was compiled for.
  runtimeManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
  if (!await fingerprintMatches(staged, runtimeManifest)) throw new Error('BUILT_APP_FINGERPRINT_DRIFT');
}

// 4. Copy and verify on the destination volume before swapping directories. Preserve
// the previous app and all legacy PKG state; restore the app if any swap/check fails.
if (options.install) {
  assertIdle();
  const writable = await access(TARGET).then(() => read('/usr/bin/stat', ['-f', '%u', TARGET]) === String(process.getuid()), () => true);
  const installer = join(work, 'install-transaction.cjs');
  const entry = `
    import {installInjectedMacApp} from './scripts/lib/mac-inject-transaction.mjs';
    import {fingerprintMacExecutable} from './runtime/macho-fingerprint.ts';
    import {readFile} from 'node:fs/promises';
    import {createHash} from 'node:crypto';
    import {spawnSync} from 'node:child_process';
    import {join} from 'node:path';
    const source = ${JSON.stringify(staged)}, target = ${JSON.stringify(TARGET)};
    const manifest = ${JSON.stringify(runtimeManifest)};
    const run = ${run.toString()};
    const idle = () => {
      const result = spawnSync('/bin/ps', ['-axww', '-o', 'comm='], {encoding: 'utf8'});
      if (result.error || result.status !== 0) throw new Error('PROCESS_CHECK_FAILED');
      for (const line of result.stdout.split('\\n')) {
        const path = line.normalize('NFC');
        if (path.startsWith(target.normalize('NFC') + '/') || path.includes('vbk-electron-updater') || path.includes('/旅游商家助手.app/Contents/')) throw new Error('QUIT_VENDOR_AND_COMPANION_FIRST');
      }
    };
    installInjectedMacApp({source, target,
      copy: (from, to) => run('/usr/bin/ditto', [from, to]),
      prepare: stage => { ${writable ? '' : `run('/usr/sbin/chown', ['-R', ${JSON.stringify(userInfo().username + ':staff')}, stage]);`} },
      beforeSwap: idle,
      verify: async app => {
        run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
        const hash = createHash('sha256').update(await readFile(join(app, 'Contents/Resources/app.asar'))).digest('hex');
        if (hash !== manifest.asarSha256 || await fingerprintMacExecutable(join(app, 'Contents/MacOS', ${JSON.stringify(support.executable)})) !== manifest.executableSha256) throw new Error('INSTALLED_FINGERPRINT_DRIFT');
      }
    }).then(result => console.log(JSON.stringify({event: 'mac_inject_installed', ...result}))).catch(error => { console.error(error); process.exitCode = 1; });
  `;
  await build({stdin: {contents: entry, resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'cjs', outfile: installer});
  if (writable) run(process.execPath, [installer]);
  else {
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const script = [process.execPath, installer].map(quote).join(' ');
    run('/usr/bin/osascript', ['-e', `do shell script ${JSON.stringify(script)} with prompt "注入旅游商家助手到官方客户端" with administrator privileges`]);
  }
}
