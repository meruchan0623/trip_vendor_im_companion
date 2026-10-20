import {cp,mkdir,readFile,writeFile,rename,rm,readdir,lstat,access} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const launcherSource = String.raw`import Foundation
import Darwin
import AppKit
// The wrapper only supervises the real client and must not own a second Dock icon.
NSApplication.shared.setActivationPolicy(.accessory)
let appURL = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().deletingLastPathComponent()
func fail(_ message: String) -> Never { fputs("TripVendorLauncher: \(message)\n", stderr); exit(1) }
let configURL = appURL.appendingPathComponent("Resources/companion/launcher.json")
guard let data = try? Data(contentsOf: configURL), let config = try? JSONSerialization.jsonObject(with: data) as? [String: String], let executable = config["vendorExecutable"], let companionExecutable = config["companionExecutable"] else { fail("Missing launcher configuration") }
var requestedPort: UInt16? = nil
var requestedAddress = false
var forwardedArguments: [String] = []
for argument in CommandLine.arguments.dropFirst() {
  if argument.hasPrefix("--remote-debugging-port=") {
    let value = String(argument.dropFirst("--remote-debugging-port=".count))
    guard requestedPort == nil, !value.isEmpty, value.allSatisfy({ $0.isASCII && $0.isNumber }), let parsed = UInt16(value), parsed >= 1024, parsed <= 65534 else { fail("Invalid or duplicate debugger port") }
    requestedPort = parsed
  } else if argument.hasPrefix("--remote-debugging-address=") {
    guard !requestedAddress, argument == "--remote-debugging-address=127.0.0.1" else { fail("Debugger address must be loopback") }
    requestedAddress = true
  } else if argument.hasPrefix("--remote-debugging") || argument.hasPrefix("-remote-debugging") {
    fail("Unsupported debugger argument")
  } else { forwardedArguments.append(argument) }
}
let expectedVendorURL = appURL.appendingPathComponent("MacOS/" + executable).standardizedFileURL
if let bundleID = Bundle(url: appURL.deletingLastPathComponent())?.bundleIdentifier {
  for running in NSRunningApplication.runningApplications(withBundleIdentifier: bundleID) {
    if running.processIdentifier != getpid(), running.executableURL?.standardizedFileURL == expectedVendorURL {
      running.activate(options: [.activateAllWindows, .activateIgnoringOtherApps]); exit(0)
    }
  }
}
let fd = socket(AF_INET, SOCK_STREAM, 0)
guard fd >= 0 else { fail("Cannot reserve debugger port") }
var address = sockaddr_in(); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET); address.sin_addr.s_addr = inet_addr("127.0.0.1"); address.sin_port = (requestedPort ?? 0).bigEndian
let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
guard bound == 0 else { close(fd); fail("Cannot bind debugger port") }
var length = socklen_t(MemoryLayout<sockaddr_in>.size)
let inspected = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }
guard inspected == 0 else { close(fd); fail("Cannot inspect debugger port") }
let port = UInt16(bigEndian: address.sin_port); close(fd)
let vendor = Process(); vendor.executableURL = appURL.appendingPathComponent("MacOS/" + executable)
vendor.arguments = forwardedArguments + ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=\(port)"]
var environment = ProcessInfo.processInfo.environment; environment.removeValue(forKey: "ELECTRON_RUN_AS_NODE"); environment.removeValue(forKey: "NODE_OPTIONS"); vendor.environment = environment
let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/trip_vendor_im_companion")
try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
let logURL = logs.appendingPathComponent("launcher.log")
if let size = try? FileManager.default.attributesOfItem(atPath: logURL.path)[.size] as? NSNumber, size.intValue > 2_000_000 { try? FileManager.default.removeItem(at: logURL) }
if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
let log = try? FileHandle(forWritingTo: logURL); _ = try? log?.seekToEnd()
func record(_ message: String) { if let bytes = (Date().description + " " + message + "\n").data(using: .utf8) { try? log?.write(contentsOf: bytes) } }
do { try vendor.run() } catch { fail("Vendor launch failed: \(error)") }
record("vendor-start pid=\(vendor.processIdentifier) port=\(port)")
let helper = Process(); helper.executableURL = appURL.appendingPathComponent("Resources/companion/旅游商家助手.app/Contents/MacOS/" + companionExecutable)
helper.arguments = ["--vendor-owner=\(vendor.processIdentifier)", "--acceptance"]; helper.environment = environment
let helperLogURL = logs.appendingPathComponent("companion.log")
if let size = try? FileManager.default.attributesOfItem(atPath: helperLogURL.path)[.size] as? NSNumber, size.intValue > 2_000_000 { try? FileManager.default.removeItem(at: helperLogURL) }
if !FileManager.default.fileExists(atPath: helperLogURL.path) { FileManager.default.createFile(atPath: helperLogURL.path, contents: nil) }
let helperLog = try? FileHandle(forWritingTo: helperLogURL); _ = try? helperLog?.seekToEnd()
helper.standardOutput = helperLog ?? FileHandle.standardOutput; helper.standardError = helperLog ?? FileHandle.standardError
// An earlier helper may be releasing its singleton lock while this vendor generation starts.
// A live prior helper receives the new owner in its second-instance handler.
var launchedHelpers: [Process] = []
let companionDeadline = Date().addingTimeInterval(30)
var companionStarted = false
var attempt = 0
while Date() < companionDeadline {
  if !vendor.isRunning { break }
  let candidate = attempt == 0 ? helper : Process()
  if attempt != 0 { candidate.executableURL = helper.executableURL; candidate.arguments = helper.arguments; candidate.environment = helper.environment; candidate.standardOutput = helper.standardOutput; candidate.standardError = helper.standardError }
  do { try candidate.run(); launchedHelpers.append(candidate); record("companion-start pid=\(candidate.processIdentifier) attempt=\(attempt + 1)") } catch { record("companion-start-failed") }
  Thread.sleep(forTimeInterval: 0.5)
  if candidate.isRunning { companionStarted = true; break }
  attempt += 1
}
if !companionStarted && vendor.isRunning { record("companion-start-timeout") }
let signalQueue = DispatchQueue(label: "trip-vendor-launcher-signals")
var sources: [DispatchSourceSignal] = []
for number in [SIGTERM, SIGINT, SIGHUP] { signal(number, SIG_IGN); let source = DispatchSource.makeSignalSource(signal: number, queue: signalQueue); source.setEventHandler { if vendor.isRunning { vendor.terminate() } }; source.resume(); sources.append(source) }
vendor.waitUntilExit()
// The helper owns its verified vendor-owner watcher; never kill a helper handed to a newer generation.
record("vendor-exit status=\(vendor.terminationStatus)")
exit(vendor.terminationStatus)
`;

const run=(command,args)=>{
  console.log(JSON.stringify({command,args}));
  const result=spawnSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  if(result.stdout)process.stdout.write(result.stdout);
  if(result.stderr)process.stderr.write(result.stderr);
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(`COMMAND_FAILED ${command} ${result.status}`);
  return result.stdout;
};
const exists=async path=>access(path).then(()=>true,()=>false);
export async function digestTree(root){
  const hash=createHash('sha256');
  async function visit(path,prefix=''){
    for(const name of (await readdir(path)).sort()){
      const file=join(path,name),rel=prefix+name,info=await lstat(file);
      if(info.isSymbolicLink()){const {readlink}=await import('node:fs/promises');hash.update(`L\0${rel}\0${await readlink(file)}\0`);}
      else if(info.isDirectory()){hash.update(`D\0${rel}\0`);await visit(file,rel+'/');}
      else{hash.update(`F\0${rel}\0${info.mode & 0o777}\0`);hash.update(await readFile(file));}
    }
  }
  await visit(root);return hash.digest('hex');
}
const plistGet=(path,key,execute)=>execute('/usr/bin/plutil',['-extract',key,'raw','-o','-',path]).trim();
export async function installMacosCompanion({targetApp,companionApp,preparedApp,backupRoot,execute=run,allowNonMac=false,packagingOnly=false}){
  if(process.platform!=='darwin'&&!allowNonMac)throw new Error('MACOS_REQUIRED');
  targetApp=resolve(targetApp);
  if(targetApp!=='/Applications/旅游商家桌面版.app'&&!packagingOnly)throw new Error('FIXED_VENDOR_INSTALL_LOCATION_REQUIRED_USE_PACKAGING_ONLY_FOR_ARTIFACTS');
  companionApp=resolve(companionApp);backupRoot=resolve(backupRoot||join(dirname(targetApp),'.trip_vendor_im_companion-backups'));
  if(!targetApp.endsWith('.app')||!companionApp.endsWith('.app'))throw new Error('APP_BUNDLE_REQUIRED');
  if(backupRoot===targetApp||backupRoot.startsWith(targetApp+'/'))throw new Error('BACKUP_MUST_BE_OUTSIDE_APP');
  const marker=join(targetApp,'Contents/Resources/companion/install.json');
  if(await exists(marker)){
    const state=JSON.parse(await readFile(marker,'utf8'));
    if(state.kind!=='trip-vendor-companion-install-v1'||!/^[-0-9a-f]{36}$/.test(state.transactionId))throw new Error('UNKNOWN_INSTALL_MARKER');
    const transaction=JSON.parse(await readFile(join(backupRoot,state.transactionId+'.json'),'utf8'));
    if(transaction.targetApp!==targetApp||await digestTree(targetApp)!==transaction.installedSha256)throw new Error('INSTALLED_APP_DRIFT');
    if(await digestTree(companionApp)!==transaction.companionSha256)throw new Error('COMPANION_CHANGED_ROLLBACK_BEFORE_REINSTALL');
    return {...transaction,idempotent:true};
  }
  // Main processes, renderers, and updater processes from this bundle must all be stopped.
  const processes=execute('/bin/ps',['-axww','-o','comm=']);
  if(processes.split('\n').some(line=>line.trim().startsWith(targetApp+'/')))throw new Error('QUIT_VENDOR_APP_BEFORE_INSTALL');
  const id=randomUUID(),transactionPath=join(backupRoot,id+'.json'),backupApp=join(backupRoot,id+'.app'),stage=join(dirname(targetApp),'.trip-vendor-stage-'+id+'.app');
  await mkdir(backupRoot,{recursive:true,mode:0o700});
  const originalSha256=await digestTree(targetApp),companionSha256=await digestTree(companionApp);
  let transaction={kind:'trip-vendor-companion-install-v1',id,targetApp,backupApp,transactionPath,stageApp:stage,originalSha256,companionSha256,state:'preparing'};
  await writeFile(transactionPath,JSON.stringify(transaction,null,2),{mode:0o600});
  try{
    await cp(preparedApp?resolve(preparedApp):targetApp,stage,{recursive:true,dereference:false,verbatimSymlinks:true});
    const contents=join(stage,'Contents'),resources=join(contents,'Resources/companion'),plist=join(contents,'Info.plist');
    const vendorExecutable=plistGet(plist,'CFBundleExecutable',execute),companionExecutable=plistGet(join(companionApp,'Contents/Info.plist'),'CFBundleExecutable',execute);
    if([vendorExecutable,companionExecutable].some(value=>!value||value.includes('/')||value==='TripVendorLauncher'))throw new Error('INVALID_BUNDLE_EXECUTABLE');
    await mkdir(resources,{recursive:true});
    await cp(companionApp,join(resources,'旅游商家助手.app'),{recursive:true,dereference:false,verbatimSymlinks:true});
    await writeFile(join(resources,'launcher.json'),JSON.stringify({vendorExecutable,companionExecutable}));
    await writeFile(join(resources,'install.json'),JSON.stringify({kind:transaction.kind,transactionId:id}));
    const source=join(backupRoot,id+'.swift');await writeFile(source,launcherSource);
    try{execute('/usr/bin/xcrun',['swiftc','-O','-target','arm64-apple-macos11','-o',join(contents,'MacOS/TripVendorLauncher'),source]);}finally{await rm(source,{force:true});}
    execute('/usr/bin/plutil',['-replace','CFBundleExecutable','-string','TripVendorLauncher',plist]);
    execute('/usr/bin/codesign',['--force','--deep','--sign','-',stage]);
    execute('/usr/bin/codesign',['--verify','--deep','--strict',stage]);
    if(await digestTree(targetApp)!==originalSha256)throw new Error('SOURCE_APP_CHANGED_DURING_INSTALL');
    transaction={...transaction,installedSha256:await digestTree(stage),state:'prepared'};
    await writeFile(transactionPath,JSON.stringify(transaction,null,2),{mode:0o600});
    await rename(targetApp,backupApp);
    try{await rename(stage,targetApp);}catch(error){await rename(backupApp,targetApp);throw error;}
    transaction.state='installed';await writeFile(transactionPath,JSON.stringify(transaction,null,2),{mode:0o600});return transaction;
  }catch(error){await rm(stage,{recursive:true,force:true});throw error;}
}
export async function rollbackMacosCompanion({transactionPath,execute=run}){
  const transaction=JSON.parse(await readFile(resolve(transactionPath),'utf8'));
  if(transaction.kind!=='trip-vendor-companion-install-v1'||!transaction.targetApp?.endsWith('.app')||!transaction.backupApp?.endsWith('.app'))throw new Error('INVALID_TRANSACTION');
  if(transaction.state==='rolled-back')return transaction;
  if(execute('/bin/ps',['-axww','-o','comm=']).split('\n').some(line=>line.trim().startsWith(transaction.targetApp+'/')))throw new Error('QUIT_VENDOR_APP_BEFORE_ROLLBACK');
  // Recover power loss before/after either directory rename, or after restoration but before journal update.
  if(!await exists(transaction.backupApp)){
    if(await exists(transaction.targetApp)&&await digestTree(transaction.targetApp)===transaction.originalSha256){
      transaction.state='rolled-back';await writeFile(resolve(transactionPath),JSON.stringify(transaction,null,2),{mode:0o600});return transaction;
    }
    throw new Error('BACKUP_MISSING');
  }
  if(await digestTree(transaction.backupApp)!==transaction.originalSha256)throw new Error('BACKUP_DRIFT');
  if(!await exists(transaction.targetApp)){
    await rename(transaction.backupApp,transaction.targetApp);
    transaction.state='rolled-back';await writeFile(resolve(transactionPath),JSON.stringify(transaction,null,2),{mode:0o600});return transaction;
  }
  if(await digestTree(transaction.targetApp)!==transaction.installedSha256)throw new Error('INSTALLED_APP_DRIFT');
  const removed=transaction.targetApp+'.companion-removed-'+transaction.id;
  await rename(transaction.targetApp,removed);
  try{await rename(transaction.backupApp,transaction.targetApp);}catch(error){await rename(removed,transaction.targetApp);throw error;}
  transaction.state='rolled-back';await writeFile(resolve(transactionPath),JSON.stringify(transaction,null,2),{mode:0o600});await rm(removed,{recursive:true,force:true});return transaction;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  throw new Error('LEGACY_DIRECT_INSTALL_DISABLED: 请使用一次性 macOS 注入安装器。');
}
