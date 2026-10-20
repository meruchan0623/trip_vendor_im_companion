import {createHash} from 'node:crypto';
import {approvedDocumentURL,type BuildFingerprint} from './identity';
import type {CDPTransport} from './cdp-policy';

export interface ImTargetCandidate {targetId:string;url:string}
export interface ImTargetObservation extends ImTargetCandidate {frameId:string;visible:boolean;focused:boolean}
export function sameTargetInventory(a:readonly ImTargetCandidate[],b:readonly ImTargetCandidate[]):boolean {
  const key=(values:readonly ImTargetCandidate[])=>JSON.stringify(values.map(item=>[item.targetId,item.url]).sort((x,y)=>x[0].localeCompare(y[0])));
  return key(a)===key(b);
}
/** Visibility/focus are browser observations, never a page-provided account or arbitrary active flag. */
export function chooseActiveImTarget(observations:readonly ImTargetObservation[]):ImTargetObservation {
  if(new Set(observations.map(item=>item.targetId)).size!==observations.length)throw new Error('INVALID_TARGET_INVENTORY');
  const visible=observations.filter(item=>item.visible);
  if(visible.length===1)return visible[0];
  const focused=visible.filter(item=>item.focused);
  if(focused.length===1)return focused[0];
  throw new Error(visible.length?'AMBIGUOUS_IM_TARGET':'IM_TARGET_INACTIVE');
}
export function approvedImTargets(result:unknown):ImTargetCandidate[]{
  const entries=(result as {targetInfos?:unknown[]})?.targetInfos;
  if(!Array.isArray(entries))throw new Error('TARGET_DISCOVERY_UNAVAILABLE');
  const targets=entries.filter((item:any)=>item?.type==='page'&&typeof item.targetId==='string'&&item.targetId&&approvedDocumentURL(item.url)) as ImTargetCandidate[];
  if(new Set(targets.map(item=>item.targetId)).size!==targets.length)throw new Error('INVALID_TARGET_INVENTORY');
  if(targets.length>16)throw new Error('IM_TARGET_LIMIT');
  return targets;
}
/** Probe only a pinned top document in a temporary isolated world; never reads business text. */
export async function observeImTarget(transport:CDPTransport,target:ImTargetCandidate,fingerprint:BuildFingerprint,nonce:string):Promise<ImTargetObservation>{
  let session:string|undefined;
  try{
    const attached=await transport.send('Target.attachToTarget',{targetId:target.targetId,flatten:true}) as any;
    if(typeof attached?.sessionId!=='string'||!attached.sessionId)throw new Error('INVALID_SESSION');
    session=attached.sessionId;
    // Resource content is available only after Page has been enabled on this new session.
    await transport.send('Page.enable',{},session);
    const tree=await transport.send('Page.getFrameTree',{},session) as any,frame=tree?.frameTree?.frame;
    if(!frame||typeof frame.id!=='string'||frame.parentId||!approvedDocumentURL(frame.url))throw new Error('UNVERIFIED_MAIN_FRAME');
    const resource=await transport.send('Page.getResourceContent',{frameId:frame.id,url:frame.url},session) as any;
    if(typeof resource?.content!=='string'||resource.content.length>20000||resource.base64Encoded!==false||createHash('sha256').update(resource.content).digest('hex')!==fingerprint.htmlSha256)throw new Error('LOADED_DOCUMENT_HASH_MISMATCH');
    const world=await transport.send('Page.createIsolatedWorld',{frameId:frame.id,worldName:`tsim-selection-${nonce}`,grantUniveralAccess:false},session) as any;
    if(!Number.isSafeInteger(world?.executionContextId)||world.executionContextId<=0)throw new Error('INVALID_CONTEXT');
    const read=await transport.send('Runtime.evaluate',{expression:'({visible:document.visibilityState==="visible",focused:document.hasFocus()})',contextId:world.executionContextId,returnByValue:true,awaitPromise:false},session) as any,value=read?.result?.value;
    if(read?.exceptionDetails||typeof value?.visible!=='boolean'||typeof value?.focused!=='boolean')throw new Error('ACTIVE_IM_TARGET_UNVERIFIED');
    const after=await transport.send('Page.getFrameTree',{},session) as any;
    if(after?.frameTree?.frame?.id!==frame.id||after?.frameTree?.frame?.loaderId!==frame.loaderId||after?.frameTree?.frame?.url!==frame.url)throw new Error('RUNTIME_TARGET_CHANGED');
    return{...target,frameId:frame.id,visible:value.visible,focused:value.focused};
  }finally{if(session)await transport.send('Target.detachFromTarget',{sessionId:session});}
}
