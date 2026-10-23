import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveRuntimeDriver} from '../runtime/driver';
import {RuntimeCDPPolicy} from '../runtime/cdp-policy';
import {embeddedPanelState} from '../electron/embedded-host';
import {mountPageFeatures} from '../runtime/page';
import {JSDOM} from 'jsdom';
import {createHash} from 'node:crypto';
import {WINDOWS_RUNTIME_BUILD} from '../runtime/build-manifest';
import {readConversationId,readCurrentOrderHint,readHeaderConversation} from '../runtime/page/conversation';
import {CompanionService} from '../electron/companion-service';

const order='1622931630893808';
test('out-of-process order frames use the DOM frame ID and detach after every outcome',async t=>{
  for(const mode of ['normal','wrong-target','wrong-parent','wrong-conversation','wrong-service','navigated','replaced','read-error','session-changed'])await t.test(mode,async()=>{
    let attached=0,detached=0,inspected=0,nodes=0,childTrees=0;
    const source='https://vbooking.ctrip.com/tour/im/ex-area/b?groupid=g&sessionid=s&serviceType=t&status=1';
    const actual='https://vbooking.ctrip.com/tour/im/ex-area/b/imExtraInfo?groupid=g&sessionid='+(mode==='wrong-conversation'?'other':'s')+'&servicetype='+(mode==='wrong-service'?'other':'t')+'&status=1';
    const policy:any=Object.create(RuntimeCDPPolicy.prototype);
    Object.assign(policy,{isolatedContextId:1,sessionId:'parent-session',generation:0,target:{frameId:'main',contextNonce:'test'},transport:{send:async(method:string,params:any,session?:string)=>{
      if(method==='Target.getTargets')return{targetInfos:[{targetId:mode==='wrong-target'?'unrelated':'child',type:'iframe',url:actual}]};
      if(method==='Target.attachToTarget'){assert.equal(params.targetId,'child');attached++;return{sessionId:'child-session'};}
      if(method==='Target.detachFromTarget'){assert.equal(params.sessionId,'child-session');detached++;return{};}
      if(method==='Page.getFrameTree'){
        if(session==='parent-session')return{frameTree:{frame:{id:'main'},childFrames:[{frame:{id:'risk',parentId:'main',url:'about:blank'}}]}};
        assert.equal(session,'child-session');childTrees++;return{frameTree:{frame:{id:'child',parentId:mode==='wrong-parent'?'other':'main',url:actual,loaderId:mode==='navigated'&&childTrees>1?'new':'original'}}};
      }
      if(method==='Runtime.evaluate'&&params.returnByValue===false){assert.equal(session,'parent-session');return{result:{objectId:'frame-object'}};}
      if(method==='DOM.describeNode'){nodes++;return{node:{frameId:mode==='replaced'&&nodes>1?'replacement':'child',attributes:['src',source]}};}
      if(method==='Runtime.releaseObject')return{};
      if(method==='Page.createIsolatedWorld'){assert.equal(session,'child-session');assert.equal(params.frameId,'child');return{executionContextId:2};}
      if(method==='Runtime.evaluate'){
        assert.equal(session,'child-session');assert.equal(params.contextId,2);inspected++;
        if(mode==='read-error')throw Error('CDP_COMMAND_REJECTED');
        if(mode==='session-changed')policy.generation++;
        return{result:{value:{width:400,height:600,entries:[{identifier:order,identifierType:'order_number',rect:{x:10,y:20,width:100,height:15}}]}}};
      }
      throw Error('Unexpected '+method);
    }}});
    const read=()=>policy.readRightOrderEntries({rect:{x:500,y:100,width:400,height:600},clientWidth:400,clientHeight:600,clientLeft:0,clientTop:0});
    if(['read-error','session-changed'].includes(mode))await assert.rejects(read);else assert.equal((await read()).length,mode==='normal'?1:0);
    assert.equal(detached,attached);if(['wrong-target','wrong-parent','wrong-conversation','wrong-service'].includes(mode))assert.equal(inspected,0);
  });
});
test('child-world reader supports the Windows redirect and rejects a different customer frame',async()=>{
  for(const mismatch of [false,true]){
    let inspected=false;
    const source='https://vbooking.ctrip.com/tour/im/ex-area/b?groupid=g&sessionid=s&serviceType=t&status=1';
    const actual='https://vbooking.ctrip.com/tour/im/ex-area/b/imExtraInfo?groupid=g&sessionid='+(mismatch?'other':'s')+'&status=1';
    const policy:any=Object.create(RuntimeCDPPolicy.prototype);
    Object.assign(policy,{isolatedContextId:1,sessionId:'session',generation:0,target:{frameId:'main',contextNonce:'test'},transport:{send:async(method:string,params:any)=>{
      if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'main'},childFrames:[{frame:{id:'child',parentId:'main',url:actual}}]}};
      if(method==='Runtime.evaluate'&&params.returnByValue===false)return{result:{objectId:'frame-object'}};
      if(method==='DOM.describeNode')return{node:{frameId:'child',attributes:['src',source]}};
      if(method==='Runtime.releaseObject')return{};
      if(method==='Page.createIsolatedWorld')return{executionContextId:2};
      if(method==='Runtime.evaluate'){inspected=true;assert.equal(params.contextId,2);return{result:{value:{width:400,height:600,entries:[{identifier:order,identifierType:'order_number',rect:{x:10,y:20,width:100,height:15}}]}}};}
      throw Error('Unexpected '+method);
    }}});
    const entries=await policy.readRightOrderEntries({rect:{x:500,y:100,width:400,height:600},clientWidth:400,clientHeight:600,clientLeft:0,clientTop:0});
    assert.equal(inspected,!mismatch);assert.equal(entries.length,mismatch?0:1);
    if(!mismatch)assert.deepEqual(entries[0].rect,{x:510,y:120,width:100,height:15});
  }
});
function fixture(mode='normal'){
  let polls=0,reads=0;
  const frame={rect:{x:0,y:0,width:400,height:600},clientWidth:400,clientHeight:600,clientLeft:0,clientTop:0};
  const driver:any=Object.create(LiveRuntimeDriver.prototype);
  Object.assign(driver,{epoch:0,invalid:false,verifyActiveTarget:async()=>true,policy:{
    installNative:async()=>{},verifyExactDocument:async()=>{},renewNative:async()=>{},
    readMessageNavigation:async()=>({active:true,dpr:1,width:1000,height:800}),
    pollNative:async()=>({snapshot:{conversationId:mode==='switch'&&++polls===2?'new':'current'},messageSurface:{active:true},orderFrame:mode==='geometry'&&++polls===2?undefined:frame}),
    readRightOrderEntries:async()=>{reads++;if(mode==='failed')throw Error('FRAME_GONE');return[{identifier:order,identifierType:'order_number',rect:frame.rect}];},
  }});
  return{driver,reads:()=>reads};
}
test('Windows reads the order child frame and retains its verified entry',async()=>{
  const f=fixture(),port=await f.driver.externalComposer('',''),result=await port.read(0);
  assert.equal(f.reads(),1);assert.equal(result.orderEntries[0].identifier,order);
});
test('a stable current-conversation hint skips child-frame reads even with the right panel collapsed',async()=>{
  for(const collapsed of [false,true]){
    const f=fixture(),poll=f.driver.policy.pollNative;
    f.driver.policy.pollNative=async()=>({...await poll(),...(collapsed?{orderFrame:undefined}:{}),currentOrderHint:{identifier:order,conversationId:'current'}});
    const result=await(await f.driver.externalComposer('','')).read(0);
    assert.deepEqual(result.currentOrderHint,{identifier:order,conversationId:'current'});assert.deepEqual(result.orderEntries,[]);assert.equal(f.reads(),0);
  }
});
test('changed, malformed or cross-conversation hints cannot survive the second native observation',async()=>{
  for(const mode of ['changed','cross-conversation','missing','malformed']){
    const f=fixture(),poll=f.driver.policy.pollNative;let count=0;
    f.driver.policy.pollNative=async()=>({...await poll(),currentOrderHint:++count===1?{identifier:order,conversationId:'current'}:mode==='missing'?undefined:{identifier:mode==='changed'?'OTHER123':mode==='malformed'?'bad value':order,conversationId:mode==='cross-conversation'?'other':'current'}});
    const result=await(await f.driver.externalComposer('','')).read(0);assert.equal(result.currentOrderHint,undefined);assert.equal(f.reads(),0);
  }
});
test('conversation/geometry changes discard the order; failed reads preserve composer availability',async()=>{
  for(const mode of ['switch','geometry','failed']){
    const f=fixture(mode),result=await(await f.driver.externalComposer('','')).read(0);
    assert.deepEqual(result.orderEntries,[]);if(mode==='failed')assert.equal(result.messageSurface.active,true);
  }
});
test('read starts independent identity gates together but cannot poll before they all pass',async()=>{
  const f=fixture(),policy=f.driver.policy,started:string[]=[];
  let release!:()=>void;
  policy.verifyExactDocument=async()=>{started.push('document');await new Promise<void>(resolve=>{release=resolve;});};
  policy.renewNative=async()=>{started.push('lease');};
  const navigation=policy.readMessageNavigation;
  policy.readMessageNavigation=async()=>{started.push('navigation');return navigation();};
  const poll=policy.pollNative;
  policy.pollNative=async()=>{started.push('poll');return poll();};
  const port=await f.driver.externalComposer('',''),reading=port.read(0);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(started,['document','lease','navigation']);
  release();assert.equal((await reading).orderEntries.length,1);
  assert.equal(started.filter(value=>value==='poll').length,2);
});
test('an identity gate rejection never reads business text even when other gates finish',async()=>{
  const f=fixture();let polls=0;
  f.driver.policy.verifyExactDocument=async()=>{throw Error('LOADED_DOCUMENT_HASH_MISMATCH');};
  f.driver.policy.pollNative=async()=>{polls++;return{};};
  await assert.rejects((await f.driver.externalComposer('','')).read(0),/LOADED_DOCUMENT_HASH_MISMATCH/);
  assert.equal(polls,0);assert.equal(f.reads(),0);
});
test('a rejected document gate waits for in-flight navigation initialization before read returns',async()=>{
  const f=fixture();let release!:()=>void,completed=false,initialized=false;
  f.driver.policy.verifyExactDocument=async()=>{throw Error('LOADED_DOCUMENT_HASH_MISMATCH');};
  f.driver.policy.readMessageNavigation=async()=>{await new Promise<void>(resolve=>{release=resolve;});initialized=true;return{active:true,dpr:1,width:1000,height:800};};
  const reading=(await f.driver.externalComposer('','')).read(0).catch((error:unknown)=>{completed=true;throw error;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(completed,false);assert.equal(initialized,false);
  release();await assert.rejects(reading,/LOADED_DOCUMENT_HASH_MISMATCH/);assert.equal(initialized,true);assert.equal(f.reads(),0);
});
test('active-account probes run in parallel and await all owned session cleanup on failure',async()=>{
  for(const failed of [false,true]){
    const ids=['hidden-a','selected','hidden-b'],attached:string[]=[],detached:string[]=[],source='fixture-html';
    let release!:()=>void,completed=false,inventoryReads=0;
    const cleanup=new Promise<void>(resolve=>{release=resolve;});
    const driver:any=Object.create(LiveRuntimeDriver.prototype);
    Object.assign(driver,{epoch:0,invalid:false,invalidate:()=>{},target:{targetId:'selected',frameId:'selected-frame',contextNonce:'fixture',fingerprint:{htmlSha256:createHash('sha256').update(source).digest('hex')}},transport:{send:async(method:string,params:any,session?:string)=>{
      if(method==='Target.getTargets'){inventoryReads++;return{targetInfos:ids.map(targetId=>({type:'page',targetId,url:WINDOWS_RUNTIME_BUILD.documentURL}))};}
      if(method==='Target.attachToTarget'){attached.push(params.targetId);return{sessionId:params.targetId};}
      if(method==='Target.detachFromTarget'){if(params.sessionId==='hidden-b')await cleanup;detached.push(params.sessionId);return{};}
      if(method==='Page.enable')return{};
      if(method==='Page.getFrameTree')return{frameTree:{frame:{id:session+'-frame',url:WINDOWS_RUNTIME_BUILD.documentURL,loaderId:'fixture'}}};
      if(method==='Page.getResourceContent')return{content:failed&&session==='hidden-a'?'changed':source,base64Encoded:false};
      if(method==='Page.createIsolatedWorld')return{executionContextId:2};
      if(method==='Runtime.evaluate')return{result:{value:{visible:session==='selected',focused:session==='selected'}}};
      throw Error('Unexpected '+method);
    }}});
    const reading=driver.verifyActiveTarget().then((value:boolean)=>{completed=true;return value;},(error:unknown)=>{completed=true;throw error;});
    // Attach/verification of all three accounts must progress while one cleanup
    // is delayed. Even a rejected sibling must not abandon that owned session.
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(attached,ids);assert.equal(completed,false);assert.ok(!detached.includes('hidden-b'));
    release();if(failed)await assert.rejects(reading,/LOADED_DOCUMENT_HASH_MISMATCH/);else assert.equal(await reading,true);
    assert.deepEqual([...detached].sort(),[...ids].sort());assert.equal(inventoryReads,failed?1:2);
  }
});
test('host order reaches the panel without parent access to the cross-origin document and clears on switch',()=>{
  const dom=new JSDOM('<body><div class="customer_info"><iframe class="customer_order-detail" src="https://vbooking.ctrip.com/tour/im/ex-area/b?groupid=g&sessionid=s&serviceType=t&status=1"></iframe></div></body>',{url:'https://merchant.invalid'});
  const key=JSON.stringify(['target',JSON.stringify(['g','s','t','1']),1,'account']);
  const base:any={auth:'ready',attached:true,composerSource:'verified-editor',phase:'idle',messageSurface:{active:true},orderEntries:[{identifier:order}],language:'en',preview:null,error:null};
  const state=embeddedPanelState(base,key);assert.equal(state.detectedOrder?.identifier,order);
  const features=mountPageFeatures(dom.window.document,{state,bridge:{invoke:async()=>{}},prewarmDelayMs:60000});
  const root=features.panel!.host.shadowRoot!;
  assert.ok(root.textContent?.includes(order));
  features.update({...state,conversationKey:'invalid',detectedOrder:{identifier:null}});
  assert.ok(!root.textContent?.includes(order));
  features.dispose();dom.window.close();
  assert.equal(embeddedPanelState({...base,messageSurface:{active:false}},key).detectedOrder?.identifier,null);
  assert.equal(embeddedPanelState({...base,orderEntries:[{identifier:order},{identifier:'123456'}]},key).detectedOrder?.identifier,null);
});
function headerFixture(){
  const dom=new JSDOM('<body><div class="im_detail_hd chat-group-name"><div class="group-chat-hover-box-txt">订单号：'+order+'</div></div><div class="customer_info close"><iframe class="customer_order-detail" src="https://vbooking.ctrip.com/tour/im/ex-area/b?groupid=g&amp;sessionid=s&amp;serviceType=t&amp;status=1"></iframe></div></body>',{url:'https://merchant.invalid',pretendToBeVisual:true});
  const document=dom.window.document,header=document.querySelector('.im_detail_hd')!;
  Object.defineProperty(header,'getClientRects',{value:()=>[{x:1,y:1,width:100,height:20}]});
  let state:any={currentConvId:'g',conversationList:[{gid:'g',sessionId:'s',serviceType:'t',status:1,relationOrderId:order}]};
  const store={getState:()=>state},root:any={containerInfo:document.body},rootFiber:any={tag:3,stateNode:root};root.current=rootFiber;
  function HeaderOwner(){return{relationOrderId:undefined,className:'group-chat-hover-box-txt'};}
  const owner:any={tag:0,type:HeaderOwner,return:rootFiber,dependencies:{firstContext:{memoizedValue:{ctrl:{store}},next:null}}};
  const alternateOwner:any={...owner,dependencies:{firstContext:{memoizedValue:{ctrl:{store}},next:null}}};
  const alternate:any={tag:5,return:alternateOwner},fiber:any={tag:5,return:owner,alternate};alternate.alternate=fiber;
  Object.defineProperty(header,'__reactFiber$fixture',{value:fiber,configurable:true});
  return{dom,document,header,store,root,owner,alternateOwner,fiber,get state(){return state;},set state(value:any){state=value;}};
}
test('the fixed header live store yields an early order with the right panel collapsed',()=>{
  const f=headerFixture();try{
    const conversation=readConversationId(f.document,true);
    assert.deepEqual(readCurrentOrderHint(f.document,conversation),{identifier:order,conversationId:conversation});
    assert.equal(readHeaderConversation(f.document)?.identifier,order);
    // An alternate's old hook data is deliberately ignored in favor of getState().
    f.alternateOwner.memoizedState={relationOrderId:'STALE123'};
    assert.equal(readCurrentOrderHint(f.document,conversation)?.identifier,order);
  }finally{f.dom.window.close();}
});
test('live-store/iframe disagreement blocks the old conversation before authorization',()=>{
  for(const mode of ['switched','duplicate','missing','unsafe-id']){
    const f=headerFixture();try{
      if(mode==='switched')f.state={currentConvId:'new',conversationList:[{gid:'new',sessionId:'new',serviceType:'t',status:1,relationOrderId:'NEW12345'}]};
      if(mode==='duplicate')f.state.conversationList.push({...f.state.conversationList[0]});
      if(mode==='missing')f.state.currentConvId='not-loaded';
      if(mode==='unsafe-id')f.state.conversationList[0].gid=9007199254740992;
      assert.throws(()=>readConversationId(f.document,true),/CONVERSATION_SOURCE_UNVERIFIED/);
    }finally{f.dom.window.close();}
  }
});
test('no-order consultations still expose a verified conversation and permit manual identifiers',()=>{
  const f=headerFixture();try{
    delete f.state.conversationList[0].relationOrderId;f.header.replaceChildren();
    const conversation=readConversationId(f.document,true);assert.equal(conversation,readConversationId(f.document));
    assert.equal(readCurrentOrderHint(f.document,conversation),undefined);
  }finally{f.dom.window.close();}
});
test('recognized header source ambiguity blocks the old iframe instead of silently falling back',()=>{
  for(const mode of ['root','stores','owner','extra-header','hidden','extra-pointer','empty-pointer','pointer-accessor']){
    const f=headerFixture();try{
      if(mode==='root')f.root.containerInfo=f.document.createElement('div');
      if(mode==='stores')f.alternateOwner.dependencies.firstContext.memoizedValue.ctrl.store={getState:()=>f.state};
      if(mode==='owner')f.owner.type=function Unrelated(){return{relationOrderId:order};};
      if(mode==='extra-header')f.document.body.append(f.header.cloneNode(true));
      if(mode==='hidden')f.header.setAttribute('hidden','');
      if(mode==='extra-pointer')Object.defineProperty(f.header,'__reactFiber$other',{value:f.fiber});
      if(mode==='empty-pointer')Object.defineProperty(f.header,'__reactFiber$fixture',{value:undefined});
      if(mode==='pointer-accessor')Object.defineProperty(f.header,'__reactFiber$fixture',{get:()=>{throw Error('must not invoke');}});
      assert.deepEqual(readHeaderConversation(f.document),{conversationId:null,identifier:null});
      assert.throws(()=>readConversationId(f.document,true),/CONVERSATION_SOURCE_UNVERIFIED/);
      assert.throws(()=>readCurrentOrderHint(f.document,readConversationId(f.document)),/CONVERSATION_SOURCE_UNVERIFIED/);
    }finally{f.dom.window.close();}
  }
});
test('a completely unsupported header keeps controlled iframe fallback while stale labels only suppress the hint',()=>{
  for(const mode of ['no-header','no-pointer','stale-label']){
    const f=headerFixture();try{
      const expected=readConversationId(f.document);
      if(mode==='no-header')f.header.remove();
      if(mode==='no-pointer')delete(f.header as any).__reactFiber$fixture;
      if(mode==='stale-label')f.header.querySelector('.group-chat-hover-box-txt')!.textContent='订单号：OLD12345';
      assert.equal(readConversationId(f.document,true),expected);assert.equal(readCurrentOrderHint(f.document,expected),undefined);
    }finally{f.dom.window.close();}
  }
});
test('host hints remain separate from visible overlay ranges and clear for another conversation',()=>{
  const conversation=JSON.stringify(['g','s','t','1']),key=JSON.stringify(['target',conversation,1,'account']);
  const state:any={auth:'ready',attached:true,composerSource:'verified-editor',phase:'idle',messageSurface:{active:true},currentOrderHint:{identifier:order,conversationId:conversation},orderEntries:[],language:'en',preview:null,error:null};
  assert.equal(embeddedPanelState(state,key).detectedOrder?.identifier,order);
  assert.equal(embeddedPanelState(state,JSON.stringify(['target','other',1,'account'])).detectedOrder?.identifier,null);
  assert.equal(embeddedPanelState({...state,messageSurface:{active:false}},key).detectedOrder?.identifier,null);
});
async function sessionFixture(){
  let identity:any={accountScope:'psim:fixture',authGeneration:1,permissions:[]},grants=0;
  const session={identity:()=>identity,sync:async()=>{},setBackgroundPolling(){},getBrowserProfile:()=>null,operatorGrant:()=>{grants++;return{accessToken:'fixture-token',sessionRef:'fixture-ref'};},translate:async()=>{throw Error('unused');},queryOriginalIdentifier:async()=>{throw Error('unused');},openLogin:async()=>{},logout:async()=>{},dispose(){}};
  const service=new CompanionService({} as never,async()=>{},()=>{},{enabled:false},true,()=>session as never),fixture=service as any;
  await fixture.sessionStarting;
  fixture.state={...service.getState(),auth:'ready',attached:true,targetInstanceId:'1:2:3',messageSurface:{active:true,composerRect:null,toolbarRect:null},currentOrderHint:{identifier:order,conversationId:'customer'}};
  fixture.foreground=true;fixture.external={close:async()=>{}};
  fixture.captured={source:'verified-editor',snapshot:{conversationId:'customer',scopeGeneration:1,platformAccountScope:'vendor:fixture'},currentOrderHint:null,orderEntries:[]};
  fixture.capture=async()=>fixture.captured;fixture.adopt=(capture:any)=>{fixture.captured=capture;fixture.state.currentOrderHint=capture.currentOrderHint??null;};fixture.publish=()=>{};
  const intent={identifier:'89123456789012345678',identifierType:'iccid' as const,conversationKey:fixture.context()};
  return{service,fixture,intent,get grants(){return grants;},set identity(value:any){identity=value;}};
}
test('operator handoff waits for observation and freshly captures a no-order consultation before granting manual card lookup',async()=>{
  const f=await sessionFixture();let release!:()=>void,captures=0;
  try{
    f.fixture.observation=new Promise<void>(resolve=>{release=resolve;});
    f.fixture.capture=async()=>{captures++;return f.fixture.captured;};
    const opening=f.service.operatorSession(f.intent);
    await new Promise(resolve=>setImmediate(resolve));assert.equal(captures,0);assert.equal(f.grants,0);
    release();assert.deepEqual(await opening,{accessToken:'fixture-token',sessionRef:'fixture-ref'});assert.equal(captures,1);assert.equal(f.grants,1);assert.equal(f.fixture.busy,false);
  }finally{await f.service.dispose();}
});
test('account, epoch, lease, foreground or conversation changes during fresh capture never receive a grant',async()=>{
  for(const mode of ['account','epoch','lease','foreground','conversation','mismatched-store']){
    const f=await sessionFixture();let release!:()=>void;
    try{
      f.fixture.capture=async()=>{await new Promise<void>(resolve=>{release=resolve;});if(mode==='mismatched-store')throw Error('CONVERSATION_SOURCE_UNVERIFIED');return mode==='conversation'?{...f.fixture.captured,snapshot:{...f.fixture.captured.snapshot,conversationId:'other'}}:f.fixture.captured;};
      const opening=f.service.operatorSession(f.intent);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.grants,0);
      if(mode==='account')f.identity={accountScope:'psim:other',authGeneration:2,permissions:[]};
      if(mode==='epoch')f.fixture.epoch++;
      if(mode==='lease')f.fixture.external={close:async()=>{}};
      if(mode==='foreground')f.fixture.foreground=false;
      release();await assert.rejects(opening,/ORDER_CONTEXT_CHANGED|CONVERSATION_SOURCE_UNVERIFIED/);assert.equal(f.grants,0);assert.equal(f.fixture.busy,false);
      if(mode==='mismatched-store'){assert.equal(f.fixture.state.currentOrderHint,null);assert.equal(f.fixture.state.messageSurface.active,false);}
    }finally{await f.service.dispose();}
  }
});
/** Adopts the fixture capture through the real service path so `verifiedAt` is recorded as in production. */
function adoptVerified(f:Awaited<ReturnType<typeof sessionFixture>>){
  f.fixture.captured={...f.fixture.captured,messageSurface:{active:true,composerRect:null,toolbarRect:null}};
  (CompanionService.prototype as any).adopt.call(f.fixture,f.fixture.captured);
  assert.equal(f.fixture.state.messageSurface.active,true);assert.ok(f.fixture.verifiedAt);
}
test('operator handoff reuses a verified capture adopted within 1 s and re-reads an older one',async t=>{
  t.mock.timers.enable({apis:['Date'],now:10_000});
  for(const [elapsed,expected] of [[0,0],[1000,0],[1001,1]] as const){
    const f=await sessionFixture();let captures=0;
    try{
      adoptVerified(f);f.fixture.capture=async()=>{captures++;return f.fixture.captured;};
      t.mock.timers.tick(elapsed);
      assert.deepEqual(await f.service.operatorSession(f.intent),{accessToken:'fixture-token',sessionRef:'fixture-ref'});
      assert.equal(captures,expected,`elapsed ${elapsed}`);assert.equal(f.grants,1);assert.equal(f.fixture.busy,false);
    }finally{await f.service.dispose();}
  }
});
test('the fresh-capture fast path still refuses foreground, conversation and login changes and yields to in-flight reads',async t=>{
  t.mock.timers.enable({apis:['Date'],now:10_000});
  for(const mode of ['foreground','surface','conversation','auth-state','logged-out','auth-generation','epoch','invalidated','lease','observation','busy']){
    const f=await sessionFixture();let captures=0,release:(()=>void)|undefined;
    try{
      adoptVerified(f);f.fixture.capture=async()=>{captures++;return f.fixture.captured;};
      let intent=f.intent;
      if(mode==='foreground')f.fixture.foreground=false;
      if(mode==='surface')f.fixture.state.messageSurface={active:false,composerRect:null,toolbarRect:null};
      if(mode==='conversation')intent={...f.intent,conversationKey:JSON.stringify(['1:2:3','other',1,'vendor:fixture'])};
      if(mode==='auth-state')f.fixture.state.auth='connecting';
      if(mode==='logged-out')f.identity=null;
      if(mode==='auth-generation')f.identity={accountScope:'psim:fixture',authGeneration:2,permissions:[]};
      if(mode==='epoch')f.fixture.epoch++;
      if(mode==='invalidated')f.service.invalidate();
      if(mode==='lease')f.fixture.external={close:async()=>{}};
      if(mode==='observation')f.fixture.observation=new Promise<void>(resolve=>{release=resolve;});
      if(mode==='busy')f.fixture.setBusy(true);
      const opening=f.service.operatorSession(intent);
      if(['foreground','surface'].includes(mode)){await assert.rejects(opening,/MESSAGE_PAGE_REQUIRED/);assert.equal(f.grants,0);}
      else if(mode==='conversation'){await assert.rejects(opening,/ORDER_CONTEXT_CHANGED/);assert.equal(f.grants,0);}
      else if(['auth-state','logged-out'].includes(mode)){await assert.rejects(opening,/PSIM_LOGIN_REQUIRED/);assert.equal(f.grants,0);}
      else{
        // Anything that could make the earlier capture stale falls back to the full fresh-capture path.
        await new Promise(resolve=>setImmediate(resolve));
        if(mode==='observation'||mode==='busy'){assert.equal(captures,0);assert.equal(f.grants,0);release?.();if(mode==='busy')f.fixture.setBusy(false);}
        assert.deepEqual(await opening,{accessToken:'fixture-token',sessionRef:'fixture-ref'});assert.equal(captures,1,mode);assert.equal(f.grants,1);
      }
      assert.equal(f.fixture.busy,false);
    }finally{await f.service.dispose();}
  }
});
test('a new header store and an old alternate/iframe cannot authorize the old intent',async()=>{
  const header=headerFixture(),f=await sessionFixture();
  try{
    const oldConversation=readConversationId(header.document);
    f.fixture.captured.snapshot.conversationId=oldConversation;f.fixture.state.currentOrderHint={identifier:order,conversationId:oldConversation};
    const intent={...f.intent,identifier:order,identifierType:'order_number' as const,conversationKey:f.fixture.context()};
    const newState={currentConvId:'new',conversationList:[{gid:'new',sessionId:'new',serviceType:'t',status:1,relationOrderId:'NEW12345'}]};
    header.owner.dependencies.firstContext.memoizedValue.ctrl.store={getState:()=>newState};
    // alternate still points at header.store and the iframe still identifies old.
    assert.deepEqual(readHeaderConversation(header.document),{conversationId:null,identifier:null});
    assert.throws(()=>readConversationId(header.document,true),/CONVERSATION_SOURCE_UNVERIFIED/);
    f.fixture.capture=async()=>{readConversationId(header.document,true);return f.fixture.captured;};
    await assert.rejects(f.service.operatorSession(intent),/CONVERSATION_SOURCE_UNVERIFIED/);
    assert.equal(f.grants,0);assert.equal(f.fixture.state.currentOrderHint,null);assert.equal(f.fixture.state.messageSurface.active,false);
  }finally{header.dom.window.close();await f.service.dispose();}
});
