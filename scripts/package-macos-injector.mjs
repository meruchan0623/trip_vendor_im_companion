#!/usr/bin/env node
// Build only: never installs, launches or modifies an installed client.
// node scripts/package-macos-injector.mjs [--official <.dmg|.app>]... [--output <directory>] [--version <semver>]
// The installer adapts whichever compatible official client (1.2.11+) it finds; every --official
// source is dry-run injected into a temporary directory and recorded as a tested version.
import {mkdir, readFile, writeFile, rm, mkdtemp} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {launcherSource} from './install-macos-companion.mjs';
import {readAsar, asarFile, sha256} from './lib/mac-pkg-asar.mjs';
import {fingerprintMacExecutable} from './lib/mac-pkg-macho.mjs';
import {verifyPackedMacHelper} from './lib/mac-helper-package.mjs';
import {injectorTreeDigest} from './lib/mac-installer-package.mjs';
import {validateMacRuntimeManifest, macRendererName, assertMacRendererContract} from '../runtime/macos-page-compatibility.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('APPLE_SILICON_BUILD_HOST_REQUIRED');
const options = {official: [], output: 'release', version: '0.7.4'};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const key = args[i].replace(/^--/, '');
  if (!['official', 'output', 'version'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('USAGE: package-macos-injector.mjs [--official <.dmg|.app>]... [--output <directory>] [--version <semver>]');
  if (key === 'official') options.official.push(args[++i]); else options[key] = args[++i];
}
if (!options.official.length) options.official.push('work/mac-arm64/official-apple.dmg');
if (!/^\d+\.\d+\.\d+$/.test(options.version)) throw new Error('INVALID_INSTALLER_VERSION');
const work = resolve('work/mac-installer'), output = resolve(options.output);
// Keep all build output away from installed applications, including custom paths.
const forbidden = path => /^\/(?:Applications|System|Library)(?:\/|$)/.test(path) || /^\/Users\/[^/]+\/Applications(?:\/|$)/.test(path);
if ([work, output].some(forbidden)) throw new Error('BUILD_OUTPUT_MUST_NOT_BE_AN_INSTALLED_APPLICATION_DIRECTORY');
function run(command, commandArgs, env = process.env) {
  console.log(JSON.stringify({command, args: commandArgs}));
  const result = spawnSync(command, commandArgs, {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env});
  if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error; if (result.status !== 0) throw new Error(`COMMAND_FAILED ${command} ${result.status}`);
  return result.stdout.trim();
}
const plist = (app, key) => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(app, 'Contents/Info.plist')]);
const APP = '旅游商家助手安装器.app', HELPER = '旅游商家助手.app';
// The packaged components need the same platform-specific acceptance gates.
for (const suite of ['outbound-wait-controller', 'macos-page-selection', 'macos-owned-session', 'macos-runtime-order', 'macos-native-parity', 'operator-overlay', 'macos-launcher-recovery', 'translation-http-telemetry', 'translation-service-telemetry', 'runtime-diagnostics', 'telemetry-log-viewer', 'transport-recovery', 'native-recovery', 'vendor-window-defaults', 'macos-window-defaults', 'order-summary', 'order-observation', 'page-performance', 'macos-injector-transaction']) {
  run(process.execPath, [`tests/run-${suite}.mjs`]);
}
await mkdir(work, {recursive: true}); await mkdir(output, {recursive: true});

// 1. Helper with the dynamic macOS runtime: it trusts only the manifest the installer writes on-device.
const helperOutput = join(work, 'helper'), env = {...process.env, TMC_RUNTIME_PLATFORM: 'darwin', TMC_MACOS_DYNAMIC: '1', TMC_INJECTOR_VERSION: options.version};
delete env.TMC_MACOS_MANIFEST;
await rm(helperOutput, {recursive: true, force: true});
run('npm', ['run', 'build:native:mac'], env); run('npm', ['run', 'build'], env);
run('npx', ['electron-builder', '--mac', 'dir', '--arm64', `-c.directories.output=${helperOutput}`], env);
const helper = join(helperOutput, 'mac-arm64', HELPER);
console.log(JSON.stringify({event: 'mac_helper_package_verified', ...await verifyPackedMacHelper(helper)}));
// An applied define replaces the identifier; other builds keep their typeof guards.
const helperMain = asarFile(await readFile(join(helper, 'Contents/Resources/app.asar')), 'dist-electron/main.cjs');
if (['__TMC_MACOS_DYNAMIC__', '__TMC_INJECTOR_VERSION__'].some(name => helperMain.includes(name))) throw new Error('HELPER_NOT_BUILT_FOR_DYNAMIC_RUNTIME_AND_INJECTOR_VERSION');

// 2. Components pinned by the manifest: launcher, helper and vendor entry bootstrap.
const app = join(work, APP), contents = join(app, 'Contents'), resources = join(contents, 'Resources'), components = join(resources, 'components'), binary = join(contents, 'MacOS/TripVendorInstaller');
await rm(app, {recursive: true, force: true}); await mkdir(components, {recursive: true}); await mkdir(join(contents, 'MacOS'));
const launcherSwift = join(work, 'Launcher.swift'); await writeFile(launcherSwift, launcherSource);
run('/usr/bin/xcrun', ['swiftc', '-O', '-target', 'arm64-apple-macos11', '-o', join(components, 'TripVendorLauncher'), launcherSwift]);
run('/usr/bin/ditto', ['--noqtn', helper, join(components, HELPER)]);
await writeFile(join(components, 'trip-vendor-bootstrap.cjs'), await readFile('scripts/lib/macos-vendor-bootstrap.cjs'));
const componentsSha256 = await injectorTreeDigest(components);

function compile(manifest) {
  const manifestText = JSON.stringify(manifest, null, 2) + '\n', config = join(work, 'InstallerConfiguration.swift');
  const tested = manifest.testedVendorVersions.length ? `已验证：${manifest.testedVendorVersions.join(' / ')}` : '未附带验证版本';
  return writeFile(join(resources, 'manifest.json'), manifestText)
    .then(() => writeFile(config, `enum InstallerConfiguration { static let manifestSha256 = ${JSON.stringify(sha256(manifestText))}; static let version = ${JSON.stringify(options.version)}; static let vendorSupport = ${JSON.stringify(`${manifest.minimumVendorVersion} 及以上（${tested}）`)} }\n`))
    .then(() => run('/usr/bin/xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', 'arm64-apple-macos12', '-runtime-compatibility-version', 'none', '-framework', 'AppKit', '-framework', 'CryptoKit', 'native/macos-installer/Engine.swift', 'native/macos-installer/Injection.swift', 'native/macos-installer/Main.swift', config, '-o', binary]));
}
const manifest = {kind: 'trip-vendor-macos-injector-v2', version: options.version, architecture: 'arm64', bundleId: 'com.ctrip.vbooking', minimumVendorVersion: '1.2.11', testedVendorVersions: [], componentsSha256};
await compile(manifest);

// 3. Acceptance: the real installer binary adapts each official client in a temporary directory,
// and the Node/TypeScript implementations must agree with what it wrote.
const scratch = await mkdtemp(join(tmpdir(), 'tsim-injector-acceptance-')), accepted = [];
try {
  for (const [index, source] of options.official.map(path => resolve(path)).entries()) {
    let mount;
    try {
      let official = source;
      if (source.endsWith('.dmg')) {
        mount = join(scratch, `dmg-${index}`); await mkdir(mount);
        run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, source]);
        official = join(mount, '旅游商家桌面版.app');
      } else if (!source.endsWith('.app')) throw new Error('OFFICIAL_DMG_OR_APP_REQUIRED');
      const report = JSON.parse(run(binary, ['--dry-run', '--source', official, '--output', join(scratch, `stage-${index}`)]));
      const stage = report.stage, companion = join(stage, 'Contents/Resources/companion'), vendorExecutable = join(stage, 'Contents/MacOS/旅游商家桌面版');
      const runtime = validateMacRuntimeManifest(JSON.parse(await readFile(join(companion, 'vendor-runtime-manifest.json'), 'utf8')));
      const archive = await readFile(join(stage, 'Contents/Resources/app.asar')), {headerString} = readAsar(archive);
      const pkg = JSON.parse(asarFile(archive, 'package.json').toString('utf8')), originalPkg = JSON.parse(asarFile(await readFile(join(official, 'Contents/Resources/app.asar')), 'package.json').toString('utf8'));
      const dist = join(stage, 'Contents/Resources/app.asar.unpacked/dist'), page = runtime.bundledPage;
      const pageFiles = [['src/pages/imPlus/index.html', page.htmlSha256], ['src/pages/main/index.html', page.navigationHtmlSha256], ['js/' + page.rendererName, page.rendererSha256], ['js/' + page.navigationRendererName, page.navigationRendererSha256]];
      const checks = {
        executable: runtime.executableSha256 === await fingerprintMacExecutable(vendorExecutable) && runtime.executableSha256 === await fingerprintMacExecutable(join(official, 'Contents/MacOS/旅游商家桌面版')),
        archive: runtime.asarSha256 === sha256(archive) && plist(stage, 'ElectronAsarIntegrity.Resources/app\\.asar.hash') === sha256(headerString),
        entry: pkg.main === 'trip-vendor-bootstrap.cjs' && pkg.version === originalPkg.version && JSON.parse(asarFile(archive, 'companion-vendor-original-main.json').toString('utf8')).main === originalPkg.main && asarFile(archive, 'trip-vendor-bootstrap.cjs').equals(await readFile('scripts/lib/macos-vendor-bootstrap.cjs')),
        launcher: plist(stage, 'CFBundleExecutable') === 'TripVendorLauncher' && JSON.parse(await readFile(join(companion, 'launcher.json'), 'utf8')).companionExecutable === plist(join(companion, HELPER), 'CFBundleExecutable'),
        pages: macRendererName(await readFile(join(dist, 'src/pages/imPlus/index.html'), 'utf8'), 'imWindow') === page.rendererName && macRendererName(await readFile(join(dist, 'src/pages/main/index.html'), 'utf8'), 'mainWindow') === page.navigationRendererName,
        hashes: (await Promise.all(pageFiles.map(async ([relative, expected]) => sha256(await readFile(join(dist, relative))) === expected))).every(Boolean),
        version: runtime.executableVersion === plist(official, 'CFBundleVersion') && report.version === plist(official, 'CFBundleShortVersionString'),
      };
      assertMacRendererContract(await readFile(join(dist, 'js', page.rendererName), 'utf8'), await readFile(join(dist, 'js', page.navigationRendererName), 'utf8'));
      // This suite's real-page probe requires a concrete official sample. Run
      // after dry-run adaptation so packaging never silently skips that probe.
      run(process.execPath, ['tests/run-macos-dynamic-runtime.mjs'], {...process.env, TMC_OFFICIAL_APP: stage});
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', stage]);
      if (Object.values(checks).some(value => !value)) throw new Error('DRY_RUN_ACCEPTANCE_FAILED ' + JSON.stringify({source, checks}));
      accepted.push({source, version: report.version, build: report.build, electron: report.electron, chromiumMajor: report.chromiumMajor, aresVersion: page.aresVersion, stageSha256: report.digest});
      console.log(JSON.stringify({event: 'mac_injector_dry_run_accepted', ...accepted.at(-1), checks}));
    } finally { if (mount) run('/usr/bin/hdiutil', ['detach', mount]); }
  }
} finally { await rm(scratch, {recursive: true, force: true}); }

// 4. Final installer records the accepted versions; the components stay byte-identical.
manifest.testedVendorVersions = [...new Set(accepted.map(item => item.version))].sort();
await compile(manifest);
await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>tech.tsim.travel-merchant-injector</string><key>CFBundleName</key><string>旅游商家助手安装器</string><key>CFBundleExecutable</key><string>TripVendorInstaller</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>${options.version}</string><key>CFBundleShortVersionString</key><string>${options.version}</string><key>LSMinimumSystemVersion</key><string>12.0</string><key>LSArchitecturePriority</key><array><string>arm64</string></array><key>NSHighResolutionCapable</key><true/></dict></plist>\n`);
// Do not --deep re-sign the components: their complete tree is pinned in the manifest.
run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
if (await injectorTreeDigest(components) !== componentsSha256) throw new Error('SIGNING_CHANGED_COMPONENTS');
const verified = JSON.parse(run(binary, ['--verify-package']));
if (verified.componentsSha256 !== componentsSha256 || verified.testedVendorVersions.join() !== manifest.testedVendorVersions.join()) throw new Error('PACKAGE_SELF_CHECK_FAILED');
const zip = join(output, `旅游商家助手-${options.version}-macOS一次性注入安装器-arm64.zip`);
await rm(zip, {force: true}); run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
const digest = sha256(await readFile(zip)); await writeFile(zip + '.sha256', digest + '  ' + zip.split('/').at(-1) + '\n');
await writeFile(join(work, 'build-report.json'), JSON.stringify({app, zip, sha256: digest, manifest, accepted, signing: 'ad-hoc', notarized: false}, null, 2) + '\n');
console.log(JSON.stringify({event: 'mac_injector_built', app, zip, sha256: digest, manifest}));
