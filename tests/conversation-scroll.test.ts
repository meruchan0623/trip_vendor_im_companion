import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createConversationScroll,CONVERSATION_SCROLL_DELAY_MS,CONVERSATION_SCROLL_WINDOW_MS} from '../runtime/page/conversation-scroll';
import {mountPageFeatures} from '../runtime/page';
import {embeddedPanelState} from '../electron/embedded-host';

const key=(group='g')=>JSON.stringify(['target',JSON.stringify([group,'s','t','1']),1,'account']);
function fixture(){
  const dom=new JSDOM('<body><div class="customer_info"><iframe class="customer_order-detail" src="https://vbooking.ctrip.com/tour/im/ex-area/b?groupid=g&sessionid=s&serviceType=t&status=1"></iframe></div><section class="chat_area-list" style="overflow-y:auto"><ul class="chat_list_content"><li>message</li></ul></section><aside style="overflow-y:auto">sidebar</aside></body>',{pretendToBeVisual:true});
  const view=dom.window,document=view.document,list=document.querySelector('ul')!,region=document.querySelector('section')!;
  list.getClientRects=()=>[{width:200,height:300}] as any;
  let now=0,serial=0,height=1000,viewport=300,top=0,writes=0;
  const timers=new Map<number,{at:number;run:()=>void}>();
  view.setTimeout=((run:()=>void,ms=0)=>{const id=++serial;timers.set(id,{at:now+ms,run});return id;}) as any;
  view.clearTimeout=((id:number)=>{timers.delete(id);}) as any;
  Object.defineProperty(view.performance,'now',{value:()=>now});
  Object.defineProperties(region,{scrollHeight:{get:()=>height},clientHeight:{get:()=>viewport},scrollTop:{get:()=>top,set:(value:number)=>{top=Math.max(0,Math.min(value,height-viewport));writes++;}}});
  const advance=(ms:number)=>{const end=now+ms;for(;;){const pending=[...timers].sort((a,b)=>a[1].at-b[1].at).find(([,timer])=>timer.at<=end);if(!pending)break;const [id,timer]=pending;now=timer.at;timers.delete(id);timer.run();}now=end;};
  const controller=createConversationScroll(document);
  return{dom,view,document,list,region,controller,advance,timers,get top(){return top;},get writes(){return writes;},height:(value:number)=>{height=value;},viewport:(value:number)=>{viewport=value;},userTop:(value:number)=>{top=value;region.dispatchEvent(new view.Event('scroll'));},bind:(group:string)=>{document.querySelector('iframe')!.setAttribute('src',`https://vbooking.ctrip.com/tour/im/ex-area/b?groupid=${group}&sessionid=s&serviceType=t&status=1`);},hidden:(hidden:boolean)=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:hidden?'hidden':'visible'});document.dispatchEvent(new view.Event('visibilitychange'));},close:()=>{controller.dispose();dom.window.close();}};
}

test('opening waits 10 ms, then follows delayed translation height and viewport changes',()=>{
  const f=fixture();try{
    f.controller.update(key());f.advance(CONVERSATION_SCROLL_DELAY_MS-1);assert.equal(f.top,0);
    f.advance(1);assert.equal(f.top,700);
    f.height(1450);f.advance(50);assert.equal(f.top,1150);
    f.viewport(400);f.advance(50);assert.equal(f.top,1050);
  }finally{f.close();}
});

test('a message list rendered after the first timer still gets its initial scroll',()=>{
  const f=fixture();try{
    f.list.remove();f.controller.update(key());f.advance(10);assert.equal(f.writes,0);
    f.region.append(f.list);f.advance(50);assert.equal(f.top,700);
  }finally{f.close();}
});

test('follow expires after two seconds; heartbeats and new messages cannot restart it',()=>{
  const f=fixture();try{
    f.controller.update(key());f.advance(CONVERSATION_SCROLL_WINDOW_MS+100);assert.equal(f.timers.size,0);
    const writes=f.writes;f.height(2000);f.list.append(f.document.createElement('li'));
    for(let n=0;n<10;n++){f.controller.update(key());f.advance(100);}
    assert.equal(f.writes,writes);assert.equal(f.timers.size,0);
  }finally{f.close();}
});

test('rapid conversation changes cancel the old delay and only scroll the new binding',()=>{
  const f=fixture();try{
    f.controller.update(key());f.advance(5);f.bind('other');f.controller.update(key('other'));f.advance(5);assert.equal(f.writes,0);
    f.height(1800);f.advance(5);assert.equal(f.top,1500);assert.equal(f.writes,1);
  }finally{f.close();}
});

test('upward user scroll immediately ends follow, even if translation adds height',()=>{
  const f=fixture();try{
    f.controller.update(key());f.advance(10);f.userTop(200);f.height(1900);f.controller.update(key());f.advance(200);
    assert.equal(f.top,200);assert.equal(f.writes,1);assert.equal(f.timers.size,0);
  }finally{f.close();}
});

test('list wheel, touch, pointer and scrolling keys cancel before the first scroll',()=>{
  for(const type of ['wheel','touchstart','pointerdown','keydown']){
    const f=fixture();try{
      f.controller.update(key());f.list.dispatchEvent(type==='keydown'?new f.view.KeyboardEvent(type,{key:'PageUp',bubbles:true}):new f.view.Event(type,{bubbles:true}));
      f.advance(100);assert.equal(f.writes,0,type);assert.equal(f.timers.size,0,type);
    }finally{f.close();}
  }
});

test('an initially unbound key waits; a later mismatch cancels without restarting',()=>{
  const f=fixture();try{
    f.bind('other');f.controller.update(key());f.advance(100);assert.equal(f.writes,0);
    f.bind('g');f.controller.update(key());f.advance(10);assert.equal(f.top,700);
    f.bind('other');f.controller.update(key());f.height(1800);f.advance(100);assert.equal(f.writes,1);
    f.bind('g');f.controller.update(key());f.advance(100);assert.equal(f.writes,1);
  }finally{f.close();}
});

test('binding is rechecked at execution even without an update',()=>{
  const f=fixture();try{f.controller.update(key());f.bind('other');f.advance(10);assert.equal(f.writes,0);assert.equal(f.timers.size,0);}finally{f.close();}
});

test('hidden page and dispose both cancel old work',()=>{
  for(const action of ['hidden','dispose']){
    const f=fixture();try{
      f.controller.update(key());if(action==='hidden')f.hidden(true);else f.controller.dispose();
      f.advance(20);if(action==='hidden')f.hidden(false);f.controller.update(key());f.advance(100);
      assert.equal(f.writes,0,action);assert.equal(f.timers.size,0,action);
    }finally{f.close();}
  }
});

test('only verified scrollable list ancestors are touched, never body or sidebar',()=>{
  const f=fixture();try{
    f.region.style.overflowY='visible';Object.defineProperties(f.document.body,{scrollHeight:{value:3000},clientHeight:{value:500}});f.document.body.style.overflowY='auto';
    const aside=f.document.querySelector('aside')!;Object.defineProperties(aside,{scrollHeight:{value:3000},clientHeight:{value:500}});
    f.controller.update(key());f.advance(100);assert.equal(f.writes,0);assert.equal(f.document.body.scrollTop,0);assert.equal(aside.scrollTop,0);
    f.region.style.overflowY='auto';f.advance(50);assert.equal(f.top,700);
  }finally{f.close();}
});

test('ambiguous visible message lists are not scrolled',()=>{
  const f=fixture();try{
    const second=f.list.cloneNode(true) as HTMLElement;second.getClientRects=f.list.getClientRects;f.region.append(second);
    f.controller.update(key());f.advance(100);assert.equal(f.writes,0);
  }finally{f.close();}
});

test('the nearest scrollable message ancestor needs no invented class',()=>{
  const f=fixture();try{
    f.region.removeAttribute('class');f.controller.update(key());f.advance(10);assert.equal(f.top,700);
    f.height(1700);f.advance(50);assert.equal(f.top,1400);
  }finally{f.close();}
});

test('scrollable ancestors containing an editor, customer sidebar or another list are excluded',()=>{
  for(const markup of ['<div class="chat_area-input"></div>','<div class="customer_info"></div>','<aside>sidebar</aside>','<ul class="chat_list_content" hidden></ul>']){
    const f=fixture();try{
      f.region.removeAttribute('class');f.region.insertAdjacentHTML('beforeend',markup);f.controller.update(key());f.advance(100);assert.equal(f.writes,0,markup);
    }finally{f.close();}
  }
});

test('after discovery layout polling stays on the cached container',()=>{
  const f=fixture();try{
    let scans=0;const query=f.document.querySelectorAll.bind(f.document);
    f.document.querySelectorAll=((selector:string)=>{if(selector==='.chat_list_content')scans++;return query(selector);}) as any;
    f.controller.update(key());f.advance(10);assert.equal(scans,1);
    f.height(1500);f.advance(1000);assert.equal(f.top,1200);assert.equal(scans,1);
  }finally{f.close();}
});

test('mountPageFeatures opens once and stable boundary/update heartbeats do not steal reading position',()=>{
  const f=fixture();
  const state=embeddedPanelState({auth:'ready',attached:true,composerSource:'verified-editor',phase:'idle',messageSurface:{active:true},orderEntries:[],language:'en',preview:null,error:null} as any,key());
  const page=mountPageFeatures(f.document,{state});
  try{
    f.advance(9);assert.equal(f.writes,0);f.advance(1);assert.equal(f.top,700);
    f.advance(CONVERSATION_SCROLL_WINDOW_MS+100);f.userTop(100);f.height(2200);
    for(let n=0;n<5;n++){page.boundary();page.update({...state});f.advance(100);}
    assert.equal(f.top,100);assert.equal(f.writes,1);
    f.bind('next');page.update({...state,conversationKey:key('next')});f.advance(10);assert.equal(f.top,1900);
    page.dispose();f.height(2400);f.advance(100);assert.equal(f.top,1900);
  }finally{page.dispose();f.close();}
});
