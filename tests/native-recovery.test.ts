import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeRecovery} from '../electron/native-recovery';
import {NativeAdapter,type NativeTransport} from '../electron/native-adapter';
import {ResidentConnection} from '../electron/resident-connection';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';

const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('native recovery deduplicates failures, backs off, caps retries and cancels on host shutdown',t=>{
  t.mock.timers.enable({apis:['setTimeout']});let starts=0,exhausted=0;
  const recovery=new NativeRecovery(()=>starts++,()=>exhausted++);
  for(const [index,delay] of [1000,3000,10000].entries()){
    recovery.status('helper_stopped');recovery.status('helper_unavailable');t.mock.timers.tick(delay-1);assert.equal(starts,index);t.mock.timers.tick(1);assert.equal(starts,index+1);
    recovery.ready();t.mock.timers.tick(100); // brief capability must not reset crash budget
  }
  recovery.status('helper_stopped');assert.equal(exhausted,1);t.mock.timers.tick(60000);assert.equal(starts,3);recovery.dispose();
  const stopped=new NativeRecovery(()=>starts++,()=>{});stopped.status('helper_stopped');stopped.dispose();t.mock.timers.tick(60000);assert.equal(starts,3);
});
test('native process loss restarts, discovers and binds a successor',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let starts=0,binds=0;const pipes:any[]=[];
  let resident:ResidentConnection;
  const recovery=new NativeRecovery(()=>adapter.start(),()=>assert.fail('unexpected exhausted'));
  const adapter=new NativeAdapter('',state=>resident?.setBound(!!state),status=>recovery.status(status),undefined,undefined,undefined,()=>{recovery.ready();resident?.notifyTargetAvailable();},()=>{
    starts++;const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){}});
    child.stdin.on('data',chunk=>{const command=JSON.parse(chunk.toString());queueMicrotask(()=>{if(command.type==='bindWindow')binds++;child.stdout.write(JSON.stringify({protocolVersion:'1.0',type:command.type==='listWindows'?'windows':'windowState',requestId:command.requestId,payload:command.type==='listWindows'?{windows:[{targetInstanceId:'123:456:789'}]}:{bound:true}})+'\n');});});pipes.push(child);return child as NativeTransport;
  });
  resident=new ResidentConnection(adapter,async()=>{});adapter.start();resident.start();await flush();assert.equal(binds,1);
  try{
    pipes[0].emit('exit',1);t.mock.timers.tick(1000);await flush();assert.equal(starts,2);
    pipes[1].stdout.write(JSON.stringify({protocolVersion:'1.0',type:'capabilities',payload:{reason:'not_bound',windowFollow:true,readMessage:false,readOrder:false,readDraft:false,writeDraft:false}})+'\n');
    t.mock.timers.tick(150);await flush();assert.equal(binds,2);
    t.mock.timers.tick(60000);pipes[1].emit('exit',1);t.mock.timers.tick(1000);await flush();assert.equal(starts,3);
  }finally{recovery.dispose();resident.dispose();adapter.stop();}
});
