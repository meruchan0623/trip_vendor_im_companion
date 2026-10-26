import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {NativeAdapter, type NativeTransport} from '../electron/native-adapter';
import {ResidentConnection} from '../electron/resident-connection';

const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const capability={windowFollow:true,readMessage:false,readOrder:false,readDraft:false,writeDraft:false,reason:'not_bound'};
function transport(){
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){}});
  const commands:any[]=[];
  child.stdin.on('data',chunk=>commands.push(JSON.parse(chunk.toString())));
  const emit=(value:unknown)=>child.stdout.write(JSON.stringify(value)+'\n');
  return{child:child as NativeTransport,commands,emit,ready:()=>emit({protocolVersion:'1.0',type:'capabilities',payload:capability})};
}

test('native ready wakes resident 150ms after an initial six-second list timeout',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const pipe=transport();let resident:ResidentConnection|undefined;
  const adapter=new NativeAdapter('',()=>{},()=>{},undefined,undefined,undefined,()=>resident?.notifyTargetAvailable(),()=>pipe.child);
  resident=new ResidentConnection(adapter,async()=>{});
  adapter.start();resident.start();
  try{
    assert.equal(pipe.commands.length,1);
    t.mock.timers.tick(6000);await flush();
    pipe.ready();await flush();
    t.mock.timers.tick(149);await flush();assert.equal(pipe.commands.length,1);
    t.mock.timers.tick(1);await flush();assert.equal(pipe.commands.length,2);
    const list=pipe.commands[1];assert.equal(list.type,'listWindows');
    pipe.emit({protocolVersion:'1.0',type:'windows',requestId:list.requestId,payload:{windows:[{targetInstanceId:'fixture'}]}});await flush();
    const bind=pipe.commands[2];assert.equal(bind.type,'bindWindow');
    pipe.emit({protocolVersion:'1.0',type:'windowState',requestId:bind.requestId,targetInstanceId:'fixture',payload:{bound:true}});await flush();
    t.mock.timers.tick(30000);await flush();assert.equal(pipe.commands.length,3);
  }finally{resident.dispose();adapter.stop();}
});

test('ready requires a valid unsolicited capability and fires once per child',async()=>{
  const pipe=transport();let wakes=0;
  const adapter=new NativeAdapter('',()=>{},()=>{},undefined,undefined,undefined,()=>wakes++,()=>pipe.child);
  adapter.start();
  try{
    for(const value of [
      {protocolVersion:'2.0',type:'capabilities',payload:capability},
      {protocolVersion:'1.0',type:'capabilities'},
      {protocolVersion:'1.0',type:'capabilities',payload:{...capability,windowFollow:'true'}},
      {protocolVersion:'1.0',type:'capabilities',payload:{...capability,readDraft:true}},
      {protocolVersion:'1.0',type:'capabilities',requestId:'probe',payload:capability},
    ])pipe.emit(value);
    await flush();assert.equal(wakes,0);
    pipe.ready();pipe.ready();await flush();assert.equal(wakes,1);
    pipe.emit({protocolVersion:'1.0',type:'targetAvailable'});await flush();assert.equal(wakes,2);
  }finally{adapter.stop();}
});

test('stopped and replaced child output or exit cannot wake or invalidate the current child',async()=>{
  const old=transport(),current=transport(),pipes=[old,current];let wakes=0,starts=0;
  const statuses:string[]=[],states:unknown[]=[];
  const adapter=new NativeAdapter('',state=>states.push(state),status=>statuses.push(status),undefined,undefined,undefined,()=>wakes++,()=>pipes[starts++].child);
  adapter.start();adapter.stop();old.ready();await flush();assert.equal(wakes,0);
  adapter.start();
  try{
    const list=adapter.list();
    old.ready();old.emit({protocolVersion:'1.0',type:'targetAvailable'});old.child.stderr.emit('data','fixed_code');old.child.emit('error',Error('old'));old.child.emit('exit',0);
    await flush();assert.equal(wakes,0);assert.deepEqual(statuses,['available','helper_stopped','available']);
    current.ready();await flush();assert.equal(wakes,1);
    const request=current.commands[0];current.emit({protocolVersion:'1.0',type:'windows',requestId:request.requestId,payload:{windows:[{targetInstanceId:'current'}]}});
    assert.equal((await list)[0].targetInstanceId,'current');assert.equal(starts,2);assert.deepEqual(states,[null]);
  }finally{adapter.stop();}
});

test('current native loss rejects requests, clears binding, and does not automatically restart',async()=>{
  const pipe=transport();let starts=0,wakes=0;const statuses:string[]=[],states:unknown[]=[];
  const adapter=new NativeAdapter('',state=>states.push(state),status=>statuses.push(status),undefined,undefined,undefined,()=>wakes++,()=>{starts++;return pipe.child;});
  adapter.start();const list=adapter.list();const failed=assert.rejects(list,/helper_stopped/);
  pipe.child.emit('exit',1);await failed;pipe.ready();await flush();
  assert.equal(starts,1);assert.equal(wakes,0);assert.deepEqual(states,[null]);assert.deepEqual(statuses,['available','helper_stopped']);
  await assert.rejects(adapter.list(),/helper_unavailable/);
});
