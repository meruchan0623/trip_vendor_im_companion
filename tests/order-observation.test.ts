import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {readCurrentOrder,readHeaderOrder,startOrderObservation} from '../runtime/page/identifiers';

const fields=(session='session-1')=>['group-1',session,'service','open'];
const parentUrl=(session='session-1')=>`https://vbooking.ctrip.com/tour/im/ex-area/b?groupid=group-1&sessionid=${session}&serviceType=service&status=open`;
const childUrl=(session='session-1')=>parentUrl(session).replace('/b?','/b/imExtraInfo?').replace('serviceType=','servicetype=');
const key=(session='session-1')=>JSON.stringify(['target',JSON.stringify(fields(session)),1,'account']);
const markup=(order='12345678')=>`<main><ul class="im_info_basic_list"><li><span class="im_info_basic_list_title">订单ID</span><span class="im_info_basic_list_content"><b>${order}</b></span></li><li><span class="im_info_basic_list_title">用户</span><span class="im_info_basic_list_content">Customer</span></li></ul></main><aside>unrelated</aside>`;
const tick=()=>new Promise(resolve=>setTimeout(resolve,15));
function fixture(){
  const dom=new JSDOM('<!doctype html><html><body><div class="customer_info"><iframe class="customer_order-detail"></iframe></div><aside>unrelated</aside></body></html>',{url:'https://vbooking.ctrip.com/tour/im',pretendToBeVisual:true});
  const child=new JSDOM(markup(),{url:childUrl(),pretendToBeVisual:true}),frame=dom.window.document.querySelector('iframe')!;
  frame.src=parentUrl();let current:Document|null=child.window.document as unknown as Document;
  Object.defineProperty(frame,'contentDocument',{configurable:true,get:()=>current});
  return{dom,child,frame,document:dom.window.document as unknown as Document,setChild:(next:Document|null)=>{current=next;},close:()=>{dom.window.close();child.window.close();}};
}

test('one order read shares ancestor visibility and the next read observes changed styles',()=>{
  const f=fixture();
  try{
    const counts=new Map<Element,number>();
    for(const window of [f.dom.window,f.child.window]){
      const original=window.getComputedStyle.bind(window);
      window.getComputedStyle=((element:Element)=>{counts.set(element,(counts.get(element)??0)+1);return original(element as never);}) as never;
    }
    assert.equal(readCurrentOrder(f.document),'12345678');
    for(const count of counts.values())assert.equal(count,1,'a common ancestor is measured once per read');
    f.child.window.document.querySelector('main')!.style.display='none';assert.equal(readCurrentOrder(f.document),undefined);
    f.child.window.document.querySelector('main')!.style.display='';assert.equal(readCurrentOrder(f.document),'12345678');
    f.child.window.document.querySelector('ul')!.insertAdjacentHTML('beforeend','<li><span class="im_info_basic_list_title">订单ID</span><span class="im_info_basic_list_content">87654321</span></li>');
    assert.equal(readCurrentOrder(f.document),undefined,'multiple candidate orders remain refused');
    f.frame.src='https://foreign.example/order';assert.equal(readCurrentOrder(f.document),undefined,'an existing foreign frame never falls back to another source');
  }finally{f.close();}
});

test('header visibility changes invalidate only the current read and split values stay refused',()=>{
  const dom=new JSDOM('<div class="im_detail_hd"><div class="group-chat-hover-box-txt">订单号：<span>ORD12345</span></div></div>');
  try{
    const document=dom.window.document as unknown as Document;assert.equal(readHeaderOrder(document),'ORD12345');
    document.querySelector('.im_detail_hd')!.setAttribute('aria-hidden','true');assert.equal(readHeaderOrder(document),undefined);
    document.querySelector('.im_detail_hd')!.removeAttribute('aria-hidden');assert.equal(readHeaderOrder(document),'ORD12345');
    document.querySelector('span')!.innerHTML='<b>ORD</b><b>12345</b>';assert.equal(readHeaderOrder(document),undefined);
  }finally{dom.window.close();}
});

test('unrelated parent and child mutations do not scan orders; relevant batches share one refresh',async()=>{
  const f=fixture(),orders:(string|undefined)[]=[];let layouts=0,sourceScans=0;
  const childDocument=f.child.window.document,original=childDocument.querySelectorAll.bind(childDocument);
  childDocument.querySelectorAll=((selector:string)=>{if(selector.includes('im_info_basic_list'))sourceScans++;return original(selector);}) as never;
  const observation=startOrderObservation(f.document,order=>orders.push(order),key(),()=>layouts++);
  const parent=new f.dom.window.MutationObserver(mutations=>{if(observation.invalidate(mutations as unknown as MutationRecord[]))observation.refresh();});
  parent.observe(f.document.body,{subtree:true,childList:true,characterData:true,attributes:true});
  try{
    assert.deepEqual(orders,['12345678']);const initialScans=sourceScans;
    f.document.body.append(f.document.createElement('footer'));
    f.document.querySelector('aside')!.textContent='new unrelated text';
    const title=childDocument.createElement('title');childDocument.head.append(title);title.textContent='another unrelated text';await tick();
    assert.equal(sourceScans,initialScans);assert.equal(layouts,0);assert.deepEqual(orders,['12345678']);
    const value=childDocument.querySelector('b')!.firstChild!;
    value.textContent='22345678';await Promise.resolve();value.textContent='32345678';await tick();
    assert.deepEqual(orders,['12345678','32345678']);assert.equal(sourceScans,initialScans,'a text edit reuses the verified order row nodes');assert.equal(layouts,1,'multiple observer deliveries share one scheduled refresh');
    const scans=sourceScans;observation.setConversationKey(key());assert.equal(sourceScans,scans,'unchanged binding is free');
    childDocument.querySelector('main')!.setAttribute('hidden','');await tick();assert.equal(orders.at(-1),undefined);
    childDocument.querySelector('main')!.removeAttribute('hidden');await tick();assert.equal(orders.at(-1),'32345678');
    const before=orders.length;
    childDocument.querySelector('li:last-child .im_info_basic_list_content')!.textContent='New name';await tick();
    assert.equal(orders.length,before,'same order is not published again');assert.equal(layouts,4,'same-order vendor geometry still invalidates placement');
    f.document.querySelector('.customer_info')!.setAttribute('hidden','');await tick();assert.equal(orders.at(-1),undefined);
    f.document.querySelector('.customer_info')!.removeAttribute('hidden');await tick();assert.equal(orders.at(-1),'32345678');
  }finally{parent.disconnect();observation.dispose();f.close();}
});

test('conversation switches, iframe navigation, replacement and disposal release stale sources',async()=>{
  const f=fixture(),orders:(string|undefined)[]=[],extra:JSDOM[]=[];
  const observation=startOrderObservation(f.document,order=>orders.push(order),key());
  try{
    assert.deepEqual(orders,['12345678']);observation.setConversationKey(key('session-2'));assert.equal(orders.at(-1),undefined);
    const next=new JSDOM(markup('87654321'),{url:childUrl('session-2'),pretendToBeVisual:true});extra.push(next);
    f.frame.src=parentUrl('session-2');f.setChild(next.window.document as unknown as Document);await tick();
    assert.equal(orders.at(-1),undefined,'new src stays pending until load');
    f.frame.dispatchEvent(new f.dom.window.Event('load'));assert.equal(orders.at(-1),'87654321');
    f.child.window.document.querySelector('b')!.textContent='99999999';await tick();assert.equal(orders.at(-1),'87654321','old child observer is detached');
    next.window.dispatchEvent(new next.window.Event('pagehide'));assert.equal(orders.at(-1),undefined);
    next.window.document.querySelector('b')!.textContent='77777777';await tick();assert.equal(orders.at(-1),undefined,'unloaded child cannot republish');
    const reloaded=new JSDOM(markup('66666666'),{url:childUrl('session-2'),pretendToBeVisual:true});extra.push(reloaded);
    f.setChild(reloaded.window.document as unknown as Document);f.frame.dispatchEvent(new f.dom.window.Event('load'));assert.equal(orders.at(-1),'66666666');
    f.frame.remove();observation.refresh();assert.equal(orders.at(-1),undefined);
    const before=orders.length;reloaded.window.document.querySelector('b')!.textContent='55555555';f.frame.dispatchEvent(new f.dom.window.Event('load'));await tick();assert.equal(orders.length,before);
    observation.dispose();observation.refresh();observation.setConversationKey(key());assert.equal(orders.length,before);
  }finally{observation.dispose();for(const child of extra)child.window.close();f.close();}
});


test('fixed-size vendor content after the order list invalidates layout without rereading the order',async()=>{
  const f=fixture(),orders:(string|undefined)[]=[];let layouts=0,queries=0,styleReads=0;
  const document=f.child.window.document,originalQuery=document.querySelectorAll.bind(document),originalStyle=f.child.window.getComputedStyle.bind(f.child.window);
  document.body.style.cssText='height:660px;overflow:hidden';document.querySelector('main')!.style.cssText='height:240px;overflow:auto';
  document.querySelectorAll=((selector:string)=>{if(selector.includes('im_info_basic_list'))queries++;return originalQuery(selector);}) as never;
  f.child.window.getComputedStyle=((element:Element)=>{styleReads++;return originalStyle(element as never);}) as never;
  const observation=startOrderObservation(f.document,order=>orders.push(order),key(),()=>layouts++);
  try{
    const initial={queries,styleReads},section=document.createElement('section');section.textContent='More vendor content';document.querySelector('main')!.append(section);await tick();
    assert.equal(layouts,1,'new later sections invalidate the cached content-bottom nodes even without ResizeObserver');assert.deepEqual({queries,styleReads},initial,'layout-only mutation performs no order node scan or visibility read');assert.deepEqual(orders,['12345678']);
    section.textContent='Changed content';section.style.height='400px';await tick();assert.equal(layouts,2,'the new sibling remains a cached layout source');assert.deepEqual({queries,styleReads},initial);
    section.remove();await tick();assert.equal(layouts,3);assert.deepEqual({queries,styleReads},initial);
    const extra=document.createElement('section');document.body.append(extra);await tick();assert.equal(layouts,4,'later siblings of list ancestors also invalidate placement');assert.deepEqual({queries,styleReads},initial);
    const owned=document.createElement('div');owned.setAttribute('data-tsim-owned','1');document.querySelector('main')!.append(owned);owned.textContent='Assistant UI';await tick();assert.equal(layouts,4,'owned changes do not trigger layout work');
    observation.dispose();extra.textContent='After disposal';await tick();assert.equal(layouts,4);
  }finally{observation.dispose();f.close();}
});
