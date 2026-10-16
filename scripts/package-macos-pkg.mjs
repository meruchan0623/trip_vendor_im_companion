#!/usr/bin/env node
import {build} from 'esbuild';
import {cp, mkdir, readFile, writeFile, access, chmod, rm} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {launcherSource} from './install-macos-companion.mjs';
import {patchVendorAsar, sha256} from './lib/mac-pkg-asar.mjs';
import {digestTree, INSTALL_KIND, OFFICIAL_REQUIREMENT} from './lib/mac-pkg-installer.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('APPLE_SILICON_BUILD_HOST_REQUIRED');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith('--') || !process.argv[i + 1] || !['official-app', 'out'].includes(process.argv[i].slice(2))) throw new Error('EXPECTED --official-app <original official app> [--out <output.pkg>]');
  options[process.argv[i].slice(2)] = process.argv[i + 1];
}
if (!options['official-app']) throw new Error('OFFICIAL_APP_REQUIRED: --official-app <unmodified official 1.2.12.app>');
const source = resolve(options['official-app']), pkg = JSON.parse(await readFile('package.json', 'utf8'));
const out = resolve(options.out || `release/TravelMerchantCompanion-${pkg.version}-mac-arm64.pkg`);
if (!out.endsWith('.pkg')) throw new Error('PKG_OUTPUT_REQUIRED');
if (await access(out).then(() => true, () => false)) throw new Error('OUTPUT_ALREADY_EXISTS');
function run(command, args, env = process.env) {
  console.log(JSON.stringify({command, args}));
  const result = spawnSync(command, args, {stdio: 'inherit', env});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`COMMAND_FAILED ${command} ${result.status}`);
}
function readCommand(command, args) {
  console.log(JSON.stringify({command, args}));
  const result = spawnSync(command, args, {encoding: 'utf8'});
  if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error; if (result.status !== 0) throw new Error('COMMAND_FAILED ' + command);
  return result.stdout.trim();
}
const support = {
  bundleId: 'com.ctrip.vbooking', version: '1.2.12', executable: '旅游商家桌面版',
  executableSha256: '0db3c283d0bb58a1e314b89cd2d4f54089c86cdc1ee0c22ecfe1550ade2ff0c2',
  asarSha256: 'e6e1a4547e3609ac858d8d71f69a982a46d6f04a8a7f4197bf4ba63ed39abb24',
  files: {
    'Contents/Resources/app.asar.unpacked/dist/packageVersion.json': 'PLACEHOLDER',
    'Contents/Resources/app.asar.unpacked/dist/src/pages/imPlus/index.html': 'a91c9fcd232a132a0441c7ed4d785fa39b4cc52d2205afc7db571489336d7b0f',
    'Contents/Resources/app.asar.unpacked/dist/js/imWindow-BnMVlw3I.js': '80f0a342ddc9cced51b20138bb41554e583490714085d0eaeb027aa882877aa7',
    'Contents/Resources/app.asar.unpacked/dist/src/pages/main/index.html': 'e32baaf2caeddf331de3a20eed37cfd259cdc20aeb2b6ab38aed96291494a4fd',
    'Contents/Resources/app.asar.unpacked/dist/js/mainWindow-2v9P5wjR.js': 'c4114938c13e12bc057a8ef0931676f8b0f68cc34db46d7d3c504badd77c81a6',
  },
};
const versionFile = join(source, 'Contents/Resources/app.asar.unpacked/dist/packageVersion.json');
const versions = JSON.parse(await readFile(versionFile, 'utf8'));
if (versions.pkgVersion !== '1.2.12' || versions.aresVersion !== '1.2.15') throw new Error('UNSUPPORTED_VENDOR_PACKAGE_VERSION');
support.files['Contents/Resources/app.asar.unpacked/dist/packageVersion.json'] = sha256(await readFile(versionFile));
for (const [key, value] of Object.entries({CFBundleIdentifier: support.bundleId, CFBundleVersion: support.version, CFBundleShortVersionString: support.version, CFBundleExecutable: support.executable})) if (readCommand('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(source, 'Contents/Info.plist')]) !== value) throw new Error('UNSUPPORTED_OFFICIAL_IDENTITY');
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--test-requirement', OFFICIAL_REQUIREMENT, source]);
const exe = join(source, 'Contents/MacOS', support.executable), archive = await readFile(join(source, 'Contents/Resources/app.asar'));
if (sha256(await readFile(exe)) !== support.executableSha256 || sha256(archive) !== support.asarSha256) throw new Error('UNSUPPORTED_OFFICIAL_HASH');
for (const [relative, expected] of Object.entries(support.files)) if (sha256(await readFile(join(source, relative))) !== expected) throw new Error('UNSUPPORTED_OFFICIAL_RESOURCE ' + relative);
const work = resolve('work/mac-pkg-build');
await rm(work, {recursive: true, force: true}); await mkdir(work, {recursive: true});
const compiledFingerprint = await build({entryPoints: ['runtime/macho-fingerprint.ts'], bundle: true, platform: 'node', format: 'esm', write: false});
const {fingerprintMacExecutable} = await import('data:text/javascript;base64,' + Buffer.from(compiledFingerprint.outputFiles[0].text).toString('base64'));
const bootstrap = await readFile('scripts/lib/macos-vendor-bootstrap.cjs');
const patched = patchVendorAsar(archive, bootstrap), runtimeManifest = {executableSha256: await fingerprintMacExecutable(exe), asarSha256: patched.asarSha256};
const runtimeManifestPath = join(work, 'runtime-manifest.json'); await writeFile(runtimeManifestPath, JSON.stringify(runtimeManifest, null, 2) + '\n');
const env = {...process.env, TMC_RUNTIME_PLATFORM: 'darwin', TMC_MACOS_MANIFEST: runtimeManifestPath};
run('npm', ['run', 'build:native:mac'], env); run('npm', ['run', 'build'], env);
run('npx', ['electron-builder', '--mac', 'dir', '--arm64'], env);
const scripts = join(work, 'scripts'), payload = join(scripts, 'payload'); await mkdir(payload, {recursive: true});
const companion = join(payload, '旅游商家助手.app');
await cp(resolve('release/mac-arm64/旅游商家助手.app'), companion, {recursive: true, verbatimSymlinks: true});
const minimumSystemVersion = readCommand('/usr/bin/plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', '-o', '-', join(companion, 'Contents/Info.plist')]);
if (!/^\d+(?:\.\d+){0,2}$/.test(minimumSystemVersion)) throw new Error('INVALID_HELPER_SYSTEM_VERSION');
const companionExecutable = readCommand('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', join(companion, 'Contents/Info.plist')]);
const launcherSwift = join(work, 'Launcher.swift'); await writeFile(launcherSwift, launcherSource);
run('/usr/bin/xcrun', ['swiftc', '-O', '-target', 'arm64-apple-macos11', '-o', join(payload, 'TripVendorLauncher'), launcherSwift]);
run('/usr/bin/codesign', ['--force', '--sign', '-', join(payload, 'TripVendorLauncher')]);
await writeFile(join(payload, 'macos-vendor-bootstrap.cjs'), bootstrap);
await build({entryPoints: ['scripts/lib/mac-pkg-entry.mjs'], bundle: true, platform: 'node', target: 'node24', format: 'cjs', outfile: join(payload, 'installer.cjs')});
const manifest = {kind: INSTALL_KIND, architecture: 'arm64', version: pkg.version, supported: support, companionExecutable, companionSha256: await digestTree(companion), launcherSha256: sha256(await readFile(join(payload, 'TripVendorLauncher'))), bootstrapSha256: sha256(bootstrap), patchedExecutableSha256: runtimeManifest.executableSha256, patchedAsarSha256: patched.asarSha256};
await writeFile(join(payload, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const helperExecutable = join(companion, 'Contents/MacOS', companionExecutable);
const safeEnv = {...process.env, ELECTRON_RUN_AS_NODE: '1'}; delete safeEnv.NODE_OPTIONS; delete safeEnv.NODE_PATH;
run(helperExecutable, ['-e', 'if (!process.versions.node || process.type !== undefined) process.exit(23); require("node:fs"); console.log(JSON.stringify({installerExecutor:"bundled-electron",node:process.versions.node,arch:process.arch}))'], safeEnv);
const hook = action => `#!/bin/sh\nset -eu\n# Installer resources are temporary; the completed installation is kept in the official app.\ncd "$(/usr/bin/dirname "$0")"\nif [ "\${3:-/}" != "/" ]; then echo '只支持安装到当前启动磁盘。' >&2; exit 1; fi\nexec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/root LANG=en_US.UTF-8 ELECTRON_RUN_AS_NODE=1 ELECTRON_NO_ASAR=1 "./payload/旅游商家助手.app/Contents/MacOS/${companionExecutable}" "./payload/installer.cjs" ${action}\n`;
for (const [name, action] of [['preinstall', 'check'], ['postinstall', 'install']]) { await writeFile(join(scripts, name), hook(action)); await chmod(join(scripts, name), 0o755); }
const component = join(work, 'plugin.pkg');
run('/usr/bin/pkgbuild', ['--nopayload', '--identifier', 'tech.tsim.travel-merchant-companion.injector', '--version', pkg.version, '--scripts', scripts, component]);
const resources = join(work, 'resources'); await mkdir(resources);
const instructions = `旅游商家助手 ${pkg.version} · macOS 一次安装插件（Apple 芯片）\n\n安装前：\n1. 先安装官方旅游商家桌面版 1.2.12 到 /Applications/旅游商家桌面版.app。\n2. 完全退出官方程序与旅游商家助手，然后打开本 PKG。\n3. 安装器校验官方身份及文件指纹；程序缺失、运行中、内容不受支持时会停止，不会替换为其他程序。\n\n安装后：正常打开官方「旅游商家桌面版」，助手随之运行并随客户端退出。以后无需重复运行安装器。\n助手为 Apple 芯片版；官方客户端保持原 Intel 架构，仍可能需要 Rosetta。\n本包不含官方程序；仅支持上述已校验构建。官方更新后，请等待相应适配版本。\n原官方程序备份及事务记录保存在 /Library/Application Support/TripVendorCompanion/backups。\n同一插件重复安装会校验已安装内容并安全完成；旧集成版请先恢复官方原版。\n\n本 PKG 未使用 Developer ID Installer 签名或 Apple 公证，组织分发时需按所在组织的软件安装策略处理。\n`;
await writeFile(join(resources, 'welcome.txt'), instructions);
const distribution = `<?xml version="1.0" encoding="utf-8"?>\n<installer-gui-script minSpecVersion="2">\n<title>旅游商家助手</title><welcome file="welcome.txt" mime-type="text/plain"/>\n<options customize="never" require-scripts="true" hostArchitectures="arm64"/>\n<domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>\n<allowed-os-versions><os-version min="${minimumSystemVersion}"/></allowed-os-versions>\n<choices-outline><line choice="default"/></choices-outline>\n<choice id="default" visible="false" title="安装助手"><pkg-ref id="tech.tsim.travel-merchant-companion.injector"/></choice>\n<pkg-ref id="tech.tsim.travel-merchant-companion.injector" version="${pkg.version}" onConclusion="none">plugin.pkg</pkg-ref>\n</installer-gui-script>\n`;
await writeFile(join(work, 'distribution.xml'), distribution); await mkdir(dirname(out), {recursive: true});
run('/usr/bin/productbuild', ['--distribution', join(work, 'distribution.xml'), '--resources', resources, '--package-path', work, out]);
await writeFile(out + '.sha256', sha256(await readFile(out)) + '  ' + out.slice(out.lastIndexOf('/') + 1) + '\n');
await writeFile(out.replace(/\.pkg$/, '-安装说明.txt'), instructions);
console.log(JSON.stringify({event: 'mac_pkg_complete', pkg: out, officialIncluded: false, target: '/Applications/旅游商家桌面版.app', helperArchitecture: 'arm64', officialArchitecture: 'x86_64', payloadManifest: join(payload, 'manifest.json')}, null, 2));
