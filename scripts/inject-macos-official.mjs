#!/usr/bin/env node
// Build an injection payload in work/ only. Installation belongs to the user-operated GUI.
// node scripts/inject-macos-official.mjs [--official <official .dmg|.app>]
import {build} from 'esbuild';
import {mkdir, readFile, rm, writeFile, mkdtemp} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {launcherSource} from './install-macos-companion.mjs';
import {patchVendorAsar, sha256} from './lib/mac-pkg-asar.mjs';
import {OFFICIAL_REQUIREMENT} from './lib/mac-pkg-installer.mjs';
import {verifyPackedMacHelper} from './lib/mac-helper-package.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('APPLE_SILICON_BUILD_HOST_REQUIRED');
const APP_NAME = '旅游商家桌面版.app', HELPER = '旅游商家助手.app';
const args = process.argv.slice(2), options = {official: 'work/mac-arm64/official-apple.dmg'};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--install' || args[i] === '--install-built') throw new Error('DIRECT_INSTALL_DISABLED: 请使用一次性 macOS 注入安装器。');
  else if (args[i] === '--official' && args[i + 1] && !args[i + 1].startsWith('--')) options.official = args[++i];
  else throw new Error('USAGE: inject-macos-official.mjs [--official <official .dmg|.app>]');
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
// Validate the darwin runtime and assistant-only supervisor before building a payload.
for (const suite of ['macos-page-selection', 'macos-owned-session', 'macos-runtime-order', 'macos-native-parity', 'operator-overlay', 'macos-launcher-recovery', 'vendor-window-defaults', 'order-summary']) {
  run(process.execPath, [`tests/run-${suite}.mjs`]);
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
runtimeManifest = {executableSha256: await fingerprintMacExecutable(exe), asarSha256: patched.asarSha256};
await writeFile(manifestPath, JSON.stringify(runtimeManifest, null, 2) + '\n');
const env = {...process.env, TMC_RUNTIME_PLATFORM: 'darwin', TMC_MACOS_MANIFEST: manifestPath};
run('npm', ['run', 'build:native:mac'], env); run('npm', ['run', 'build'], env);
run('npx', ['electron-builder', '--mac', 'dir', '--arm64', '-c.directories.output=work/mac-inject/helper'], env);
const helper = join(work, 'helper/mac-arm64', HELPER), companionExecutable = plist(helper, 'CFBundleExecutable');
console.log(JSON.stringify({event:'mac_helper_package_verified',...await verifyPackedMacHelper(helper)}));

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
