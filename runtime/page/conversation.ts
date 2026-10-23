import {RUNTIME_PLATFORM} from '../build-manifest';
/** Verified vendor order-frame identity shared by native drafts and page UI. */
export function readConversationId(document:Document,verifyHeader=false):string{
  const frames=document.querySelectorAll<HTMLIFrameElement>('.customer_info iframe.customer_order-detail');
  if(frames.length!==1)throw new Error('CONVERSATION_SOURCE_UNVERIFIED');
  const url=new URL(frames[0].getAttribute('src')??'');
  if(url.origin!=='https://vbooking.ctrip.com'||url.pathname!=='/tour/im/ex-area/b'||url.username||url.password||url.hash)throw new Error('CONVERSATION_SOURCE_UNVERIFIED');
  const fields=['groupid','sessionid','serviceType','status'].map(key=>url.searchParams.get(key)??'');
  if(!fields[0]||!fields[1]||fields.some(value=>value.length>128||/[\r\n\u0000]/.test(value)))throw new Error('CONVERSATION_SOURCE_UNVERIFIED');
  const id=JSON.stringify(fields);
  if(verifyHeader){const header=readHeaderConversation(document);if(header&&header.conversationId!==id)throw new Error('CONVERSATION_SOURCE_UNVERIFIED');}
  return id;
}
export interface CurrentOrderHint {identifier:string;conversationId:string}
interface HeaderConversation {conversationId:string|null;identifier:string|null}
/** Fixed header owner only. React's DOM pointer may address either alternate;
 * both must resolve to the same live store, never to a stale memoized state.
 * No store, controller, message list or arbitrary tree data leaves this reader.
 */
export function readHeaderConversation(document:Document):HeaderConversation|undefined{
  const blocked:HeaderConversation={conversationId:null,identifier:null};let recognizedHeader=false;
  try{
    const headers=document.querySelectorAll<HTMLElement>('.im_detail_hd.chat-group-name');if(!headers.length)return;
    recognizedHeader=true;if(headers.length!==1)return blocked;
    const header=headers[0];if(!header.isConnected||document.visibilityState!=='visible'||header.getClientRects().length===0)return blocked;
    for(let element:Element|null=header;element;element=element.parentElement){const style=document.defaultView!.getComputedStyle(element);if(element.hasAttribute('hidden')||element.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0')return blocked;}
    const keys=Object.getOwnPropertyNames(header).filter(key=>key.startsWith('__reactFiber$'));
    // An older unsupported header can retain the controlled iframe path. Once
    // a React source exists, ambiguity is a transition, never fallback consent.
    if(!keys.length)return;if(keys.length!==1)return blocked;
    const pointer=Object.getOwnPropertyDescriptor(header,keys[0])?.value;
    const branches=[...new Set<any>([pointer,pointer?.alternate].filter(Boolean))];if(!branches.length)return blocked;
    const roots=new Set<any>(),stores=new Set<any>();let unsupportedBranch=false;
    for(const start of branches){
      let rootFound=false;
      for(let fiber=start,depth=0;fiber&&depth<64;fiber=fiber.return,depth++){
        if(fiber.tag!==3)continue;
        const root=fiber.stateNode,container=root?.containerInfo;
        if(root?.current&&(fiber===root.current||fiber.alternate===root.current)&&(container===document||container?.ownerDocument===document&&container.isConnected&&container.contains(header))){roots.add(root);rootFound=true;}break;
      }
      if(!rootFound)return blocked;
      let storeFound=false;
      for(let owner=start,depth=0;owner&&depth<12;owner=owner.return,depth++){
        if(owner.tag!==0||typeof owner.type!=='function')continue;
        const source=Function.prototype.toString.call(owner.type);if(!source.includes('relationOrderId')||!source.includes('group-chat-hover-box-txt'))continue;
        const controllers=new Set<any>();let dependency=owner.dependencies?.firstContext,count=0;
        for(;dependency&&count<16;dependency=dependency.next,count++){const value=dependency.memoizedValue;if(value&&typeof value==='object'&&Object.hasOwn(value,'ctrl')&&value.ctrl&&typeof value.ctrl==='object')controllers.add(value.ctrl);}
        if(dependency||controllers.size!==1)return blocked;
        const store=[...controllers][0].store;if(!store||typeof store.getState!=='function')return blocked;
        stores.add(store);storeFound=true;break;
      }
      // macOS page builds have their own renderer. An unknown owner contract
      // supplies no capability; retain its existing controlled iframe reader.
      // Once a matching owner is found, all root/store/state checks still fail
      // closed, including disagreement between the two React branches.
      if(!storeFound){if(RUNTIME_PLATFORM!=='darwin')return blocked;unsupportedBranch=true;}
    }
    if(unsupportedBranch){if(stores.size===0)return;return blocked;}
    if(roots.size!==1||stores.size!==1)return blocked;
    const state=[...stores][0].getState();
    if(!state||!Array.isArray(state.conversationList)||state.conversationList.length>10000)return blocked;
    const scalar=(value:unknown)=>typeof value==='string'?value:typeof value==='number'&&Number.isSafeInteger(value)?String(value):undefined;
    const selectedId=scalar(state.currentConvId);if(!selectedId)return blocked;
    const matches=state.conversationList.filter((row:any)=>row&&scalar(row.gid)===selectedId);if(matches.length!==1)return blocked;
    const selected=matches[0],raw=[selected.gid,selected.sessionId,selected.serviceType,selected.status];
    const fields=raw.map(value=>value===undefined?'':scalar(value));
    if(fields.some(value=>value===undefined||value.length>128||/[\r\n\u0000]/.test(value))||!fields[0]||!fields[1])return blocked;
    const conversationId=JSON.stringify(fields),value=selected.relationOrderId;
    let identifier=typeof value==='string'&&/^[A-Za-z0-9_-]{4,80}$/.test(value)?value:null;
    // A present vendor label must agree; an unrendered hover label is not needed
    // for the current conversation's explicit, verified relationOrderId field.
    const labels=[...header.querySelectorAll('.group-chat-hover-box-txt')].map(line=>(line.textContent??'').trim()).filter(text=>/^订单号\s*[：:]/.test(text));
    if(labels.length>1||labels.length===1&&labels[0].replace(/^订单号\s*[：:]\s*/,'')!==identifier)identifier=null;
    return{conversationId,identifier};
  }catch{return recognizedHeader?blocked:undefined;}
}
export function readCurrentOrderHint(document:Document,expectedConversation:string):CurrentOrderHint|null|undefined{
  const header=readHeaderConversation(document);if(!header)return;
  if(header.conversationId!==expectedConversation)throw new Error('CONVERSATION_SOURCE_UNVERIFIED');
  // On Mac null suppresses legacy iframe fallback for a recognized source
  // without an admitted identifier. Undefined means this capability is absent.
  return header.identifier?{identifier:header.identifier,conversationId:expectedConversation}:RUNTIME_PLATFORM==='darwin'?null:undefined;
}
/** Host keys include the target, conversation, editor generation and account. */
export function matchesPageConversation(document:Document,key:string|null):boolean{
  try{const parts=JSON.parse(key??'null');return Array.isArray(parts)&&parts.length===4&&typeof parts[1]==='string'&&parts[1]===readConversationId(document);}catch{return false;}
}
