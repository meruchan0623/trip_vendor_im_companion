import {it,expect,vi} from 'vitest';
import {LiveRuntimeDriver} from '../../runtime/driver';
import {RuntimeCDPPolicy} from '../../runtime/cdp-policy';
import {VERIFIED_RUNTIME_BUILD} from '../../runtime/identity';
it('omits optional listener diagnostics while preserving startup verification',async()=>{
 const listeners=new Set<any>();
 const transport:any={onEvent:(fn:any)=>{listeners.add(fn);return()=>{};},onDisconnect:()=>()=>{},send:vi.fn(async(method:string)=>method==='Target.getTargets'?{targetInfos:[{targetId:'im',type:'page',url:VERIFIED_RUNTIME_BUILD.documentURL}]}:{})};
 const target:any={targetId:'im',frameId:'frame',documentURL:VERIFIED_RUNTIME_BUILD.documentURL,contextNonce:'nonce',fingerprint:Object.fromEntries(['executable','executableVersion','packageVersion','aresVersion','executableSha256','asarSha256','htmlSha256','rendererSha256'].map(k=>[k,(VERIFIED_RUNTIME_BUILD as any)[k]]))};
 const driver:any=new (LiveRuntimeDriver as any)(transport,target,'bundle','a'.repeat(64));
 driver.defaultContexts.add(1);driver.scripts.set('script',{id:'script',context:1});
 const methods=['attachSession','enableInspection','verifyExactDocument','verifyRenderer','createOwnedWorld','inspectParentCaptures'] as const;
 const spies=methods.map(name=>vi.spyOn(RuntimeCDPPolicy.prototype,name).mockResolvedValue([] as never));
 try {await driver.verifyCurrentTarget(target,{collectParentCaptures:false});for(const spy of spies.slice(0,5))expect(spy).toHaveBeenCalledOnce();expect(spies[5]).not.toHaveBeenCalled();}
 finally{vi.restoreAllMocks();}
});
