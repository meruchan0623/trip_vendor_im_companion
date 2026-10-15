// @vitest-environment jsdom
import {describe,it,expect,vi,afterEach} from 'vitest';
import {JSDOM} from 'jsdom';
import {findIdentifierMatches,inferIdentifierType,readHeaderOrder,linkifyIdentifiers,startIdentifierLinkifier,unlinkifyIdentifiers,IDENTIFIER_CLASS,SCAN_DEBOUNCE_MS} from '../../runtime/page/identifiers';
const ICCID='89860012345678901234';
function page(bubbles:string[],header='订单号：1234567890'){const dom=new JSDOM(`<div class="im_detail inform-con"><div class="im_detail_hd"><div class="group-chat-hover-box"><div class="group-chat-hover-box-txt">${header}</div></div></div><div class="chat_area"><div class="chat_list_content"><ul>${bubbles.map(text=>`<li class="normal-message-item customer"><div class="chat-content"><div class="chat-text">${text}</div></div></li>`).join('')}</ul></div><div class="chat_area-input"><div class="tiptap ProseMirror chat-editor" contenteditable="true">草稿 ${ICCID}</div></div></div></div>`,{pretendToBeVisual:true});return{dom,doc:dom.window.document};}
const wrappers=(doc:Document)=>[...doc.querySelectorAll<HTMLElement>(`.${IDENTIFIER_CLASS}`)];
afterEach(()=>{vi.useRealTimers();});
describe('identifier regex, priority and type',()=>{
  it('finds ICCIDs, prefixed order ids, underscore ids and generic ids',()=>{expect(findIdentifierMatches(`ICCID ${ICCID} order OD-12345678 ref A_123456ABC_7 and X12345Y`).map(match=>match.text)).toEqual([ICCID,'OD-12345678','A_123456ABC_7','X12345Y']);});
  it('drops lower-priority overlaps so one identifier is matched once',()=>{const matches=findIdentifierMatches(`${ICCID} OD-12345678`);expect(matches).toHaveLength(2);expect(matches[0]).toEqual({index:0,length:20,text:ICCID});});
  it('ignores plain words and short numbers',()=>{expect(findIdentifierMatches('hello world 12345 ok')).toEqual([]);});
  it('infers iccid and eiccid only',()=>{expect(inferIdentifierType(ICCID)).toBe('iccid');expect(inferIdentifierType('E'+ICCID)).toBe('eiccid');expect(inferIdentifierType('OD-12345678')).toBeUndefined();expect(inferIdentifierType('8986001234')).toBeUndefined();});
});
describe('explicit header identifiers only',()=>{
  it('leaves arbitrary message numbers, ICCIDs and prefixed references untouched',()=>{const {doc}=page([`1234567890 ${ICCID} OD-12345678`],'客户');expect(linkifyIdentifiers(doc,vi.fn())).toBe(0);expect(wrappers(doc)).toHaveLength(0);expect(doc.querySelector('.chat-editor')!.textContent).toBe(`草稿 ${ICCID}`);});
  it('links only a labelled header order and opens only on activation',()=>{const {doc}=page([ICCID]);const open=vi.fn();expect(linkifyIdentifiers(doc,open)).toBe(1);expect(open).not.toHaveBeenCalled();wrappers(doc)[0].click();expect(open).toHaveBeenCalledWith({identifier:'1234567890',identifierType:'order_number'});expect(linkifyIdentifiers(doc,open)).toBe(0);unlinkifyIdentifiers(doc);expect(wrappers(doc)).toHaveLength(0);});
  it('cleans its style and wrappers on disposal and ignores owned changes',async()=>{vi.useFakeTimers();const {doc}=page([]);const linkifier=startIdentifierLinkifier(doc,vi.fn());const own=doc.createElement('div');own.setAttribute('data-tsim-owned','1');doc.body.append(own);await vi.advanceTimersByTimeAsync(SCAN_DEBOUNCE_MS*2);expect(wrappers(doc)).toHaveLength(1);linkifier.dispose();expect(wrappers(doc)).toHaveLength(0);expect(doc.getElementById('tsim-query-identifier-style')).toBeNull();});
});

describe('header order ambiguity',()=>{
  it.each([
    ['订单号：1600000000000202','1600000000000202'],
    ['订单号：<span>001600000000000202</span>','001600000000000202'],
    ['<div>订单号：1600000000000202</div><div>1600000000000303</div>',undefined],
    ['订单号：1600000000000202<br>1600000000000303',undefined],
    ['订单号：<span>1600000000000202</span><span>1600000000000303</span>',undefined],
    ['<div>订单号：1600000000000202</div><div>订单号：1600000000000303</div>',undefined],
    ['订单号：1600000000000202\n订单号：1600000000000303',undefined],
    ['订单号：<span>16000000</span>00000202',undefined],
    ['订单号：16000000000001011600000000000303',undefined],
    ['订单号：<span>1600000000000101</span>1600000000000303',undefined],
    ['<span>订单号：</span><span>1600000000000101</span>','1600000000000101'],
    ['<span>订单号：</span><span>1600000000000101</span><span>订单号：</span><span>1600000000000101</span>','1600000000000101'],
    ['订单号：1600000000000101<div hidden>订单号：1600000000000303</div>','1600000000000101'],
    ['订单号：1600000000000101<div style="display:none">订单号：1600000000000303</div>','1600000000000101'],
    ['订单号：1600000000000101<div data-tsim-owned="1">订单号：1600000000000303</div>','1600000000000101'],
    ['订单号：<span hidden>1600000000000101</span>',undefined],
    ['订单号：<span>123456789012345678901234567890123456789012345678901</span>',undefined],
  ])('reads a single explicit value without flattening %s',(markup,expected)=>{const {doc,dom}=page([],markup);expect(readHeaderOrder(doc)).toBe(expected);dom.window.close();});
  it('disables the chip when separate header entries contain multiple orders',()=>{const {doc,dom}=page([],'订单号：1600000000000202');const extra=doc.createElement('div');extra.className='group-chat-hover-box-txt';extra.textContent='订单号：1600000000000303';doc.querySelector('.im_detail_hd')!.append(extra);expect(readHeaderOrder(doc)).toBeUndefined();dom.window.close();});
  it('ignores a hidden hover source and plugin-owned header sources',()=>{const {doc,dom}=page([],'订单号：1600000000000101');const header=doc.querySelector<HTMLElement>('.group-chat-hover-box-txt')!;header.style.display='none';expect(readHeaderOrder(doc)).toBeUndefined();header.style.display='';header.closest('.im_detail_hd')!.setAttribute('data-tsim-owned','1');expect(readHeaderOrder(doc)).toBeUndefined();dom.window.close();});
  it('keeps a linked vendor value readable but does not decorate ambiguous joined orders',()=>{const {doc,dom}=page([],'订单号：1600000000000101');linkifyIdentifiers(doc,vi.fn());expect(readHeaderOrder(doc)).toBe('1600000000000101');doc.querySelector('.group-chat-hover-box-txt')!.innerHTML='订单号：<span>1600000000000101</span><span>1600000000000303</span>';expect(linkifyIdentifiers(doc,vi.fn())).toBe(0);expect(wrappers(doc)).toHaveLength(0);dom.window.close();});
  it('reads fresh values after conversation changes and clears ambiguous or removed orders',()=>{const {doc,dom}=page([],'订单号：1600000000000101');const header=doc.querySelector('.group-chat-hover-box-txt')!;expect(readHeaderOrder(doc)).toBe('1600000000000101');header.textContent='订单号：1600000000000303';expect(readHeaderOrder(doc)).toBe('1600000000000303');header.innerHTML='订单号：<span>1600000000000101</span><span>1600000000000303</span>';expect(readHeaderOrder(doc)).toBeUndefined();header.remove();expect(readHeaderOrder(doc)).toBeUndefined();dom.window.close();});
});
