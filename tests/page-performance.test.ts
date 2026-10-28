import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountPageFeatures} from '../runtime/page';
import {embeddedPanelState} from '../electron/embedded-host';
import {OPERATOR_FRAME_ID,OPERATOR_WARM_ID} from '../runtime/page/operator-overlay';

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const key=JSON.stringify(['target',JSON.stringify(['g','s','t','1']),1,'account']);
const guest=(text:string)=>`<li class="normal-message-item customer"><div class="message-name"><span class="tag-guest">guest</span></div><div class="chat-content"><div class="chat-text">${text}</div></div></li>`;
function fixture(){
  const dom=new JSDOM(`<body><div class="customer_info"><iframe class="customer_order-detail" src="https://vbooking.ctrip.com/tour/im/ex-area/b?groupid=g&sessionid=s&serviceType=t&status=1"></iframe></div><ul class="chat_list_content">${guest('Hello, can you help me please?')}</ul><div class="chat_area-input"><div class="chat-func-list"></div><div class="tiptap ProseMirror chat-editor" contenteditable="true"></div></div></body>`,{url:'https://merchant.invalid',pretendToBeVisual:true});
  const state=embeddedPanelState({auth:'ready',attached:true,composerSource:'verified-editor',phase:'idle',messageSurface:{active:true},orderEntries:[],language:'en',preview:null,error:null} as any,key);
  delete state.detectedOrder;
  return{dom,document:dom.window.document,state};
}

test('stable boundaries and editor mutations never refresh summary or preload an order page',async()=>{
  const f=fixture(),calls:string[]=[];
  const page=mountPageFeatures(f.document,{state:f.state,bridge:{invoke:async(name)=>{calls.push(name);}},prewarmDelayMs:1});
  try{
    await sleep(400);
    let updates=0,positions=0;
    const summary=page.summary!,update=summary.update,reposition=summary.reposition;
    summary.update=(value)=>{updates++;update(value);};summary.reposition=()=>{positions++;reposition();};
    for(let i=0;i<30;i++){page.boundary();f.document.querySelector('.chat-editor')!.textContent=`draft ${i}`;}
    await sleep(350);
    assert.equal(updates,0);assert.equal(positions,0);
    assert.equal(f.document.getElementById(OPERATOR_FRAME_ID),null);assert.equal(f.document.getElementById(OPERATOR_WARM_ID),null);
    assert.equal(calls.includes('operatorSession'),false);
    const frame=f.document.querySelector('iframe')!;frame.setAttribute('src','https://vbooking.ctrip.com/tour/im/ex-area/b?groupid=new&sessionid=new&serviceType=t&status=1');
    await sleep(200);assert.ok(updates>0,'a binding change still clears the summary');assert.ok(positions>0,'a source change still invalidates geometry');
  }finally{page.dispose();f.dom.window.close();}
});

test('a changed account/conversation key releases the opened TSIM frame immediately',()=>{
  const f=fixture(),page=mountPageFeatures(f.document,{state:f.state,bridge:{invoke:async()=>{}}});
  try{
    page.overlay.open({identifier:'ORDER12345'});assert.ok(page.overlay.frame);
    page.update({...f.state,conversationKey:JSON.stringify(['target',JSON.stringify(['g','s','t','1']),2,'new-account'])});
    assert.equal(page.overlay.frame,null);
    page.overlay.open({identifier:'ORDER12345'});assert.ok(page.overlay.frame);
    page.update({...f.state,auth:'needs_login'} as any);assert.equal(page.overlay.frame,null);
  }finally{page.dispose();f.dom.window.close();}
});
