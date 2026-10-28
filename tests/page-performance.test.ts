import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountPageFeatures} from '../runtime/page';
import {embeddedPanelState} from '../electron/embedded-host';
import {OPERATOR_FRAME_ID} from '../runtime/page/operator-overlay';

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const key=JSON.stringify(['target',JSON.stringify(['g','s','t','1']),1,'account']);
const guest=(text:string)=>`<li class="normal-message-item customer"><div class="message-name"><span class="tag-guest">guest</span></div><div class="chat-content"><div class="chat-text">${text}</div></div></li>`;
function fixture(){
  const dom=new JSDOM(`<body><div class="customer_info"><iframe class="customer_order-detail" src="https://vbooking.ctrip.com/tour/im/ex-area/b?groupid=g&sessionid=s&serviceType=t&status=1"></iframe></div><ul class="chat_list_content">${guest('Hello, can you help me please?')}</ul><div class="chat_area-input"><div class="chat-func-list"></div><div class="tiptap ProseMirror chat-editor" contenteditable="true"></div></div></body>`,{url:'https://merchant.invalid',pretendToBeVisual:true});
  const state=embeddedPanelState({auth:'ready',attached:true,composerSource:'verified-editor',phase:'idle',messageSurface:{active:true},orderEntries:[],language:'en',preview:null,error:null} as any,key);
  delete state.detectedOrder;
  return{dom,document:dom.window.document,state};
}

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
