import {readConversationId,readCurrentOrderHint,type CurrentOrderHint} from './page/conversation';
import type{VerifiedComposerSnapshot}from'../src/shared/workbench';
import type {OrderEntry,MessageSurface,OrderViewport,SurfaceRect} from '../src/shared/companion-api';
import {collectTextRuns,findIdentifierMatches,inferIdentifierType,MESSAGE_TEXT_SELECTOR,HEADER_TEXT_SELECTOR,HEADER_ORDER} from './page/identifiers';
const SELECTOR='.tiptap.ProseMirror.chat-editor[contenteditable="true"]';
interface PublicEditor {view:{dom:HTMLElement;composing:boolean;focus():void};state:{doc:{content:{size:number}}};isDestroyed:boolean;isEditable:boolean;getJSON():unknown;on(type:string,handler:()=>void):unknown;off(type:string,handler:()=>void):unknown;commands:{setContent(content:unknown,emitUpdate:boolean,parseOptions:{preserveWhitespace:'full'}):boolean;setTextSelection(position:number):boolean}}
export type NativeInteraction={type:'draft-changed'}|{type:'replace-shortcut';snapshot:VerifiedComposerSnapshot}|{type:'send-shortcut';snapshot:VerifiedComposerSnapshot;sendGeneration?:number};
export interface NativeInteractionOptions {shortcutEnabled:boolean;enterSend:boolean;sendGeneration?:number}
export function isReplaceChord(event:Pick<KeyboardEvent,'key'|'ctrlKey'|'altKey'|'shiftKey'|'metaKey'>){return event.key==='Enter'&&event.altKey&&!event.shiftKey&&(event.ctrlKey!==event.metaKey);}
/** A plain Enter, which the vendor treats as send. Shift+Enter (newline) and modified chords are left alone. */
export function isSendKey(event:Pick<KeyboardEvent,'key'|'ctrlKey'|'altKey'|'shiftKey'|'metaKey'>){return event.key==='Enter'&&!event.altKey&&!event.shiftKey&&!event.ctrlKey&&!event.metaKey;}
export function isReplaceIntent(event:Pick<KeyboardEvent,'key'|'ctrlKey'|'altKey'|'shiftKey'|'metaKey'|'isTrusted'|'repeat'|'isComposing'|'keyCode'>){return isReplaceChord(event)&&event.isTrusted&&!event.repeat&&!event.isComposing&&event.keyCode!==229;}
export interface NativePoll {snapshot?:VerifiedComposerSnapshot;writeVerified:boolean;reason?:string;currentOrderHint?:CurrentOrderHint|null;orderEntries?:OrderEntry[];orderViewport?:OrderViewport;messageSurface?:MessageSurface;orderFrame?:{rect:SurfaceRect;clientWidth:number;clientHeight:number;clientLeft:number;clientTop:number}}
const inactiveSurface=():MessageSurface=>({active:false,composerRect:null,toolbarRect:null});
function visibleRect(element:Element|null,document:Document,clip?:SurfaceRect):SurfaceRect|null{
  if(!element?.isConnected||element.closest('[hidden],[aria-hidden="true"],.customer_info.close'))return null;
  const view=document.defaultView!;for(let parent:Element|null=element;parent;parent=parent.parentElement){const style=view.getComputedStyle(parent);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0')return null;}
  let r=element.getBoundingClientRect();
  // Tiptap grows with the draft inside the vendor's scrolling input. Its full
  // content box may extend beyond the viewport; only the exposed input matters.
  if(clip){
    // Vendor CSS also uses flex:1;height:0 with visible overflow on .chat-editor.
    // At the bottom, its border box can be offscreen while overflowing text is
    // still exposed by the scrolling .chat-box. Include that content extent.
    const style=view.getComputedStyle(element),contentHeight=(element as HTMLElement).scrollHeight;
    if((style.overflowY||style.overflow||'visible')==='visible'&&Number.isFinite(contentHeight)&&contentHeight>r.height){
      r={x:r.x,y:r.y,width:r.width,height:contentHeight,left:r.left,top:r.top,right:r.right,bottom:r.y+contentHeight} as DOMRect;
    }
    let x=Math.max(r.x,clip.x),y=Math.max(r.y,clip.y),right=Math.min(r.right,clip.x+clip.width),bottom=Math.min(r.bottom,clip.y+clip.height);
    // Scrolling moves the content box above the toolbar. Compare the exposed
    // portion after ancestor clipping, not the document's unscrolled origin.
    for(let parent=element.parentElement;parent;parent=parent.parentElement){
      const style=view.getComputedStyle(parent),clips=(value:string)=>/^(auto|scroll|hidden|clip)$/.test(value);
      const clipX=clips(style.overflowX||style.overflow),clipY=clips(style.overflowY||style.overflow);
      if(!clipX&&!clipY)continue;
      const bounds=parent.getBoundingClientRect();
      if(clipX){x=Math.max(x,bounds.left);right=Math.min(right,bounds.right);}
      if(clipY){y=Math.max(y,bounds.top);bottom=Math.min(bottom,bounds.bottom);}
    }
    r={x,y,width:right-x,height:bottom-y,right,bottom} as DOMRect;
  }
  if(![r.x,r.y,r.width,r.height].every(Number.isFinite)||r.width<=0||r.height<=0||r.x<0||r.y<0||r.right>view.innerWidth+1||r.bottom>view.innerHeight+1)return null;
  return{x:r.x,y:r.y,width:r.width,height:r.height};
}
/** Local geometry only. The host also verifies the separate main window's selected message navigation. */
export function messageSurfaceGeometry(document:Document):MessageSurface{
  if(document.visibilityState!=='visible')return inactiveSurface();
  const composers=document.querySelectorAll('.chat_area-input');if(composers.length!==1)return inactiveSurface();
  const composer=composers[0],composerRect=visibleRect(composer,document);if(!composerRect)return inactiveSurface();
  const toolbars=composer.querySelectorAll('.chat-func-list'),editors=composer.querySelectorAll(SELECTOR),sends=composer.querySelectorAll(SEND_SELECTOR);
  if(toolbars.length!==1||editors.length!==1)return inactiveSurface();
  const bar=visibleRect(toolbars[0],document),editor=visibleRect(editors[0],document,composerRect);if(!bar||!editor)return inactiveSurface();
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
/** Text-only StarterKit documents may carry presentation marks and nested blocks. */
function plainDoc(value:unknown):{doc:unknown;text:string}|null{
  let count=0;
  const visit=(node:any,depth:number):string|null=>{
    if(!node||depth>32||++count>5000||typeof node.type!=='string'||node.content!==undefined&&!Array.isArray(node.content))return null;
    if(node.marks!==undefined&&(!Array.isArray(node.marks)||node.marks.some((mark:any)=>!['bold','italic','strike','code'].includes(mark?.type)||mark.attrs&&Object.keys(mark.attrs).length)))return null;
    if(node.type==='text')return typeof node.text==='string'&&!node.content?node.text:null;
    if(node.type==='hardBreak')return '\n';
    if(node.type==='horizontalRule')return '';
    if(!['doc','paragraph','heading','codeBlock','blockquote','bulletList','orderedList','listItem'].includes(node.type))return null;
    const children=(node.content??[]).map((child:any)=>visit(child,depth+1));if(children.some((child:any)=>child===null))return null;
    return children.join(['paragraph','heading','codeBlock'].includes(node.type)?'':'\n');
  };
  if((value as any)?.type!=='doc'||!Array.isArray((value as any).content)||(value as any).content.length>1000)return null;
  const text=visit(value,0);return text===null||text.length>20000?null:{doc:value,text};
}
/** Fixed main-world adapter for the pinned Tiptap2 build. Exposes reads, compare-and-swap draft replacement, and a compare-and-swap send of the exact verified draft; the send is only reachable after the user's own trusted Enter. */
export function createNativeComposer(meta:{leaseId:string;documentGeneration:number;bindingName?:string},document:Document=window.document){
  if(!/^[a-z0-9-]{16,100}$/i.test(meta.leaseId)||!Number.isSafeInteger(meta.documentGeneration)||meta.documentGeneration<=0)throw new Error('INVALID_NATIVE_LEASE');
  if(meta.bindingName!==undefined&&!/^tsim_native_[a-f0-9]{32}$/.test(meta.bindingName))throw new Error('INVALID_NATIVE_BINDING');
  let disposed=false,revision=1,scopeGeneration=1,authGeneration=0,editorNumber=0,lastConversation='',editor:PublicEditor|undefined,element:HTMLElement|undefined,composing=false;
  let lastPoll=Date.now();const watchdog=document.defaultView!.setInterval(()=>{if(Date.now()-lastPoll>=6000)dispose();},1000);
  let ownWrite=false,writeUpdateObserved=false,contentFingerprint='',quoteFingerprint='',shortcutEnabled=false,enterSend=false,wakeQueued=false,sendGeneration=0,shortcutSinceFocus=false;
  const pending:NativeInteraction[]=[];
  const wake=meta.bindingName?(document.defaultView as unknown as Record<string,unknown>)[meta.bindingName]:undefined;
  function enqueue(event:NativeInteraction){if(disposed||ownWrite||typeof wake!=='function')return;
    // Editing cancels an undelivered Enter. Only another trusted Enter may
    // authorize the new snapshot, appended after its draft-change notice.
    if(event.type==='draft-changed'||event.type==='send-shortcut'){const previous=pending.findIndex(item=>item.type==='send-shortcut');if(previous>=0)pending.splice(previous,1);}
    if(pending.some(item=>item.type===event.type))return;pending.push(event);if(wakeQueued)return;wakeQueued=true;queueMicrotask(()=>{wakeQueued=false;if(disposed||!pending.length)return;try{(wake as (payload:string)=>void)('wake');}catch{pending.length=0;}});}
  // The vendor keeps citations beside the editor, not in the Tiptap document.
  const readQuote=()=>[...(element?.closest('.chat_area-input')?.querySelectorAll('.cite-container .cite-text')??[])].map(node=>node.innerHTML).join('\n');
  const syncQuote=()=>{const next=readQuote();if(next!==quoteFingerprint){quoteFingerprint=next;revision++;enqueue({type:'draft-changed'});}};
  const quoteObserver=new document.defaultView!.MutationObserver(()=>{if(!disposed)syncQuote();});
  const update=()=>{if(disposed)return;if(ownWrite)writeUpdateObserved=true;const fingerprint=JSON.stringify(editor?.getJSON());if(fingerprint===contentFingerprint)return;contentFingerprint=fingerprint;revision++;enqueue({type:'draft-changed'});};
  const input=(event:Event)=>{if(!event.isTrusted||ownWrite)return;enqueue({type:'draft-changed'});};
  const start=()=>{composing=true;revision++;enqueue({type:'draft-changed'});};const end=()=>{const owner=editor;document.defaultView!.requestAnimationFrame(()=>{if(disposed||editor!==owner)return;composing=false;revision++;enqueue({type:'draft-changed'});});};
  const owned=(event:KeyboardEvent)=>{bind();return !!element&&(event.target===element||element.contains(event.target as Node))&&(document.activeElement===element||element.contains(document.activeElement))&&messageSurfaceGeometry(document).active;};
  const keydown=(event:KeyboardEvent)=>{if(disposed||!event.isTrusted)return;
    if(enterSend&&isSendKey(event)){try{
      // An IME confirmation Enter belongs to the input method, not to send.
      if(event.isComposing||event.keyCode===229||composing||!owned(event)||editor!.view.composing)return;
      // Attachments and unsupported documents remain with the vendor. A verified
      // text draft is intercepted synchronously before the vendor can send it.
      let current:VerifiedComposerSnapshot;try{current=snapshot();}catch{event.preventDefault();event.stopImmediatePropagation();return;}
      if(!current.isPlainText)return;
      event.preventDefault();event.stopImmediatePropagation();if(event.repeat)return;if(!current.composing&&current.text.trim()){shortcutSinceFocus=true;enqueue({type:'send-shortcut',snapshot:current,sendGeneration});}
    }catch{/* Unverified editors never produce send intents. */}return;}
    if(!shortcutEnabled||!isReplaceChord(event))return;try{if(!owned(event))return;
    // Consume even a repeat or unfinished IME chord so the vendor cannot treat Enter as send.
    event.preventDefault();event.stopImmediatePropagation();if(!isReplaceIntent(event)||composing||editor!.view.composing)return;const current=snapshot();if(!current.composing){shortcutSinceFocus=true;enqueue({type:'replace-shortcut',snapshot:current});}
  }catch{/* Unverified editors never produce write intents. */}};
  document.addEventListener('keydown',keydown,true);
  const revokeShortcuts=()=>{if(disposed)return;pending.splice(0,pending.length,...pending.filter(event=>event.type==='draft-changed'));if(shortcutSinceFocus){revision++;shortcutSinceFocus=false;}};
  const visibility=()=>{if(document.visibilityState==='hidden')revokeShortcuts();};
  document.defaultView!.addEventListener('blur',revokeShortcuts);document.addEventListener('visibilitychange',visibility);
  const conversation=()=>readConversationId(document,true);
  function bind(){const nodes=document.querySelectorAll<HTMLElement>(SELECTOR);if(nodes.length!==1||!nodes[0].isConnected||nodes[0].getClientRects().length===0)throw new Error('COMPOSER_SOURCE_UNVERIFIED');const next=(nodes[0]as HTMLElement&{editor?:PublicEditor}).editor;
    if(!next||next.isDestroyed||next.isEditable!==true||next.view?.dom!==nodes[0]||typeof next.getJSON!=='function'||typeof next.on!=='function'||typeof next.off!=='function'||typeof next.commands?.setContent!=='function')throw new Error('COMPOSER_PUBLIC_API_UNVERIFIED');
    if(editor!==next){if(editor)editor.off('update',update);element?.removeEventListener('input',input);element?.removeEventListener('compositionstart',start);element?.removeEventListener('compositionend',end);editor=next;element=nodes[0];quoteObserver.disconnect();quoteFingerprint=readQuote();const composer=element.closest('.chat_area-input');if(composer)quoteObserver.observe(composer,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['src','alt','title']});contentFingerprint=JSON.stringify(editor.getJSON());pending.length=0;editor.on('update',update);element.addEventListener('input',input);element.addEventListener('compositionstart',start);element.addEventListener('compositionend',end);composing=false;editorNumber++;scopeGeneration++;revision++;}
  }
  function snapshot():VerifiedComposerSnapshot{if(disposed)throw new Error('NATIVE_LEASE_ENDED');bind();const key=conversation();if(key!==lastConversation){lastConversation=key;scopeGeneration++;revision++;}syncQuote();const raw=editor!.getJSON(),pure=plainDoc(raw);const editorIdentity=`${meta.leaseId}:${editorNumber}`;return{text:pure?.text??'',conversationId:key,revision,scopeGeneration,authGeneration,editorIdentity,docFingerprint:JSON.stringify({doc:raw,quote:quoteFingerprint}),isPlainText:!!pure,composing:composing||editor!.view.composing===true,platformAccountScope:`merchant-document:${meta.leaseId}`,composerId:editorIdentity,documentGeneration:meta.documentGeneration};}
  function dispose(){if(disposed)return;disposed=true;quoteObserver.disconnect();pending.length=0;document.removeEventListener('keydown',keydown,true);document.defaultView!.removeEventListener('blur',revokeShortcuts);document.removeEventListener('visibilitychange',visibility);document.defaultView!.clearInterval(watchdog);editor?.off('update',update);element?.removeEventListener('input',input);element?.removeEventListener('compositionstart',start);element?.removeEventListener('compositionend',end);editor=undefined;element=undefined;}
  return{
    drainInteractions():NativeInteraction[]{if(disposed)throw new Error('NATIVE_LEASE_ENDED');return pending.splice(0,8);},
    setInteractionOptions(options:NativeInteractionOptions){const next=options?.sendGeneration??0;if(disposed||typeof options?.shortcutEnabled!=='boolean'||typeof options.enterSend!=='boolean'||!Number.isSafeInteger(next)||next<0)throw new Error('INVALID_INTERACTION_OPTIONS');if(next<sendGeneration)return;const changed=next!==sendGeneration;sendGeneration=next;shortcutEnabled=options.shortcutEnabled;enterSend=options.enterSend;pending.splice(0,pending.length,...pending.filter(event=>event.type==='draft-changed'||event.type==='replace-shortcut'&&shortcutEnabled||event.type==='send-shortcut'&&enterSend&&!changed));},
    heartbeat(){if(disposed)throw new Error('NATIVE_LEASE_ENDED');lastPoll=Date.now();},
    // Authentication rotates draft authorization, not the conversation or its language preferences.
    poll(nextAuthGeneration:number):NativePoll{if(disposed)throw new Error('NATIVE_LEASE_ENDED');lastPoll=Date.now();if(!Number.isSafeInteger(nextAuthGeneration)||nextAuthGeneration<0)throw new Error('INVALID_AUTH_GENERATION');if(nextAuthGeneration!==authGeneration){authGeneration=nextAuthGeneration;revision++;}const messageSurface=messageSurfaceGeometry(document),orderViewport={width:document.defaultView!.innerWidth,height:document.defaultView!.innerHeight,dpr:document.defaultView!.devicePixelRatio||1};if(!messageSurface.active)return{writeVerified:false,messageSurface,orderEntries:[],orderViewport,reason:'MESSAGE_PAGE_INACTIVE'};try{const current=snapshot();return{snapshot:current,writeVerified:true,messageSurface,orderEntries:[],orderViewport,orderFrame:orderFrameGeometry(document),currentOrderHint:readCurrentOrderHint(document,current.conversationId)};}catch(error){return{writeVerified:false,messageSurface:inactiveSurface(),orderEntries:[],orderViewport,reason:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'COMPOSER_UNAVAILABLE'};}},
    replaceDraft(expected:VerifiedComposerSnapshot,text:string){const current=snapshot();if(!messageSurfaceGeometry(document).active||!document.hasFocus())throw new Error('DRAFT_COMPARE_AND_SWAP_FAILED');if(typeof text!=='string'||!text.trim()||text.length>20000||!current.isPlainText||current.composing||JSON.stringify(current)!==JSON.stringify(expected))throw new Error('DRAFT_COMPARE_AND_SWAP_FAILED');const doc={type:'doc',content:text.split('\n').map(line=>({type:'paragraph',content:line?[{type:'text',text:line}]:[]}))};const verified=plainDoc(doc);if(!verified||verified.text!==text)throw new Error('DRAFT_COMPARE_AND_SWAP_FAILED');if(typeof editor!.commands.setTextSelection!=='function'||typeof editor!.view.focus!=='function'||!Number.isSafeInteger(editor!.state?.doc?.content?.size))throw new Error('COMPOSER_PUBLIC_API_UNVERIFIED');const expectedQuote=quoteFingerprint;writeUpdateObserved=false;ownWrite=true;try{if(editor!.commands.setContent(doc,true,{preserveWhitespace:'full'})!==true)throw new Error('DRAFT_WRITE_REJECTED');}finally{ownWrite=false;}if(!writeUpdateObserved)throw new Error('DRAFT_UPDATE_NOT_OBSERVED');revision++;const result=snapshot();if(quoteFingerprint!==expectedQuote||result.text!==text||result.conversationId!==current.conversationId||result.scopeGeneration!==current.scopeGeneration||result.editorIdentity!==current.editorIdentity)throw new Error('DRAFT_READBACK_MISMATCH');
      // The pinned Tiptap focus command schedules a frame. Use its public selection
      // command and synchronous ProseMirror view.focus so focus cannot cross a later switch.
      // setContent is the only document-changing transaction; moving the caret adds no history step.
      if(editor!.commands.setTextSelection(editor!.state.doc.content.size)!==true)throw new Error('DRAFT_FOCUS_REJECTED');
      if(JSON.stringify(snapshot())!==JSON.stringify(result))throw new Error('DRAFT_READBACK_MISMATCH');
      editor!.view.focus();return result;},
    /** Clicks the vendor send button only for the exact, focused, verified draft the host just read back. */
    sendDraft(expected:VerifiedComposerSnapshot){const current=snapshot();if(!messageSurfaceGeometry(document).active||!document.hasFocus()||!current.isPlainText||current.composing||!current.text.trim()||JSON.stringify(current)!==JSON.stringify(expected))throw new Error('DRAFT_COMPARE_AND_SWAP_FAILED');
      const buttons=document.querySelectorAll<HTMLButtonElement>(SEND_SELECTOR);if(buttons.length!==1||!buttons[0].isConnected||buttons[0].getClientRects().length===0||buttons[0].disabled)throw new Error('SEND_BUTTON_UNAVAILABLE');
      buttons[0].click();return true;},
    dispose,
  };
}
declare global{interface Window{tsimNativeComposerFactory?:{create:typeof createNativeComposer}}}
if(typeof window!=='undefined')Object.defineProperty(window,'tsimNativeComposerFactory',{value:Object.freeze({create:createNativeComposer}),configurable:true});


