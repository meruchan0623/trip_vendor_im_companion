import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {LiveRuntimeDriver} from '../runtime/driver';
import {RUNTIME_PLATFORM,VERIFIED_RUNTIME_BUILD} from '../runtime/build-manifest';
import {readConversationId,readCurrentOrderHint} from '../runtime/page/conversation';
import {createNativeComposer} from '../runtime/native-composer';
import {embeddedPanelState} from '../electron/embedded-host';
import {mountPageFeatures} from '../runtime/page';
import {CompanionService} from '../electron/companion-service';

const order='1622931630893808';
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
function headerFixture(){
  const dom=new JSDOM('<body><div class="im_detail_hd chat-group-name"><div class="group-chat-hover-box-txt">订单号：'+order+'</div></div><div class="customer_info close"><iframe class="customer_order-detail" src="https://vbooking.ctrip.com/tour/im/ex-area/b?groupid=g&amp;sessionid=s&amp;serviceType=t&amp;status=1"></iframe></div><div class="chat_area-input"><div class="chat-func-list"></div><div class="tiptap ProseMirror chat-editor" contenteditable="true"></div></div></body>',{url:VERIFIED_RUNTIME_BUILD.documentURL,pretendToBeVisual:true});
  const document=dom.window.document,header=document.querySelector('.im_detail_hd')!;
  for(const [selector,rect] of [['.im_detail_hd',[10,10,400,30]],['.chat_area-input',[10,100,800,200]],['.chat-func-list',[10,100,800,40]],['.chat-editor',[10,150,800,100]]] as const){
    const element=document.querySelector(selector)!,[x,y,width,height]=rect;
    Object.defineProperty(element,'getClientRects',{value:()=>[{x,y,width,height}]});
    Object.defineProperty(element,'getBoundingClientRect',{value:()=>({x,y,width,height,left:x,top:y,right:x+width,bottom:y+height})});
  }
  const editorElement=document.querySelector('.chat-editor')!;
  Object.assign(editorElement,{editor:{view:{dom:editorElement,composing:false},isDestroyed:false,isEditable:true,getJSON:()=>({type:'doc',content:[{type:'paragraph'}]}),on(){},off(){},commands:{setContent(){throw Error('must not write');}}}});
  let state:any={currentConvId:'g',conversationList:[{gid:'g',sessionId:'s',serviceType:'t',status:1,relationOrderId:order}]};
  const store={getState:()=>state},root:any={containerInfo:document.body},rootFiber:any={tag:3,stateNode:root};root.current=rootFiber;
  function HeaderOwner(){return{relationOrderId:undefined,className:'group-chat-hover-box-txt'};}
  const owner:any={tag:0,type:HeaderOwner,return:rootFiber,dependencies:{firstContext:{memoizedValue:{ctrl:{store}},next:null}}};
  const alternateOwner:any={...owner,dependencies:{firstContext:{memoizedValue:{ctrl:{store}},next:null}}};
  const fiber:any={tag:5,return:owner,alternate:{tag:5,return:alternateOwner}};
  Object.defineProperty(header,'__reactFiber$fixture',{value:fiber,configurable:true});
  return{dom,document,header,owner,alternateOwner,get state(){return state;},set state(value:any){state=value;}};
}

test('runner selects the macOS manifest rather than the Windows host default',()=>assert.equal(RUNTIME_PLATFORM,'darwin'));
test('Mac native polls expose a structurally verified early hint with a collapsed unreadable order frame',()=>{
  const f=headerFixture(),native=createNativeComposer({leaseId:'a'.repeat(32),documentGeneration:1},f.document);
  try{
    const poll=native.poll(1);assert.equal(poll.writeVerified,true);assert.equal(poll.orderFrame,undefined);
    assert.deepEqual(poll.currentOrderHint,{identifier:order,conversationId:poll.snapshot!.conversationId});
    f.state={currentConvId:'other',conversationList:[{gid:'other',sessionId:'other',serviceType:'t',status:1,relationOrderId:'OTHER123'}]};
    const switched=native.poll(1);assert.equal(switched.writeVerified,false);assert.equal(switched.reason,'CONVERSATION_SOURCE_UNVERIFIED');assert.equal(switched.currentOrderHint,undefined);
  }finally{native.dispose();f.dom.window.close();}
});
test('Mac unknown owner contracts retain the iframe conversation without accepting an early private-store hint',()=>{
  for(const mode of ['no-pointer','unknown-owner']){
    const f=headerFixture();try{
      if(mode==='no-pointer')delete(f.header as any).__reactFiber$fixture;
      else{f.owner.type=f.alternateOwner.type=function UnknownOwner(){};f.owner.dependencies.firstContext.memoizedValue.ctrl.store={getState(){throw Error('unsupported store must not be read');}};}
      const expected=readConversationId(f.document);assert.equal(readConversationId(f.document,true),expected);assert.equal(readCurrentOrderHint(f.document,expected),undefined);
    }finally{f.dom.window.close();}
  }
});
test('Mac recognized alternate/store disagreement blocks the old iframe conversation',()=>{
  const f=headerFixture();try{f.alternateOwner.dependencies.firstContext.memoizedValue.ctrl.store={getState:()=>f.state};assert.throws(()=>readConversationId(f.document,true),/CONVERSATION_SOURCE_UNVERIFIED/);}finally{f.dom.window.close();}
});
test('Mac partial owner capability and a recognized source with a stale label cannot fall back to an old order',()=>{
  const f=headerFixture();try{
    f.header.querySelector('.group-chat-hover-box-txt')!.textContent='订单号：OLD12345';
    const conversation=readConversationId(f.document,true);assert.equal(readCurrentOrderHint(f.document,conversation),null);
    assert.equal(embeddedPanelState({messageSurface:{active:true},currentOrderHint:null,orderEntries:[{identifier:order}]} as any,JSON.stringify(['target',conversation,1,'account'])).detectedOrder?.identifier,null);
    f.owner.type=function UnknownOwner(){};assert.throws(()=>readConversationId(f.document,true),/CONVERSATION_SOURCE_UNVERIFIED/);
  }finally{f.dom.window.close();}
});
function driverFixture(){
  let polls=0,childReads=0;
  const driver:any=Object.create(LiveRuntimeDriver.prototype);
  Object.assign(driver,{epoch:0,invalid:false,verifyActiveTarget:async()=>true,policy:{installNative:async()=>{},verifyExactDocument:async()=>{},renewNative:async()=>{},readMessageNavigation:async()=>({active:true,width:1000,height:800,dpr:2}),pollNative:async()=>{polls++;return{snapshot:{conversationId:'current'},messageSurface:{active:true},currentOrderHint:{identifier:order,conversationId:'current'}};},readRightOrderEntries:async()=>{childReads++;throw Error('Windows frame reader must not run');}}});
  return{driver,get polls(){return polls;},get childReads(){return childReads;}};
}
test('Mac driver double-checks hints without invoking Windows child-frame discovery',async()=>{
  for(const mode of ['stable','changed','wrong-conversation','missing']){
    const f=driverFixture(),poll=f.driver.policy.pollNative;
    f.driver.policy.pollNative=async()=>{const result=await poll();return f.polls===2&&mode!=='stable'?{...result,currentOrderHint:mode==='missing'?undefined:{identifier:mode==='changed'?'OTHER123':order,conversationId:mode==='wrong-conversation'?'other':'current'}}:result;};
    const result=await(await f.driver.externalComposer('','')).read(1);
    assert.equal(result.currentOrderHint?.identifier,mode==='stable'?order:undefined);assert.equal(f.childReads,0);assert.equal(f.polls,2);
  }
});
test('Mac independent identity gates start together, await cleanup and never poll after a failure',async()=>{
  for(const failed of [false,true]){
    const f=driverFixture(),gate=deferred(),started:string[]=[];
    f.driver.policy.verifyExactDocument=async()=>{started.push('document');if(failed)throw Error('UNVERIFIED_DOCUMENT');};
    f.driver.policy.renewNative=async()=>{started.push('lease');};
    f.driver.policy.readMessageNavigation=async()=>{started.push('navigation');await gate.promise;return{active:true,width:1000,height:800,dpr:2};};
    let settled=false;const reading=(await f.driver.externalComposer('','')).read(1).finally(()=>{settled=true;});
    const rejected=failed?assert.rejects(reading,/UNVERIFIED_DOCUMENT/):undefined;
    await flush();assert.deepEqual(started,['document','lease','navigation']);assert.equal(f.polls,0);assert.equal(settled,false);
    gate.resolve();if(rejected)await rejected;else await reading;assert.equal(f.polls,failed?0:2);
  }
});
test('Mac active-target verification probes in parallel and settles all temporary sessions before failure',async()=>{
  for(const failed of [false,true]){
    const ids=['selected','hidden'],attached:string[]=[],detached:string[]=[],cleanup=deferred(),source='Mac pinned fixture';
    const driver:any=Object.create(LiveRuntimeDriver.prototype);let settled=false;
    Object.assign(driver,{epoch:0,invalid:false,invalidate(){},target:{targetId:'selected',frameId:'selected-frame',contextNonce:'fixture',fingerprint:{htmlSha256:createHash('sha256').update(source).digest('hex')}},transport:{send:async(method:string,params:any,session?:string)=>{
      if(method==='Target.getTargets')return{targetInfos:ids.map(targetId=>({type:'page',targetId,url:VERIFIED_RUNTIME_BUILD.documentURL}))};
      if(method==='Target.attachToTarget'){attached.push(params.targetId);return{sessionId:params.targetId};}
      if(method==='Target.detachFromTarget'){if(params.sessionId==='hidden')await cleanup.promise;detached.push(params.sessionId);return{};}
      if(method==='Page.enable')return{};
      if(method==='Page.getFrameTree')return{frameTree:{frame:{id:session+'-frame',url:VERIFIED_RUNTIME_BUILD.documentURL,loaderId:'same'}}};
      if(method==='Page.getResourceContent')return{content:failed&&session==='selected'?'changed':source,base64Encoded:false};
      if(method==='Page.createIsolatedWorld')return{executionContextId:2};
      if(method==='Runtime.evaluate')return{result:{value:{visible:session==='selected',focused:session==='selected'}}};
      throw Error('Unexpected '+method);
    }}});
    const verifying=driver.verifyActiveTarget().finally(()=>{settled=true;}),rejected=failed?assert.rejects(verifying,/LOADED_DOCUMENT_HASH_MISMATCH/):undefined;
    await flush();assert.deepEqual(attached,ids);assert.equal(settled,false);cleanup.resolve();if(rejected)await rejected;else assert.equal(await verifying,true);assert.deepEqual(detached.sort(),[...ids].sort());
  }
});
test('Mac host hints reach the page and stop masking legacy observation when withdrawn',()=>{
  const f=headerFixture(),conversation=readConversationId(f.document),key=JSON.stringify(['target',conversation,1,'account']);
  const base:any={auth:'ready',attached:true,composerSource:'verified-editor',phase:'idle',messageSurface:{active:true},currentOrderHint:{identifier:order,conversationId:conversation},orderEntries:[],language:'en',preview:null,error:null};
  const state=embeddedPanelState(base,key),page=mountPageFeatures(f.document,{state,bridge:{invoke:async()=>{}},prewarmDelayMs:60000});
  try{
    const root=page.panel!.host.shadowRoot!;assert.equal(state.detectedOrder?.identifier,order);assert.ok(root.textContent?.includes(order));
    const absent=embeddedPanelState({...base,currentOrderHint:undefined},key);assert.equal('detectedOrder' in absent,false);page.update(absent);assert.ok(!root.textContent?.includes(order));
    page.update(state);assert.ok(root.textContent?.includes(order));page.update(embeddedPanelState(base,JSON.stringify(['target','other',2,'other-account'])));assert.ok(!root.textContent?.includes(order));
  }finally{page.dispose();f.dom.window.close();}
});
test('Mac late iframe loads cannot overwrite an accepted host hint, and resume after hint withdrawal',()=>{
  const f=headerFixture(),conversation=readConversationId(f.document),key=JSON.stringify(['target',conversation,1,'account']);
  const base:any={auth:'ready',attached:true,composerSource:'verified-editor',phase:'idle',messageSurface:{active:true},currentOrderHint:{identifier:order,conversationId:conversation},orderEntries:[],language:'en',preview:null,error:null};
  const child=new JSDOM('<ul class="im_info_basic_list"><li><span class="im_info_basic_list_title">订单ID</span><span class="im_info_basic_list_content">1234567890</span></li></ul>',{url:'https://vbooking.ctrip.com/tour/im/ex-area/b/imExtraInfo?groupid=g&sessionid=s&servicetype=t&status=1'});
  const frame=f.document.querySelector('iframe')!;Object.defineProperty(frame,'contentDocument',{get:()=>child.window.document});
  const state=embeddedPanelState(base,key),page=mountPageFeatures(f.document,{state,bridge:{invoke:async()=>{}},prewarmDelayMs:60000});
  try{
    frame.dispatchEvent(new f.dom.window.Event('load'));const root=page.panel!.host.shadowRoot!;
    assert.ok(root.textContent?.includes(order));assert.ok(!root.textContent?.includes('1234567890'));
    page.update(embeddedPanelState({...base,currentOrderHint:null},key));assert.ok(!root.textContent?.includes('1234567890'));assert.ok(!root.textContent?.includes(order));
    page.update(embeddedPanelState({...base,currentOrderHint:undefined},key));assert.ok(root.textContent?.includes('1234567890'));
  }finally{page.dispose();child.window.close();f.dom.window.close();}
});
test('Mac pinned-build and lease failures cannot admit an otherwise well-formed hint',async()=>{
  let commands=0;
  await assert.rejects(LiveRuntimeDriver.discover({send:async()=>{commands++;throw Error('must not send');}} as never,{...VERIFIED_RUNTIME_BUILD,rendererSha256:'0'.repeat(64)},'','0'.repeat(64)),/UNVERIFIED_BUILD/);assert.equal(commands,0);
  const f=driverFixture();f.driver.policy.renewNative=async()=>{throw Error('NATIVE_LEASE_ENDED');};
  await assert.rejects((await f.driver.externalComposer('','')).read(1),/NATIVE_LEASE_ENDED/);assert.equal(f.polls,0);
  const h=headerFixture(),native=createNativeComposer({leaseId:'a'.repeat(32),documentGeneration:1},h.document);
  native.dispose();assert.throws(()=>native.poll(1),/NATIVE_LEASE_ENDED/);h.dom.window.close();
});
test('Mac discovery cancellation removes its temporary listener without waiting for the polling timer',async()=>{
  const listeners=new Set<()=>void>();let inventories=0;
  const transport:any={onDisconnect:(callback:()=>void)=>{listeners.add(callback);return()=>listeners.delete(callback);},send:async(method:string)=>{assert.equal(method,'Target.getTargets');inventories++;return{targetInfos:[]};}};
  const discovery=LiveRuntimeDriver.discover(transport,VERIFIED_RUNTIME_BUILD,'','0'.repeat(64),60000),rejected=assert.rejects(discovery,/CDP_DISCONNECTED/);
  await flush();assert.equal(listeners.size,1);for(const listener of listeners)listener();await rejected;assert.equal(listeners.size,0);assert.equal(inventories,1);
});
test('Mac no-target discovery retains its bounded deadline and removes the disconnect listener',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:0});const listeners=new Set<()=>void>();
  const transport:any={onDisconnect:(callback:()=>void)=>{listeners.add(callback);return()=>listeners.delete(callback);},send:async()=>({targetInfos:[]})};
  const rejected=assert.rejects(LiveRuntimeDriver.discover(transport,VERIFIED_RUNTIME_BUILD,'','0'.repeat(64),250),/IM_TARGET_NOT_READY/);
  await flush();t.mock.timers.tick(250);await rejected;assert.equal(listeners.size,0);
});
test('Mac order authorization rechecks the owned account and capture before returning a grant',async()=>{
  for(const changed of [false,true]){
    const gate=deferred();let grants=0,current:any={accountScope:'owned:1',authGeneration:1,permissions:[]};
    const session:any={identity:()=>current,sync:async()=>{},setBackgroundPolling(){},getBrowserProfile:()=>null,operatorGrant:()=>{grants++;return{accessToken:'fixture',sessionRef:'fixture-ref'};},dispose:async()=>{}};
    const service=new CompanionService({} as never,async()=>{},()=>{},{enabled:false},true,()=>session),fixture=service as any;
    try{
      await fixture.sessionStarting;fixture.state={...service.getState(),sessionMode:'owned',auth:'ready',attached:true,targetInstanceId:'target',messageSurface:{active:true}};fixture.foreground=true;fixture.external={close:async()=>{}};
      fixture.captured={source:'verified-editor',snapshot:{conversationId:'current',scopeGeneration:1,platformAccountScope:'vendor:1'},orderEntries:[]};
      fixture.capture=async()=>{await gate.promise;return fixture.captured;};fixture.adopt=()=>{};fixture.publish=()=>{};
      const granting=service.operatorSession({identifier:order,identifierType:'order_number',conversationKey:fixture.context()});
      const rejected=changed?assert.rejects(granting,/ORDER_CONTEXT_CHANGED/):undefined;await flush();assert.equal(grants,0);
      if(changed)current={...current,accountScope:'owned:2',authGeneration:2};gate.resolve();if(rejected)await rejected;else assert.deepEqual(await granting,{accessToken:'fixture',sessionRef:'fixture-ref'});assert.equal(grants,changed?0:1);
    }finally{await service.dispose();}
  }
});
