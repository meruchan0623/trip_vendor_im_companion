import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveRuntimeDriver} from '../runtime/driver';
import {RuntimeCDPPolicy} from '../runtime/cdp-policy';
import {embeddedPanelState} from '../electron/embedded-host';
import {mountPageFeatures} from '../runtime/page';
import {JSDOM} from 'jsdom';

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
