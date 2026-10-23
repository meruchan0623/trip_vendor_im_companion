import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {watchVendorOwner} from '../electron/vendor-owner';

const {installBootstrap}=createRequire(import.meta.url)(join(process.cwd(),'scripts/lib/windows-vendor-bootstrap.cjs'));
const identity={pid:8123,executable:'C:\\Vendor\\旅游商家桌面版.exe',startedAt:'original-start'};
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('owner inspection tolerates temporary failures, resets its budget after recovery, and stops after disposal',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  let fail=false,calls=0;const exits:string[]=[];
  const stop=await watchVendorOwner(identity.pid,async()=>{calls++;if(fail)throw Error('PROCESS_INSPECTION_FAILED');return identity;},identity.executable,reason=>exits.push(reason),1000,{isProcessGone:()=>false});
  try{
    for(let repeat=0;repeat<2;repeat++){
      fail=true;for(let i=0;i<2;i++){t.mock.timers.tick(1000);await flush();}assert.deepEqual(exits,[]);
      fail=false;t.mock.timers.tick(1000);await flush();assert.deepEqual(exits,[]);
    }
    stop();const before=calls;t.mock.timers.tick(5000);await flush();assert.equal(calls,before);
  }finally{stop();}
});

test('confirmed owner exit or PID reuse stops immediately; persistent unknown failures stop after a finite budget',async t=>{
  for(const mode of ['gone','changed','unknown'])await t.test(mode,async t=>{
    t.mock.timers.enable({apis:['setInterval']});let calls=0;const exits:string[]=[];
    const stop=await watchVendorOwner(identity.pid,async()=>{if(calls++===0)return identity;if(mode==='changed')return {...identity,startedAt:'reused-pid'};throw Error('PROCESS_INSPECTION_FAILED');},identity.executable,reason=>exits.push(reason),1000,{isProcessGone:()=>mode==='gone'});
    try{
      t.mock.timers.tick(1000);await flush();
      if(mode==='unknown'){assert.deepEqual(exits,[]);for(let i=0;i<2;i++){t.mock.timers.tick(1000);await flush();}}
      assert.deepEqual(exits,[mode==='gone'?'VENDOR_OWNER_EXITED':mode==='changed'?'VENDOR_OWNER_CHANGED':'VENDOR_OWNER_INSPECTION_FAILED']);
      const before=calls;t.mock.timers.tick(5000);await flush();assert.equal(calls,before);
    }finally{stop();}
  });
});

test('disposing during an in-flight inspection suppresses a late exit callback',async t=>{
  t.mock.timers.enable({apis:['setInterval']});let reject!:(error:Error)=>void,calls=0;const exits:string[]=[];
  const stop=await watchVendorOwner(identity.pid,async()=>{if(calls++===0)return identity;return new Promise((_,fail)=>{reject=fail;});},identity.executable,reason=>exits.push(reason),1000,{isProcessGone:()=>true});
  t.mock.timers.tick(1000);await flush();stop();reject(Error('late inspection failure'));await flush();assert.deepEqual(exits,[]);
});

function bootstrap(){
  const app:any=new EventEmitter();app.commandLine={appendSwitch(){},removeSwitch(){}};app.whenReady=()=>Promise.resolve();
  let accept!:(socket:any)=>void;const children:any[]=[],timers=new Map<number,{callback:()=>void;delay:number}>();let serial=0;
  const server:any=new EventEmitter();server.listen=()=>{};server.unref=()=>{};server.close=()=>{};
  const runtime=installBootstrap({app,pid:8123,execPath:identity.executable,argv:[],randomBytes:()=>Buffer.alloc(16),
    createServer:(callback:(socket:any)=>void)=>{accept=callback;return server;},
    spawn:()=>{const child:any=new EventEmitter();child.kill=()=>{};children.push(child);return child;},
    schedule:(callback:()=>void,delay:number)=>{const id=++serial;timers.set(id,{callback,delay});return id;},cancel:(id:number)=>timers.delete(id)});
  const run=(delay:number)=>{const entry=[...timers].find(([,timer])=>timer.delay===delay);assert.ok(entry,'expected timer '+delay);timers.delete(entry[0]);entry[1].callback();};
  const connect=()=>{const socket:any=new EventEmitter();socket.setEncoding=()=>{};socket.destroy=()=>socket.emit('close');accept(socket);return socket;};
  return{app,children,timers,runtime,run,connect};
}

test('bootstrap retries unexpected helper exit with bounded backoff and deduplicates error/exit events',async()=>{
  const f=bootstrap();await flush();assert.equal(f.children.length,1);
  for(const delay of [1000,3000,10000]){
    const child=f.children.at(-1);child.emit('error',Error('spawn failed'));child.emit('exit',1);
    assert.equal(f.runtime.stage(),'failed');assert.equal(f.timers.size,1);f.run(delay);
  }
  f.children.at(-1).emit('exit',1);assert.equal(f.children.length,4);assert.equal(f.runtime.stage(),'exited');assert.equal(f.timers.size,0);
});

test('a progress connection cancels retry and an adopted helper prevents duplicate launches',async()=>{
  const f=bootstrap();await flush();f.children[0].emit('exit',0);assert.equal(f.timers.size,1);
  const socket=f.connect();assert.equal(f.timers.size,0);socket.emit('data',JSON.stringify({stage:'panel-mounted'})+'\n');
  f.run(60000);assert.equal(f.children.length,1);socket.emit('close');assert.equal(f.runtime.stage(),'failed');f.run(1000);assert.equal(f.children.length,2);
});

test('stable mounted assistance resets the restart budget, while vendor quit cancels all recovery',async()=>{
  const f=bootstrap();await flush();f.children[0].emit('exit',1);f.run(1000);
  const socket=f.connect();socket.emit('data',JSON.stringify({stage:'panel-mounted'})+'\n');f.run(60000);
  f.children[1].emit('exit',1);socket.emit('close');f.run(1000);assert.equal(f.children.length,3);
  f.children[2].emit('exit',1);assert.equal(f.timers.size,1);f.app.emit('before-quit');assert.equal(f.timers.size,0);
  f.children[2].emit('exit',1);assert.equal(f.timers.size,0);assert.equal(f.children.length,3);
});

test('vendor quit before readiness never starts assistance',async()=>{
  const f=bootstrap();f.app.emit('before-quit');await flush();assert.equal(f.children.length,0);assert.equal(f.timers.size,0);
});

test('a failed connection cannot reset the crash budget merely because the helper stays alive',async()=>{
  const f=bootstrap();await flush();f.children[0].emit('exit',1);f.run(1000);
  const socket=f.connect();socket.emit('data',JSON.stringify({stage:'panel-mounted'})+'\n');assert.equal(f.timers.size,1);
  socket.emit('data',JSON.stringify({stage:'failed'})+'\n');assert.equal(f.timers.size,0);
  f.children[1].emit('exit',1);socket.emit('close');f.run(3000);assert.equal(f.children.length,3);
});
