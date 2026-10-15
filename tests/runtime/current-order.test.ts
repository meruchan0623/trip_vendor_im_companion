// @vitest-environment jsdom
import {describe,it,expect,vi} from 'vitest';
import {JSDOM} from 'jsdom';
import {readCurrentOrder,startOrderObservation} from '../../runtime/page/identifiers';
const FIRST='1600000000000101',SECOND='1600000000000303';
const FRAME_URL='https://vbooking.ctrip.com/tour/im/ex-area/b';
const frameUrl=(group='g1',child=false)=>`${FRAME_URL}${child?'/imExtraInfo':''}?groupid=${group}&sessionid=s1&${child?'servicetype':'serviceType'}=1&status=1`;
const context=(group='g1')=>JSON.stringify(['target',JSON.stringify([group,'s1','1','1']),2,'merchant-document:test']);
const row=(value:string)=>`<li><div class="im_info_basic_list_title">订单ID</div><div class="im_info_basic_list_content">${value}</div></li>`;
function fixture(value=FIRST){
  const parent=new JSDOM(`<div class="im_detail_hd"><div class="group-chat-hover-box-txt">订单号：1234567890</div></div><div class="customer_info"><iframe class="customer_order-detail"></iframe></div>`,{pretendToBeVisual:true});
  const doc=parent.window.document,frame=doc.querySelector('iframe')!;frame.src=frameUrl();
  const children:JSDOM[]=[];
  const makeChild=(markup:string,group='g1')=>{const dom=new JSDOM(`<ul class="im_info_basic_list">${markup}</ul>`,{url:frameUrl(group,true),pretendToBeVisual:true});children.push(dom);return dom.window.document;};
  let child=makeChild(row(value));
  Object.defineProperty(frame,'contentDocument',{configurable:true,get:()=>child});
  return{doc,frame,makeChild,setChild(next:Document){child=next;},close(){for(const dom of children)dom.window.close();parent.window.close();}};
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
describe('current vendor order detail',()=>{
  it('prefers the observed frame order row over a valid header',()=>{const f=fixture();expect(readCurrentOrder(f.doc)).toBe(FIRST);f.close();});
  it.each([
    [row('001600000000000101'),'001600000000000101'],
    [row(FIRST)+row(FIRST),FIRST],
    [row(FIRST)+row(SECOND),undefined],
    [row(FIRST+SECOND),undefined],
    [row(`<span>${FIRST}</span><span>${SECOND}</span>`),undefined],
    [row('<span>16000000</span><span>00000101</span>'),undefined],
    [row('OD-12345678'),undefined],
    [row(FIRST).replace('订单ID','订单号'),undefined],
    [row(FIRST).replace('im_info_basic_list_content','other'),undefined],
    [row(FIRST).replace('<li>','<li hidden>'),undefined],
    [row(FIRST)+row(SECOND).replace('<li>','<li data-tsim-owned="1">'),FIRST],
    [row(`<span>${FIRST}</span><span hidden>${SECOND}</span>`),FIRST],
  ])('accepts only one unambiguous numeric labelled value: %s',(markup,expected)=>{const f=fixture();f.setChild(f.makeChild(markup));expect(readCurrentOrder(f.doc)).toBe(expected);f.close();});
  it('does not fall back on loading, cross-origin failures, hidden or unapproved frames',()=>{
    const f=fixture();
    Object.defineProperty(f.frame,'contentDocument',{configurable:true,get:()=>{throw new DOMException('Blocked','SecurityError');}});expect(readCurrentOrder(f.doc)).toBeUndefined();
    Object.defineProperty(f.frame,'contentDocument',{configurable:true,get:()=>null});expect(readCurrentOrder(f.doc)).toBeUndefined();
    f.frame.src='https://example.com/tour/im/ex-area/b';expect(readCurrentOrder(f.doc)).toBeUndefined();
    f.frame.remove();expect(readCurrentOrder(f.doc)).toBe('1234567890');f.close();
  });
  it('rejects multiple matching frames and unrelated child document locations',()=>{const f=fixture();const other=f.frame.cloneNode() as HTMLIFrameElement;f.frame.after(other);expect(readCurrentOrder(f.doc)).toBeUndefined();other.remove();f.setChild(new JSDOM('<p>loading</p>').window.document);expect(readCurrentOrder(f.doc)).toBeUndefined();f.close();});
  it('observes child changes and iframe loads, clears navigation, and detaches replaced documents',async()=>{
    const f=fixture(),changed=vi.fn(),observation=startOrderObservation(f.doc,changed);
    expect(changed).toHaveBeenLastCalledWith(FIRST);
    const old=f.frame.contentDocument!;old.querySelector('.im_info_basic_list_content')!.textContent=SECOND;await settle();expect(changed).toHaveBeenLastCalledWith(SECOND);
    f.frame.src=FRAME_URL+'?next=1';await settle();expect(changed).toHaveBeenLastCalledWith(undefined);
    f.setChild(f.makeChild(row(FIRST)));f.frame.dispatchEvent(new f.doc.defaultView!.Event('load'));expect(changed).toHaveBeenLastCalledWith(FIRST);
    changed.mockClear();old.querySelector('ul')!.textContent='changed after navigation';await settle();expect(changed).not.toHaveBeenCalled();
    observation.dispose();f.frame.contentDocument!.querySelector('ul')!.textContent='removed';f.frame.dispatchEvent(new f.doc.defaultView!.Event('load'));await settle();expect(changed).not.toHaveBeenCalled();f.close();
  });
  it('clears on mismatched conversation and iframe unload until a fresh load',()=>{
    const f=fixture(),changed=vi.fn(),observation=startOrderObservation(f.doc,changed,context());
    observation.setConversationKey(context('g2'));expect(changed).toHaveBeenLastCalledWith(undefined);observation.refresh();expect(changed).toHaveBeenLastCalledWith(undefined);
    observation.setConversationKey(context());expect(changed).toHaveBeenLastCalledWith(FIRST);
    f.frame.dispatchEvent(new f.doc.defaultView!.Event('load'));expect(changed).toHaveBeenLastCalledWith(FIRST);
    f.frame.contentDocument!.defaultView!.dispatchEvent(new f.frame.contentDocument!.defaultView!.Event('pagehide'));expect(changed).toHaveBeenLastCalledWith(undefined);
    observation.dispose();f.close();
  });
  it('tracks AJAX changes inside the correctly associated conversation document',async()=>{
    const f=fixture(),changed=vi.fn(),observation=startOrderObservation(f.doc,changed,context()),content=f.frame.contentDocument!.querySelector('.im_info_basic_list_content')!;
    content.textContent=SECOND;await settle();expect(changed).toHaveBeenLastCalledWith(SECOND);
    observation.dispose();f.close();
  });
  it.each([FIRST,SECOND])('accepts frame-load before host context update, including an unchanged order %s',(order)=>{
    const f=fixture(),changed=vi.fn(),observation=startOrderObservation(f.doc,changed,context());
    f.frame.src=frameUrl('g2');f.setChild(f.makeChild(row(order),'g2'));f.frame.dispatchEvent(new f.doc.defaultView!.Event('load'));
    expect(changed).toHaveBeenLastCalledWith(undefined);
    observation.setConversationKey(context('g2'));expect(changed).toHaveBeenLastCalledWith(order);
    observation.dispose();f.close();
  });
  it.each([FIRST,SECOND])('accepts host context update before frame-load, including an unchanged order %s',async(order)=>{
    const f=fixture(),changed=vi.fn(),observation=startOrderObservation(f.doc,changed,context());
    observation.setConversationKey(context('g2'));expect(changed).toHaveBeenLastCalledWith(undefined);
    f.frame.contentDocument!.querySelector('.im_info_basic_list_content')!.textContent=order;await settle();expect(changed).toHaveBeenLastCalledWith(undefined);
    f.frame.src=frameUrl('g2');await settle();expect(changed).toHaveBeenLastCalledWith(undefined);
    f.setChild(f.makeChild(row(order),'g2'));f.frame.dispatchEvent(new f.doc.defaultView!.Event('load'));expect(changed).toHaveBeenLastCalledWith(order);
    observation.dispose();f.close();
  });
  it('rejects an old child document when mounting after src already switched',()=>{
    const f=fixture();f.frame.src=frameUrl('g2');expect(readCurrentOrder(f.doc)).toBeUndefined();
    const changed=vi.fn(),observation=startOrderObservation(f.doc,changed,context('g2'));expect(changed).toHaveBeenLastCalledWith(undefined);
    f.setChild(f.makeChild(row(SECOND),'g2'));f.frame.dispatchEvent(new f.doc.defaultView!.Event('load'));expect(changed).toHaveBeenLastCalledWith(SECOND);
    observation.dispose();f.close();
  });
  it('allows null host context to become a verified matching context without navigation',()=>{
    const f=fixture(),changed=vi.fn(),observation=startOrderObservation(f.doc,changed,null);expect(changed).toHaveBeenLastCalledWith(undefined);
    observation.setConversationKey(context());expect(changed).toHaveBeenLastCalledWith(FIRST);
    observation.setConversationKey('malformed');expect(changed).toHaveBeenLastCalledWith(undefined);
    observation.dispose();f.close();
  });
  it('cleans replaced frame bindings when the parent asks to refresh',async()=>{
    const f=fixture(),changed=vi.fn(),observation=startOrderObservation(f.doc,changed),old=f.frame;
    old.remove();observation.refresh();expect(changed).toHaveBeenLastCalledWith('1234567890');
    changed.mockClear();old.dispatchEvent(new f.doc.defaultView!.Event('load'));old.contentDocument!.querySelector('ul')!.textContent='stale';await settle();expect(changed).not.toHaveBeenCalled();
    const next=f.doc.createElement('iframe');next.className='customer_order-detail';next.src=FRAME_URL;Object.defineProperty(next,'contentDocument',{get:()=>f.makeChild(row(SECOND))});f.doc.querySelector('.customer_info')!.append(next);observation.refresh();expect(changed).toHaveBeenLastCalledWith(SECOND);
    observation.dispose();f.close();
  });
});
