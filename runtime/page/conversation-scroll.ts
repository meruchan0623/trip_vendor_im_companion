import {matchesPageConversation} from './conversation';

export const CONVERSATION_SCROLL_DELAY_MS=10;
export const CONVERSATION_SCROLL_WINDOW_MS=2000;
const LAYOUT_CHECK_MS=50;

/** Only the message-list region may own scrolling; never climb into the page/sidebar. */
function messageScroller(document:Document):HTMLElement|undefined{
  const view=document.defaultView!;
  const visible=(element:HTMLElement)=>{
    if(!element.isConnected||!element.getClientRects().length)return false;
    for(let node:HTMLElement|null=element;node;node=node.parentElement){
      const style=view.getComputedStyle(node);
      if(node.hidden||node.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')return false;
    }
    return true;
  };
  const lists=[...document.querySelectorAll<HTMLElement>('.chat_list_content')].filter(visible);
  if(lists.length!==1)return;
  const list=lists[0];
  for(let node:HTMLElement|null=list,depth=0;node&&depth<5&&node!==document.body&&node!==document.documentElement;node=node.parentElement,depth++){
    // A wrapper spanning the editor, customer sidebar or another list is not
    // a message viewport, even if its own overflow happens to be scrollable.
    if(node!==list&&(node.querySelector('.chat_area-input, .chat-editor, .customer_info, aside, [role="complementary"]')||node.querySelectorAll('.chat_list_content').length!==1))return;
    const style=view.getComputedStyle(node);
    if(/^(auto|scroll|overlay)$/.test(style.overflowY||style.overflow)&&node.clientHeight>0&&node.scrollHeight>node.clientHeight)return node;
  }
}

/** One short follow window per opened host binding, cancelled by reading/interaction. */
export function createConversationScroll(document:Document){
  const view=document.defaultView!;
  let key:string|null=null,attempted=false,disposed=false,timer:number|undefined;
  let scroller:HTMLElement|undefined,lastTop=0,lastHeight=-1,lastViewport=-1,deadline=0;
  const cancel=()=>{view.clearTimeout(timer);timer=undefined;scroller=undefined;};
  const valid=()=>!disposed&&!!key&&document.visibilityState!=='hidden'&&matchesPageConversation(document,key);
  const check=()=>{
    timer=undefined;
    if(!valid()||view.performance.now()>deadline){cancel();return;}
    // Once located, layout checks stay on the cached message container.
    const next=scroller?.isConnected?scroller:messageScroller(document);
    if(next){
      if(scroller===next&&next.scrollTop<lastTop-2){cancel();return;}
      const changed=scroller!==next||lastHeight!==next.scrollHeight||lastViewport!==next.clientHeight;
      scroller=next;
      if(changed){
        const bottom=Math.max(0,next.scrollHeight-next.clientHeight);
        if(Math.abs(next.scrollTop-bottom)>1)next.scrollTop=bottom;
      }
      lastTop=next.scrollTop;lastHeight=next.scrollHeight;lastViewport=next.clientHeight;
    }else{scroller=undefined;lastHeight=lastViewport=-1;}
    timer=view.setTimeout(check,LAYOUT_CHECK_MS);
  };
  const update=(nextKey:string|null,bound=matchesPageConversation(document,nextKey))=>{
    if(disposed)return;
    if(key!==nextKey){cancel();key=nextKey;attempted=false;}
    if(!bound||document.visibilityState==='hidden'){cancel();return;}
    if(!key||attempted)return;
    attempted=true;lastHeight=lastViewport=-1;deadline=view.performance.now()+CONVERSATION_SCROLL_WINDOW_MS;
    timer=view.setTimeout(check,CONVERSATION_SCROLL_DELAY_MS);
  };
  const inMessages=(event:Event)=>event.target instanceof view.Element&&(!!event.target.closest('.chat_list_content')||!!(scroller??messageScroller(document))?.contains(event.target));
  const onInteraction=(event:Event)=>{if(timer!==undefined&&inMessages(event))cancel();};
  const onKey=(event:KeyboardEvent)=>{if(timer!==undefined&&['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))cancel();};
  const onScroll=(event:Event)=>{if(scroller&&event.target===scroller&&scroller.scrollTop<lastTop-2)cancel();};
  const onVisibility=()=>{if(document.visibilityState==='hidden')cancel();else update(key);};
  document.addEventListener('wheel',onInteraction,{capture:true,passive:true});
  document.addEventListener('touchstart',onInteraction,{capture:true,passive:true});
  document.addEventListener('pointerdown',onInteraction,true);
  document.addEventListener('keydown',onKey,true);
  document.addEventListener('scroll',onScroll,true);
  document.addEventListener('visibilitychange',onVisibility);
  return{update,dispose(){if(disposed)return;disposed=true;cancel();document.removeEventListener('wheel',onInteraction,true);document.removeEventListener('touchstart',onInteraction,true);document.removeEventListener('pointerdown',onInteraction,true);document.removeEventListener('keydown',onKey,true);document.removeEventListener('scroll',onScroll,true);document.removeEventListener('visibilitychange',onVisibility);}};
}
