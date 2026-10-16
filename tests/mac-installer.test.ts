import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,rename,symlink,readlink,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
const {patchRelaunch}=createRequire(import.meta.url)('../scripts/lib/macos-vendor-bootstrap.cjs');
// @ts-expect-error Installer intentionally runs directly in Node without a compile step.
import {installMacosCompanion,rollbackMacosCompanion,digestTree,launcherSource} from '../scripts/install-macos-companion.mjs';
const roots:string[]=[];
const nativeFixtureRoots=new Set<string>();
async function waitForFixtureProcesses(root:string){
  const deadline=Date.now()+5000;
  for(;;){
    const processes=execFileSync('/bin/ps',['-axww','-o','args='],{encoding:'utf8'});
    if(!processes.split('\n').some(line=>line.includes(root+'/Fixture.app/')))return;
    if(Date.now()>=deadline)throw new Error('FAKE_HELPER_DID_NOT_EXIT: '+root);
    await new Promise(resolve=>setTimeout(resolve,50));
  }
}
afterEach(async()=>{
  for(const root of roots.splice(0)){
    if(nativeFixtureRoots.has(root)){await waitForFixtureProcesses(root);nativeFixtureRoots.delete(root);}
    await rm(root,{recursive:true,force:true});
  }
});
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'trip-vendor-install-'));roots.push(root);
  const targetApp=join(root,'vendor.app'),companionApp=join(root,'helper.app'),preparedApp=join(root,'arm.app');
  for(const app of [targetApp,companionApp,preparedApp]){
    await mkdir(join(app,'Contents/MacOS'),{recursive:true});await mkdir(join(app,'Contents/Resources'),{recursive:true});
    await writeFile(join(app,'Contents/Info.plist'),app===companionApp?'Helper':'Vendor');
    await writeFile(join(app,'Contents/MacOS',app===companionApp?'Helper':'Vendor'),app===preparedApp?'ARM64':'ORIGINAL');
    await writeFile(join(app,'Contents/Resources/app.asar'),'VENDOR ASAR BYTES');
    await symlink('app.asar',join(app,'Contents/Resources/relative-link'));
  }
  const calls:{command:string;args:string[]}[]=[];
  const execute=(command:string,args:string[])=>{
    calls.push({command,args});
    if(command==='/bin/ps')return '';
    if(command==='/usr/bin/plutil'&&args[0]==='-extract')return args.at(-1)!.includes('helper.app')?'Helper':'Vendor';
    // Model the generated launcher in the filesystem; native compilation is checked separately on macOS.
    if(command==='/usr/bin/xcrun')return '';
    return '';
  };
  return{targetApp,companionApp,preparedApp,execute,calls,allowNonMac:true,packagingOnly:true};
}
describe('self-contained macOS install transaction',()=>{
  it('refuses installing a runnable vendor package outside its supported fixed path without explicit packaging mode',async()=>{
    const f=await fixture();await expect(installMacosCompanion({...f,packagingOnly:false})).rejects.toThrow('FIXED_VENDOR_INSTALL_LOCATION_REQUIRED');
  });
  it('installs prepared ARM bundle, embeds helper and preserves ASAR, then restores original bytes',async()=>{
    const f=await fixture(),before=await digestTree(f.targetApp),result=await installMacosCompanion(f);
    expect(result.state).toBe('installed');
    expect(await readlink(join(f.targetApp,'Contents/Resources/relative-link'))).toBe('app.asar');
    const marker=JSON.parse(await readFile(join(f.targetApp,'Contents/Resources/companion/install.json'),'utf8'));
    expect(marker.transactionPath).toBeUndefined();expect(marker.transactionId).toBe(result.id);
    expect(await readFile(join(f.targetApp,'Contents/MacOS/Vendor'),'utf8')).toBe('ARM64');
    expect(await readFile(join(f.targetApp,'Contents/Resources/app.asar'),'utf8')).toBe('VENDOR ASAR BYTES');
    expect(JSON.parse(await readFile(join(f.targetApp,'Contents/Resources/companion/launcher.json'),'utf8'))).toEqual({vendorExecutable:'Vendor',companionExecutable:'Helper'});
    expect(f.calls.some(call=>call.command==='/usr/bin/codesign'&&call.args.includes('--verify'))).toBe(true);
    const repeat=await installMacosCompanion(f);expect(repeat.idempotent).toBe(true);expect(repeat.id).toBe(result.id);
    await rollbackMacosCompanion({transactionPath:result.transactionPath,execute:f.execute});expect(await digestTree(f.targetApp)).toBe(before);
    expect((await rollbackMacosCompanion({transactionPath:result.transactionPath,execute:f.execute})).state).toBe('rolled-back');
  });
  it('fails before swapping the app if native build/signing fails',async()=>{
    const f=await fixture(),before=await digestTree(f.targetApp);
    await expect(installMacosCompanion({...f,execute:(command:string,args:string[])=>{if(command==='/usr/bin/codesign')throw new Error('SIGN_FAILED');return f.execute(command,args);}})).rejects.toThrow('SIGN_FAILED');
    expect(await digestTree(f.targetApp)).toBe(before);
  });
  it('refuses live install/rollback and unknown changes rather than overwriting them',async()=>{
    const f=await fixture(),live=(command:string,args:string[])=>command==='/bin/ps'?join(f.targetApp,'Contents/MacOS/Vendor'):f.execute(command,args);
    await expect(installMacosCompanion({...f,execute:live})).rejects.toThrow('QUIT_VENDOR');
    const result=await installMacosCompanion(f);
    await expect(rollbackMacosCompanion({transactionPath:result.transactionPath,execute:live})).rejects.toThrow('QUIT_VENDOR');
    await writeFile(join(f.targetApp,'Contents/Resources/app.asar'),'UPDATER NEW CONTENT');
    await expect(rollbackMacosCompanion({transactionPath:result.transactionPath,execute:f.execute})).rejects.toThrow('INSTALLED_APP_DRIFT');
    expect(await readFile(join(f.targetApp,'Contents/Resources/app.asar'),'utf8')).toBe('UPDATER NEW CONTENT');
  });
  it('refuses changed helper on repeated install and tampered backup on rollback',async()=>{
    const f=await fixture(),result=await installMacosCompanion(f);
    await writeFile(join(f.companionApp,'Contents/Resources/app.asar'),'NEW HELPER');
    await expect(installMacosCompanion(f)).rejects.toThrow('COMPANION_CHANGED');
    await writeFile(join(result.backupApp,'Contents/Resources/app.asar'),'BROKEN BACKUP');
    await expect(rollbackMacosCompanion({transactionPath:result.transactionPath,execute:f.execute})).rejects.toThrow('BACKUP_DRIFT');
  });
  it('recovers an interruption between the backup rename and installing the prepared app',async()=>{
    const f=await fixture(),result=await installMacosCompanion(f),installed=join(f.targetApp,'..','interrupted.app');
    await rename(f.targetApp,installed);
    const restored=await rollbackMacosCompanion({transactionPath:result.transactionPath,execute:f.execute});
    expect(restored.state).toBe('rolled-back');expect(await digestTree(f.targetApp)).toBe(result.originalSha256);
  });
  it('leaves helper termination to the verified owner watcher across relaunch generations',()=>{expect(launcherSource).not.toContain('helper.terminate()');expect(launcherSource).toContain('Date().addingTimeInterval(30)');expect(launcherSource).toContain('companion-start-timeout');});
  it('keeps machine-specific project paths out of the native launch configuration',()=>{
    expect(launcherSource).toContain('Resources/companion/旅游商家助手.app/Contents/MacOS/');
    expect(launcherSource).toContain('--vendor-owner=');expect(launcherSource).toContain('--remote-debugging-address=127.0.0.1');
    expect(launcherSource).not.toContain('/Users/');
  });
});

// Exercise the generated native executable, so the actual Swift validation cannot drift from test expectations.
describe.skipIf(process.platform!=='darwin')('native launcher debugger arguments',()=>{
  it('preserves a caller port and rejects duplicates, invalid ports, remote addresses and occupied ports',async()=>{
    const root=await mkdtemp(join(tmpdir(),'trip-launcher-native-'));roots.push(root);nativeFixtureRoots.add(root);
    const contents=join(root,'Fixture.app/Contents'),macos=join(contents,'MacOS');
    await mkdir(macos,{recursive:true});const helperDir=join(contents,'Resources/companion/旅游商家助手.app/Contents/MacOS');await mkdir(helperDir,{recursive:true});
    await writeFile(join(contents,'Resources/companion/launcher.json'),JSON.stringify({vendorExecutable:'Vendor',companionExecutable:'FixtureHelper'}));
    await writeFile(join(macos,'Vendor'),'#!/bin/sh\nprintf "%s\\n" "$@" > "$TRIP_LAUNCH_FIXTURE/vendor-args"\nif [ -f "$TRIP_LAUNCH_FIXTURE/delayed" ]; then (sleep 2; rm "$TRIP_LAUNCH_FIXTURE/helper-lock") & sleep 3.5; else sleep 0.3; fi\n');
    await chmod(join(macos,'Vendor'),0o755);
    await writeFile(join(helperDir,'FixtureHelper'),'#!/bin/sh\nif [ -f "$TRIP_LAUNCH_FIXTURE/helper-lock" ]; then exit 0; fi\nprintf "%s\\n" "$@" > "$TRIP_LAUNCH_FIXTURE/helper-args"\nowner="${1#--vendor-owner=}"\nwhile kill -0 "$owner" 2>/dev/null; do sleep 0.05; done\nprintf stopped > "$TRIP_LAUNCH_FIXTURE/helper-stopped"\n');
    await chmod(join(helperDir,'FixtureHelper'),0o755);
    const source=join(root,'Launcher.swift'),launcher=join(macos,'TripVendorLauncher');
    // Compile the production implementation with only its log destination confined to this test root.
    const fixtureSource=launcherSource.replace('FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/trip_vendor_im_companion")','URL(fileURLWithPath: ProcessInfo.processInfo.environment["TRIP_LAUNCH_FIXTURE"]!).appendingPathComponent("logs")');
    expect(fixtureSource).not.toBe(launcherSource);await writeFile(source,fixtureSource);
    execFileSync('/usr/bin/xcrun',['swiftc','-O','-target','arm64-apple-macos11','-o',launcher,source]);
    const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw new Error('PORT_FIXTURE_FAILED');
    const port=address.port;
    const invoke=(args:string[])=>spawnSync(launcher,args,{env:{...process.env,TRIP_LAUNCH_FIXTURE:root},encoding:'utf8',timeout:5000});
    expect(invoke([`--remote-debugging-port=${port}`]).status).toBe(1);
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    const success=invoke([`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1']);expect(success.status).toBe(0);await waitForFixtureProcesses(root);
    expect(await readFile(join(root,'helper-stopped'),'utf8')).toBe('stopped');
    expect(await readFile(join(root,'logs/launcher.log'),'utf8')).toContain('vendor-start');
    expect(await readFile(join(root,'logs/companion.log'),'utf8')).toBe('');
    expect(await readFile(join(root,'helper-args'),'utf8')).toMatch(/--vendor-owner=\d+/);
    expect((await readFile(join(root,'vendor-args'),'utf8')).trim().split('\n')).toEqual(['--remote-debugging-address=127.0.0.1',`--remote-debugging-port=${port}`]);
    await writeFile(join(root,'delayed'),'');await writeFile(join(root,'helper-lock'),'');await rm(join(root,'helper-stopped'));
    const delayed=invoke([]);expect(delayed.status).toBe(0);await waitForFixtureProcesses(root);expect(await readFile(join(root,'helper-stopped'),'utf8')).toBe('stopped');
    for(const args of [['--remote-debugging-port=1'],['--remote-debugging-port=65535'],['--remote-debugging-port=no'],['--remote-debugging-port=9000','--remote-debugging-port=9001'],['--remote-debugging-address=0.0.0.0'],['--remote-debugging-port','9000'],['--remote-debugging-pipe']])expect(invoke(args).status).toBe(1);
  },20000);
});

describe('vendor relaunch bootstrap',()=>{
  it('routes default and self-targeted relaunches through the launcher while preserving args/options',()=>{
    const calls:unknown[]=[];const app={relaunch(options?:unknown){calls.push(options);}};
    patchRelaunch(app,{execPath:'/Applications/Vendor.app/Contents/MacOS/Vendor',argv:['--recover-default','--remote-debugging-port=9000','--remote-debugging-address=127.0.0.1']});
    app.relaunch();app.relaunch({args:['--recover','--remote-debugging-port=9001'],execPath:'/Applications/Vendor.app/Contents/MacOS/Vendor',custom:true});
    expect(calls).toEqual([{args:['--recover-default'],execPath:'/Applications/Vendor.app/Contents/MacOS/TripVendorLauncher'},{args:['--recover'],execPath:'/Applications/Vendor.app/Contents/MacOS/TripVendorLauncher',custom:true}]);
  });
  it('keeps explicitly different target paths and receiver binding intact',()=>{
    let captured:unknown,receiver:unknown;const app={relaunch(options?:unknown){captured=options;receiver=this;}};const options={execPath:'/Applications/Updater.app/Contents/MacOS/Updater',args:['--apply']};
    patchRelaunch(app,{execPath:'/Applications/Vendor.app/Contents/MacOS/Vendor'});app.relaunch(options);expect(captured).toBe(options);expect(receiver).toBe(app);
  });
});
