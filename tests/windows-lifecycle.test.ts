import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {LiveRuntimeDriver} from '../runtime/driver';
import {VERIFIED_RUNTIME_BUILD} from '../runtime/identity';
import {RuntimeCDPPolicy} from '../runtime/cdp-policy';
import {activateWindowsRuntimeBuild} from '../runtime/build-manifest';
import {CompanionService} from '../electron/companion-service';

function deferred<T=void>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};}
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const panel={} as any;
function inventory(){
  const html='verified fixture',fingerprint={...VERIFIED_RUNTIME_BUILD,htmlSha256:createHash('sha256').update(html).digest('hex')};
  let visible:string|undefined='A',focused:string|undefined='A',corrupt=false;
  const mounts:string[]=[],probes:string[]=[],detaches:string[]=[];
  const transport={send:async(method:string,params:any,session?:string)=>{
    if(method==='Target.getTargets')return{targetInfos:['A','B'].map(targetId=>({targetId,type:'page',url:VERIFIED_RUNTIME_BUILD.documentURL}))};
    if(method==='Target.attachToTarget')return{sessionId:params.targetId};
    if(method==='Target.detachFromTarget'){detaches.push(params.sessionId);return{};}
    if(method==='Page.enable')return{};
    if(method==='Page.getFrameTree')return{frameTree:{frame:{id:session+'-frame',url:VERIFIED_RUNTIME_BUILD.documentURL,loaderId:session+'-loader'}}};
    if(method==='Page.getResourceContent')return{content:corrupt?'unexpected vendor bytes':html,base64Encoded:false};
    if(method==='Page.createIsolatedWorld')return{executionContextId:session==='A'?1:2};
    if(method==='Runtime.evaluate'){probes.push(session!);return{result:{value:{visible:visible==='both'||visible===session,focused:focused===session}}};}
    throw Error('Unexpected '+method);
  }};
  const make=(id:string)=>{
    const driver:any=Object.create(LiveRuntimeDriver.prototype);
    const mounted=deferred(),activity=deferred();
    Object.assign(driver,{epoch:0,invalid:false,mounted:false,nativeListeners:new Set(),invalidators:new Set(),target:{targetId:id,frameId:id+'-frame',contextNonce:'fixture',fingerprint},transport,
      policy:{session:'owned-session',matchesNativeWake:()=>false,nativeReady:false,invalidateContext(){},verifyExactDocument:async()=>{},installOwnedArtifact:async()=>{},registerWorkbenchBinding:async()=>{},verifyOwnedFrame:async()=>{},detachUi:async()=>{},
        documentActivity:async()=>{activity.resolve();return{visible:visible===id,focused:focused===id};},
        mountUi:async()=>{assert.equal(visible,id,'only the visible account may mount');mounts.push(id);mounted.resolve();},},});
    return{driver,mounted:mounted.promise,activity:activity.promise};
  };
  return{make,mounts,probes,detaches,setVisible:(id?:string)=>{visible=id;focused=id;},corrupt:()=>{corrupt=true;}};
}

test('hidden bootstrap migrates to the currently visible verified account, without returning to the old account',{timeout:5000},async()=>{
  const world=inventory();world.setVisible();const old=world.make('A');
  const mounting=old.driver.mountCompanion(panel,async()=>{}),rejected=assert.rejects(mounting,/RUNTIME_TARGET_CHANGED/);
  await old.activity;world.setVisible('B');await rejected;
  await world.make('B').driver.mountCompanion(panel,async()=>{});
  assert.deepEqual(world.mounts,['B']);assert.ok(world.probes.includes('A')&&world.probes.includes('B'));
  assert.equal(world.detaches.filter(id=>id==='A').length,world.detaches.filter(id=>id==='B').length);
});

test('all-hidden retains its lease and resumes when the same verified account becomes visible',{timeout:5000},async()=>{
  const world=inventory();world.setVisible();const item=world.make('A');
  const mounting=item.driver.mountCompanion(panel,async()=>{});await item.activity;world.setVisible('A');await mounting;
  assert.deepEqual(world.mounts,['A']);assert.equal(item.driver.invalid,false);
});

test('rapid A B A invalidates both obsolete bootstrap owners and mounts only the final account',{timeout:5000},async()=>{
  const world=inventory();world.setVisible();const a=world.make('A');
  const first=a.driver.mountCompanion(panel,async()=>{}),firstRejected=assert.rejects(first,/RUNTIME_TARGET_CHANGED/);
  await a.activity;world.setVisible('B');await firstRejected;
  const b=world.make('B');world.setVisible();const second=b.driver.mountCompanion(panel,async()=>{}),secondRejected=assert.rejects(second,/RUNTIME_TARGET_CHANGED/);
  await b.activity;world.setVisible('A');await secondRejected;
  await world.make('A').driver.mountCompanion(panel,async()=>{});
  assert.deepEqual(world.mounts,['A']);assert.equal(a.driver.invalid,true);assert.equal(b.driver.invalid,true);
});

test('navigation or native lease loss cancels a hidden mount and permits a fresh verified mount',{timeout:5000},async t=>{
  for(const reason of ['Page.frameNavigated','BOOTSTRAP_NATIVE_LEASE_ENDED'])await t.test(reason,async()=>{
    const world=inventory();world.setVisible();const item=world.make('A');
    if(reason==='BOOTSTRAP_NATIVE_LEASE_ENDED')Object.assign(item.driver.policy,{nativeReady:true,renewNative:async()=>{throw Error('NATIVE_LEASE_ENDED');}});
    const mounting=item.driver.mountCompanion(panel,async()=>{}),rejected=assert.rejects(mounting,/RUNTIME_TARGET_CHANGED/);
    await item.activity;
    if(reason==='Page.frameNavigated')item.driver.event({method:'Page.frameNavigated',params:{frame:{id:'A-frame'}},sessionId:'owned-session'});
    await rejected;
    world.setVisible('B');await world.make('B').driver.mountCompanion(panel,async()=>{});assert.deepEqual(world.mounts,['B']);
  });
});

test('hidden handover still rejects fingerprint drift and ambiguous visible targets',{timeout:5000},async t=>{
  for(const mode of ['fingerprint','ambiguous'])await t.test(mode,async()=>{
    const world=inventory();world.setVisible();const item=world.make('A');
    const mounting=item.driver.mountCompanion(panel,async()=>{}),rejected=assert.rejects(mounting,mode==='fingerprint'?/LOADED_DOCUMENT_HASH_MISMATCH/:/AMBIGUOUS_IM_TARGET/);
    await item.activity;if(mode==='fingerprint'){world.corrupt();world.setVisible('B');}else world.setVisible('both');
    await rejected;assert.equal(item.driver.invalid,true);assert.deepEqual(world.mounts,[]);
  });
});

function composer(options:{mount?:Promise<void>;syncInvalidated?:boolean;next?:any}={}){
  let invalidated:undefined|(()=>void),closes=0,unsubscribes=0,reconnects=0,mounts=0;
  const started=deferred();
  const value:any={targetInstanceId:'1:2:3',onInteraction:()=>()=>{},onInvalidated:(callback:()=>void)=>{invalidated=callback;if(options.syncInvalidated)callback();return()=>{unsubscribes++;invalidated=undefined;};},
    mountWorkbench:async()=>{mounts++;started.resolve();await options.mount;},read:async()=>{throw Error('unexpected business read');},renew:async()=>{},
    replace:async()=>{throw Error('unexpected draft write');},send:async()=>{throw Error('unexpected customer send');},close:async()=>{closes++;},
    ...(options.next?{reconnect:async()=>{reconnects++;return options.next;}}:{}),};
  return{value,started:started.promise,invalidate:()=>invalidated?.(),counts:()=>({closes,unsubscribes,reconnects,mounts})};
}
async function serviceFixture(first:any){
  const session:any={identity:()=>null,sync:async()=>{},setBackgroundPolling(){},getBrowserProfile:()=>null,dispose:async()=>{}};
  const service:any=new CompanionService({} as never,async()=>{},()=>{},{enabled:false},true,()=>session);
  await flush();service.state.targetInstanceId='1:2:3';service.state.attached=true;service.state.autoTranslate=false;service.state.auth='needs_login';service.readDraft=async()=>{};
  service.reconnecting={id:'1:2:3',epoch:0,controller:new AbortController(),promise:Promise.resolve(first),claimed:false,disposed:false};
  return service;
}

test('invalidation during mount releases the connection gate; late old rejection cannot close its successor',{timeout:5000},async()=>{
  const mount=deferred(),nextMount=deferred(),successor=composer({mount:nextMount.promise}),first=composer({mount:mount.promise,next:successor.value}),service=await serviceFixture(first.value);
  try{
    const old=service.connectComposer();await first.started;first.invalidate();
    assert.equal(service.externalConnecting,undefined);assert.ok(service.nextConnectAt<=Date.now());
    const next=service.connectComposer();await successor.started;
    const gate=service.externalConnecting,nextConnectAt=service.nextConnectAt;mount.reject(Error('RUNTIME_TARGET_CHANGED'));await old;
    assert.equal(service.external,successor.value);assert.equal(service.externalConnecting,gate);assert.equal(first.counts().closes,0);assert.equal(successor.counts().closes,0);assert.equal(service.nextConnectAt,nextConnectAt);
    nextMount.resolve();await next;assert.equal(successor.counts().mounts,1);
  }finally{await service.dispose();}
});

test('late successful old mount cannot close a socket while warm reconnect owns it',{timeout:5000},async()=>{
  const mount=deferred(),successor=composer(),first=composer({mount:mount.promise,next:successor.value}),service=await serviceFixture(first.value);
  try{
    const old=service.connectComposer();await first.started;first.invalidate();mount.resolve();await old;
    assert.equal(first.counts().closes,0);await service.connectComposer();assert.equal(service.external,successor.value);assert.equal(successor.counts().closes,0);
  }finally{await service.dispose();}
});

test('synchronous invalidation during registration unsubscribes the obsolete callback and recovers',{timeout:5000},async()=>{
  const successor=composer(),first=composer({syncInvalidated:true,next:successor.value}),service=await serviceFixture(first.value);
  try{
    await service.connectComposer();assert.equal(first.counts().mounts,0);assert.equal(first.counts().unsubscribes,1);assert.equal(service.stopInvalidation,undefined);
    await service.connectComposer();assert.equal(service.external,successor.value);assert.equal(first.counts().closes,0);assert.equal(successor.counts().mounts,1);
  }finally{await service.dispose();}
});

test('ordinary mount failure closes only that failed owner and permits a later connection',{timeout:5000},async()=>{
  const mount=deferred(),first=composer({mount:mount.promise}),service=await serviceFixture(first.value);
  try{
    const pending=service.connectComposer();await first.started;mount.reject(Error('OWNED_FRAME_BOUNDARY_FAILED'));await pending;
    assert.equal(first.counts().closes,1);assert.equal(service.external,undefined);assert.equal(service.externalConnecting,undefined);
    const successor=composer();service.reconnecting={id:'1:2:3',epoch:service.connectionEpoch,controller:new AbortController(),promise:Promise.resolve(successor.value),claimed:false,disposed:false};
    await service.connectComposer();assert.equal(service.external,successor.value);assert.equal(successor.counts().mounts,1);
  }finally{await service.dispose();}
});

test('exact-document checks reuse a verified hash only for the same session, loader and URL',async()=>{
  const saved=VERIFIED_RUNTIME_BUILD,html='exact document fixture';
  activateWindowsRuntimeBuild({...saved,htmlSha256:createHash('sha256').update(html).digest('hex')});
  try{
    const keys=['executable','executableVersion','packageVersion','aresVersion','executableSha256','asarSha256','htmlSha256','rendererSha256'] as const;
    const fingerprint=Object.fromEntries(keys.map(key=>[key,VERIFIED_RUNTIME_BUILD[key]])) as any;
    let loader='L1',content=html,reads=0,sessions=0;
    const transport:any={disconnect:async()=>{},send:async(method:string)=>{
      if(method==='Target.attachToTarget')return{sessionId:'S'+(++sessions)};
      if(method==='Target.detachFromTarget')return{};
      if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'F',url:VERIFIED_RUNTIME_BUILD.documentURL,loaderId:loader}}};
      if(method==='Page.getResourceContent'){reads++;return{content,base64Encoded:false};}
      throw Error('Unexpected '+method);
    }};
    const policy=new RuntimeCDPPolicy(transport,{targetId:'T',frameId:'F',contextNonce:'fixture',documentURL:VERIFIED_RUNTIME_BUILD.documentURL,fingerprint},'0'.repeat(64));
    await policy.attachSession();
    await policy.verifyExactDocument();await policy.verifyExactDocument();await policy.verifyExactDocument();assert.equal(reads,1);
    // A reload is a new loader: its bytes are read and compared again before any reuse.
    loader='L2';content='tampered vendor bytes';
    await assert.rejects(policy.verifyExactDocument(),/LOADED_DOCUMENT_HASH_MISMATCH/);assert.equal(reads,2);
    await assert.rejects(policy.verifyExactDocument(),/LOADED_DOCUMENT_HASH_MISMATCH/);assert.equal(reads,3);
    loader='L3';content=html;await policy.verifyExactDocument();await policy.verifyExactDocument();assert.equal(reads,4);
    policy.invalidateContext();await policy.verifyExactDocument();assert.equal(reads,5);
  }finally{activateWindowsRuntimeBuild(saved);}
});
