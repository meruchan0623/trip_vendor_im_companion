import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountPageFeatures} from '../runtime/page';
import {createCustomerLanguageReader,affectsCustomerLanguage,detectLanguage} from '../runtime/page/language';
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

test('unchanged customer originals reuse inference; changed originals, visibility and reset invalidate it',()=>{
  const f=fixture(),reader=createCustomerLanguageReader(f.document);
  try{
    const first=reader.read();assert.equal(first.language,'en');assert.equal(first.sampleCount,1);
    assert.equal(reader.read(),first);
    f.document.querySelector('.chat-content')!.insertAdjacentHTML('beforeend','<div class="tran-group"><div class="chat-text">韓国語の翻訳</div></div>');
    assert.equal(reader.read(),first,'vendor translation is not a new original');
    f.document.querySelector('.chat-content > .chat-text')!.textContent='こんにちは、インターネットに接続できません。';
    const changed=reader.read();assert.notEqual(changed,first);assert.equal(changed.language,'ja');
    const row=f.document.querySelector('li') as HTMLElement;row.hidden=true;
    assert.equal(reader.read().sampleCount,0);row.hidden=false;
    assert.equal(reader.read().language,'ja');reader.reset();assert.notEqual(reader.read(),changed);
  }finally{reader.reset();f.dom.window.close();}
});

test('language cache retains the 30-original window and does not retain oversized content',()=>{
  const f=fixture(),reader=createCustomerLanguageReader(f.document);
  try{
    f.document.querySelector('ul')!.innerHTML=Array.from({length:40},()=>guest('Hello, I need help with this service.')).join('');
    assert.equal(reader.read().sampleCount,30);
    f.document.querySelector('ul')!.innerHTML=guest('您好，请问可以帮我吗？'.repeat(7000));
    assert.notEqual(reader.read(),reader.read(),'oversized original is not persisted in the cache');
  }finally{reader.reset();f.dom.window.close();}
});

test('language invalidation ignores editor input but observes original changes and list removal',()=>{
  const f=fixture(),observer=new f.dom.window.MutationObserver(()=>{});
  try{
    observer.observe(f.document.body,{childList:true,subtree:true,attributes:true,attributeOldValue:true,characterData:true});
    f.document.querySelector('.chat-editor')!.textContent='draft';
    assert.equal(observer.takeRecords().some(affectsCustomerLanguage),false);
    f.document.querySelector('.chat-content > .chat-text')!.textContent='new original';
    assert.equal(observer.takeRecords().some(affectsCustomerLanguage),true);
    const list=f.document.querySelector('ul')!;list.className='loading';
    assert.equal(observer.takeRecords().some(affectsCustomerLanguage),true);
    list.className='chat_list_content';observer.takeRecords();list.remove();
    assert.equal(observer.takeRecords().some(affectsCustomerLanguage),true);
  }finally{observer.disconnect();f.dom.window.close();}
});

test('long unbroken originals and incomplete mailbox tokens do not cause quadratic cleanup',()=>{
  const started=performance.now();
  assert.equal(detectLanguage('a'.repeat(70000)),'unknown');
  assert.equal(detectLanguage('a'.repeat(70000)+'@invalid'),'unknown');
  assert.equal(detectLanguage('a.'.repeat(35000)),'unknown');
  assert.equal(detectLanguage('Please help me connect. person@example.com'),'en');
  assert.ok(performance.now()-started<2000,'synthetic cleanup must remain bounded, not a UI latency claim');
});

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
