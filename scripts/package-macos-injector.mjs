#!/usr/bin/env node
// Build only: never installs, launches or modifies an installed client.
// First build the payload with inject-macos-official.mjs, then run this script.
import {mkdir, readFile, writeFile, rm, mkdtemp} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {OFFICIAL_REQUIREMENT} from './lib/mac-pkg-installer.mjs';
import {patchVendorAsar, sha256} from './lib/mac-pkg-asar.mjs';
import {fingerprintMacExecutable} from './lib/mac-pkg-macho.mjs';
import {verifyPackedMacHelper} from './lib/mac-helper-package.mjs';
import {injectorTreeDigest} from './lib/mac-installer-package.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('APPLE_SILICON_BUILD_HOST_REQUIRED');
const options = {official: 'work/mac-arm64/official-apple.dmg', payload: 'work/mac-inject/旅游商家桌面版.app', output: 'release', version: '0.6.0'};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const key = args[i].replace(/^--/, '');
  if (!['official', 'payload', 'output', 'version'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('USAGE: package-macos-injector.mjs [--official <.dmg|.app>] [--payload <built .app>] [--output <directory>] [--version <semver>]');
  options[key] = args[++i];
}
if (!/^\d+\.\d+\.\d+$/.test(options.version)) throw new Error('INVALID_INSTALLER_VERSION');
const work = resolve('work/mac-installer'), output = resolve(options.output), source = resolve(options.official), payload = resolve(options.payload);
// Keep all build output away from installed applications, including custom paths.
const forbidden = path => /^\/(?:Applications|System|Library)(?:\/|$)/.test(path) || /^\/Users\/[^/]+\/Applications(?:\/|$)/.test(path);
if ([work, output].some(forbidden)) throw new Error('BUILD_OUTPUT_MUST_NOT_BE_AN_INSTALLED_APPLICATION_DIRECTORY');
function run(command, commandArgs) {
  console.log(JSON.stringify({command, args: commandArgs}));
  const result = spawnSync(command, commandArgs, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error; if (result.status !== 0) throw new Error(`COMMAND_FAILED ${command} ${result.status}`);
  return result.stdout.trim();
}
const plist = (app, key) => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(app, 'Contents/Info.plist')]);
await mkdir(work, {recursive: true}); await mkdir(output, {recursive: true});
let mount;
try {
  let official = source;
  if (source.endsWith('.dmg')) {
    mount = await mkdtemp(join(work, 'official-'));
    run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, source]);
    official = join(mount, '旅游商家桌面版.app');
  } else if (!source.endsWith('.app')) throw new Error('OFFICIAL_DMG_OR_APP_REQUIRED');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--test-requirement', OFFICIAL_REQUIREMENT, official]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', payload]);
  const bundleId = plist(official, 'CFBundleIdentifier'), vendorVersion = plist(official, 'CFBundleShortVersionString'), vendorExecutable = plist(official, 'CFBundleExecutable');
  if (bundleId !== 'com.ctrip.vbooking' || plist(payload, 'CFBundleIdentifier') !== bundleId || plist(payload, 'CFBundleShortVersionString') !== vendorVersion || plist(payload, 'CFBundleExecutable') !== 'TripVendorLauncher') throw new Error('PAYLOAD_AND_OFFICIAL_IDENTITY_MISMATCH');
  const runtimeManifest = JSON.parse(await readFile(resolve('work/mac-inject/runtime-manifest.json'), 'utf8'));
  const originalAsar = await readFile(join(official, 'Contents/Resources/app.asar'));
  const patched = patchVendorAsar(originalAsar, await readFile('scripts/lib/macos-vendor-bootstrap.cjs'));
  if (patched.asarSha256 !== runtimeManifest.asarSha256 || sha256(await readFile(join(payload, 'Contents/Resources/app.asar'))) !== patched.asarSha256 || await fingerprintMacExecutable(join(official, 'Contents/MacOS', vendorExecutable)) !== runtimeManifest.executableSha256 || await fingerprintMacExecutable(join(payload, 'Contents/MacOS', vendorExecutable)) !== runtimeManifest.executableSha256) throw new Error('PREBUILT_PAYLOAD_STALE_OR_DIFFERENT_OFFICIAL_BUILD: rebuild with inject-macos-official.mjs');
  console.log(JSON.stringify({event: 'mac_injector_helper_verified', ...await verifyPackedMacHelper(join(payload, 'Contents/Resources/companion/旅游商家助手.app'))}));
  const app = join(work, '旅游商家助手安装器.app'), contents = join(app, 'Contents'), resources = join(contents, 'Resources'), binary = join(contents, 'MacOS/TripVendorInstaller');
  await rm(app, {recursive: true, force: true}); await mkdir(resources, {recursive: true}); await mkdir(join(contents, 'MacOS'));
  run('/usr/bin/ditto', [payload, join(resources, 'payload.app')]);
  const manifest = {kind: 'trip-vendor-macos-injector-v1', version: options.version, architecture: 'arm64', bundleId, vendorVersion, officialSha256: await injectorTreeDigest(official), payloadSha256: await injectorTreeDigest(join(resources, 'payload.app'))};
  const manifestText = JSON.stringify(manifest, null, 2) + '\n'; await writeFile(join(resources, 'manifest.json'), manifestText);
  const config = join(work, 'InstallerConfiguration.swift');
  await writeFile(config, `enum InstallerConfiguration { static let manifestSha256 = ${JSON.stringify(sha256(manifestText))}; static let version = ${JSON.stringify(options.version)}; static let vendorVersion = ${JSON.stringify(vendorVersion)} }\n`);
  run('/usr/bin/xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', 'arm64-apple-macos12', '-runtime-compatibility-version', 'none', '-framework', 'AppKit', '-framework', 'CryptoKit', 'native/macos-installer/Engine.swift', 'native/macos-installer/Main.swift', config, '-o', binary]);
  await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>tech.tsim.travel-merchant-injector</string><key>CFBundleName</key><string>旅游商家助手安装器</string><key>CFBundleExecutable</key><string>TripVendorInstaller</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>${options.version}</string><key>CFBundleShortVersionString</key><string>${options.version}</string><key>LSMinimumSystemVersion</key><string>12.0</string><key>LSArchitecturePriority</key><array><string>arm64</string></array><key>NSHighResolutionCapable</key><true/></dict></plist>\n`);
  // Do not --deep re-sign the payload: its complete tree is pinned in the manifest.
  run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  if (await injectorTreeDigest(join(resources, 'payload.app')) !== manifest.payloadSha256) throw new Error('SIGNING_CHANGED_PAYLOAD');
  const zip = join(output, `旅游商家助手-${options.version}-macOS一次性注入安装器-arm64.zip`);
  await rm(zip, {force: true}); run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
  const digest = sha256(await readFile(zip)); await writeFile(zip + '.sha256', digest + '  ' + zip.split('/').at(-1) + '\n');
  await writeFile(join(work, 'build-report.json'), JSON.stringify({app, zip, sha256: digest, manifest, signing: 'ad-hoc', notarized: false}, null, 2) + '\n');
  console.log(JSON.stringify({event: 'mac_injector_built', app, zip, sha256: digest, manifest}));
} finally { if (mount) { run('/usr/bin/hdiutil', ['detach', mount]); await rm(mount, {recursive: true, force: true}); } }
