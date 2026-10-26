import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {watchVendorOwner,vendorOwnerExitCode} from '../electron/vendor-owner';
import {nativeLaunchArguments} from '../electron/native-adapter';
import {RUNTIME_PLATFORM} from '../runtime/identity';

const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const identity={pid:8123,executable:'/Applications/Café旅游商家.app/Contents/MacOS/旅游商家',startedAt:'original-start'};

test('darwin build keeps native launch independent of Windows binding arguments',()=>{
  assert.equal(RUNTIME_PLATFORM,'darwin');
  assert.deepEqual(nativeLaunchArguments('/fixture/TravelMerchant.WindowHelper',{platform:'darwin',installed:true,helper:'/fixture/helper',args:['--vendor-owner=8123']}),[]);
});

test('owner inspection exhaustion exposes a retryable exit code while normal owner lifetime ends remain clean',()=>{
  assert.equal(vendorOwnerExitCode('VENDOR_OWNER_INSPECTION_FAILED'),72);
  assert.equal(vendorOwnerExitCode('VENDOR_OWNER_EXITED'),0);
  assert.equal(vendorOwnerExitCode('VENDOR_OWNER_CHANGED'),0);
});

test('Mac owner watcher tolerates a transient inspection failure and NFC path spelling, then rejects a replaced executable',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  let calls=0;const exits:string[]=[];
  const stop=await watchVendorOwner(identity.pid,async()=>{
    calls++;
    if(calls===2)throw Error('PROCESS_IDENTITY_UNAVAILABLE');
    return {...identity,executable:calls<4?identity.executable.normalize('NFD'):identity.executable.toLowerCase()};
  },identity.executable,reason=>exits.push(reason),1000,{isProcessGone:()=>false});
  try{
    for(let i=0;i<2;i++){t.mock.timers.tick(1000);await flush();assert.deepEqual(exits,[]);}
    t.mock.timers.tick(1000);await flush();assert.deepEqual(exits,['VENDOR_OWNER_CHANGED']);
  }finally{stop();}
});

test('Mac owner watcher distinguishes confirmed exit from bounded unavailable inspection',async t=>{
  for(const gone of [true,false])await t.test(gone?'confirmed exit':'unavailable identity',async t=>{
    t.mock.timers.enable({apis:['setInterval']});let calls=0;const exits:string[]=[];
    const stop=await watchVendorOwner(identity.pid,async()=>{if(calls++===0)return identity;throw Error('PROCESS_IDENTITY_UNAVAILABLE');},identity.executable,reason=>exits.push(reason),1000,{isProcessGone:()=>gone});
    try{
      for(let i=0;i<(gone?1:3);i++){t.mock.timers.tick(1000);await flush();}
      assert.deepEqual(exits,[gone?'VENDOR_OWNER_EXITED':'VENDOR_OWNER_INSPECTION_FAILED']);
      const before=calls;t.mock.timers.tick(5000);await flush();assert.equal(calls,before);
    }finally{stop();}
  });
});

test('native Swift assistant recovery state machine',{skip:process.platform!=='darwin'?'requires macOS Swift compiler; Windows mocks are not Mac binary acceptance':false},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'tsim-macos-recovery-'));
  const execute=promisify(execFile);
  try{
    const source=await readFile('native/macos/CompanionRecovery.swift','utf8');
    const fixture=await readFile('tests/macos-companion-recovery.swift','utf8');
    const input=join(directory,'main.swift'),executable=join(directory,'recovery-test');
    await writeFile(input,source+'\n'+fixture);
    await execute('/usr/bin/xcrun',['swiftc','-o',executable,input]);
    const result=await execute(executable,[]);assert.match(result.stdout,/macos_companion_recovery_ok/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
