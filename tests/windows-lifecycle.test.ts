import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {LiveRuntimeDriver} from '../runtime/driver';
import {VERIFIED_RUNTIME_BUILD} from '../runtime/identity';
import {activateWindowsRuntimeBuild} from '../runtime/build-manifest';
import {CompanionService} from '../electron/companion-service';
import {RuntimeCDPPolicy} from '../runtime/cdp-policy';

function deferred<T=void>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};}
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const panel={} as any;
function inventory(){
  const html='verified fixture',fingerprint={...VERIFIED_RUNTIME_BUILD,htmlSha256:createHash('sha256').update(html).digest('hex')};
  // A changed document is a new navigation, so tampering also changes the loader identity.
  let visible:string|undefined='A',focused:string|undefined='A',corrupt=false,generation=0;
  const mounts:string[]=[],probes:string[]=[],detaches:string[]=[];
  const transport={send:async(method:string,params:any,session?:string)=>{
    if(method==='Target.getTargets')return{targetInfos:['A','B'].map(targetId=>({targetId,type:'page',url:VERIFIED_RUNTIME_BUILD.documentURL}))};
    if(method==='Target.attachToTarget')return{sessionId:params.targetId};
    if(method==='Target.detachFromTarget'){detaches.push(params.sessionId);return{};}
    if(method==='Page.enable')return{};
    if(method==='Page.getFrameTree')return{frameTree:{frame:{id:session+'-frame',url:VERIFIED_RUNTIME_BUILD.documentURL,loaderId:session+'-loader-'+generation}}};
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
  return{make,mounts,probes,detaches,setVisible:(id?:string)=>{visible=id;focused=id;},corrupt:()=>{corrupt=true;generation++;}};
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
  const world=inventory();world.setVisible();const item=world.make('A');let waits=0;
  const mounting=item.driver.mountCompanion(panel,async()=>{},()=>{waits++;});await item.activity;await flush();assert.equal(waits,1);world.setVisible('A');await mounting;
  assert.deepEqual(world.mounts,['A']);assert.equal(item.driver.invalid,false);assert.equal(waits,1);
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

/** Resolves true only if the promise settles within a few event-loop turns. */
async function settlesSoon(promise:Promise<unknown>){let settled=false;void promise.then(()=>{settled=true;},()=>{settled=true;});for(let i=0;i<5&&!settled;i++)await flush();return settled;}

test('a socket waiting for the IM page releases the busy phase and is never awaited, even by the connect that started it',{timeout:5000},async t=>{
  for(const timing of ['before-claim','after-claim'])await t.test(timing,async()=>{
    const arrived=deferred<any>(),successor=composer(),first=composer(),service=await serviceFixture(first.value);
    let waits=0,report!:()=>void;first.value.reconnect=async(_signal:AbortSignal,onWaiting:()=>void)=>{waits++;report=onWaiting;if(timing==='before-claim')onWaiting();return arrived.promise;};
    try{
      await service.connectComposer();assert.equal(service.external,first.value);
      // The vendor logs out: the warm reconnect keeps its verified socket and waits for the IM page.
      first.invalidate();assert.equal(waits,1);
      const creator=service.connectComposer();
      if(timing==='after-claim'){await flush();assert.equal(service.state.phase,'reading');assert.equal(await settlesSoon(creator),false);report();}
      assert.equal(await settlesSoon(creator),true,'the creating call must settle once the attempt waits');
      assert.notEqual(service.externalConnecting,undefined);assert.equal(service.state.phase,'idle');
      assert.equal(await settlesSoon(service.connectComposer()),true);
      arrived.resolve(successor.value);for(let i=0;i<5&&service.externalConnecting;i++)await flush();
      assert.equal(service.external,successor.value);assert.equal(successor.counts().mounts,1);assert.equal(service.externalConnecting,undefined);assert.equal(service.waitingConnection,undefined);
    }finally{await service.dispose();}
  });
});

test('a mount waiting for a hidden IM page releases the busy phase and completes when it becomes visible',{timeout:5000},async()=>{
  const visible=deferred(),first=composer(),service=await serviceFixture(first.value);
  // The verified attach reports waiting from inside mountWorkbench, as LiveRuntimeDriver.mountCompanion does.
  let report!:()=>void;const successor=composer({mount:visible.promise});const mount=successor.value.mountWorkbench;
  successor.value.mountWorkbench=async(...args:unknown[])=>{report();return mount(...args);};
  first.value.reconnect=async(_signal:AbortSignal,onWaiting:()=>void)=>{report=onWaiting;return successor.value;};
  try{
    await service.connectComposer();first.invalidate();
    const creator=service.connectComposer();await successor.started;
    assert.equal(await settlesSoon(creator),true,'the creating call must settle while the page is hidden');
    assert.equal(service.state.phase,'idle');assert.notEqual(service.externalConnecting,undefined);
    visible.resolve();for(let i=0;i<5&&service.externalConnecting;i++)await flush();
    assert.equal(service.external,successor.value);assert.equal(service.externalConnecting,undefined);assert.equal(successor.counts().closes,0);
  }finally{await service.dispose();}
});

function discoveryInventory(){
  const saved=VERIFIED_RUNTIME_BUILD,html='verified discovery fixture';
  activateWindowsRuntimeBuild({...saved,htmlSha256:createHash('sha256').update(html).digest('hex')});
  const keys=['executable','executableVersion','packageVersion','aresVersion','executableSha256','asarSha256','htmlSha256','rendererSha256'] as const;
  const fingerprint=Object.fromEntries(keys.map(key=>[key,VERIFIED_RUNTIME_BUILD[key]])) as any;
  let ids=['A','B'],visible:string|undefined,corrupt=false,generation=0,driftInventory=false,closed=false,listCalls=0,resourceReads=0,enables=0;
  const disconnects=new Set<()=>void>(),events=new Set<()=>void>(),worldNames=new Set<string>(),attached:string[]=[],detached:string[]=[];
  const transport:any={onEvent:(listener:()=>void)=>{events.add(listener);return()=>events.delete(listener);},
    onDisconnect:(listener:()=>void)=>{disconnects.add(listener);if(closed)listener();return()=>disconnects.delete(listener);},
    disconnect:async()=>{closed=true;for(const listener of [...disconnects])listener();},
    send:async(method:string,params:any,session?:string)=>{
      if(closed)throw Error('CDP_DISCONNECTED');
      if(method==='Target.getTargets'){listCalls++;return{targetInfos:(driftInventory&&listCalls%2===0?['A','C']:ids).map(targetId=>({targetId,type:'page',url:VERIFIED_RUNTIME_BUILD.documentURL}))};}
      if(method==='Target.attachToTarget'){attached.push(params.targetId);return{sessionId:params.targetId};}
      if(method==='Target.detachFromTarget'){detached.push(params.sessionId);return{};}
      if(method==='Page.enable'){enables++;return{};}
      if(method==='Page.getFrameTree')return{frameTree:{frame:{id:session+'-frame',url:VERIFIED_RUNTIME_BUILD.documentURL,loaderId:session+'-loader-'+generation}}};
      if(method==='Page.getResourceContent'){resourceReads++;return{content:corrupt?'tampered bytes':html,base64Encoded:false};}
      if(method==='Page.createIsolatedWorld'){worldNames.add(params.worldName);return{executionContextId:session==='A'?1:2};}
      if(method==='Runtime.evaluate')return{result:{value:{visible:visible==='both'||visible===session,focused:visible===session}}};
      throw Error('Unexpected discovery '+method);
    }};
  return{transport,attached,detached,worldNames,discover:(onWaiting?:()=>void)=>LiveRuntimeDriver.discover(transport,fingerprint,'fixture bundle','0'.repeat(64),8000,onWaiting),
    setVisible:(id?:string)=>{visible=id;},removeTargets:()=>{ids=[];},corrupt:()=>{corrupt=true;generation++;},reload:()=>{generation++;},driftInventory:()=>{driftInventory=true;},
    counts:()=>({listCalls,resourceReads,enables,disconnectListeners:disconnects.size}),restore:()=>activateWindowsRuntimeBuild(saved)};
}

test('Windows discovery keeps one verified socket beyond eight seconds of hidden accounts and resumes only on visible B',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:0});const f=discoveryInventory();t.after(f.restore);
  const messages:unknown[][]=[];t.mock.method(console,'log',(...args:unknown[])=>{messages.push(args);});
  let settled=false,waits=0;const discovering=f.discover(()=>{waits++;}).finally(()=>{settled=true;});await flush();
  for(let i=0;i<12;i++){t.mock.timers.tick(1000);await flush();}
  // Each loader is hash-verified once; hidden polling afterwards only re-reads visibility.
  assert.equal(settled,false);assert.equal(f.counts().resourceReads,2);assert.equal(f.counts().enables,2);assert.equal(f.worldNames.size,1);
  assert.equal(messages.filter(args=>typeof args[0]==='string'&&args[0].includes('runtime-waiting-visible')).length,1);
  // The unbounded hidden wait is reported once so the companion can release its busy state.
  assert.equal(waits,1);
  f.reload();t.mock.timers.tick(1000);await flush();assert.equal(f.counts().resourceReads,4);assert.equal(f.counts().enables,4);
  f.setVisible('B');t.mock.timers.tick(1000);await flush();const driver=await discovering;
  assert.equal(driver.target.targetId,'B');assert.equal(f.counts().disconnectListeners,1);
  assert.equal(f.attached.length,f.detached.length);await driver.disconnect();assert.equal(f.counts().disconnectListeners,0);
});

test('Windows hidden discovery still times out within eight seconds after verified targets disappear',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:0});const f=discoveryInventory();t.after(f.restore);
  let settled=false;const rejected=assert.rejects(f.discover().finally(()=>{settled=true;}),/IM_TARGET_NOT_READY/);await flush();
  for(let i=0;i<12;i++){t.mock.timers.tick(1000);await flush();}assert.equal(settled,false);
  f.removeTargets();for(let i=0;i<7;i++){t.mock.timers.tick(1000);await flush();}assert.equal(settled,false);
  t.mock.timers.tick(1000);await rejected;assert.equal(f.counts().disconnectListeners,0);assert.equal(f.attached.length,f.detached.length);
});

test('Windows hidden discovery wakes immediately on cancellation through transport disconnect and removes its listener',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:0});const f=discoveryInventory();t.after(f.restore);
  const rejected=assert.rejects(f.discover(),/CDP_DISCONNECTED/);await flush();const before=f.counts().listCalls;
  await f.transport.disconnect();await rejected;assert.equal(f.counts().disconnectListeners,0);
  t.mock.timers.tick(20000);await flush();assert.equal(f.counts().listCalls,before);
});

test('Windows hidden discovery continues rejecting changed hashes, ambiguous visible accounts and inventory drift',async t=>{
  for(const mode of ['hash','ambiguous','inventory'])await t.test(mode,async t=>{
    t.mock.timers.enable({apis:['setTimeout','Date'],now:0});const f=discoveryInventory();t.after(f.restore);
    const rejected=assert.rejects(f.discover(),mode==='hash'?/LOADED_DOCUMENT_HASH_MISMATCH/:mode==='ambiguous'?/AMBIGUOUS_IM_TARGET/:/RUNTIME_TARGET_CHANGED/);await flush();
    if(mode==='hash')f.corrupt();else if(mode==='ambiguous')f.setVisible('both');else f.driftInventory();
    t.mock.timers.tick(1000);await rejected;assert.equal(f.counts().disconnectListeners,0);assert.equal(f.attached.length,f.detached.length);
  });
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

test('lease-only active checks share one inventory observation; writes always observe afresh',{timeout:5000},async()=>{
  const world=inventory(),item=world.make('A');
  const [first,second]=await Promise.all([item.driver.verifyActiveTarget(true),item.driver.verifyActiveTarget(true)]);
  assert.equal(first,true);assert.equal(second,true);assert.equal(world.probes.length,2);
  await item.driver.verifyActiveTarget(true);assert.equal(world.probes.length,2);
  await item.driver.verifyActiveTarget(false);assert.equal(world.probes.length,4);
  await new Promise(resolve=>setTimeout(resolve,350));
  await item.driver.verifyActiveTarget(true);assert.equal(world.probes.length,6);
  // An account switch is observed once the reuse window has passed, and invalidates the epoch.
  world.setVisible('B');await new Promise(resolve=>setTimeout(resolve,350));
  await assert.rejects(item.driver.verifyActiveTarget(true),/RUNTIME_TARGET_CHANGED/);assert.equal(item.driver.invalid,true);
});

test('idle lease renewal keeps four attempts inside the six-second leases instead of one per poll',async t=>{
  t.mock.timers.enable({apis:['setInterval','Date'],now:0});
  const idle=composer(),service=await serviceFixture(idle.value);let renews=0;idle.value.renew=async()=>{renews++;};
  try{
    service.external=idle.value;service.foreground=false;service.updatePolling();
    for(let i=0;i<12;i++){t.mock.timers.tick(500);await flush();}
    assert.equal(renews,4);
  }finally{await service.dispose();}
});
