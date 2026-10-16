import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink,readlink,realpath,chmod,stat} from 'node:fs/promises';
import {rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
// @ts-expect-error Directly executable Node script.
import {installMacosCompanion,rollbackMacosCompanion,digestTree} from '../scripts/install-macos-companion.mjs';
// @ts-expect-error Directly executable Node script.
import {updateMacosCompanion} from '../scripts/update-macos-companion.mjs';
// @ts-expect-error Directly executable Node script.
import {rollbackMacPkg} from '../scripts/lib/mac-pkg-installer.mjs';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),'trip-update-')));roots.push(root);
  const targetApp=join(root,'vendor.app'),companionApp=join(root,'helper.app'),backupRoot=join(root,'backups');
  for(const app of [targetApp,companionApp]){
    await mkdir(join(app,'Contents/MacOS'),{recursive:true});await mkdir(join(app,'Contents/Resources'),{recursive:true});
    await writeFile(join(app,'Contents/Info.plist'),app===targetApp?'Vendor':'Helper');
    await writeFile(join(app,'Contents/MacOS',app===targetApp?'Vendor':'Helper'),app===targetApp?'VENDOR EXECUTABLE':'OLD HELPER');
    await writeFile(join(app,'Contents/Resources/app.asar'),app===targetApp?'VENDOR ASAR':'OLD HELPER ASAR');
  }
  await symlink('app.asar',join(targetApp,'Contents/Resources/relative-link'));
  const calls:{command:string;args:string[]}[]=[];
  const execute=(command:string,args:string[])=>{
    calls.push({command,args});
    if(command==='/bin/ps')return '';
    if(command==='/usr/bin/plutil'&&args[0]==='-extract')return args.at(-1)!.includes('helper.app')?'Helper':'Vendor';
    return '';
  };
  const options={targetApp,companionApp,backupRoot,execute,allowNonMac:true};
  const initial=await installMacosCompanion({...options,packagingOnly:true});
  await writeFile(join(companionApp,'Contents/MacOS/Helper'),'NEW HELPER');
  await writeFile(join(companionApp,'Contents/Resources/app.asar'),'NEW HELPER ASAR');
  calls.length=0;
  return{...options,root,calls,initial};
}
const markerPath=(target:string)=>join(target,'Contents/Resources/companion/install.json');
describe('existing macOS companion update',()=>{
  it('updates only the helper, preserves vendor bytes and symlinks, and can roll back to the complete previous integration',async()=>{
    const f=await fixture(),before=await digestTree(f.targetApp),launcher=await readFile(join(f.targetApp,'Contents/Resources/companion/launcher.json'));
    await writeFile(join(f.targetApp,'Contents/Resources/companion/旅游商家助手.app/Contents/Resources/obsolete'),'old-only');
    // Account for this fixture-only file in its original install journal.
    const prior=JSON.parse(await readFile(f.initial.transactionPath,'utf8'));prior.installedSha256=await digestTree(f.targetApp);await writeFile(f.initial.transactionPath,JSON.stringify(prior));
    const original=await digestTree(f.targetApp),result=await updateMacosCompanion(f);
    expect(result.kind).toBe('trip-vendor-companion-install-v1');expect(result.state).toBe('installed');expect(result.originalSha256).toBe(original);expect(result.id).not.toBe(f.initial.id);
    expect(await digestTree(result.backupApp)).toBe(original);expect(await digestTree(f.targetApp)).toBe(result.installedSha256);
    const helper=join(f.targetApp,'Contents/Resources/companion/旅游商家助手.app');
    expect(await digestTree(helper)).toBe(await digestTree(f.companionApp));expect(await readFile(join(helper,'Contents/MacOS/Helper'),'utf8')).toBe('NEW HELPER');
    expect(await readFile(join(f.targetApp,'Contents/Resources/app.asar'),'utf8')).toBe('VENDOR ASAR');
    expect(await readFile(join(f.targetApp,'Contents/MacOS/Vendor'),'utf8')).toBe('VENDOR EXECUTABLE');
    expect(await readlink(join(f.targetApp,'Contents/Resources/relative-link'))).toBe('app.asar');
    expect(await readFile(join(f.targetApp,'Contents/Resources/companion/launcher.json'))).toEqual(launcher);
    expect(JSON.parse(await readFile(markerPath(f.targetApp),'utf8')).transactionId).toBe(result.id);
    expect(f.calls.filter(call=>call.command==='/usr/bin/codesign').map(call=>call.args)).toEqual([['--force','--deep','--sign','-',result.stageApp],['--verify','--deep','--strict',result.stageApp]]);
    await rollbackMacosCompanion({transactionPath:result.transactionPath,execute:f.execute});expect(await digestTree(f.targetApp)).toBe(original);
    expect(JSON.parse(await readFile(markerPath(f.targetApp),'utf8')).transactionId).toBe(f.initial.id);expect(before).not.toBe(original);
  });
  it('restores source bundle directory permissions after reserving a private staging directory',async()=>{
    const f=await fixture();await chmod(f.targetApp,0o755);await chmod(f.companionApp,0o755);
    // updateMacosCompanion reserves stage at 0700 before copying into it.
    const result=await updateMacosCompanion(f);
    expect((await stat(f.targetApp)).mode&0o777).toBe(0o755);
    expect((await stat(result.backupApp)).mode&0o777).toBe(0o755);
    expect((await stat(join(f.targetApp,'Contents/Resources/companion/旅游商家助手.app'))).mode&0o777).toBe(0o755);
  });
  it('refuses a live vendor or helper, including a process appearing during staging',async()=>{
    const f=await fixture(),before=await digestTree(f.targetApp);
    for(const relative of ['Contents/MacOS/Vendor','Contents/Resources/companion/旅游商家助手.app/Contents/MacOS/Helper']){
      await expect(updateMacosCompanion({...f,execute:(command:string,args:string[])=>command==='/bin/ps'?`999999 ${join(f.targetApp,relative)}`:f.execute(command,args)})).rejects.toThrow('QUIT_VENDOR_APP_BEFORE_UPDATE');
    }
    let checks=0;
    await expect(updateMacosCompanion({...f,execute:(command:string,args:string[])=>command==='/bin/ps'&&args.includes('-axww')?(++checks===2?`999999 ${join(f.targetApp,'Contents/MacOS/Vendor')}`:''):f.execute(command,args)})).rejects.toThrow('QUIT_VENDOR_APP_BEFORE_UPDATE');
    expect(checks).toBe(2);expect(f.calls.some(call=>call.command==='/usr/bin/codesign'&&call.args.includes('--verify'))).toBe(true);
    expect(await digestTree(f.targetApp)).toBe(before);expect((await readdir(f.root)).some(name=>name.startsWith('.trip-vendor-stage-'))).toBe(false);
  });
  it('rejects standalone helpers, external updaters, decomposed bundle paths and malformed process output while allowing its own executor',async()=>{
    const f=await fixture(),before=await digestTree(f.targetApp);
    const livePaths=[
      '/Users/fixture/Library/Caches/vbk-electron-updater/pending/Updater',
      '/Users/fixture/Downloads/旅游商家助手.app/Contents/MacOS/旅游商家助手',
      join(f.targetApp,'Contents/MacOS/Vendor').normalize('NFD'),
    ];
    for(const executable of livePaths){
      await expect(updateMacosCompanion({...f,execute:(command:string,args:string[])=>command==='/bin/ps'&&args.includes('-axww')?`999999 ${executable}`:f.execute(command,args)})).rejects.toThrow('QUIT_VENDOR_APP_BEFORE_UPDATE');
    }
    await expect(updateMacosCompanion({...f,execute:(command:string,args:string[])=>command==='/bin/ps'&&args.includes('-axww')?'unparseable process output':f.execute(command,args)})).rejects.toThrow('PROCESS_INSPECTION_INVALID');
    expect(await digestTree(f.targetApp)).toBe(before);
    const result=await updateMacosCompanion({...f,execute:(command:string,args:string[])=>command==='/bin/ps'&&args.includes('-axww')?`${process.pid} /private/tmp/Payload/旅游商家助手.app/Contents/MacOS/旅游商家助手`:f.execute(command,args)});
    expect(result.state).toBe('installed');
  });
  it('rejects drift, unknown markers, redirected transaction paths and changed executable names',async()=>{
    const f=await fixture(),marker=await readFile(markerPath(f.targetApp));
    await writeFile(markerPath(f.targetApp),JSON.stringify({kind:'unknown',transactionId:f.initial.id}));await expect(updateMacosCompanion(f)).rejects.toThrow('UNKNOWN_INSTALL_MARKER');await writeFile(markerPath(f.targetApp),marker);
    const previous=await readFile(f.initial.transactionPath,'utf8'),transaction=JSON.parse(previous);transaction.backupApp=join(f.root,'unrelated.app');await writeFile(f.initial.transactionPath,JSON.stringify(transaction));
    await expect(updateMacosCompanion(f)).rejects.toThrow('UNTRUSTED_INSTALL_TRANSACTION');await writeFile(f.initial.transactionPath,previous);
    await expect(updateMacosCompanion({...f,execute:(command:string,args:string[])=>command==='/usr/bin/plutil'?'DifferentHelper':f.execute(command,args)})).rejects.toThrow('COMPANION_EXECUTABLE_CHANGED');
    await writeFile(join(f.targetApp,'Contents/Resources/app.asar'),'VENDOR UPDATER DRIFT');await expect(updateMacosCompanion(f)).rejects.toThrow('INSTALLED_APP_DRIFT');
    expect(await readFile(join(f.targetApp,'Contents/Resources/app.asar'),'utf8')).toBe('VENDOR UPDATER DRIFT');
  });
  it('rejects symlink bundles and metadata without following them',async()=>{
    const f=await fixture(),alias=join(f.root,'alias.app');await symlink(f.targetApp,alias);
    await expect(updateMacosCompanion({...f,targetApp:alias})).rejects.toThrow('UNTRUSTED_UPDATE_PATH');
    await rm(alias);await symlink(f.companionApp,alias);await expect(updateMacosCompanion({...f,companionApp:alias})).rejects.toThrow('UNTRUSTED_UPDATE_PATH');
    const realMarker=join(f.root,'real-marker');await writeFile(realMarker,await readFile(markerPath(f.targetApp)));await rm(markerPath(f.targetApp));await symlink(realMarker,markerPath(f.targetApp));
    await expect(updateMacosCompanion(f)).rejects.toThrow('UNTRUSTED_UPDATE_PATH');
  });
  it('preserves the original integration and clears stage after signing failure',async()=>{
    const f=await fixture(),before=await digestTree(f.targetApp);
    await expect(updateMacosCompanion({...f,execute:(command:string,args:string[])=>{if(command==='/usr/bin/codesign')throw new Error('SIGN_FAILED');return f.execute(command,args);}})).rejects.toThrow('SIGN_FAILED');
    expect(await digestTree(f.targetApp)).toBe(before);expect((await readdir(f.root)).some(name=>name.startsWith('.trip-vendor-stage-'))).toBe(false);
  });
  it('restores the complete old bundle if the second directory rename fails',async()=>{
    const f=await fixture(),before=await digestTree(f.targetApp);let stage='';let checks=0;
    await expect(updateMacosCompanion({...f,execute:(command:string,args:string[])=>{
      if(command==='/usr/bin/codesign')stage=args.at(-1)!;
      if(command==='/bin/ps'&&args.includes('-axww')&&++checks===2){expect(stage).toContain('.app');rmSync(stage,{recursive:true});}
      return f.execute(command,args);
    }})).rejects.toThrow('ENOENT');
    expect(checks).toBe(2);
    expect(await digestTree(f.targetApp)).toBe(before);expect((await readdir(f.root)).some(name=>name.startsWith('.trip-vendor-stage-'))).toBe(false);
  });
  it('refuses source changes during staging instead of overwriting them',async()=>{
    const f=await fixture();
    await expect(updateMacosCompanion({...f,execute:(command:string,args:string[])=>{
      if(command==='/usr/bin/codesign'&&args.includes('--verify'))execFileSync(process.execPath,['-e',"require('fs').writeFileSync(process.argv[1],'concurrent vendor change')",join(f.targetApp,'Contents/Resources/app.asar')]);
      return f.execute(command,args);
    }})).rejects.toThrow('SOURCE_APP_CHANGED_DURING_UPDATE');
    expect(await readFile(join(f.targetApp,'Contents/Resources/app.asar'),'utf8')).toBe('concurrent vendor change');
  });
  it('enforces the real fixed path in the CLI and without the test seam',async()=>{
    const f=await fixture();await expect(updateMacosCompanion({...f,allowNonMac:false})).rejects.toThrow(process.platform==='darwin'?'FIXED_VENDOR_INSTALL_LOCATION_REQUIRED':'MACOS_REQUIRED');
    let output='';try{execFileSync(process.execPath,['scripts/update-macos-companion.mjs','--target-app',f.targetApp,'--companion-app',f.companionApp],{encoding:'utf8',stdio:'pipe'});}catch(error){output=(error as {stderr:string}).stderr;}
    expect(output).toContain(process.platform==='darwin'?'FIXED_VENDOR_INSTALL_LOCATION_REQUIRED':'MACOS_REQUIRED');
  });
});

async function pkgFixture(){
  const f=await fixture(),kind='trip-vendor-companion-pkg-v1',payloadSha256='a'.repeat(64);
  await writeFile(markerPath(f.targetApp),JSON.stringify({kind,transactionId:f.initial.id,payloadSha256}));
  const journal={kind,id:f.initial.id,targetApp:f.targetApp,originalSha256:f.initial.originalSha256,installedSha256:await digestTree(f.targetApp),payloadSha256,state:'installed'};
  await writeFile(f.initial.transactionPath,JSON.stringify(journal));
  return {...f,journal};
}
describe('PKG companion receipt updates',()=>{
  it('retains PKG marker and journal compatibility and rolls back through the system installer API',async()=>{
    const f=await pkgFixture(),original=await digestTree(f.targetApp),result=await updateMacosCompanion(f);
    expect(result.kind).toBe('trip-vendor-companion-pkg-v1');expect(result.payloadSha256).toMatch(/^[a-f0-9]{64}$/);expect(result.payloadSha256).not.toBe(f.journal.payloadSha256);
    expect(result.stageApp).toBe(join(f.backupRoot,result.id+'.stage.app'));
    expect(JSON.parse(await readFile(markerPath(f.targetApp),'utf8'))).toEqual({kind:result.kind,transactionId:result.id,payloadSha256:result.payloadSha256});
    expect(await readdir(f.backupRoot)).not.toContain('pending.json');expect(await readdir(f.backupRoot)).not.toContain('.install-lock');
    const restored=await rollbackMacPkg({...f,fixture:true});expect(restored.state).toBe('rolled-back');expect(await digestTree(f.targetApp)).toBe(original);
    expect(JSON.parse(await readFile(markerPath(f.targetApp),'utf8')).transactionId).toBe(f.initial.id);
  });
  it('rejects tampered PKG original backups, incomplete transactions and concurrent installation',async()=>{
    const f=await pkgFixture();
    await writeFile(join(f.backupRoot,'pending.json'),'{}');await expect(updateMacosCompanion(f)).rejects.toThrow('PENDING_INSTALL_REQUIRES_RECOVERY');await rm(join(f.backupRoot,'pending.json'));
    await mkdir(join(f.backupRoot,'.install-lock'));await expect(updateMacosCompanion(f)).rejects.toThrow('INSTALL_ALREADY_RUNNING');await rm(join(f.backupRoot,'.install-lock'),{recursive:true});
    await writeFile(join(f.initial.backupApp,'Contents/Resources/app.asar'),'tampered');await expect(updateMacosCompanion(f)).rejects.toThrow('BACKUP_DRIFT');
    expect(JSON.parse(await readFile(markerPath(f.targetApp),'utf8')).transactionId).toBe(f.initial.id);
  });
});
