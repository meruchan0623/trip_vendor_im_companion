import { approvedDocumentURL,assertBuildFingerprint,type BuildFingerprint } from './identity';
export interface RuntimeTarget {targetId:string;frameId:string;executionContextId?:number;contextNonce:string;documentURL:string;fingerprint:BuildFingerprint}
export interface OwnedRuntimeHandle {detach():Promise<void>;heartbeat(sequence:number):Promise<void>}
export interface RuntimeDriver {
  verifyCurrentTarget(target:RuntimeTarget):Promise<void>;
  mountOwnedBundle(target:RuntimeTarget,options:{leaseMs:6000;mode:'outbound-operator';customerSend:'disabled'}):Promise<OwnedRuntimeHandle>;
  watchInvalidation(target:RuntimeTarget,invalidate:()=>void):()=>void;
  disconnect():Promise<void>;
}
/** Serial attach/detach around an already verified user-launched loopback session. */
export class RuntimeAttachment {
  private generation=0;private sequence=0;private handle:OwnedRuntimeHandle|undefined;private unsubscribe:(()=>void)|undefined;
  private queue=Promise.resolve();private state:'detached'|'attaching'|'attached'='detached';
  constructor(private driver:RuntimeDriver){}
  get status(){return this.state;}
  attach(target:RuntimeTarget):Promise<void>{
    if(this.state==='attached')return Promise.reject(new Error('ALREADY_ATTACHED'));
    const generation=++this.generation;
    const work=async()=>{
      if(generation!==this.generation)throw new Error('TARGET_CHANGED');
      if(this.state==='attached')throw new Error('ALREADY_ATTACHED');
      assertBuildFingerprint(target.fingerprint);
      if(!approvedDocumentURL(target.documentURL)||!target.targetId||!target.frameId||!target.contextNonce||(target.executionContextId!==undefined&&(!Number.isSafeInteger(target.executionContextId)||target.executionContextId<=0)))throw new Error('UNVERIFIED_RUNTIME_TARGET');
      this.state='attaching';
      this.unsubscribe=this.driver.watchInvalidation(target,()=>{if(generation!==this.generation)return;void this.detach();});
      try{
        await this.driver.verifyCurrentTarget(target);
        if(generation!==this.generation)throw new Error('TARGET_CHANGED');
        const handle=await this.driver.mountOwnedBundle(target,{leaseMs:6000,mode:'outbound-operator',customerSend:'disabled'});
        if(generation!==this.generation){await handle.detach();throw new Error('TARGET_CHANGED');}
        this.handle=handle;this.state='attached';
      }catch(error){this.unsubscribe?.();this.unsubscribe=undefined;this.state='detached';await this.driver.disconnect().catch(()=>{});throw error;}
    };
    const result=this.queue.then(work);this.queue=result.catch(()=>{});return result;
  }
  detach():Promise<void>{
    this.generation++;
    const work=async()=>{this.unsubscribe?.();this.unsubscribe=undefined;const handle=this.handle;this.handle=undefined;this.state='detached';if(handle)await handle.detach();};
    const result=this.queue.then(work);this.queue=result.catch(()=>{});return result;
  }
  async heartbeat():Promise<void>{if(this.state!=='attached'||!this.handle)return;const handle=this.handle,generation=this.generation;try{await handle.heartbeat(++this.sequence);}catch{if(this.handle===handle&&this.generation===generation)await this.detach();}}
  async close():Promise<void>{try{await this.detach();}finally{await this.driver.disconnect();}}
}

