import {describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {approvedImTargets,chooseActiveImTarget,observeImTarget,sameTargetInventory,type ImTargetObservation} from '../../runtime/target-selection';
import {VERIFIED_RUNTIME_BUILD,type BuildFingerprint} from '../../runtime/identity';
const candidate=(targetId:string,visible:boolean,focused:boolean):ImTargetObservation=>({targetId,url:VERIFIED_RUNTIME_BUILD.documentURL,frameId:`frame-${targetId}`,visible,focused});
describe('active BrowserView selection',()=>{
  it('selects unique visibility or unique focus and never falls back to enumeration order',()=>{
    for(const values of [[candidate('b',true,true),candidate('a',true,false)],[candidate('a',true,false),candidate('b',true,true)]])expect(chooseActiveImTarget(values).targetId).toBe('b');
    expect(chooseActiveImTarget([candidate('a',false,true),candidate('b',true,false)]).targetId).toBe('b');
    for(const values of [[candidate('a',true,false),candidate('b',true,false)],[candidate('a',true,true),candidate('b',true,true)],[candidate('a',false,true)]])expect(()=>chooseActiveImTarget(values)).toThrow();
  });
  it('rejects duplicate and unbounded target inventory and ignores unapproved pages',()=>{
    expect(approvedImTargets({targetInfos:[{type:'page',targetId:'safe',url:VERIFIED_RUNTIME_BUILD.documentURL},{type:'page',targetId:'remote',url:'https://example.test/'}]}).map(item=>item.targetId)).toEqual(['safe']);
    expect(()=>approvedImTargets({})).toThrow('TARGET_DISCOVERY_UNAVAILABLE');
    expect(()=>approvedImTargets({targetInfos:Array.from({length:17},(_,i)=>({type:'page',targetId:String(i),url:VERIFIED_RUNTIME_BUILD.documentURL}))})).toThrow('IM_TARGET_LIMIT');
    expect(()=>chooseActiveImTarget([candidate('a',true,true),candidate('a',true,false)])).toThrow('INVALID_TARGET_INVENTORY');
    expect(sameTargetInventory([candidate('a',true,true),candidate('b',false,false)],[candidate('b',true,true),candidate('a',false,false)])).toBe(true);
  });
});
describe('read-only target evidence probe with fake wire',()=>{
  function fixture(){
    const html='static fixture',fingerprint={htmlSha256:createHash('sha256').update(html).digest('hex')} as BuildFingerprint;
    let frameReads=0;const state={badHtml:false,navigated:false,invalidProbe:false};
    const send=vi.fn(async(method:string,params:Record<string,unknown>,session?:string):Promise<any>=>{
      if(method==='Target.attachToTarget')return{sessionId:'probe-session'};
      if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'frame',loaderId:++frameReads>1&&state.navigated?'changed':'initial',url:VERIFIED_RUNTIME_BUILD.documentURL}}};
      if(method==='Page.getResourceContent')return{content:state.badHtml?'unknown':html,base64Encoded:false};
      if(method==='Page.createIsolatedWorld')return{executionContextId:18};
      if(method==='Runtime.evaluate')return{result:{value:state.invalidProbe?{visible:'true',focused:true}:{visible:true,focused:true}}};
      return{};
    });return{state,send,fingerprint};
  }
  it('uses a fixed isolated metadata read and always detaches the temporary session',async()=>{
    const f=fixture(),result=await observeImTarget({send:f.send,disconnect:async()=>{}},candidate('a',false,false),f.fingerprint,'test-nonce');
    expect(result).toMatchObject({targetId:'a',frameId:'frame',visible:true,focused:true});
    expect(f.send).toHaveBeenCalledWith('Runtime.evaluate',{expression:'({visible:document.visibilityState==="visible",focused:document.hasFocus()})',contextId:18,returnByValue:true,awaitPromise:false},'probe-session');
    expect(f.send).toHaveBeenLastCalledWith('Target.detachFromTarget',{sessionId:'probe-session'});
  });
  it.each(['badHtml','navigated','invalidProbe'] as const)('refuses %s evidence and still detaches',async(kind)=>{
    const f=fixture();f.state[kind]=true;
    await expect(observeImTarget({send:f.send,disconnect:async()=>{}},candidate('a',true,true),f.fingerprint,'test')).rejects.toThrow();
    expect(f.send).toHaveBeenLastCalledWith('Target.detachFromTarget',{sessionId:'probe-session'});
    if(kind==='badHtml')expect(f.send.mock.calls.some(([method])=>method==='Runtime.evaluate')).toBe(false);
  });
});
