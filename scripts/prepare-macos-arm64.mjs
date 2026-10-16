#!/usr/bin/env node
/** Prepare and audit an untouched vendor candidate. Never modifies /Applications. */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as asar from '@electron/asar';
import { createHash } from 'node:crypto';
import { nativeInventory, sha256 } from './lib/arm64-inventory.mjs';

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith('--') || !process.argv[i + 1]) throw new Error('Expected --candidate <app> --out <directory> [--source <app>]');
  options[process.argv[i].slice(2)] = process.argv[i + 1];
}
const source = resolve(options.source || '/Applications/旅游商家桌面版.app');
const candidate = resolve(options.candidate || source);
const output = resolve(options.out || 'work/mac-arm64/prepared');
if (output === '/Applications' || output.startsWith('/Applications/')) throw new Error('Staging output cannot be inside /Applications');
if (source.startsWith(output + '/') || candidate.startsWith(output + '/')) throw new Error('Input app cannot be inside staging output');
if (existsSync(output)) throw new Error(`Output exists; choose a new staging directory: ${output}`);
mkdirSync(output, { recursive: true });
const stagedApp = join(output, basename(source));
console.log(`Copy vendor candidate: ${candidate} -> ${stagedApp}`);
cpSync(candidate, stagedApp, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
const resources = join(stagedApp, 'Contents/Resources');
const archive = join(resources, 'app.asar');
const extracted = join(output, 'audit-source');
asar.extractAll(archive, extracted);
let migration = null;
if (options.runtime || options['native-root']) {
  if (!options.runtime || !options['native-root']) throw new Error('Migration requires both --runtime <electron zip> and --native-root <node_modules>');
  const runtimeHash = await sha256(resolve(options.runtime));
  if (runtimeHash !== 'a687b199fcb9890f43af90ac8a4d19dc7b15522394de89e42abd5f5c6b735804') throw new Error('Electron 27.3.11 ARM runtime SHA256 differs from official SHASUMS256');
  const runtime = join(output, 'runtime');
  mkdirSync(runtime);
  execFileSync('/usr/bin/ditto', ['-x', '-k', resolve(options.runtime), runtime], { stdio: 'inherit' });
  const runtimeContents = join(runtime, 'Electron.app/Contents');
  const runtimeVersion = readFileSync(join(runtimeContents, 'Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist'));
  if (!runtimeVersion.length) throw new Error('Missing Electron framework metadata');
  const originalExecutable = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleExecutable', join(stagedApp, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  // Preserve the vendor's app identity and resources, replacing executable code with ARM Electron.
  rmSync(join(stagedApp, 'Contents/Frameworks'), { recursive: true });
  cpSync(join(runtimeContents, 'Frameworks'), join(stagedApp, 'Contents/Frameworks'), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  cpSync(join(runtimeContents, 'MacOS/Electron'), join(stagedApp, 'Contents/MacOS', originalExecutable));
  for (const suffix of ['', ' (GPU)', ' (Plugin)', ' (Renderer)']) {
    const genericName = `Electron Helper${suffix}`;
    const vendorName = `${originalExecutable} Helper${suffix}`;
    const generic = join(stagedApp, 'Contents/Frameworks', genericName + '.app');
    const branded = join(stagedApp, 'Contents/Frameworks', vendorName + '.app');
    renameSync(generic, branded);
    renameSync(join(branded, 'Contents/MacOS', genericName), join(branded, 'Contents/MacOS', vendorName));
    cpSync(join(candidate, 'Contents/Frameworks', vendorName + '.app/Contents/Info.plist'), join(branded, 'Contents/Info.plist'));
    rmSync(join(branded, 'Contents/_CodeSignature'), { recursive: true, force: true });
  }

  rmSync(join(stagedApp, 'Contents/_CodeSignature'), { recursive: true, force: true });
  const nativeRoot = resolve(options['native-root']);
  const publicPackages = ['better-sqlite3', 'sqlite3', 'heapdump', 'node-screenshots-darwin-arm64', '@img/sharp-darwin-arm64', '@img/sharp-libvips-darwin-arm64', '@napi-rs/nice-darwin-arm64', '@napi-rs/snappy-darwin-arm64'];
  for (const name of publicPackages) {
    const destination = join(extracted, 'node_modules', name);
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(nativeRoot, name), destination, { recursive: true, verbatimSymlinks: true });
  }
  // Add a small startup adapter without rewriting vendor code.
  const packageFile = join(extracted, 'package.json');
  const vendorPackage = JSON.parse(readFileSync(packageFile, 'utf8'));
  if (vendorPackage.main === 'trip-vendor-bootstrap.cjs') throw new Error('Candidate is already companion-patched');
  cpSync(resolve('scripts/lib/macos-vendor-bootstrap.cjs'), join(extracted, 'trip-vendor-bootstrap.cjs'));
  writeFileSync(join(extracted, 'companion-vendor-original-main.json'), JSON.stringify({ main: vendorPackage.main }) + '\n');
  vendorPackage.main = 'trip-vendor-bootstrap.cjs';
  writeFileSync(packageFile, JSON.stringify(vendorPackage, null, 2) + '\n');
  // Public architecture dispatch now selects ARM siblings; the original app is the provenance backup.
  for (const name of ['node-screenshots-darwin-x64', '@img/sharp-darwin-x64', '@img/sharp-libvips-darwin-x64', '@napi-rs/nice-darwin-x64', '@napi-rs/snappy-darwin-x64']) {
    rmSync(join(extracted, 'node_modules', name), { recursive: true, force: true });
    rmSync(join(archive + '.unpacked', 'node_modules', name), { recursive: true, force: true });
  }
  rmSync(archive);
  // Keep vendor resources outside the ASAR header (drizzle migrations, OCR wasm, UI assets).
  // createPackageWithOptions overwrites only the native entries it emits.
  await asar.createPackageWithOptions(extracted, archive, { unpack: '**/*.{node,dylib}', unpackDir: '{dist,node_modules/onnxruntime-web/dist}' });
  const integrity = createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex');
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${integrity}`, join(stagedApp, 'Contents/Info.plist')], { stdio: 'inherit' });
  migration = { vendorBootstrap: 'trip-vendor-bootstrap.cjs', runtimeZip: resolve(options.runtime), runtimeSha256: await sha256(resolve(options.runtime)), publicPackages, privateNativeReplacement: false };
  rmSync(runtime, { recursive: true });
}

const executableName = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleExecutable', join(stagedApp, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
const executable = join(stagedApp, 'Contents/MacOS', executableName);
const sourceArchive = join(source, 'Contents/Resources/app.asar');
const native = [
  ...(await nativeInventory(join(stagedApp, 'Contents'))).map(item => ({ ...item, location: 'bundle' })),
  ...(await nativeInventory(extracted)).map(item => ({ ...item, location: 'asar' })),
];
const blockers = native.filter(item => !item.architectures.includes('arm64'));
const report = {
  schemaVersion: 1, migration, createdAt: new Date().toISOString(), source, candidate, stagedApp,
  version: JSON.parse(readFileSync(join(extracted, 'package.json'), 'utf8')).version,
  sourceArchiveSha256: await sha256(sourceArchive), archiveSha256: await sha256(archive), executableSha256: await sha256(executable),
  readyForArm64: blockers.length === 0,
  runtimeArm64: native.filter(item => item.location === 'bundle' && !item.path.startsWith('Resources/')).every(item => item.architectures.includes('arm64')),
  limitations: blockers.length ? ['Residual vendor Intel-only native packages and standalone tools are preserved. Their presence requires separate runtime-path verification; this report does not claim full independence from Rosetta.'] : [],
  native, blockers,
};
writeFileSync(join(output, 'arm64-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ stagedApp, readyForArm64: report.readyForArm64, nativeFiles: native.length, blockers: blockers.map(({ location, path, architectures }) => ({ location, path, architectures })), executableSha256: report.executableSha256, archiveSha256: report.archiveSha256 }, null, 2));
rmSync(extracted, { recursive: true });
if (blockers.length) process.exitCode = 2;
