import {afterEach, describe, expect, it} from 'vitest';
import {mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink, access, cp, realpath, chmod, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {unsignedMachOHash as runtimeHash} from '../runtime/macho-fingerprint';
// @ts-expect-error Directly executable installer tools deliberately use JavaScript.
import {checkMacPkg, preflightMacPkg, installMacPkg, rollbackMacPkg, recoverMacPkg, digestTree, INSTALL_KIND, OFFICIAL_REQUIREMENT, execute as productionExecute} from '../scripts/lib/mac-pkg-installer.mjs';
// @ts-expect-error Directly executable installer tools deliberately use JavaScript.
import {patchVendorAsar, asarFile, readAsar, sha256} from '../scripts/lib/mac-pkg-asar.mjs';
// @ts-expect-error Directly executable installer tools deliberately use JavaScript.
import {unsignedMachOHash} from '../scripts/lib/mac-pkg-macho.mjs';
const asar = createRequire(import.meta.url)('@electron/asar');
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true}); });
async function temp() { const root = await mkdtemp(join(await realpath(tmpdir()), 'trip-pkg-')); roots.push(root); return root; }
function image() {
  const b = Buffer.alloc(288); b.writeUInt32LE(0xfeedfacf); b.writeUInt32LE(2, 16); b.writeUInt32LE(88, 20);
  b.writeUInt32LE(0x19, 32); b.writeUInt32LE(72, 36); b.write('__LINKEDIT', 40); b.writeBigUInt64LE(160n, 64); b.writeBigUInt64LE(128n, 72); b.writeBigUInt64LE(160n, 80);
  b.writeUInt32LE(0x1d, 104); b.writeUInt32LE(16, 108); b.writeUInt32LE(256, 112); b.writeUInt32LE(32, 116); b.fill(17, 128, 256); b.fill(42, 256); return b;
}
async function archive(root: string) {
  const files = join(root, 'asar-src'); await mkdir(files);
  await writeFile(join(files, 'package.json'), JSON.stringify({name: 'vendor', version: '1.2.12', main: 'main.cjs'}));
  await writeFile(join(files, 'main.cjs'), 'module.exports = "original business bytes";');
  await writeFile(join(files, 'large-file'), Buffer.alloc(5 * 1024 * 1024, 7));
  await asar.createPackage(files, join(root, 'original.asar')); return readFile(join(root, 'original.asar'));
}
async function fixture() {
  const root = await temp(), targetApp = join(root, '旅游商家桌面版.app'), payload = join(root, 'payload'), backupRoot = join(root, 'backups');
  await mkdir(join(targetApp, 'Contents/MacOS'), {recursive: true}); await mkdir(join(targetApp, 'Contents/Resources'), {recursive: true});
  await writeFile(join(targetApp, 'Contents/Info.plist'), 'fixture plist'); await writeFile(join(targetApp, 'Contents/MacOS/Vendor'), image());
  const original = await archive(root); await writeFile(join(targetApp, 'Contents/Resources/app.asar'), original);
  await mkdir(join(payload, '旅游商家助手.app/Contents/MacOS'), {recursive: true}); await writeFile(join(payload, '旅游商家助手.app/Contents/MacOS/Helper'), 'helper');
  await writeFile(join(payload, 'TripVendorLauncher'), 'launcher'); const bootstrap = Buffer.from('module.exports = "fixture bootstrap";');
  await writeFile(join(payload, 'macos-vendor-bootstrap.cjs'), bootstrap);
  const manifest = {kind: INSTALL_KIND, architecture: 'arm64', version: '0.3.2', companionExecutable: 'Helper', companionSha256: await digestTree(join(payload, '旅游商家助手.app')), launcherSha256: sha256(Buffer.from('launcher')), bootstrapSha256: sha256(bootstrap), patchedAsarSha256: patchVendorAsar(original, bootstrap).asarSha256, patchedExecutableSha256: unsignedMachOHash(image()), supported: {bundleId: 'com.ctrip.vbooking', version: '1.2.12', executable: 'Vendor', executableSha256: sha256(image()), asarSha256: sha256(original), files: {}}};
  const calls: {command: string; args: string[]}[] = [];
  const execute = (command: string, args: string[]) => {
    calls.push({command, args});
    if (command === '/usr/bin/plutil' && args[0] === '-extract') return ({CFBundleIdentifier: 'com.ctrip.vbooking', CFBundleVersion: '1.2.12', CFBundleShortVersionString: '1.2.12', CFBundleExecutable: 'Vendor'} as Record<string, string>)[args[1]];
    return '';
  };
  return {root, targetApp, payload, backupRoot, manifest, execute, calls, fixture: true};
}
describe('deterministic minimal ASAR bootstrap', () => {
  it('preserves all original file bytes/header entries and appends only the launcher adapter', async () => {
    const root = await temp(), input = await archive(root), patched = patchVendorAsar(input, Buffer.from('bootstrap'));
    expect(patchVendorAsar(input, Buffer.from('bootstrap')).asarSha256).toBe(patched.asarSha256);
    expect(asarFile(patched.archive, 'main.cjs')).toEqual(asarFile(input, 'main.cjs'));
    expect(sha256(asarFile(patched.archive, 'large-file'))).toBe(sha256(asarFile(input, 'large-file')));
    expect(readAsar(patched.archive).header.files['large-file']).toEqual(readAsar(input).header.files['large-file']);
    expect(JSON.parse(asarFile(patched.archive, 'package.json').toString()).main).toBe('trip-vendor-bootstrap.cjs');
    expect(JSON.parse(asarFile(patched.archive, 'companion-vendor-original-main.json').toString()).main).toBe('main.cjs');
    const path = join(root, 'patched.asar'); await writeFile(path, patched.archive);
    expect(asar.extractFile(path, 'main.cjs')).toEqual(asarFile(input, 'main.cjs'));
    expect(sha256(asar.getRawHeader(path).headerString)).toBe(patched.headerSha256);
    expect(() => patchVendorAsar(patched.archive, Buffer.from('bootstrap'))).toThrow('UNSUPPORTED_VENDOR_MAIN');
  });
  it('shares exactly the runtime signature-independent executable fingerprint', () => { expect(unsignedMachOHash(image())).toBe(runtimeHash(image())); });
});
describe('PKG install safety and transactions', () => {
  it('preserves readable application roots when installing through a private backup directory', async () => {
    const f = await fixture();
    await chmod(f.targetApp, 0o755);
    await chmod(join(f.payload, '旅游商家助手.app'), 0o755);
    const result = await installMacPkg(f);
    for (const path of [f.targetApp, join(f.backupRoot, result.id + '.app'), join(f.targetApp, 'Contents/Resources/companion/旅游商家助手.app')]) {
      expect((await stat(path)).mode & 0o777).toBe(0o755);
    }
    expect((await stat(f.backupRoot)).mode & 0o777).toBe(0o700);
  });
  it('installs, detects identical repeat, and restores exact original bytes', async () => {
    const f = await fixture(), before = await digestTree(f.targetApp), installed = await installMacPkg(f);
    expect(installed.state).toBe('installed'); expect(await digestTree(f.targetApp)).not.toBe(before);
    expect(f.calls.find(c => c.command === '/usr/bin/codesign')?.args).toContain(OFFICIAL_REQUIREMENT);
    expect(f.calls.some(c => c.command.includes('swift') || c.command.includes('npm') || c.command.includes('node'))).toBe(false);
    expect((await installMacPkg(f)).idempotent).toBe(true);
    expect((await rollbackMacPkg(f)).state).toBe('rolled-back'); expect(await digestTree(f.targetApp)).toBe(before);
  });
  it('rejects missing, live, unknown same-name, and previously integrated clients', async () => {
    const f = await fixture(); await expect(checkMacPkg({...f, targetApp: join(f.root, 'missing.app')})).rejects.toThrow('OFFICIAL_APP_NOT_FOUND');
    await expect(checkMacPkg({...f, execute: (command: string, args: string[]) => command === '/bin/ps' ? '999999 ' + f.targetApp + '/Contents/MacOS/Vendor' : f.execute(command, args)})).rejects.toThrow('QUIT_VENDOR');
    await expect(checkMacPkg({...f, execute: (command: string, args: string[]) => command === '/usr/bin/plutil' && args[1] === 'CFBundleIdentifier' ? 'attacker.bundle' : f.execute(command, args)})).rejects.toThrow('UNSUPPORTED_VENDOR_IDENTITY');
    await writeFile(join(f.targetApp, 'Contents/Resources/app.asar'), 'other same-name app'); await expect(checkMacPkg(f)).rejects.toThrow('UNSUPPORTED_VENDOR_BUILD');
    await mkdir(join(f.targetApp, 'Contents/Resources/companion')); await writeFile(join(f.targetApp, 'Contents/Resources/companion/install.json'), JSON.stringify({kind: 'trip-vendor-companion-install-v1'}));
    await expect(checkMacPkg(f)).rejects.toThrow('EXISTING_INSTALL_REQUIRES_RESTORE');
  });
  it('fails before swapping and removes staged data when signing fails', async () => {
    const f = await fixture(), before = await digestTree(f.targetApp);
    await expect(installMacPkg({...f, execute: (command: string, args: string[]) => { if (command === '/usr/bin/codesign' && args[0] === '--force') throw new Error('SIGN_FAILED'); return f.execute(command, args); }})).rejects.toThrow('SIGN_FAILED');
    expect(await digestTree(f.targetApp)).toBe(before); await expect(access(join(f.backupRoot, 'pending.json'))).rejects.toThrow();
  });
  it('restores the original after interruption between directory renames', async () => {
    const f = await fixture(), result = await installMacPkg(f), installed = join(f.root, 'installed.app');
    await rename(f.targetApp, installed); await writeFile(join(f.backupRoot, 'pending.json'), JSON.stringify({...result, state: 'prepared'}));
    await preflightMacPkg(f); expect(await digestTree(f.targetApp)).toBe(result.originalSha256);
  });
  it('refuses payload, installed program, and backup drift', async () => {
    const f = await fixture(), result = await installMacPkg(f);
    await writeFile(join(f.targetApp, 'Contents/MacOS/Vendor'), 'modified'); await expect(installMacPkg(f)).rejects.toThrow('INSTALLED_APP_OR_BACKUP_DRIFT');
    const other = await fixture(); await writeFile(join(other.payload, 'TripVendorLauncher'), 'modified'); await expect(installMacPkg(other)).rejects.toThrow('PAYLOAD_INTEGRITY_MISMATCH');
    expect(result.state).toBe('installed');
  });
  it('rejects symlinked app, mutable resource, or backup root without touching the destination', async () => {
    const f = await fixture(), alias = join(f.root, 'alias.app'); await symlink(f.targetApp, alias); await expect(checkMacPkg({...f, targetApp: alias})).rejects.toThrow('UNSAFE_DIRECTORY');
    const archive = join(f.targetApp, 'Contents/Resources/app.asar'), outside = join(f.root, 'external.asar'); await rename(archive, outside); await symlink(outside, archive);
    await expect(checkMacPkg(f)).rejects.toThrow('UNSAFE_VENDOR_FILE');
    const other = await fixture(), outsideBackups = join(other.root, 'outside'); await mkdir(outsideBackups); await symlink(outsideBackups, other.backupRoot);
    await expect(installMacPkg(other)).rejects.toThrow('UNSAFE_DIRECTORY');
  });
  it('excludes its own executor PID, but refuses other helper processes', async () => {
    const f = await fixture();
    const self = {...f, execute: (command: string, args: string[]) => command === '/bin/ps' ? process.pid + ' ' + join(f.payload, '旅游商家助手.app/Contents/MacOS/Helper') : f.execute(command, args)};
    expect((await checkMacPkg(self)).state).toBe('compatible');
    await expect(checkMacPkg({...self, execute: (command: string, args: string[]) => command === '/bin/ps' ? '999999 ' + join(f.payload, '旅游商家助手.app/Contents/MacOS/Helper') : f.execute(command, args)})).rejects.toThrow('QUIT_VENDOR');
  });
  it('reclaims an abandoned installer lock and completes pending restoration in preflight', async () => {
    const f = await fixture(), installed = await installMacPkg(f);
    await rename(f.targetApp, join(f.root, 'interrupted-installed.app'));
    await writeFile(join(f.backupRoot, 'pending.json'), JSON.stringify({...installed, state: 'prepared'}));
    await mkdir(join(f.backupRoot, '.install-lock')); await writeFile(join(f.backupRoot, '.install-lock/owner.json'), JSON.stringify({pid: 2147483647, startedAt: 'previous boot'}));
    expect((await preflightMacPkg(f)).state).toBe('compatible'); expect(await digestTree(f.targetApp)).toBe(installed.originalSha256);
  });
  it('rejects active concurrent installer locks', async () => {
    const f = await fixture(); await mkdir(join(f.backupRoot, '.install-lock'), {recursive: true}); await writeFile(join(f.backupRoot, '.install-lock/owner.json'), JSON.stringify({pid: process.pid}));
    await expect(installMacPkg(f)).rejects.toThrow('INSTALL_ALREADY_RUNNING');
  });
});

// Opt-in because the original official app and a freshly built payload are local artifacts.
describe.skipIf(process.platform !== 'darwin' || !process.env.TMC_PKG_NATIVE_FIXTURE)('real official app injection and re-signing', () => {
  it('verifies signature, keeps vendor business files and Intel executable, reads back runtime fingerprints, then rolls back', async () => {
    const root = await temp(), targetApp = join(root, '旅游商家桌面版.app'), payload = resolve('work/mac-pkg-build/scripts/payload'), source = process.env.TMC_PKG_NATIVE_FIXTURE!;
    await cp(source, targetApp, {recursive: true, verbatimSymlinks: true});
    const manifest = JSON.parse(await readFile(join(payload, 'manifest.json'), 'utf8'));
    const options = {targetApp, payload, backupRoot: join(root, 'backups'), manifest, fixture: true, execute: (command: string, args: string[]) => command === '/bin/ps' && args[0] === '-axww' ? '' : productionExecute(command, args)};
    const original = await readFile(join(source, 'Contents/Resources/app.asar')), before = await digestTree(targetApp);
    const harness = join(root, 'native-installer-fixture.cjs');
    // Exercise every transaction operation under the exact bundled Electron executor.
    await build({stdin: {contents: `import {readFile} from 'node:fs/promises';import {installMacPkg,rollbackMacPkg,execute} from ${JSON.stringify(resolve('scripts/lib/mac-pkg-installer.mjs'))};process.noAsar=true;(async()=>{const options=${JSON.stringify({targetApp, payload, backupRoot: join(root, 'backups'), manifest, fixture: true})};options.execute=(command,args)=>command==='/bin/ps'&&args[0]==='-axww'?'':execute(command,args);console.log('FIXTURE_RESULT='+JSON.stringify(await (process.argv[2]==='rollback'?rollbackMacPkg:installMacPkg)(options)));})().catch(error=>{console.error(error);process.exitCode=1});`, resolveDir: process.cwd()}, bundle: true, platform: 'node', target: 'node24', format: 'cjs', outfile: harness});
    const bundledExecutor = join(payload, '旅游商家助手.app/Contents/MacOS', manifest.companionExecutable);
    const invoke = (action: string) => { const output = execFileSync(bundledExecutor, [harness, action], {env: {...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1'}, encoding: 'utf8'}); console.log(output); return JSON.parse(output.split('\n').find(line => line.startsWith('FIXTURE_RESULT='))!.slice('FIXTURE_RESULT='.length)); };
    const result = invoke('install'), patched = await readFile(join(targetApp, 'Contents/Resources/app.asar'));
    const originalMain = JSON.parse(asarFile(original, 'package.json').toString()).main;
    expect(asarFile(patched, originalMain)).toEqual(asarFile(original, originalMain));
    expect(sha256(patched)).toBe(manifest.patchedAsarSha256);
    expect(unsignedMachOHash(await readFile(join(targetApp, 'Contents/MacOS/旅游商家桌面版')))).toBe(manifest.patchedExecutableSha256);
    expect(execFileSync('/usr/bin/file', [join(targetApp, 'Contents/MacOS/旅游商家桌面版')], {encoding: 'utf8'})).toContain('x86_64');
    const integrity = execFileSync('/usr/bin/plutil', ['-extract', 'ElectronAsarIntegrity.Resources/app\\.asar.hash', 'raw', '-o', '-', join(targetApp, 'Contents/Info.plist')], {encoding: 'utf8'}).trim();
    expect(integrity).toBe(sha256(asar.getRawHeader(join(targetApp, 'Contents/Resources/app.asar')).headerString));
    const nodeSmoke = execFileSync(join(targetApp, 'Contents/Resources/companion/旅游商家助手.app/Contents/MacOS', manifest.companionExecutable), ['-e', 'process.noAsar=true;const fs=require("node:fs"),vm=require("node:vm"),a=fs.readFileSync(process.argv[1]),h=JSON.parse(a.toString("utf8",16,16+a.readUInt32LE(12))),base=8+a.readUInt32LE(4);function file(n){const e=h.files[n];return a.subarray(base+Number(e.offset),base+Number(e.offset)+e.size).toString("utf8")}const pkg=JSON.parse(file("package.json"));if(pkg.main!=="trip-vendor-bootstrap.cjs")process.exit(2);new vm.Script(file(pkg.main));process.noAsar=false;if(JSON.parse(fs.readFileSync(process.argv[1]+"/package.json","utf8")).main!==pkg.main)process.exit(3);console.log("bundled-executor-asar-bootstrap-verified")', join(targetApp, 'Contents/Resources/app.asar')], {env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, encoding: 'utf8'});
    expect(nodeSmoke).toContain('bundled-executor-asar-bootstrap-verified');
    expect(invoke('install').idempotent).toBe(true); expect(invoke('rollback').state).toBe('rolled-back'); expect(await digestTree(targetApp)).toBe(before);
    expect(result.state).toBe('installed');
  }, 180000);
});
