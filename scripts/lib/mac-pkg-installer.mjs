import {access, cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {join, dirname, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {patchVendorAsar, sha256} from './mac-pkg-asar.mjs';
import {fingerprintMacExecutable} from './mac-pkg-macho.mjs';

export const TARGET_APP = '/Applications/旅游商家桌面版.app';
export const BACKUP_ROOT = '/Library/Application Support/TripVendorCompanion/backups';
export const INSTALL_KIND = 'trip-vendor-companion-pkg-v1';
export const OFFICIAL_REQUIREMENT = '=anchor apple generic and identifier "com.ctrip.vbooking" and certificate leaf[subject.OU] = "RPQ7NNQCK8"';
export function execute(command, args) {
  console.log(JSON.stringify({command, args}));
  const result = spawnSync(command, args, {encoding: 'utf8', env: {...process.env, LC_ALL: 'en_US.UTF-8'}, maxBuffer: 16 * 1024 * 1024});
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('COMMAND_FAILED ' + command + ' ' + result.status);
  return result.stdout;
}
const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const markerPath = app => join(app, 'Contents/Resources/companion/install.json');
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
export async function digestTree(root) {
  const hash = createHash('sha256');
  async function visit(path, prefix = '') {
    for (const name of (await readdir(path)).sort()) {
      const file = join(path, name), relative = prefix + name, info = await lstat(file);
      if (info.isSymbolicLink()) hash.update(`L\0${relative}\0${await readlink(file)}\0`);
      else if (info.isDirectory()) { hash.update(`D\0${relative}\0`); await visit(file, relative + '/'); }
      else if (info.isFile()) { hash.update(`F\0${relative}\0${info.mode & 0o777}\0`); hash.update(await readFile(file)); }
      else throw new Error('UNSUPPORTED_BUNDLE_ENTRY ' + relative);
    }
  }
  await visit(root); return hash.digest('hex');
}
async function syncDirectory(path) { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function atomicJSON(path, value) {
  const temp = path + '.' + randomUUID() + '.tmp';
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  await rename(temp, path);
  await syncDirectory(dirname(path));
}
async function directory(path, {trusted = false} = {}) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('UNSAFE_DIRECTORY ' + path);
  if (trusted && (info.uid !== 0 || (info.mode & 0o022))) throw new Error('BACKUP_DIRECTORY_MUST_BE_ROOT_OWNED ' + path);
}
async function secureBackups(root, fixture) {
  if (fixture) { await mkdir(root, {recursive: true, mode: 0o700}); await directory(root); return; }
  // Validate every existing parent before using recursive creation as root.
  const support = '/Library/Application Support', base = dirname(root);
  await directory(support, {trusted: true});
  for (const path of [base, root]) { await mkdir(path, {mode: 0o700}).catch(error => { if (error.code !== 'EEXIST') throw error; }); await directory(path, {trusted: true}); if ((await lstat(path)).mode & 0o077) throw new Error('BACKUP_DIRECTORY_MUST_BE_PRIVATE ' + path); }
}
function paths(root, targetApp, id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('INVALID_TRANSACTION_ID');
  return {journal: join(root, id + '.json'), backup: join(root, id + '.app'), stage: join(root, id + '.stage.app'), removed: join(root, id + '.removed.app')};
}
function context(options) {
  const {fixture = false, execute: run = execute} = options;
  if (!fixture && (process.platform !== 'darwin' || process.arch !== 'arm64')) throw new Error('APPLE_SILICON_MAC_REQUIRED');
  const targetApp = resolve(options.targetApp || TARGET_APP), backupRoot = resolve(options.backupRoot || BACKUP_ROOT);
  if (!fixture && (targetApp !== TARGET_APP || backupRoot !== BACKUP_ROOT)) throw new Error('FIXED_INSTALL_PATH_REQUIRED');
  return {...options, targetApp, backupRoot, run, fixture};
}
function idle(c) {
  const listing = c.run('/bin/ps', ['-axww', '-o', 'pid=,comm=']);
  for (const line of listing.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(.*)$/.exec(line); if (!match) throw new Error('PROCESS_INSPECTION_INVALID');
    if (Number(match[1]) === process.pid) continue; // The bundled Electron is also this installer's Node executor.
    const p = match[2].normalize('NFC');
    if (p.startsWith(c.targetApp.normalize('NFC') + '/') || p.includes('vbk-electron-updater') || p.includes('/旅游商家助手.app/Contents/')) throw new Error('QUIT_VENDOR_AND_COMPANION_BEFORE_INSTALL: 请先完全退出旅游商家桌面版及旅游商家助手。');
  }
}
async function verifyPayload(c) {
  const {manifest, payload} = c;
  if (manifest.kind !== INSTALL_KIND || manifest.architecture !== 'arm64' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(manifest.version)) throw new Error('INVALID_PAYLOAD_MANIFEST');
  if (await digestTree(join(payload, '旅游商家助手.app')) !== manifest.companionSha256 || sha256(await readFile(join(payload, 'TripVendorLauncher'))) !== manifest.launcherSha256 || sha256(await readFile(join(payload, 'macos-vendor-bootstrap.cjs'))) !== manifest.bootstrapSha256) throw new Error('PAYLOAD_INTEGRITY_MISMATCH');
}
async function verifyOfficial(c, app) {
  await directory(app);
  for (const path of ['Contents', 'Contents/MacOS', 'Contents/Resources']) await directory(join(app, path));
  const plist = join(app, 'Contents/Info.plist'), support = c.manifest.supported;
  for (const relative of ['Contents/Info.plist', 'Contents/MacOS/' + support.executable, 'Contents/Resources/app.asar', ...Object.keys(support.files)]) {
    const path = join(app, relative), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('UNSAFE_VENDOR_FILE ' + relative);
  }
  for (const [key, expected] of Object.entries({CFBundleIdentifier: support.bundleId, CFBundleVersion: support.version, CFBundleShortVersionString: support.version, CFBundleExecutable: support.executable})) {
    if (c.run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]).trim() !== expected) throw new Error('UNSUPPORTED_VENDOR_IDENTITY: 仅支持经过校验的官方旅游商家桌面版 ' + support.version);
  }
  c.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--test-requirement', OFFICIAL_REQUIREMENT, app]);
  const exe = join(app, 'Contents/MacOS', support.executable);
  if (sha256(await readFile(exe)) !== support.executableSha256 || sha256(await readFile(join(app, 'Contents/Resources/app.asar'))) !== support.asarSha256) throw new Error('UNSUPPORTED_VENDOR_BUILD: 官方程序版本或内容不匹配，请安装受支持的官方版本。');
  for (const [relative, expected] of Object.entries(support.files)) if (sha256(await readFile(join(app, relative))) !== expected) throw new Error('UNSUPPORTED_VENDOR_RESOURCE ' + relative);
}
async function installed(c) {
  const marker = await readJSON(markerPath(c.targetApp));
  if (marker.kind !== INSTALL_KIND) throw new Error('EXISTING_INSTALL_REQUIRES_RESTORE: 请先恢复旧版集成程序为官方原版。');
  const p = paths(c.backupRoot, c.targetApp, marker.transactionId), journal = await readJSON(p.journal);
  if (journal.kind !== INSTALL_KIND || journal.id !== marker.transactionId || journal.targetApp !== c.targetApp || journal.state !== 'installed') throw new Error('INVALID_INSTALL_RECEIPT');
  if (await digestTree(c.targetApp) !== journal.installedSha256 || await digestTree(p.backup) !== journal.originalSha256) throw new Error('INSTALLED_APP_OR_BACKUP_DRIFT');
  if (marker.payloadSha256 !== sha256(JSON.stringify(c.manifest))) throw new Error('DIFFERENT_PLUGIN_VERSION_REQUIRES_ROLLBACK');
  return {...journal, idempotent: true};
}
export async function checkMacPkg(options) {
  const c = context(options);
  idle(c); await verifyPayload(c);
  if (!await exists(c.targetApp)) throw new Error('OFFICIAL_APP_NOT_FOUND: 请先将官方「旅游商家桌面版.app」安装到 /Applications（应用程序）后，再安装本插件。');
  if (await exists(markerPath(c.targetApp))) { await directory(c.targetApp); return installed(c); }
  await verifyOfficial(c, c.targetApp); return {state: 'compatible', targetApp: c.targetApp};
}
async function restore(c, journal) {
  if (journal.kind !== INSTALL_KIND || journal.targetApp !== c.targetApp) throw new Error('INVALID_TRANSACTION');
  const p = paths(c.backupRoot, c.targetApp, journal.id);
  if (await exists(p.backup)) {
    if (await digestTree(p.backup) !== journal.originalSha256) throw new Error('BACKUP_DRIFT');
    if (await exists(c.targetApp)) {
      const actual = await digestTree(c.targetApp);
      if (actual !== journal.installedSha256) throw new Error('TARGET_CHANGED_DURING_RECOVERY');
      await rename(c.targetApp, p.removed);
    }
    try { await rename(p.backup, c.targetApp); } catch (error) { if (await exists(p.removed)) await rename(p.removed, c.targetApp); throw error; }
  } else if (!await exists(c.targetApp) || await digestTree(c.targetApp) !== journal.originalSha256) throw new Error('ORIGINAL_APP_UNAVAILABLE');
  await rm(p.stage, {recursive: true, force: true}); await rm(p.removed, {recursive: true, force: true});
  await syncDirectory(dirname(c.targetApp)); await syncDirectory(c.backupRoot);
  journal.state = 'rolled-back'; await atomicJSON(p.journal, journal); return journal;
}
export async function recoverMacPkg(options) {
  const c = context(options), pending = join(c.backupRoot, 'pending.json');
  if (!await exists(pending)) return;
  idle(c);
  const journal = await readJSON(pending);
  if (journal.state === 'installed') {
    const p = paths(c.backupRoot, c.targetApp, journal.id);
    if (await digestTree(c.targetApp) !== journal.installedSha256 || await digestTree(p.backup) !== journal.originalSha256) throw new Error('COMMITTED_INSTALL_DRIFT');
    await atomicJSON(p.journal, journal);
  } else await restore(c, journal);
  await rm(pending);
}
function processBirth(c, pid) { return c.run('/bin/ps', ['-p', String(pid), '-o', 'lstart=']).trim(); }
async function acquireLock(c) {
  const lock = join(c.backupRoot, '.install-lock');
  try { await mkdir(lock, {mode: 0o700}); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await directory(lock, {trusted: !c.fixture});
    const ownerPath = join(lock, 'owner.json');
    if (!await exists(ownerPath)) throw new Error('INSTALL_LOCK_INCOMPLETE: 请确认没有安装器运行后，由管理员移除锁目录再重试：' + lock);
    const owner = await readJSON(ownerPath);
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('INVALID_INSTALL_LOCK');
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; else throw failure; }
    if (alive && (!owner.startedAt || processBirth(c, owner.pid) === owner.startedAt)) throw new Error('INSTALL_ALREADY_RUNNING');
    // A privileged, abandoned lock can be reclaimed after the prior process has exited.
    await rm(lock, {recursive: true}); await mkdir(lock, {mode: 0o700});
  }
  await atomicJSON(join(lock, 'owner.json'), {pid: process.pid, startedAt: processBirth(c, process.pid)}); return lock;
}
export async function preflightMacPkg(options) {
  const c = context(options); idle(c); await verifyPayload(c);
  if (!await exists(c.backupRoot)) return checkMacPkg(c);
  await secureBackups(c.backupRoot, c.fixture);
  const lock = await acquireLock(c);
  try { await recoverMacPkg(c); return await checkMacPkg(c); }
  finally { await rm(lock, {recursive: true, force: true}); }
}
export async function rollbackMacPkg(options) {
  const c = context(options); idle(c); await secureBackups(c.backupRoot, c.fixture);
  const lock = await acquireLock(c);
  try { const marker = await readJSON(markerPath(c.targetApp)), p = paths(c.backupRoot, c.targetApp, marker.transactionId); return await restore(c, await readJSON(p.journal)); } finally { await rm(lock, {recursive: true, force: true}); }
}
export async function installMacPkg(options) {
  const c = context(options); idle(c); await verifyPayload(c); await secureBackups(c.backupRoot, c.fixture);
  const lock = await acquireLock(c);
  if ((await lstat(dirname(c.targetApp))).dev !== (await lstat(c.backupRoot)).dev) { await rm(lock, {recursive: true, force: true}); throw new Error('BACKUP_MUST_BE_ON_SAME_VOLUME'); }
  const pending = join(c.backupRoot, 'pending.json'); let journal;
  try {
    await recoverMacPkg(c);
    const checked = await checkMacPkg(c); if (checked.idempotent) return checked;
    const id = randomUUID(), p = paths(c.backupRoot, c.targetApp, id);
    journal = {kind: INSTALL_KIND, id, targetApp: c.targetApp, originalSha256: await digestTree(c.targetApp), payloadSha256: sha256(JSON.stringify(c.manifest)), state: 'preparing'};
    await atomicJSON(p.journal, journal); await atomicJSON(pending, journal);
    console.log('正在准备助手并保留官方原程序备份。');
    await cp(c.targetApp, p.stage, {recursive: true, verbatimSymlinks: true});
    await verifyOfficial(c, p.stage);
    if (await digestTree(p.stage) !== journal.originalSha256) throw new Error('OFFICIAL_COPY_DRIFT');
    const contents = join(p.stage, 'Contents'), resources = join(contents, 'Resources/companion'), plist = join(contents, 'Info.plist');
    await mkdir(resources);
    await cp(join(c.payload, '旅游商家助手.app'), join(resources, '旅游商家助手.app'), {recursive: true, verbatimSymlinks: true});
    await cp(join(c.payload, 'TripVendorLauncher'), join(contents, 'MacOS/TripVendorLauncher'));
    await writeFile(join(resources, 'launcher.json'), JSON.stringify({vendorExecutable: c.manifest.supported.executable, companionExecutable: c.manifest.companionExecutable}));
    await writeFile(markerPath(p.stage), JSON.stringify({kind: INSTALL_KIND, transactionId: id, payloadSha256: journal.payloadSha256}));
    const archivePath = join(contents, 'Resources/app.asar'), patched = patchVendorAsar(await readFile(archivePath), await readFile(join(c.payload, 'macos-vendor-bootstrap.cjs')));
    if (patched.asarSha256 !== c.manifest.patchedAsarSha256) throw new Error('PATCHED_ASAR_HASH_MISMATCH');
    await writeFile(archivePath, patched.archive);
    c.run('/usr/bin/plutil', ['-replace', 'ElectronAsarIntegrity.Resources/app\\.asar.hash', '-string', patched.headerSha256, plist]);
    c.run('/usr/bin/plutil', ['-replace', 'CFBundleExecutable', '-string', 'TripVendorLauncher', plist]);
    c.run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', p.stage]);
    c.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', p.stage]);
    if (await fingerprintMacExecutable(join(contents, 'MacOS', c.manifest.supported.executable)) !== c.manifest.patchedExecutableSha256) throw new Error('SIGNED_EXECUTABLE_FINGERPRINT_DRIFT');
    idle(c);
    if (await digestTree(c.targetApp) !== journal.originalSha256) throw new Error('SOURCE_APP_CHANGED_DURING_INSTALL');
    journal.installedSha256 = await digestTree(p.stage); journal.state = 'prepared';
    await atomicJSON(p.journal, journal); await atomicJSON(pending, journal);
    await rename(c.targetApp, p.backup); await rename(p.stage, c.targetApp);
    await syncDirectory(dirname(c.targetApp)); await syncDirectory(c.backupRoot);
    journal.state = 'installed'; await atomicJSON(pending, journal); await atomicJSON(p.journal, journal); await rm(pending);
    console.log('助手安装完成。请正常打开「旅游商家桌面版」。官方原程序备份：' + p.backup);
    return journal;
  } catch (error) {
    if (journal && journal.state !== 'installed') {
      try { await restore(c, journal); await rm(pending, {force: true}); }
      catch (restoreError) { throw new Error(error.message + '; RECOVERY_REQUIRED: ' + restoreError.message + '; journal=' + pending); }
    }
    throw error;
  } finally { await rm(lock, {recursive: true, force: true}); }
}
