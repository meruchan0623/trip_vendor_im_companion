// @vitest-environment jsdom
import {JSDOM}from'jsdom';
import{beforeEach,afterEach,describe,it,expect,vi}from'vitest';
import{mountRuntimeUi,type RuntimeUiHandle}from'../../runtime/runtime-ui';
import{VERIFIED_RUNTIME_BUILD}from'../../runtime/identity';
import{IDENTIFIER_CLASS}from'../../runtime/page/identifiers';
import type{PanelState}from'../../src/shared/workbench';
const metadata={leaseId:'runtime-unit-test-lease',aresVersion:'1.2.14' as const,htmlSha256:VERIFIED_RUNTIME_BUILD.htmlSha256,rendererSha256:VERIFIED_RUNTIME_BUILD.rendererSha256,keyboardBoundary:'isolated-world-shadow' as const};
const conversationKey=(id:string)=>JSON.stringify(['1:2:3',JSON.stringify([id,'session-'+id,'fixture-type','1']),1,'vendor-a']);
const C1=conversationKey('c1'),C2=conversationKey('c2'),C3=conversationKey('c3');
const frameURL=(id:string)=>'https://vbooking.ctrip.com/tour/im/ex-area/b?groupid='+id+'&sessionid=session-'+id+'&serviceType=fixture-type&status=1';
const switchFrame=(id:string)=>document.querySelector('iframe.customer_order-detail')!.setAttribute('src',frameURL(id));
const IM='<div id="root"><div class="customer_info"><iframe class="customer_order-detail" src="'+frameURL('c1')+'"></iframe></div><div class="im_detail inform-con"><div class="im_detail_hd"><div class="group-chat-hover-box"><div class="group-chat-hover-box-txt">订单号：1234567890</div></div></div><div class="chat_area"><div class="chat_area-list"><div class="chat_list_content"><ul><li class="normal-message-item customer"><div class="chat-content"><div class="chat-text">こんにちは、ICCID 89860012345678901234 です</div></div></li></ul></div></div><div class="chat_area-input"><div class="tiptap ProseMirror chat-editor" contenteditable="true"><p>您好</p></div></div><div class="chat_area-button"><div class="list-btn_send"><button class="btn_send">发送</button></div></div></div></div></div>';
const state=(patch:Partial<PanelState>={}):PanelState=>({auth:'ready',conversationKey:C1,draft:{text:'您好',composing:false},enabled:true,target:'en',followCustomer:{lang:null,following:true,manualEnabled:false},status:'idle',preview:null,error:null,busy:false,...patch});
const bindingName='tsim_'+'a'.repeat(32);
let handle:RuntimeUiHandle|undefined,dom:JSDOM,document:Document,binding:ReturnType<typeof vi.fn>;
beforeEach(()=>{vi.useFakeTimers();dom=new JSDOM('',{url:VERIFIED_RUNTIME_BUILD.documentURL,pretendToBeVisual:true});document=dom.window.document;document.head.innerHTML=`<script src="${VERIFIED_RUNTIME_BUILD.rendererURL}"></script>`;document.body.innerHTML=IM;binding=vi.fn();Object.defineProperty(dom.window,bindingName,{configurable:true,value:binding});});
afterEach(async()=>{await handle?.detach();handle=undefined;dom.window.close();vi.restoreAllMocks();vi.useRealTimers();});
const calls=()=>binding.mock.calls.map(([payload])=>JSON.parse(payload as string));
describe('runtime factory: thin isolated-world entry over the page features',()=>{
  it('keeps a cold-start lease before the composer appears, then mounts lazily',async()=>{
    document.body.innerHTML='<div id="root"></div>';
    handle=mountRuntimeUi(metadata,document,{bindingName,state:state({auth:'needs_login',status:'needs_login',conversationKey:null})});
    expect(handle.boundary()).toBe(true);expect(handle.geometry()).toMatchObject({width:0,height:0});
    await vi.advanceTimersByTimeAsync(1100);handle.heartbeat(1);expect(document.getElementById('tsim-outbound-panel')).toBeNull();
    document.body.innerHTML=IM;await vi.advanceTimersByTimeAsync(101);
    const host=document.getElementById('tsim-outbound-panel')!;expect(host.nextElementSibling).toBe(document.querySelector('.chat_area-input'));expect(handle.boundary()).toBe(true);
    expect((host.shadowRoot!.querySelector('.login') as HTMLButtonElement).hidden).toBe(false);expect(host.shadowRoot!.querySelector('.login')!.textContent).toBe('登录 TSim');
    await handle.detach();expect(vi.getTimerCount()).toBe(0);
  });
  it('survives a temporary vendor composer replacement across heartbeats',async()=>{
    handle=mountRuntimeUi(metadata,document,{bindingName,state:state()});const oldHost=document.getElementById('tsim-outbound-panel')!;
    const oldArea=document.querySelector('.chat_area')!;oldArea.remove();handle.heartbeat(1);expect(handle.boundary()).toBe(true);
    await vi.advanceTimersByTimeAsync(101);handle.heartbeat(2);expect(document.getElementById('tsim-outbound-panel')).toBeNull();
    document.body.innerHTML=IM;handle.heartbeat(3);expect(document.getElementById('tsim-outbound-panel')).toBe(oldHost);expect(oldHost.nextElementSibling).toBe(document.querySelector('.chat_area-input'));
    // Replacing only the editor/composer keeps the owned panel and the lease.
    document.querySelector('.chat_area-input')!.outerHTML='<div class="chat_area-input"><div class="tiptap ProseMirror chat-editor" contenteditable="true"></div></div>';
    await vi.advanceTimersByTimeAsync(101);handle.heartbeat(4);expect(document.getElementById('tsim-outbound-panel')).toBe(oldHost);
    // Once the observer has adopted the new anchor, removal alone still fails.
    oldHost.remove();await vi.advanceTimersByTimeAsync(101);expect(oldHost.isConnected).toBe(false);expect(()=>handle!.heartbeat(5)).toThrow('OWNED_FRAME_BOUNDARY_FAILED');
  });
  it('rejects a foreign panel host while waiting for the composer',()=>{
    document.body.innerHTML='<div id="root"></div>';handle=mountRuntimeUi(metadata,document,{bindingName,state:state()});
    const fake=document.createElement('div');fake.id='tsim-outbound-panel';document.body.append(fake);
    expect(()=>handle!.heartbeat(1)).toThrow('OWNED_FRAME_BOUNDARY_FAILED');expect(document.documentElement.hasAttribute('data-tsim-runtime-lease')).toBe(false);
  });
  it('refuses hidden mounting before creating a panel, lease or listener timers',()=>{
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});const before=document.body.innerHTML;
    expect(()=>mountRuntimeUi(metadata,document,{bindingName,state:state()})).toThrow('IM_TARGET_INACTIVE');
    expect(document.body.innerHTML).toBe(before);expect(document.documentElement.hasAttribute('data-tsim-runtime-lease')).toBe(false);expect(vi.getTimerCount()).toBe(0);expect(calls()).toEqual([]);
  });
  it('loading the factory alone never mounts; wrong renderer, document or metadata are rejected',()=>{expect(document.getElementById('tsim-outbound-panel')).toBeNull();expect(()=>mountRuntimeUi({...metadata,keyboardBoundary:'isolated-iframe-document' as never},document)).toThrow('UNAPPROVED_METADATA');expect(()=>mountRuntimeUi({...metadata,extra:1} as never,document)).toThrow('UNAPPROVED_METADATA');const other=new JSDOM('<div id="root"></div>',{url:'file:///C:/fixture/index.html'});expect(()=>mountRuntimeUi(metadata,other.window.document)).toThrow('UNAPPROVED_DOCUMENT');other.window.close();document.head.innerHTML='<script src="../../../../js/imWindow-9Tos9blK.js"></script>';expect(()=>mountRuntimeUi(metadata,document)).toThrow('UNAPPROVED_RENDERER');expect(document.documentElement.hasAttribute('data-tsim-runtime-lease')).toBe(false);});
  it('mounts the panel above the composer without decorating customer identifiers; a second mount is refused',()=>{handle=mountRuntimeUi(metadata,document,{bindingName,state:state()});const host=document.getElementById('tsim-outbound-panel')!;expect(host.nextElementSibling).toBe(document.querySelector('.chat_area-input'));expect(document.documentElement.getAttribute('data-tsim-runtime-lease')).toBe(metadata.leaseId);expect([...document.querySelectorAll(`.${IDENTIFIER_CLASS}`)].map(node=>node.getAttribute('data-tsim-identifier'))).toEqual([]);expect(()=>mountRuntimeUi(metadata,document)).toThrow('UNAPPROVED_LAYOUT_OR_ALREADY_ATTACHED');expect(handle.geometry()).toMatchObject({viewportWidth:dom.window.innerWidth,viewportHeight:dom.window.innerHeight});expect(Object.keys(handle.geometry())).toHaveLength(7);});
  it('without a service bridge no business controls or customer links mount',()=>{handle=mountRuntimeUi(metadata,document);expect(document.getElementById('tsim-outbound-panel')).toBeNull();expect(document.querySelectorAll(`.${IDENTIFIER_CLASS}`)).toHaveLength(0);expect(()=>mountRuntimeUi(metadata,document,{bindingName:'tsim_'+'b'.repeat(32),state:state()})).toThrow();});
  it('page intents travel through the binding and settle via respondWorkbench',async()=>{handle=mountRuntimeUi(metadata,document,{bindingName,state:state({status:'ready',preview:'Hello'})});const root=document.getElementById('tsim-outbound-panel')!.shadowRoot!;expect([...root.querySelectorAll('button')].some(button=>button.textContent==='替换并发送')).toBe(false);const replace=[...root.querySelectorAll('button')].find(button=>button.classList.contains('primary'))!;replace.click();const call=calls().find(item=>item.action==='apply')!;expect(call).toEqual({id:expect.stringMatching(/^\d+$/),action:'apply',args:[{mode:'replace'}]});handle.respondWorkbench(call.id,true);handle.respondWorkbench(call.id,false);handle.respondWorkbench('999',true);
    handle.updateWorkbench(state({status:'translating'}));expect(root.querySelector('.badge')!.textContent).toBe('翻译中');});
  it('reports unknown for unattributed messages and queries orders only after an explicit identifier',async()=>{
    handle=mountRuntimeUi(metadata,document,{bindingName,state:state()},{prewarmDelayMs:10});await vi.advanceTimersByTimeAsync(500);
    document.querySelector('ul')!.insertAdjacentHTML('beforeend','<li class="normal-message-item customer"><div class="chat-content"><div class="chat-text">Call 1234567890</div></div></li>');await vi.advanceTimersByTimeAsync(500);
    expect(calls()).toEqual([{id:expect.any(String),action:'customerLanguage',args:[{lang:'unknown',conversationKey:C1}]}]);handle.respondWorkbench(calls()[0].id,true);expect(document.getElementById('tsim-operator-frame')).toBeNull();expect(document.querySelectorAll(`.${IDENTIFIER_CLASS}`)).toHaveLength(0);
    const root=document.getElementById('tsim-outbound-panel')!.shadowRoot!;const query=root.querySelector<HTMLInputElement>('.query input')!;query.value='0000123';root.querySelector('.query form')!.dispatchEvent(new Event('submit',{cancelable:true}));
    const frame=document.getElementById('tsim-operator-frame') as HTMLIFrameElement;expect(new URL(frame.src).searchParams.get('identifier')).toBe('0000123');expect(new URL(frame.src).searchParams.has('mode')).toBe(false);expect(calls().filter(item=>item.action==='queryOrder')).toEqual([]);
  });
  const guest=()=>{document.querySelector('li.customer')!.insertAdjacentHTML('afterbegin','<div class="message-name"><span class="tag-guest">客人</span></div>');};
  const languageCalls=()=>calls().filter(item=>item.action==='customerLanguage');
  it('retries a rejected language report without requiring another DOM mutation',async()=>{
    guest();handle=mountRuntimeUi(metadata,document,{bindingName,state:state()});await vi.advanceTimersByTimeAsync(300);
    expect(languageCalls()).toHaveLength(1);handle.respondWorkbench(languageCalls()[0].id,false);
    await vi.advanceTimersByTimeAsync(1000);expect(languageCalls()).toHaveLength(2);
    expect(languageCalls()[1].args).toEqual([{lang:'ja',conversationKey:C1}]);
    handle.updateWorkbench(state({followCustomer:{lang:'ja',following:true,manualEnabled:false}}));
    handle.respondWorkbench(languageCalls()[1].id,true);await vi.advanceTimersByTimeAsync(2000);expect(languageCalls()).toHaveLength(2);
  });
  it('retries acknowledged but unreflected reports and stops after a bounded budget',async()=>{
    guest();handle=mountRuntimeUi(metadata,document,{bindingName,state:state()});
    for(let attempt=0;attempt<4;attempt++){
      await vi.advanceTimersByTimeAsync(attempt===0?300:1000);expect(languageCalls()).toHaveLength(attempt+1);
      handle.respondWorkbench(languageCalls()[attempt].id,true);
      handle.updateWorkbench(state());
    }
    await vi.advanceTimersByTimeAsync(1500);expect(languageCalls()).toHaveLength(4);
  });
  it('recovers a missing binding reply, then cancels stale retry work on conversation change and detach',async()=>{
    guest();handle=mountRuntimeUi(metadata,document,{bindingName,state:state()});await vi.advanceTimersByTimeAsync(1300);
    expect(languageCalls()).toHaveLength(2);const old=languageCalls().map(call=>call.id);
    switchFrame('c2');handle.updateWorkbench(state({conversationKey:C2}));await vi.advanceTimersByTimeAsync(300);
    expect(languageCalls()).toHaveLength(3);expect(languageCalls()[2].args[0].conversationKey).toBe(C2);
    handle.updateWorkbench(state({conversationKey:C2,followCustomer:{lang:'ja',following:true,manualEnabled:false}}));
    old.forEach((id,index)=>handle!.respondWorkbench(id,index===0));await vi.advanceTimersByTimeAsync(1000);expect(languageCalls()).toHaveLength(3);
    // Leave a live retry in flight, then prove detach removes all its timers.
    switchFrame('c3');handle.updateWorkbench(state({conversationKey:C3}));await vi.advanceTimersByTimeAsync(300);expect(languageCalls()).toHaveLength(4);
    await handle.detach();await vi.advanceTimersByTimeAsync(1500);expect(languageCalls()).toHaveLength(4);expect(vi.getTimerCount()).toBe(0);
  });
  it('does not redraw the panel for message mutations within the same conversation',async()=>{
    handle=mountRuntimeUi(metadata,document,{bindingName,state:state({status:'ready',preview:'Hello'})});
    const root=document.getElementById('tsim-outbound-panel')!.shadowRoot!;
    let changes=0;const observer=new dom.window.MutationObserver(records=>{changes+=records.length;});
    observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true});
    for(let i=0;i<20;i++){
      document.querySelector('.chat-text')!.textContent='こんにちは '+i;
      await Promise.resolve();
    }
    expect(changes).toBe(0);
    switchFrame('c2');await vi.advanceTimersByTimeAsync(1);
    expect(root.querySelector<HTMLElement>('.preview')!.hidden).toBe(true);
    expect(changes).toBeGreaterThan(0);observer.disconnect();
  });
  it.each(['DOM first','state first'])('blocks stale language and preview during a conversation switch: %s',async order=>{
    guest();handle=mountRuntimeUi(metadata,document,{bindingName,state:state({status:'ready',preview:'A private translation',followCustomer:{lang:'ja',following:true,manualEnabled:false}})});
    const root=document.getElementById('tsim-outbound-panel')!.shadowRoot!;
    const next=state({conversationKey:C2});
    if(order==='DOM first')switchFrame('c2');else handle.updateWorkbench(next);
    await vi.advanceTimersByTimeAsync(350);
    expect(root.querySelector<HTMLElement>('.preview')!.hidden).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('.primary')!.disabled).toBe(true);
    expect(languageCalls()).toHaveLength(0);
    // A late state delivery still cannot restore A's preview over B's DOM.
    if(order==='DOM first'){
      handle.updateWorkbench(state({status:'ready',preview:'A private translation'}));
      expect(root.querySelector<HTMLElement>('.preview')!.hidden).toBe(true);
      handle.updateWorkbench(next);
    }else switchFrame('c2');
    await vi.advanceTimersByTimeAsync(350);
    expect(languageCalls()).toHaveLength(1);
    expect(languageCalls()[0].args).toEqual([{lang:'ja',conversationKey:C2}]);
    expect(root.querySelector<HTMLElement>('.preview')!.hidden).toBe(true);
  });
  it('rescans when a published language disappears in the same conversation',async()=>{
    guest();handle=mountRuntimeUi(metadata,document,{bindingName,state:state({followCustomer:{lang:'ja',following:true,manualEnabled:false}})});
    await vi.advanceTimersByTimeAsync(300);expect(languageCalls()).toHaveLength(0);
    handle.updateWorkbench(state());await vi.advanceTimersByTimeAsync(300);expect(languageCalls()).toHaveLength(1);
    expect(languageCalls()[0].args).toEqual([{lang:'ja',conversationKey:C1}]);
  });
  it('scans during sustained vendor mutations instead of waiting for scrolling to stop',async()=>{
    guest();handle=mountRuntimeUi(metadata,document,{bindingName,state:state()});
    for(let index=0;index<8;index++){
      document.querySelector('.chat-text')!.textContent=`こんにちは ${index}`;
      await vi.advanceTimersByTimeAsync(100);
      if(index===3)expect(languageCalls()).toHaveLength(1);
    }
    expect(languageCalls()).toHaveLength(1);
    handle.updateWorkbench(state({followCustomer:{lang:'ja',following:true,manualEnabled:false}}));
    handle.respondWorkbench(languageCalls()[0].id,true);await vi.advanceTimersByTimeAsync(1500);expect(languageCalls()).toHaveLength(1);
  });
  it('accepts an unknown observation without retrying against a retained service language',async()=>{
    handle=mountRuntimeUi(metadata,document,{bindingName,state:state({followCustomer:{lang:'ja',following:true,manualEnabled:false}})});
    await vi.advanceTimersByTimeAsync(300);expect(languageCalls()).toHaveLength(1);
    expect(languageCalls()[0].args[0].lang).toBe('unknown');handle.respondWorkbench(languageCalls()[0].id,true);
    handle.updateWorkbench(state({followCustomer:{lang:'ja',following:true,manualEnabled:false}}));
    await vi.advanceTimersByTimeAsync(2000);expect(languageCalls()).toHaveLength(1);
  });
  it('does not render backend order fields and removes iframe on conversation switch',()=>{
    handle=mountRuntimeUi(metadata,document,{bindingName,state:state({order:{identifier:'0000123',status:'ready',error:null,fields:[{label:'状态',value:'PRIVATE VALUE'}]}})});
    const root=document.getElementById('tsim-outbound-panel')!.shadowRoot!;expect(root.querySelector('.order-result')).toBeNull();expect(root.textContent).not.toContain('PRIVATE VALUE');
    (root.querySelector('.query input') as HTMLInputElement).value='0000123';root.querySelector('.query form')!.dispatchEvent(new Event('submit',{cancelable:true}));const frame=document.getElementById('tsim-operator-frame') as HTMLIFrameElement;expect(new URL(frame.src).searchParams.get('identifier')).toBe('0000123');handle.updateWorkbench(state({conversationKey:C2}));expect(document.getElementById('tsim-operator-frame')).toBeNull();expect(document.getElementById('tsim-operator-loading')).toBeNull();expect(calls().some(item=>item.action==='queryOrder')).toBe(false);
  });
  it('detach is idempotent, rejects pending intents and removes everything owned while preserving the vendor DOM',async()=>{const before=document.querySelector('.chat_area')!.textContent;handle=mountRuntimeUi(metadata,document,{bindingName,state:state()},{prewarmDelayMs:10});await vi.advanceTimersByTimeAsync(10);const root=document.getElementById('tsim-outbound-panel')!.shadowRoot!;root.querySelector<HTMLButtonElement>('.switch')!.click();await handle.detach();await handle.detach();
    for(const selector of ['#tsim-outbound-panel','#tsim-operator-frame','#tsim-operator-loading','#tsim-query-identifier-style',`.${IDENTIFIER_CLASS}`])expect(document.querySelector(selector)).toBeNull();expect(document.documentElement.hasAttribute('data-tsim-runtime-lease')).toBe(false);expect(document.querySelector('.chat_area')!.textContent).toBe(before);expect(document.querySelector('.chat-editor')!.innerHTML).toBe('<p>您好</p>');expect(()=>handle!.heartbeat(1)).toThrow('LEASE_ENDED');expect(vi.getTimerCount()).toBe(0);});
  it('lease expires without heartbeat; stale heartbeats are rejected',async()=>{handle=mountRuntimeUi(metadata,document,{bindingName,state:state()});handle.heartbeat(1);expect(()=>handle!.heartbeat(1)).toThrow('STALE');await vi.advanceTimersByTimeAsync(6000);expect(document.getElementById('tsim-outbound-panel')).toBeNull();expect(()=>handle!.heartbeat(2)).toThrow('LEASE_ENDED');});
  it.each(['lease','foreign-panel','duplicate-panel','removed-panel'])('revokes the lease after %s boundary drift',kind=>{handle=mountRuntimeUi(metadata,document,{bindingName,state:state()},{prewarmDelayMs:0});vi.advanceTimersByTime(0);
    if(kind==='lease')document.documentElement.setAttribute('data-tsim-runtime-lease','other');
    if(kind==='foreign-panel'){const own=document.getElementById('tsim-outbound-panel')!;own.id='renamed';const fake=document.createElement('div');fake.id='tsim-outbound-panel';document.body.prepend(fake);}
    if(kind==='duplicate-panel')document.body.append(document.getElementById('tsim-outbound-panel')!.cloneNode(true));
    if(kind==='removed-panel')document.getElementById('tsim-outbound-panel')!.remove();
    expect(()=>handle!.heartbeat(1)).toThrow('OWNED_FRAME_BOUNDARY_FAILED');expect(document.querySelector('[id="renamed"][data-tsim-owned]')).toBeNull();expect(()=>handle!.heartbeat(2)).toThrow('LEASE_ENDED');});
});
