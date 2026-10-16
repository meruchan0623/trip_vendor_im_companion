/** Verified vendor order-frame identity shared by native drafts and page UI. */
export function readConversationId(document:Document):string{
  const frames=document.querySelectorAll<HTMLIFrameElement>('.customer_info iframe.customer_order-detail');
  if(frames.length!==1)throw new Error('CONVERSATION_SOURCE_UNVERIFIED');
  const url=new URL(frames[0].getAttribute('src')??'');
  if(url.origin!=='https://vbooking.ctrip.com'||url.pathname!=='/tour/im/ex-area/b'||url.username||url.password||url.hash)throw new Error('CONVERSATION_SOURCE_UNVERIFIED');
  const fields=['groupid','sessionid','serviceType','status'].map(key=>url.searchParams.get(key)??'');
  if(!fields[0]||!fields[1]||fields.some(value=>value.length>128||/[\r\n\u0000]/.test(value)))throw new Error('CONVERSATION_SOURCE_UNVERIFIED');
  return JSON.stringify(fields);
}
/** Host keys include the target, conversation, editor generation and account. */
export function matchesPageConversation(document:Document,key:string|null):boolean{
  try{const parts=JSON.parse(key??'null');return Array.isArray(parts)&&parts.length===4&&typeof parts[1]==='string'&&parts[1]===readConversationId(document);}catch{return false;}
}
