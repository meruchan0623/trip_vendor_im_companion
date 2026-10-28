/** Ported from respondio queryIdentifiers: turns ICCID / eICCID / order numbers in IM bubbles into TSim query entries. */
export type OperatorIdentifierType='iccid'|'eiccid'|'order_number';
export interface QueryIdentifierEntry {identifier:string;identifierType?:OperatorIdentifierType}
export interface IdentifierMatch {index:number;length:number;text:string}
interface TextFragment {node:Text;start:number;end:number}
interface TextRun {text:string;fragments:TextFragment[]}
interface Decoration {run:TextRun;match:IdentifierMatch;entry:QueryIdentifierEntry}
export const IDENTIFIER_PATTERNS=[/\b89\d{18,19}\b/g,/\b[A-Z]{2,3}-\d{6,}\b/gi,/\b[A-Z]_\d{6}[A-Z0-9]+_\d+\b/gi,/\b[A-Z0-9]*\d[A-Z0-9_-]{5,49}\b/gi];
export const MESSAGE_TEXT_SELECTOR='.chat_list_content li.normal-message-item .chat-content .chat-text';
export const HEADER_TEXT_SELECTOR='.im_detail_hd .group-chat-hover-box-txt';
export const IDENTIFIER_CLASS='tsim-query-identifier';
const STYLE_ID='tsim-query-identifier-style';
export const HEADER_ORDER=/订单号\s*[：:]\s*([A-Za-z0-9_-]{6,50})\s*$/;
/** Anything carrying this marker (or our hosts) is plugin-owned and never rescanned. */
export const OWNED_SELECTOR='[data-tsim-owned="1"], #tsim-outbound-panel, #tsim-operator-viewport, #tsim-operator-frame, #tsim-operator-loading, #tsim-order-summary';
const TEXT_RUN_BREAK_SELECTOR=[OWNED_SELECTOR,'a','button','[role="button"]','[role="link"]','label','summary','[contenteditable]','textarea','input','select','iframe','script','style','template','time'].join(', ');
/** Inline tags do not break text continuity; an identifier may span them. */
const INLINE_TAGS=new Set(['ABBR','B','BDI','BDO','CITE','CODE','DEL','EM','FONT','I','INS','KBD','MARK','Q','S','SAMP','SMALL','SPAN','STRONG','SUB','SUP','U','VAR']);
const COMPOSER_SELECTOR='.chat_area-input, .tiptap, [contenteditable="true"], textarea, input, select';
export const SCAN_DEBOUNCE_MS=120;
export function findIdentifierMatches(text:string):IdentifierMatch[]{
  const matches:IdentifierMatch[]=[];
  for(const pattern of IDENTIFIER_PATTERNS){const re=new RegExp(pattern.source,pattern.flags);let match:RegExpExecArray|null;while((match=re.exec(text))!==null)matches.push({index:match.index,length:match[0].length,text:match[0]});}
  matches.sort((a,b)=>a.index-b.index);
  // Patterns are listed by priority: drop anything overlapping an earlier kept match.
  return matches.filter((match,index,all)=>!all.slice(0,index).some(previous=>match.index>=previous.index&&match.index<previous.index+previous.length||match.index+match.length>previous.index&&match.index+match.length<=previous.index+previous.length));
}
export function inferIdentifierType(identifier:string):OperatorIdentifierType|undefined{if(/^89\d{18,19}$/.test(identifier))return 'iccid';if(/^[Ee]89\d{18,19}$/.test(identifier))return 'eiccid';return undefined;}
export const isOwned=(element:Element|null|undefined)=>!!element?.closest(OWNED_SELECTOR);
const isComposer=(element:Element)=>!!element.closest(COMPOSER_SELECTOR)||!!element.querySelector(COMPOSER_SELECTOR);
/** Split an element into continuous text runs; block and interactive elements break a run. */
export function collectTextRuns(root:Element):TextRun[]{
  const runs:TextRun[]=[];let text='',fragments:TextFragment[]=[];
  const flush=()=>{if(text)runs.push({text,fragments});text='';fragments=[];};
  const visit=(node:Node)=>{
    if(node.nodeType===3){const data=(node as Text).data;if(!data)return;const start=text.length;text+=data;fragments.push({node:node as Text,start,end:text.length});return;}
    if(node.nodeType!==1)return;const element=node as Element;
    if(element!==root&&element.matches(TEXT_RUN_BREAK_SELECTOR)){flush();return;}
    const breaks=element!==root&&!INLINE_TAGS.has(element.tagName);if(breaks)flush();for(const child of [...element.childNodes])visit(child);if(breaks)flush();
  };
  visit(root);flush();return runs;
}
function locateOffset(run:TextRun,offset:number,isEnd:boolean):[Text,number]|null{const fragment=run.fragments.find(({start,end})=>isEnd?offset>start&&offset<=end:offset>=start&&offset<end);return fragment?[fragment.node,offset-fragment.start]:null;}
export function ensureIdentifierStyle(document:Document){
  const existing=document.getElementById(STYLE_ID);if(existing)return existing;const style=document.createElement('style');style.id=STYLE_ID;style.setAttribute('data-tsim-owned','1');
  style.textContent=`.${IDENTIFIER_CLASS}{display:inline;margin:0;padding:0 .04em;border-radius:.16em;background:#efe2ff;color:#6815a8;cursor:pointer;text-decoration:underline dashed;text-underline-offset:2px;font:inherit;line-height:inherit;overflow-wrap:anywhere;outline-offset:1px}.${IDENTIFIER_CLASS}:hover,.${IDENTIFIER_CLASS}:focus-visible{background:#e2ccff}`;
  (document.head??document.documentElement).append(style);return style;
}
function createWrapper(document:Document,entry:QueryIdentifierEntry,onOpen:(entry:QueryIdentifierEntry)=>void){
  const span=document.createElement('span'),label=`在 TSim 中查询 ${entry.identifier}`;span.className=IDENTIFIER_CLASS;span.title=label;span.setAttribute('aria-label',label);span.setAttribute('role','button');span.tabIndex=0;span.textContent=entry.identifier;span.setAttribute('data-tsim-identifier',entry.identifier);if(entry.identifierType)span.setAttribute('data-tsim-identifier-type',entry.identifierType);span.setAttribute('data-tsim-owned','1');
  const activate=(event:Event)=>{event.preventDefault();event.stopPropagation();onOpen({...entry});};
  span.addEventListener('click',activate);span.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' ')activate(event);});return span;
}
function decorate(document:Document,decorations:Decoration[],onOpen:(entry:QueryIdentifierEntry)=>void){
  // Replace from the back so earlier offsets stay valid.
  let count=0;for(const {run,match,entry} of [...decorations].sort((a,b)=>b.match.index-a.match.index)){const start=locateOffset(run,match.index,false),end=locateOffset(run,match.index+match.length,true);if(!start||!end||!start[0].isConnected||!end[0].isConnected)continue;const range=document.createRange();range.setStart(start[0],start[1]);range.setEnd(end[0],end[1]);range.deleteContents();range.insertNode(createWrapper(document,entry,onOpen));count++;}
  return count;
}
/** One pass over message bubbles and the header order line. Returns the number of new wrappers. */
export function linkifyIdentifiers(document:Document,onOpen:(entry:QueryIdentifierEntry)=>void):number{
  let count=0;
  for(const line of document.querySelectorAll(HEADER_TEXT_SELECTOR)){if(isOwned(line)||isComposer(line))continue;const wrappers=[...line.querySelectorAll(`.${IDENTIFIER_CLASS}`)];if(wrappers.length){
      // React rewrites its own text node in place; a fresh order number beside our old wrapper means the wrapper is stale.
      const plain=collectTextRuns(line).map(run=>run.text).join('');if(!HEADER_ORDER.test(plain))continue;wrappers.forEach(wrapper=>wrapper.remove());}
    const order=readHeaderOrder(document);if(!order)continue;
    const runs=collectTextRuns(line);for(const run of runs){const match=HEADER_ORDER.exec(run.text);if(!match||match[1]!==order)continue;const index=match.index+match[0].lastIndexOf(match[1]);count+=decorate(document,[{run,match:{index,length:match[1].length,text:match[1]},entry:{identifier:match[1],identifierType:'order_number'}}],onOpen);}}
  return count;
}
/** Read one unambiguous labelled order. Text-node boundaries are never erased:
 * textContent would concatenate separate vendor rows into a synthetic identifier.
 * Multiple labelled orders, split identifiers, or extra identifier-only rows disable the chip.
 */
export function readHeaderOrder(document:Document):string|undefined{return readHeaderOrderSources(document,createOrderVisibilityRead());}
function readHeaderOrderSources(document:Document,visible:(element:Element)=>boolean):string|undefined{
  const candidates:string[]=[];let ambiguous=false;
  for(const header of document.querySelectorAll(HEADER_TEXT_SELECTOR)){
    if(isOwned(header)||!visible(header))continue;
    const parts:string[]=[];
    const visit=(node:Node)=>{
      if(node.nodeType===3){for(const part of (node.textContent??'').split(/[\r\n]+/)){const text=part.trim();if(text)parts.push(text);}return;}
      if(node.nodeType!==1)return;const element=node as Element;
      if(element.matches('script,style,template')||!visible(element))return;
      if(isOwned(element)){
        // Our identifier wrapper is the original vendor value. Other plugin UI is never a source.
        if(element.matches(`.${IDENTIFIER_CLASS}[data-tsim-identifier]`)&&element.textContent===element.getAttribute('data-tsim-identifier'))parts.push(element.textContent??'');
        return;
      }
      for(const child of element.childNodes)visit(child);
    };
    visit(header);
    for(let index=0;index<parts.length;index++){
      const part=parts[index],inline=/^订单号\s*[：:]\s*([A-Za-z0-9_-]{6,50})$/.exec(part);
      if(inline){if(isValidOrderValue(inline[1]))candidates.push(inline[1]);else ambiguous=true;continue;}
      if(/^订单号\s*[：:]$/.test(part)){
        const value=parts[index+1];if(value&&isValidOrderValue(value)){candidates.push(value);index++;}else ambiguous=true;
      }else if(/^[A-Za-z0-9_-]{6,50}$/.test(part)||part.includes('订单号'))ambiguous=true;
    }
  }
  const unique=[...new Set(candidates)];return !ambiguous&&unique.length===1?unique[0]:undefined;
}
/** Conservative admission limit, not a vendor length contract: reject long numeric strings
 * such as the observed 32-digit concatenation rather than guessing or truncating an order. */
function isValidOrderValue(value:string){return /^[A-Za-z0-9_-]{6,50}$/.test(value)&&/\d/.test(value)&&(!/^\d+$/.test(value)||value.length<=20);}
/** The cache belongs to one read only: style changes never survive into the next scan. */
function createOrderVisibilityRead(){
  const cache=new Map<Element,boolean>();
  const visible=(element:Element):boolean=>{
    const known=cache.get(element);if(known!==undefined)return known;
    const path:Element[]=[];let current:Element|null=element,result=true;
    while(current){
      const cached=cache.get(current);if(cached!==undefined){result=cached;break;}
      path.push(current);
      if(current.matches('[hidden],[aria-hidden="true"]')){result=false;break;}
      const style=current.ownerDocument.defaultView?.getComputedStyle(current);
      if(style?.display==='none'||style?.visibility==='hidden'||style?.visibility==='collapse'){result=false;break;}
      current=current.parentElement;
    }
    for(const node of path)cache.set(node,result);return result;
  };
  return visible;
}
export const CURRENT_ORDER_FRAME_SELECTOR='.customer_info iframe.customer_order-detail';
function isApprovedOrderUrl(value:string,base?:string){
  try{const url=new URL(value,base);return url.origin==='https://vbooking.ctrip.com'&&!url.username&&!url.password&&!url.hash&&['/tour/im/ex-area/b','/tour/im/ex-area/b/imExtraInfo'].includes(url.pathname);}catch{return false;}
}
/** Same four fields used by native-composer.conversation(). */
function orderConversation(value:string,child=false){
  // The observed redirect lowercases serviceType to servicetype in the child URL.
  try{if(!isApprovedOrderUrl(value))return;const url=new URL(value);if(url.pathname!==(child?'/tour/im/ex-area/b/imExtraInfo':'/tour/im/ex-area/b'))return;const fields=['groupid','sessionid',child?'servicetype':'serviceType','status'].map(key=>url.searchParams.get(key)??'');if(!fields[0]||!fields[1]||fields.some(field=>field.length>128||/[\r\n\u0000]/.test(field)))return;return JSON.stringify(fields);}catch{return;}
}
/** companion-service.context = [targetInstanceId, native conversationId, scopeGeneration, accountScope]. */
function expectedOrderConversation(key:string|null|undefined){
  try{if(!key)return;const context=JSON.parse(key);if(!Array.isArray(context)||context.length!==4||typeof context[1]!=='string')return;const fields=JSON.parse(context[1]);if(!Array.isArray(fields)||fields.length!==4||fields.some(field=>typeof field!=='string'||field.length>128||/[\r\n\u0000]/.test(field))||!fields[0]||!fields[1])return;return JSON.stringify(fields);}catch{return;}
}
function orderFrameDocument(frame:HTMLIFrameElement):Document|undefined{
  try{if(!isApprovedOrderUrl(frame.src,frame.ownerDocument.baseURI))return;const child=frame.contentDocument;if(child&&isApprovedOrderUrl(child.URL)){const source=orderConversation(frame.src);if(source&&source!==orderConversation(child.URL,true))return;return child;}}catch{/* Cross-origin navigation may revoke the vendor's existing read access. */}
}
/** Prefer the observed vendor order row. An existing unreadable/loading frame is not a header fallback. */
export function readCurrentOrder(document:Document):string|undefined{return readOrderSources(document);}
function readOrderSources(document:Document,knownFrames?:readonly HTMLIFrameElement[],knownRows?:readonly Element[]):string|undefined{
  const visible=createOrderVisibilityRead();
  const frames=knownFrames??[...document.querySelectorAll<HTMLIFrameElement>(CURRENT_ORDER_FRAME_SELECTOR)].filter(frame=>!isOwned(frame));
  if(!frames.length)return readHeaderOrderSources(document,visible);
  if(frames.length!==1||!visible(frames[0]))return;
  const child=orderFrameDocument(frames[0]);if(!child)return;
  const values:string[]=[];
  for(const row of knownRows??child.querySelectorAll('.im_info_basic_list > li')){
    if(isOwned(row)||!visible(row))continue;
    const labels=[...row.children].filter(element=>element.matches('.im_info_basic_list_title')&&!isOwned(element)&&visible(element));
    if(!labels.some(label=>label.textContent?.trim()==='订单ID'))continue;
    const contents=[...row.children].filter(element=>element.matches('.im_info_basic_list_content')&&!isOwned(element)&&visible(element));
    if(labels.length!==1||contents.length!==1)return;
    // Each leaf is a separate value; never concatenate adjacent vendor nodes into an identifier.
    const parts:string[]=[];
    const visit=(node:Node)=>{if(node.nodeType===3){const text=node.textContent?.trim();if(text)parts.push(text);return;}if(node.nodeType!==1)return;const element=node as Element;if(isOwned(element)||!visible(element)||element.matches('script,style,template'))return;for(const next of element.childNodes)visit(next);};
    visit(contents[0]);
    if(parts.length!==1||!/^\d{6,20}$/.test(parts[0]))return;
    values.push(parts[0]);
  }
  const unique=[...new Set(values)];return unique.length===1?unique[0]:undefined;
}
const ORDER_PARENT_SOURCE_SELECTOR=`${CURRENT_ORDER_FRAME_SELECTOR}, ${HEADER_TEXT_SELECTOR}`;
const ORDER_CHILD_SOURCE_SELECTOR='.im_info_basic_list';
/** Inspect only the changed subtree and cached source ancestors, never unrelated page descendants. */
function affectsOrderSources(mutations:readonly MutationRecord[],sources:readonly Element[],selector:string){
  const containsSource=(element:Element)=>sources.some(source=>source===element||element.contains(source))||element.matches(selector)||!!element.querySelector(selector);
  return mutations.some(mutation=>{
    const target=mutation.target.nodeType===1?mutation.target as Element:mutation.target.parentElement;
    if(!target||isOwned(target))return false;
    const changed=mutation.type==='childList'?[...mutation.addedNodes,...mutation.removedNodes]:[];
    if(changed.length&&changed.every(node=>node.nodeType===1&&isOwned(node as Element)))return false;
    if(sources.some(source=>source===target||source.contains(target)))return true;
    if(mutation.type==='attributes')return containsSource(target);
    if(target.closest(selector))return true;
    return changed.some(node=>node.nodeType===1&&!isOwned(node as Element)&&containsSource(node as Element));
  });
}
/** Parent mutations invalidate cached sources; loads and relevant child changes are observed here. */
export function startOrderObservation(document:Document,onOrder:(order:string|undefined)=>void,conversationKey?:string|null,onSourceChange?:()=>void){
  type Binding={frame:HTMLIFrameElement;src:string;child?:Document;observer?:MutationObserver;sources:Element[];rows:Element[];sourcesDirty:boolean;layoutSources:Element[];layoutAncestors:Set<Element>;layoutDirty:boolean;pending:boolean;load:()=>void;unload:()=>void;attributes:MutationObserver};
  const view=document.defaultView!,bindings=new Map<HTMLIFrameElement,Binding>();
  let disposed=false,scheduled:number|undefined,pendingRead=false,discover=true,headers:Element[]=[],lastOrder:string|undefined,emitted=false;
  const publish=(order:string|undefined)=>{if(!emitted||lastOrder!==order){emitted=true;lastOrder=order;onOrder(order);}};
  const detachChild=(binding:Binding)=>{binding.observer?.disconnect();binding.child?.defaultView?.removeEventListener('pagehide',binding.unload);binding.child?.defaultView?.removeEventListener('unload',binding.unload);binding.observer=undefined;binding.child=undefined;binding.sources=[];binding.rows=[];binding.layoutSources=[];binding.layoutAncestors.clear();binding.layoutDirty=false;};
  const emit=()=>{
    if(disposed)return;
    const expected=expectedOrderConversation(conversationKey),frames=[...bindings.values()];
    const mismatched=conversationKey!==undefined&&frames.length>0&&(!expected||frames.some(binding=>orderConversation(binding.frame.src)!==expected||!binding.child||orderConversation(binding.child.URL,true)!==expected));
    publish(mismatched||frames.some(binding=>binding.pending)?undefined:readOrderSources(document,frames.map(binding=>binding.frame),frames[0]?.rows));
  };
  const refreshLayout=(binding:Binding)=>{
    const nodes=new Set<Element>(),ancestors=new Set<Element>();
    for(const source of binding.sources)for(let node:Element|null=source;node&&node!==binding.child?.body;node=node.parentElement){
      nodes.add(node);if(node.parentElement)ancestors.add(node.parentElement);
      for(let sibling=node.nextElementSibling;sibling;sibling=sibling.nextElementSibling)if(!isOwned(sibling))nodes.add(sibling);
    }
    binding.layoutSources=[...nodes];binding.layoutAncestors=ancestors;binding.layoutDirty=false;
  };
  const affectsLayout=(mutations:readonly MutationRecord[],binding:Binding)=>mutations.some(mutation=>{
    const element=mutation.target.nodeType===1?mutation.target as Element:mutation.target.parentElement;
    if(!element||isOwned(element))return false;
    const changed=mutation.type==='childList'?[...mutation.addedNodes,...mutation.removedNodes]:[];
    if(changed.length&&changed.every(node=>node.nodeType===1&&isOwned(node as Element)))return false;
    if(binding.layoutSources.some(source=>source===element||source.contains(element)))return true;
    if(mutation.type==='attributes'&&binding.layoutSources.some(source=>element.contains(source)))return true;
    return changed.length>0&&binding.layoutAncestors.has(element);
  });
  const schedule=(readOrder=true)=>{
    if(disposed)return;pendingRead=pendingRead||readOrder;if(scheduled!==undefined)return;
    scheduled=view.setTimeout(()=>{
      scheduled=undefined;const read=pendingRead;pendingRead=false;
      if(read)refresh(false);else for(const binding of bindings.values())if(binding.layoutDirty)refreshLayout(binding);
      onSourceChange?.();
    },0);
  };
  const refresh=(rediscover=true)=>{
    if(disposed)return;
    if(scheduled!==undefined){view.clearTimeout(scheduled);scheduled=undefined;pendingRead=false;}
    if(rediscover)discover=true;
    const frames=discover?[...document.querySelectorAll<HTMLIFrameElement>(CURRENT_ORDER_FRAME_SELECTOR)].filter(frame=>!isOwned(frame)):[...bindings.keys()].filter(frame=>frame.isConnected);
    if(discover)headers=[...document.querySelectorAll(HEADER_TEXT_SELECTOR)].filter(header=>!isOwned(header));
    discover=false;
    for(const [frame,binding] of bindings)if(!frames.includes(frame)){frame.removeEventListener('load',binding.load);binding.attributes.disconnect();detachChild(binding);bindings.delete(frame);}
    for(const frame of frames){
      let binding=bindings.get(frame);
      if(!binding){
        binding={frame,src:frame.src,pending:false,sources:[],rows:[],sourcesDirty:false,layoutSources:[],layoutAncestors:new Set(),layoutDirty:false,load:()=>{},unload:()=>{},attributes:new view.MutationObserver(()=>{if(binding!.src!==frame.src){binding!.pending=true;detachChild(binding!);publish(undefined);}schedule();})};
        const current=binding;
        current.load=()=>{current.pending=false;current.src=frame.src;detachChild(current);refresh(false);onSourceChange?.();};
        current.unload=()=>{current.pending=true;detachChild(current);publish(undefined);onSourceChange?.();};
        frame.addEventListener('load',current.load);current.attributes.observe(frame,{attributes:true,attributeFilter:['src']});bindings.set(frame,current);
      }
      if(binding.src!==frame.src){binding.src=frame.src;binding.pending=true;detachChild(binding);}
      const child=binding.pending?undefined:orderFrameDocument(frame);
      if(child!==binding.child){
        detachChild(binding);binding.child=child;
        if(child){
          const current=binding;
          current.sourcesDirty=true;
          current.observer=new view.MutationObserver(mutations=>{
            if(disposed||!current.frame.isConnected)return;
            if(current.src!==frame.src){current.pending=true;detachChild(current);publish(undefined);schedule();return;}
            const orderChanged=affectsOrderSources(mutations,current.sources,ORDER_CHILD_SOURCE_SELECTOR);
            if(!orderChanged&&!affectsLayout(mutations,current))return;
            current.layoutDirty=true;
            if(orderChanged&&mutations.some(mutation=>mutation.type==='childList'||mutation.type==='attributes'&&mutation.attributeName==='class'))current.sourcesDirty=true;
            schedule(orderChanged);
          });
          current.observer.observe(child,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden','aria-hidden']});child.defaultView?.addEventListener('pagehide',current.unload);child.defaultView?.addEventListener('unload',current.unload);
        }
      }
      if(binding.child&&(rediscover||binding.sourcesDirty||binding.sources.some(source=>!source.isConnected)||binding.rows.some(row=>!row.isConnected))){binding.sources=[...binding.child.querySelectorAll(ORDER_CHILD_SOURCE_SELECTOR)];binding.rows=binding.sources.flatMap(source=>[...source.children].filter(node=>node.matches('li')));binding.sourcesDirty=false;binding.layoutDirty=true;}
      if(binding.layoutDirty)refreshLayout(binding);
    }
    emit();
  };
  refresh();
  return{
    refresh,
    /** The owner batches relevant parent mutations; false means no order scan is needed. */
    invalidate(mutations:readonly MutationRecord[]){
      if(disposed||!affectsOrderSources(mutations,[...bindings.keys(),...headers],ORDER_PARENT_SOURCE_SELECTOR))return false;
      discover=true;return true;
    },
    setConversationKey(key:string|null){if(disposed||conversationKey===key)return;conversationKey=key;publish(undefined);refresh();},
    dispose(){if(disposed)return;disposed=true;view.clearTimeout(scheduled);for(const binding of bindings.values()){binding.frame.removeEventListener('load',binding.load);binding.attributes.disconnect();detachChild(binding);}bindings.clear();headers=[];},
  };
}
export function unlinkifyIdentifiers(document:Document){for(const element of document.querySelectorAll<HTMLElement>(`.${IDENTIFIER_CLASS}[data-tsim-identifier]`)){element.replaceWith(document.createTextNode(element.getAttribute('data-tsim-identifier')??element.textContent??''));}}
/** Debounced observer; ignores our own mutations and disconnects while scanning. */
export function startIdentifierLinkifier(document:Document,onOpen:(entry:QueryIdentifierEntry)=>void){
  const view=document.defaultView!;let disposed=false,timer:number|undefined;const style=ensureIdentifierStyle(document);
  const scan=()=>{timer=undefined;if(disposed||!document.body||document.visibilityState==='hidden')return;observer.disconnect();try{linkifyIdentifiers(document,onOpen);}finally{if(!disposed)observer.observe(document.body,{childList:true,subtree:true,characterData:true});}};
  const schedule=()=>{if(disposed||document.visibilityState==='hidden')return;if(timer!==undefined)view.clearTimeout(timer);timer=view.setTimeout(scan,SCAN_DEBOUNCE_MS);};
  const observer=new view.MutationObserver(mutations=>{if(disposed)return;const onlyOwned=mutations.every(mutation=>{const target=mutation.target.nodeType===1?mutation.target as Element:mutation.target.parentElement;if(isOwned(target))return true;if(mutation.type!=='childList')return false;const changed=[...mutation.addedNodes,...mutation.removedNodes];return changed.length>0&&changed.every(node=>node.nodeType===1&&isOwned(node as Element));});if(!onlyOwned)schedule();});
  const onVisibility=()=>{view.clearTimeout(timer);if(document.visibilityState!=='hidden')scan();};document.addEventListener('visibilitychange',onVisibility);
  scan();
  return{rescan:scan,dispose(){if(disposed)return;disposed=true;if(timer!==undefined)view.clearTimeout(timer);observer.disconnect();document.removeEventListener('visibilitychange',onVisibility);unlinkifyIdentifiers(document);style.remove();}};
}
