import {cp,mkdir,readFile,writeFile,rename,rm,lstat,open,realpath,chmod} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digestTree} from './lib/mac-pkg-installer.mjs';
const KIND='trip-vendor-companion-install-v1';
const PKG_KIND='trip-vendor-companion-pkg-v1';
const PKG_BACKUPS='/Library/Application Support/TripVendorCompanion/backups';
const FIXED_APP='/Applications/旅游商家桌面版.app';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA=/^[0-9a-f]{64}$/;
const run=(command,args)=>{
  console.log(JSON.stringify({command,args}));
  const result=spawnSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  if(result.stdout)process.stdout.write(result.stdout);
  if(result.stderr)process.stderr.write(result.stderr);
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(`COMMAND_FAILED ${command} ${result.status}`);
  return result.stdout;
};
async function plainPath(path,{directory=false}={}){
  const info=await lstat(path);
  if(info.isSymbolicLink()||(directory?!info.isDirectory():!info.isFile()))throw new Error('UNTRUSTED_UPDATE_PATH');
}
async function bundlePaths(app){
  await plainPath(app,{directory:true});
  for(const relative of ['Contents','Contents/MacOS','Contents/Resources'])await plainPath(join(app,relative),{directory:true});
  await plainPath(join(app,'Contents/Info.plist'));
}
async function jsonFile(path){
  await plainPath(path);
  const handle=await open(path,'r');
  try{
    if((await handle.stat()).size>65536)throw new Error('UNTRUSTED_UPDATE_METADATA');
    const value=JSON.parse(await handle.readFile('utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('UNTRUSTED_UPDATE_METADATA');
    return value;
  }catch{throw new Error('UNTRUSTED_UPDATE_METADATA');}finally{await handle.close();}
}
async function trustedBackups(root,fixture){
  await plainPath(root,{directory:true});
  if(fixture)return;
  for(const path of ['/Library/Application Support',dirname(root),root]){
    const info=await lstat(path);
    if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path||info.uid!==0||(info.mode&0o022))throw new Error('BACKUP_DIRECTORY_MUST_BE_ROOT_OWNED');
    if(path!=='/Library/Application Support'&&(info.mode&0o077))throw new Error('BACKUP_DIRECTORY_MUST_BE_PRIVATE');
  }
}
async function syncDirectory(path){const file=await open(path,'r');try{await file.sync();}finally{await file.close();}}
async function atomicJSON(path,value){
  const temp=path+'.'+randomUUID()+'.tmp';let file;
  try{file=await open(temp,'wx',0o600);await file.writeFile(JSON.stringify(value,null,2));await file.sync();await file.close();file=undefined;await rename(temp,path);await syncDirectory(dirname(path));}
  finally{await file?.close().catch(()=>{});await rm(temp,{force:true}).catch(()=>{});}
}
function stopped(targetApp,execute){
  const listing=execute('/bin/ps',['-axww','-o','pid=,comm=']);
  for(const line of listing.split('\n')){
    if(!line.trim())continue;
    const match=/^\s*(\d+)\s+(.*)$/.exec(line);
    if(!match)throw new Error('PROCESS_INSPECTION_INVALID');
    if(Number(match[1])===process.pid)continue;
    const executable=match[2].normalize('NFC');
    if(executable.startsWith(targetApp.normalize('NFC')+'/')||executable.includes('vbk-electron-updater')||executable.includes('/旅游商家助手.app/Contents/'))throw new Error('QUIT_VENDOR_APP_BEFORE_UPDATE');
  }
}
const executableName=value=>typeof value==='string'&&/^[^/\\\u0000-\u001f]{1,255}$/.test(value)&&value!=='.'&&value!=='..';
/** Update only the embedded helper of a verified existing integration. Never imports vendor browser data. */
export async function updateMacosCompanion({targetApp=FIXED_APP,companionApp,backupRoot,execute=run,allowNonMac=false}={}){
  if(process.platform!=='darwin'&&!allowNonMac)throw new Error('MACOS_REQUIRED');
  targetApp=resolve(targetApp);
  // The explicit programmatic test seam is not exposed by the CLI.
  if(targetApp!==FIXED_APP&&!allowNonMac)throw new Error('FIXED_VENDOR_INSTALL_LOCATION_REQUIRED');
  if(typeof companionApp!=='string')throw new Error('COMPANION_APP_REQUIRED');
  companionApp=resolve(companionApp);
  if(!targetApp.endsWith('.app')||!companionApp.endsWith('.app'))throw new Error('APP_BUNDLE_REQUIRED');
  if(companionApp===targetApp||companionApp.startsWith(targetApp+'/')||targetApp.startsWith(companionApp+'/'))throw new Error('HELPER_MUST_BE_SEPARATE_APP');
  await bundlePaths(targetApp);await bundlePaths(companionApp);
  const resources=join(targetApp,'Contents/Resources/companion');await plainPath(resources,{directory:true});
  const marker=await jsonFile(join(resources,'install.json'));
  const pkg=marker.kind===PKG_KIND;
  if((!pkg&&marker.kind!==KIND)||!UUID.test(marker.transactionId)||Object.keys(marker).sort().join(',')!==(pkg?'kind,payloadSha256,transactionId':'kind,transactionId')||(pkg&&!SHA.test(marker.payloadSha256)))throw new Error('UNKNOWN_INSTALL_MARKER');
  backupRoot=resolve(backupRoot||(pkg?PKG_BACKUPS:join(dirname(targetApp),'.trip_vendor_im_companion-backups')));
  if(backupRoot===targetApp||backupRoot.startsWith(targetApp+'/')||backupRoot===companionApp||backupRoot.startsWith(companionApp+'/'))throw new Error('BACKUP_MUST_BE_OUTSIDE_APP');
  if(pkg&&!allowNonMac&&backupRoot!==PKG_BACKUPS)throw new Error('FIXED_BACKUP_PATH_REQUIRED');
  if(pkg)await trustedBackups(backupRoot,allowNonMac);else await plainPath(backupRoot,{directory:true});
  if((await lstat(dirname(targetApp))).dev!==(await lstat(backupRoot)).dev)throw new Error('BACKUP_MUST_BE_ON_SAME_VOLUME');
  const lock=join(backupRoot,'.install-lock');
  try{await mkdir(lock,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw new Error('INSTALL_ALREADY_RUNNING');throw error;}
  try{
  await atomicJSON(join(lock,'owner.json'),{pid:process.pid,startedAt:execute('/bin/ps',['-p',String(process.pid),'-o','lstart=']).trim()});
  const pending=join(backupRoot,'pending.json');
  if(pkg&&await lstat(pending).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw new Error('PENDING_INSTALL_REQUIRES_RECOVERY');
  const oldPath=join(backupRoot,marker.transactionId+'.json'),previous=await jsonFile(oldPath);
  if(previous.kind!==marker.kind||previous.id!==marker.transactionId||previous.state!=='installed'||previous.targetApp!==targetApp
    ||(!pkg&&(previous.transactionPath!==oldPath||previous.backupApp!==join(backupRoot,previous.id+'.app')||previous.stageApp!==join(dirname(targetApp),'.trip-vendor-stage-'+previous.id+'.app')||!SHA.test(previous.companionSha256)))
    ||(pkg&&(previous.payloadSha256!==marker.payloadSha256))
    ||!SHA.test(previous.installedSha256)||!SHA.test(previous.originalSha256))throw new Error('UNTRUSTED_INSTALL_TRANSACTION');
  if(pkg){const backup=join(backupRoot,previous.id+'.app');await plainPath(backup,{directory:true});if(await digestTree(backup)!==previous.originalSha256)throw new Error('BACKUP_DRIFT');}
  const targetMode=(await lstat(targetApp)).mode&0o777;
  const originalSha256=await digestTree(targetApp);
  if(originalSha256!==previous.installedSha256)throw new Error('INSTALLED_APP_DRIFT');
  stopped(targetApp,execute);
  const launcher=await jsonFile(join(resources,'launcher.json'));
  if(!executableName(launcher.vendorExecutable)||!executableName(launcher.companionExecutable))throw new Error('INVALID_LAUNCHER_CONFIGURATION');
  await plainPath(join(targetApp,'Contents/MacOS',launcher.vendorExecutable));
  await plainPath(join(resources,'旅游商家助手.app'),{directory:true});
  const helperExecutable=execute('/usr/bin/plutil',['-extract','CFBundleExecutable','raw','-o','-',join(companionApp,'Contents/Info.plist')]).trim();
  if(!executableName(helperExecutable)||helperExecutable!==launcher.companionExecutable)throw new Error('COMPANION_EXECUTABLE_CHANGED');
  await plainPath(join(companionApp,'Contents/MacOS',helperExecutable));
  const companionSha256=await digestTree(companionApp),id=randomUUID(),transactionPath=join(backupRoot,id+'.json');
  const backupApp=join(backupRoot,id+'.app'),stage=pkg?join(backupRoot,id+'.stage.app'):join(dirname(targetApp),'.trip-vendor-stage-'+id+'.app');
  const payloadSha256=pkg?createHash('sha256').update(JSON.stringify({previousPayloadSha256:marker.payloadSha256,companionSha256})).digest('hex'):undefined;
  let transaction={kind:marker.kind,id,targetApp,backupApp,transactionPath,stageApp:stage,originalSha256,companionSha256,...(pkg?{payloadSha256}:{}),state:'preparing'};
  // Reserve the stage name, so copy cannot merge into an existing or redirected tree.
  await mkdir(stage,{mode:0o700});
  let backedUp=false,installed=false,journalCreated=false;
  try{
    await writeFile(transactionPath,JSON.stringify(transaction,null,2),{mode:0o600,flag:'wx'});journalCreated=true;
    if(pkg)await atomicJSON(pending,transaction);
    await cp(targetApp,stage,{recursive:true,dereference:false,verbatimSymlinks:true});
    // The private reservation directory must regain the source bundle's public access mode.
    // cp() preserves the mode of a destination directory that already exists.
    await chmod(stage,targetMode);
    if(await digestTree(stage)!==originalSha256)throw new Error('SOURCE_COPY_DRIFT');
    const stageResources=join(stage,'Contents/Resources/companion');
    await rm(join(stageResources,'旅游商家助手.app'),{recursive:true});
    await cp(companionApp,join(stageResources,'旅游商家助手.app'),{recursive:true,dereference:false,verbatimSymlinks:true});
    if(await digestTree(companionApp)!==companionSha256||await digestTree(join(stageResources,'旅游商家助手.app'))!==companionSha256)throw new Error('HELPER_CHANGED_DURING_UPDATE');
    await writeFile(join(stageResources,'install.json'),JSON.stringify({kind:marker.kind,transactionId:id,...(pkg?{payloadSha256}:{})}));
    execute('/usr/bin/codesign',['--force','--deep','--sign','-',stage]);
    execute('/usr/bin/codesign',['--verify','--deep','--strict',stage]);
    if(await digestTree(targetApp)!==originalSha256)throw new Error('SOURCE_APP_CHANGED_DURING_UPDATE');
    transaction={...transaction,installedSha256:await digestTree(stage),state:'prepared'};
    await atomicJSON(transactionPath,transaction);
    if(pkg)await atomicJSON(pending,transaction);
    // Repeat both guards immediately before swapping the bundle.
    await plainPath(targetApp,{directory:true});await plainPath(backupRoot,{directory:true});
    if(await digestTree(targetApp)!==originalSha256)throw new Error('SOURCE_APP_CHANGED_DURING_UPDATE');
    stopped(targetApp,execute);
    await rename(targetApp,backupApp);backedUp=true;
    await rename(stage,targetApp);installed=true;
    await syncDirectory(dirname(targetApp));await syncDirectory(backupRoot);
    transaction.state='installed';if(pkg)await atomicJSON(pending,transaction);await atomicJSON(transactionPath,transaction);if(pkg)await rm(pending);
    return transaction;
  }catch(error){
    if(backedUp){
      // Restore the complete pre-update bundle even if the second rename or journal write fails.
      try{if(installed)await rename(targetApp,stage);await rename(backupApp,targetApp);backedUp=false;await syncDirectory(dirname(targetApp));await syncDirectory(backupRoot);}
      catch{throw new Error('UPDATE_RESTORE_FAILED_BACKUP_RETAINED');}
    }
    await rm(stage,{recursive:true,force:true});
    transaction.state='failed';
    if(journalCreated)await atomicJSON(transactionPath,transaction).catch(()=>{});
    if(pkg)await rm(pending,{force:true});
    throw error;
  }
  }finally{await rm(lock,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2),options={};
    for(let index=0;index<args.length;index++){
      if(!['--target-app','--companion-app','--backup-root'].includes(args[index])||!args[index+1]||args[index+1].startsWith('--'))throw new Error('EXPECTED_NAMED_ARGUMENT_VALUE');
      const key=args[index].slice(2);if(options[key])throw new Error('DUPLICATE_ARGUMENT');options[key]=args[++index];
    }
    console.log(JSON.stringify(await updateMacosCompanion({targetApp:options['target-app'],companionApp:options['companion-app']||'release/mac-arm64/旅游商家助手.app',backupRoot:options['backup-root']}),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
