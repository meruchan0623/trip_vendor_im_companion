import {describe,it,expect,vi} from 'vitest';
// Synthetic loaded resources keep this protocol test independent of installed vendor files.
vi.mock('node:crypto',()=>({createHash:()=>({update(value:string){return{digest:()=>value==='fixture-nav-html'?'94feb90c608b9a5cb6710c6b608349f2742ac6c9304de622a76fcc9bc97e5c47':value==='fixture-nav-script'?'3dc548ead7bc30a230d48d14f231c3a6d86b457e6d5c233f280a635051480582':'0'.repeat(64)};}})}));
import {RuntimeCDPPolicy} from '../../runtime/cdp-policy';
import {VERIFIED_RUNTIME_BUILD} from '../../runtime/identity';
const navURL=VERIFIED_RUNTIME_BUILD.documentURL.replace('/imPlus/','/main/'),navScript=VERIFIED_RUNTIME_BUILD.rendererURL.replace('imWindow-DfcqWwN2.js','mainWindow-BMmNuWTW.js');
function fixture(){
  const listeners=new Set<(event:any)=>void>();let modified=false;
  const send=vi.fn(async(method:string,params:any,sessionId?:string):Promise<any>=>{
    const emit=(method:string,params:any)=>{for(const listener of listeners)listener({method,params,sessionId});};
    if(method==='Target.getTargets')return{targetInfos:[{type:'page',targetId:'navigation',url:navURL}]};
    if(method==='Target.attachToTarget')return{sessionId:params.targetId==='navigation'?'nav-session':'im-session'};
    if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'nav-main',url:navURL}}};
    if(method==='Page.getResourceContent'){if(params.url!==navURL)throw new Error('CDP_COMMAND_REJECTED');return{content:'fixture-nav-html',base64Encoded:false};}
    if(method==='Runtime.enable'){emit('Runtime.executionContextCreated',{context:{id:4,auxData:{frameId:'nav-main',isDefault:true}}});emit('Runtime.executionContextCreated',{context:{id:9,auxData:{frameId:'unrelated-child',isDefault:true}}});}
    if(method==='Debugger.enable'){emit('Debugger.scriptParsed',{scriptId:'200',url:navScript,executionContextId:9});emit('Debugger.scriptParsed',{scriptId:'300',url:'https://attacker.example/mainWindow-BMmNuWTW.js',executionContextId:4});emit('Debugger.scriptParsed',{scriptId:'100',url:navScript,executionContextId:4});}
    if(method==='Debugger.getScriptSource')return{scriptSource:modified?'modified bytes':'fixture-nav-script'};
    if(method==='Page.createIsolatedWorld')return{executionContextId:88};
    if(method==='Runtime.evaluate')return{result:{value:{active:true,dpr:1.5,width:1280,height:960}}};
    return{};
  });
  const policy=new RuntimeCDPPolicy({send,disconnect:async()=>{},onEvent(listener){listeners.add(listener);return()=>listeners.delete(listener);}},{targetId:'im',frameId:'im-main',contextNonce:'navigation-test',documentURL:VERIFIED_RUNTIME_BUILD.documentURL,fingerprint:VERIFIED_RUNTIME_BUILD},'0'.repeat(64));
  return{policy,send,modify(){modified=true;}};
}
describe('pinned navigation script via debugger, fake CDP wire',()=>{
  it('hashes exact loaded main-frame script source and disables debugger after verification',async()=>{
    const f=fixture();await f.policy.attachSession();expect(await f.policy.readMessageNavigation()).toEqual({active:true,dpr:1.5,width:1280,height:960});
    expect(f.send).toHaveBeenCalledWith('Debugger.getScriptSource',{scriptId:'100'},'nav-session');expect(f.send).toHaveBeenCalledWith('Debugger.disable',{},'nav-session');
    expect(f.send.mock.calls.filter(([method])=>method==='Page.getResourceContent').every(([,params])=>params.url===navURL)).toBe(true);
    const sourceCall=f.send.mock.calls.findIndex(([method])=>method==='Debugger.getScriptSource'),inspectCall=f.send.mock.calls.findIndex(([method])=>method==='Runtime.evaluate');expect(inspectCall).toBeGreaterThan(sourceCall);await f.policy.close();
  });
  it('rejects altered loaded bytes before any navigation DOM inspection',async()=>{
    const f=fixture();f.modify();await f.policy.attachSession();await expect(f.policy.readMessageNavigation()).rejects.toThrow('MESSAGE_NAVIGATION_BUILD_MISMATCH');expect(f.send.mock.calls.some(([method])=>method==='Runtime.evaluate')).toBe(false);expect(f.send).toHaveBeenCalledWith('Debugger.disable',{},'nav-session');await f.policy.close();
  });
});
