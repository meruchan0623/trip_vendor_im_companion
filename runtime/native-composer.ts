import type{VerifiedComposerSnapshot}from'../src/shared/workbench';
import type {OrderEntry,MessageSurface,OrderViewport,SurfaceRect} from '../src/shared/companion-api';
import {collectTextRuns,findIdentifierMatches,inferIdentifierType,MESSAGE_TEXT_SELECTOR,HEADER_TEXT_SELECTOR,HEADER_ORDER} from './page/identifiers';
const SELECTOR='.tiptap.ProseMirror.chat-editor[contenteditable="true"]';
interface PublicEditor {view:{dom:HTMLElement;composing:boolean;focus():void};state:{doc:{content:{size:number}}};isDestroyed:boolean;isEditable:boolean;getJSON():unknown;on(type:string,handler:()=>void):unknown;off(type:string,handler:()=>void):unknown;commands:{setContent(content:unknown,emitUpdate:boolean,parseOptions:{preserveWhitespace:'full'}):boolean;setTextSelection(position:number):boolean}}
export type NativeInteraction={type:'draft-changed'}|{type:'replace-shortcut';snapshot:VerifiedComposerSnapshot};
export function isReplaceChord(event:Pick<KeyboardEvent,'key'|'ctrlKey'|'altKey'|'shiftKey'|'metaKey'>){return event.key==='Enter'&&event.ctrlKey&&event.altKey&&!event.shiftKey&&!event.metaKey;}
export function isReplaceIntent(event:Pick<KeyboardEvent,'key'|'ctrlKey'|'altKey'|'shiftKey'|'metaKey'|'isTrusted'|'repeat'|'isComposing'|'keyCode'>){return isReplaceChord(event)&&event.isTrusted&&!event.repeat&&!event.isComposing&&event.keyCode!==229;}
export interface NativePoll {snapshot?:VerifiedComposerSnapshot;writeVerified:boolean;reason?:string;orderEntries?:OrderEntry[];orderViewport?:OrderViewport;messageSurface?:MessageSurface;orderFrame?:{rect:SurfaceRect;clientWidth:number;clientHeight:number;clientLeft:number;clientTop:number}}
const inactiveSurface=():MessageSurface=>({active:false,composerRect:null,toolbarRect:null});
function visibleRect(element:Element|null,document:Document):SurfaceRect|null{
  if(!element?.isConnected||element.closest('[hidden],[aria-hidden="true"],.customer_info.close'))return null;
  const view=document.defaultView!;for(let parent:Element|null=element;parent;parent=parent.parentElement){const style=view.getComputedStyle(parent);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0')return null;}
  const r=element.getBoundingClientRect();if(![r.x,r.y,r.width,r.height].every(Number.isFinite)||r.width<=0||r.height<=0||r.x<0||r.y<0||r.right>view.innerWidth+1||r.bottom>view.innerHeight+1)return null;
  return{x:r.x,y:r.y,width:r.width,height:r.height};
}
/** Local geometry only. The host also verifies the separate main window's selected message navigation. */
export function messageSurfaceGeometry(document:Document):MessageSurface{
  if(document.visibilityState!=='visible')return inactiveSurface();
  const composers=document.querySelectorAll('.chat_area-input');if(composers.length!==1)return inactiveSurface();
  const composer=composers[0],composerRect=visibleRect(composer,document);if(!composerRect)return inactiveSurface();
  const toolbars=composer.querySelectorAll('.chat-func-list'),editors=composer.querySelectorAll(SELECTOR),sends=composer.querySelectorAll(SEND_SELECTOR);
  if(toolbars.length!==1||editors.length!==1)return inactiveSurface();
  const bar=visibleRect(toolbars[0],document),editor=visibleRect(editors[0],document);if(!bar||!editor)return inactiveSurface();
  const barBottom=bar.y+bar.height;if(bar.x<composerRect.x||bar.y<composerRect.y||bar.x+bar.width>composerRect.x+composerRect.width||barBottom>composerRect.y+composerRect.height||barBottom>editor.y+1)return inactiveSurface();
  for(const send of sends){const r=visibleRect(send,document);if(r&&r.y<barBottom&&r.y+r.height>bar.y&&r.x<bar.x+bar.width&&r.x+r.width>bar.x)return inactiveSurface();}
  // Leave all vendor attachment/screenshot/translation controls clickable.
  let left=bar.x+8;for(const child of toolbars[0].children){const r=visibleRect(child,document);if(r)left=Math.max(left,r.x+r.width+8);}
  const width=bar.x+bar.width-8-left;
  return{active:true,composerRect,toolbarRect:width>=200&&bar.height>=28?{x:left,y:bar.y,width,height:Math.min(40,bar.height)}:null};
}
function orderFrameGeometry(document:Document):NativePoll['orderFrame']{
  const frames=document.querySelectorAll<HTMLIFrameElement>('.customer_info iframe.customer_order-detail');if(frames.length!==1)return;
  const frame=frames[0],rect=visibleRect(frame,document);if(!rect||frame.clientWidth<=0||frame.clientHeight<=0||Math.abs(rect.width-frame.offsetWidth)>1||Math.abs(rect.height-frame.offsetHeight)>1)return;
  return{rect,clientWidth:frame.clientWidth,clientHeight:frame.clientHeight,clientLeft:frame.clientLeft,clientTop:frame.clientTop};
}
/** Observes visible identifier ranges without decorating or changing the vendor document. */
export function visibleOrderEntries(document:Document):OrderEntry[]{
  const view=document.defaultView!,entries:OrderEntry[]=[];
  const elements=[...document.querySelectorAll(MESSAGE_TEXT_SELECTOR),...document.querySelectorAll(HEADER_TEXT_SELECTOR)];
  for(const element of elements.slice(-200)){
    if(element.closest('[data-tsim-owned="1"], .chat_area-input'))continue;
    const parent=element.closest('.chat_list_content')?.getBoundingClientRect();
    for(const run of collectTextRuns(element)){
      const header=element.matches(HEADER_TEXT_SELECTOR)?HEADER_ORDER.exec(run.text):null;
      const matches=element.matches(HEADER_TEXT_SELECTOR)?header?[{index:run.text.lastIndexOf(header[1]),length:header[1].length,text:header[1]}]:[]:findIdentifierMatches(run.text);
      for(const match of matches){
        const first=run.fragments.find(part=>match.index>=part.start&&match.index<part.end),last=run.fragments.find(part=>match.index+match.length>part.start&&match.index+match.length<=part.end);
        if(!first||!last)continue;
        const range=document.createRange();range.setStart(first.node,match.index-first.start);range.setEnd(last.node,match.index+match.length-last.start);
        if(typeof range.getClientRects!=='function')continue;
        const rects=[...range.getClientRects()];
        // A wrapped identifier cannot be covered with one window without intercepting unrelated text.
        if(rects.length!==1)continue;const rect=rects[0];
        if(rect.width<=0||rect.height<=0||rect.x<0||rect.y<0||rect.right>view.innerWidth||rect.bottom>view.innerHeight||parent&&(rect.y<parent.top||rect.bottom>parent.bottom))continue;
        entries.push({identifier:match.text,identifierType:header?'order_number':inferIdentifierType(match.text)??'order_number',rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}});
        if(entries.length>=12)return entries;
      }
    }
  }
  return entries;
}
const SEND_SELECTOR='.chat_area-button .list-btn_send button.btn_send';
function plainDoc(value:unknown):{doc:unknown;text:string}|null{
  const root=value as any;if(!root||root.type!=='doc'||!Array.isArray(root.content)||root.content.length>1000||root.attrs&&Object.keys(root.attrs).length)return null;const paragraphs:any[]=[],lines:string[]=[];
  for(const paragraph of root.content){if(paragraph?.type!=='paragraph'||paragraph.attrs&&Object.values(paragraph.attrs).some(value=>value!==null)||paragraph.marks?.length||paragraph.content&&!Array.isArray(paragraph.content))return null;const content:any[]=[],line:string[]=[];
    for(const node of paragraph.content??[]){if(node?.marks?.length||node?.attrs&&Object.keys(node.attrs).length)return null;if(node?.type==='text'&&typeof node.text==='string'){content.push({type:'text',text:node.text});line.push(node.text);}else if(node?.type==='hardBreak'){content.push({type:'hardBreak'});line.push('\n');}else return null;}paragraphs.push({...paragraph,content});lines.push(line.join(''));}
  const text=lines.join('\n');if(text.length>20000)return null;return{doc:{type:'doc',content:paragraphs},text};
}
/** Fixed main-world adapter for the pinned Tiptap2 build. Only reads and compare-and-swap draft replacement are exposed; no message submission API. */
export function createNativeComposer(meta:{leaseId:string;documentGeneration:number;bindingName?:string},document:Document=window.document){
  if(!/^[a-z0-9-]{16,100}$/i.test(meta.leaseId)||!Number.isSafeInteger(meta.documentGeneration)||meta.documentGeneration<=0)throw new Error('INVALID_NATIVE_LEASE');
  if(meta.bindingName!==undefined&&!/^tsim_native_[a-f0-9]{32}$/.test(meta.bindingName))throw new Error('INVALID_NATIVE_BINDING');
  let disposed=false,revision=1,scopeGeneration=1,authGeneration=0,editorNumber=0,lastConversation='',editor:PublicEditor|undefined,element:HTMLElement|undefined,composing=false;
  let lastPoll=Date.now();const watchdog=document.defaultView!.setInterval(()=>{if(Date.now()-lastPoll>=6000)dispose();},1000);
  let ownWrite=false,writeUpdateObserved=false,contentFingerprint='',shortcutEnabled=false,wakeQueued=false;
  const pending:NativeInteraction[]=[];
  const wake=meta.bindingName?(document.defaultView as unknown as Record<string,unknown>)[meta.bindingName]:undefined;
  function enqueue(event:NativeInteraction){if(disposed||ownWrite||typeof wake!=='function')return;if(event.type==='draft-changed'){if(pending.some(item=>item.type==='draft-changed'))return;}else if(pending.some(item=>item.type==='replace-shortcut'))return;pending.push(event);if(wakeQueued)return;wakeQueued=true;queueMicrotask(()=>{wakeQueued=false;if(disposed||!pending.length)return;try{(wake as (payload:string)=>void)('wake');}catch{pending.length=0;}});}
  const update=()=>{if(disposed)return;if(ownWrite)writeUpdateObserved=true;const fingerprint=JSON.stringify(editor?.getJSON());if(fingerprint===contentFingerprint)return;contentFingerprint=fingerprint;revision++;enqueue({type:'draft-changed'});};
  const input=(event:Event)=>{if(!event.isTrusted||ownWrite)return;enqueue({type:'draft-changed'});};
  const start=()=>{composing=true;revision++;enqueue({type:'draft-changed'});};const end=()=>{const owner=editor;document.defaultView!.requestAnimationFrame(()=>{if(disposed||editor!==owner)return;composing=false;revision++;enqueue({type:'draft-changed'});});};
  const keydown=(event:KeyboardEvent)=>{if(disposed||!shortcutEnabled||!event.isTrusted||!isReplaceChord(event))return;try{bind();if(!element||event.target!==element&&!element.contains(event.target as Node)||document.activeElement!==element&&!element.contains(document.activeElement)||!messageSurfaceGeometry(document).active)return;
    // Consume even a repeat or unfinished IME chord so the vendor cannot treat Enter as send.
    event.preventDefault();event.stopImmediatePropagation();if(!isReplaceIntent(event)||composing||editor!.view.composing)return;const current=snapshot();if(!current.composing)enqueue({type:'replace-shortcut',snapshot:current});
  }catch{/* Unverified editors never produce write intents. */}};
  document.addEventListener('keydown',keydown,true);
  function conversation(){const frames=document.querySelectorAll<HTMLIFrameElement>('.customer_info iframe.customer_order-detail');if(frames.length!==1)throw new Error('CONVERSATION_SOURCE_UNVERIFIED');const url=new URL(frames[0].getAttribute('src')??'');if(url.origin!=='https://vbooking.ctrip.com'||url.pathname!=='/tour/im/ex-area/b'||url.username||url.password||url.hash)throw new Error('CONVERSATION_SOURCE_UNVERIFIED');const fields=['groupid','sessionid','serviceType','status'].map(key=>url.searchParams.get(key)??'');if(!fields[0]||!fields[1]||fields.some(value=>value.length>128||/[\r\n\u0000]/.test(value)))throw new Error('CONVERSATION_SOURCE_UNVERIFIED');return JSON.stringify(fields);}
  function bind(){const nodes=document.querySelectorAll<HTMLElement>(SELECTOR);if(nodes.length!==1||!nodes[0].isConnected||nodes[0].getClientRects().length===0)throw new Error('COMPOSER_SOURCE_UNVERIFIED');const next=(nodes[0]as HTMLElement&{editor?:PublicEditor}).editor;
    if(!next||next.isDestroyed||next.isEditable!==true||next.view?.dom!==nodes[0]||typeof next.getJSON!=='function'||typeof next.on!=='function'||typeof next.off!=='function'||typeof next.commands?.setContent!=='function')throw new Error('COMPOSER_PUBLIC_API_UNVERIFIED');
    if(editor!==next){if(editor)editor.off('update',update);element?.removeEventListener('input',input);element?.removeEventListener('compositionstart',start);element?.removeEventListener('compositionend',end);editor=next;element=nodes[0];contentFingerprint=JSON.stringify(editor.getJSON());pending.length=0;editor.on('update',update);element.addEventListener('input',input);element.addEventListener('compositionstart',start);element.addEventListener('compositionend',end);composing=false;editorNumber++;scopeGeneration++;revision++;}
  }
  function snapshot():VerifiedComposerSnapshot{if(disposed)throw new Error('NATIVE_LEASE_ENDED');bind();const key=conversation();if(key!==lastConversation){lastConversation=key;scopeGeneration++;revision++;}const pure=plainDoc(editor!.getJSON());if(!pure)throw new Error('COMPOSER_NOT_PLAIN_TEXT');const editorIdentity=`${meta.leaseId}:${editorNumber}`;return{text:pure.text,conversationId:key,revision,scopeGeneration,authGeneration,editorIdentity,docFingerprint:JSON.stringify(pure.doc),isPlainText:true,composing:composing||editor!.view.composing===true,platformAccountScope:`merchant-document:${meta.leaseId}`,composerId:editorIdentity,documentGeneration:meta.documentGeneration};}
  function dispose(){if(disposed)return;disposed=true;pending.length=0;document.removeEventListener('keydown',keydown,true);document.defaultView!.clearInterval(watchdog);editor?.off('update',update);element?.removeEventListener('input',input);element?.removeEventListener('compositionstart',start);element?.removeEventListener('compositionend',end);editor=undefined;element=undefined;}
  return{
    drainInteractions():NativeInteraction[]{if(disposed)throw new Error('NATIVE_LEASE_ENDED');return pending.splice(0,8);},
    setInteractionOptions(options:{shortcutEnabled:boolean}){if(disposed||typeof options?.shortcutEnabled!=='boolean')throw new Error('INVALID_INTERACTION_OPTIONS');shortcutEnabled=options.shortcutEnabled;pending.splice(0,pending.length,...pending.filter(event=>event.type!=='replace-shortcut'));},
    heartbeat(){if(disposed)throw new Error('NATIVE_LEASE_ENDED');lastPoll=Date.now();},
    poll(nextAuthGeneration:number):NativePoll{if(disposed)throw new Error('NATIVE_LEASE_ENDED');lastPoll=Date.now();if(!Number.isSafeInteger(nextAuthGeneration)||nextAuthGeneration<0)throw new Error('INVALID_AUTH_GENERATION');if(nextAuthGeneration!==authGeneration){authGeneration=nextAuthGeneration;scopeGeneration++;revision++;}const messageSurface=messageSurfaceGeometry(document),orderViewport={width:document.defaultView!.innerWidth,height:document.defaultView!.innerHeight,dpr:document.defaultView!.devicePixelRatio||1};if(!messageSurface.active)return{writeVerified:false,messageSurface,orderEntries:[],orderViewport,reason:'MESSAGE_PAGE_INACTIVE'};try{return{snapshot:snapshot(),writeVerified:true,messageSurface,orderEntries:[],orderViewport,orderFrame:orderFrameGeometry(document)};}catch(error){return{writeVerified:false,messageSurface:inactiveSurface(),orderEntries:[],orderViewport,reason:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'COMPOSER_UNAVAILABLE'};}},
    replaceDraft(expected:VerifiedComposerSnapshot,text:string){const current=snapshot();if(!messageSurfaceGeometry(document).active||!document.hasFocus())throw new Error('DRAFT_COMPARE_AND_SWAP_FAILED');if(typeof text!=='string'||!text.trim()||text.length>20000||!current.isPlainText||current.composing||JSON.stringify(current)!==JSON.stringify(expected))throw new Error('DRAFT_COMPARE_AND_SWAP_FAILED');const doc={type:'doc',content:text.split('\n').map(line=>({type:'paragraph',content:line?[{type:'text',text:line}]:[]}))};const verified=plainDoc(doc);if(!verified||verified.text!==text)throw new Error('DRAFT_COMPARE_AND_SWAP_FAILED');if(typeof editor!.commands.setTextSelection!=='function'||typeof editor!.view.focus!=='function'||!Number.isSafeInteger(editor!.state?.doc?.content?.size))throw new Error('COMPOSER_PUBLIC_API_UNVERIFIED');writeUpdateObserved=false;ownWrite=true;try{if(editor!.commands.setContent(doc,true,{preserveWhitespace:'full'})!==true)throw new Error('DRAFT_WRITE_REJECTED');}finally{ownWrite=false;}if(!writeUpdateObserved)throw new Error('DRAFT_UPDATE_NOT_OBSERVED');revision++;const result=snapshot();if(result.text!==text||result.conversationId!==current.conversationId||result.scopeGeneration!==current.scopeGeneration||result.editorIdentity!==current.editorIdentity)throw new Error('DRAFT_READBACK_MISMATCH');
      // The pinned Tiptap focus command schedules a frame. Use its public selection
      // command and synchronous ProseMirror view.focus so focus cannot cross a later switch.
      // setContent is the only document-changing transaction; moving the caret adds no history step.
      if(editor!.commands.setTextSelection(editor!.state.doc.content.size)!==true)throw new Error('DRAFT_FOCUS_REJECTED');
      if(JSON.stringify(snapshot())!==JSON.stringify(result))throw new Error('DRAFT_READBACK_MISMATCH');
      editor!.view.focus();return result;},
    dispose,
  };
}
declare global{interface Window{tsimNativeComposerFactory?:{create:typeof createNativeComposer}}}
if(typeof window!=='undefined')Object.defineProperty(window,'tsimNativeComposerFactory',{value:Object.freeze({create:createNativeComposer}),configurable:true});


