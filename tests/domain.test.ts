import { describe,it,expect,vi,afterEach } from 'vitest';
import { parseOrderCandidates } from '../src/shared/orders';
import { DraftController } from '../src/shared/draft';
import { TranslationCache } from '../src/shared/cache';
import { validTranslation,validQuery,allowedHostURL,approvedHostFrame,validText,allowedRemoteRequest } from '../src/shared/validation';
import type { TranslationRequest,TranslationResult } from '../src/shared/types';
import { mayAcceptResponse } from '../src/shared/guards';
const request:TranslationRequest={requestId:'214f3458-818e-4e22-8a63-dca9b9a28c76',text:'欢迎咨询',targetLanguage:'ja',sourceLanguage:'zh-CN',purpose:'outbound',configurationVersion:'server-v1',context:{accountScope:'agent-a',platformAccountScope:'unknown',conversationKey:'manual-1',generation:1,authGeneration:1,draftRevision:1}};
const result:TranslationResult={requestId:request.requestId,translatedText:'お問い合わせありがとうございます。',sourceLanguage:'zh-CN',targetLanguage:'ja',context:request.context,fromCache:false};
afterEach(()=>vi.useRealTimers());
describe('identifier candidates',()=>{
  it('preserves 18 digit IDs as strings and marks platform labels unverified',()=>{ const c=parseOrderCandidates('订单ID：123456789012345678'); expect(c[0]?.identifier).toBe('123456789012345678'); expect(c[0]?.confidence).toBe('low'); expect(c[0]?.requiresConfirmation).toBe(true); });
  it('does not scan phone/date/price or unrelated numbers',()=>expect(parseOrderCandidates('电话 13812345678 日期 2026-10-14 价格 128.00 产品 123456789012345678')).toEqual([]));
  it('normalizes fullwidth digits and returns multiple confirmed candidates',()=>{const c=parseOrderCandidates('TSim订单号：１２３４５６７８９０１２３４５６７８\nICCID: 8986012345678901234');expect(c).toHaveLength(2);expect(c[0]?.normalized).toBe(true);});
});
describe('draft scheduling',()=>{
  it('waits until IME completes and debounce expires',()=>{vi.useFakeTimers();const fn=vi.fn();const d=new DraftController(fn);d.compositionStart();d.update('你');vi.advanceTimersByTime(2000);expect(fn).not.toHaveBeenCalled();d.compositionEnd();vi.advanceTimersByTime(1499);expect(fn).not.toHaveBeenCalled();vi.advanceTimersByTime(1);expect(fn).toHaveBeenCalledWith(1);});
  it('cancel prevents same revision auto-retry but later input permits it',()=>{vi.useFakeTimers();const fn=vi.fn();const d=new DraftController(fn);d.update('hello');d.cancel();d.compositionEnd();vi.advanceTimersByTime(3000);expect(fn).not.toHaveBeenCalled();d.update('hello!');vi.advanceTimersByTime(1500);expect(fn).toHaveBeenCalledWith(2);});
  it('context pause and global disable are independent',()=>{vi.useFakeTimers();const fn=vi.fn();const d=new DraftController(fn);d.update('a');d.pause();d.update('b');vi.advanceTimersByTime(2000);expect(fn).not.toHaveBeenCalled();d.setEnabled(false);d.resume();vi.advanceTimersByTime(2000);expect(fn).not.toHaveBeenCalled();d.setEnabled(true);vi.advanceTimersByTime(1500);expect(fn).toHaveBeenCalledOnce();d.resetContext();expect(d.paused).toBe(false);expect(d.generation).toBe(2);});
});
describe('bounded account cache',()=>{
  it('isolates every account/context/purpose/language/config dimension',()=>{const c=new TranslationCache();const key=c.key(request,'hash');c.set(key,result);for (const variant of [{...request,context:{...request.context,accountScope:'agent-b'}},{...request,context:{...request.context,platformAccountScope:'merchant-b'}},{...request,context:{...request.context,conversationKey:'manual-2'}},{...request,context:{...request.context,authGeneration:2}},{...request,purpose:'inbound' as const},{...request,targetLanguage:'ko' as const},{...request,configurationVersion:'v2'}]) expect(c.get(c.key(variant,'hash'))).toBeUndefined();expect(c.get(key)).toBeDefined();expect(c.clear()).toBe(1);expect(c.get(key)).toBeUndefined();});
  it('evicts and expires entries',()=>{vi.useFakeTimers();const c=new TranslationCache(1,100);c.set('one',result);c.set('two',result);expect(c.get('one')).toBeUndefined();vi.advanceTimersByTime(101);expect(c.get('two')).toBeUndefined();});
});
describe('narrow bridge validation',()=>{
  it('rejects arbitrary API or token fields and unsupported purposes',()=>{expect(validTranslation(request)).toBe(true);expect(validTranslation({...request,url:'/messages/send'})).toBe(false);expect(validTranslation({...request,token:'secret'})).toBe(false);expect(validTranslation({...request,purpose:'back'})).toBe(false);});
  it('requires explicit query confirmation and versioned context',()=>{const q={requestId:request.requestId,identifier:'123456789012345678',identifierType:'order_number',context:request.context,confirmed:true};expect(validQuery(q)).toBe(true);expect(validQuery({...q,confirmed:false})).toBe(false);expect(validQuery({...q,identifier:123456789012345678})).toBe(false);});
  it('rejects media/base64 and oversized translations',()=>{for(const t of ['data:image/png;base64,test','file:///secret','[图片]','a'.repeat(20001),'a'.repeat(300)])expect(validText(t)).toBe(false);});
  it('blocks lookalike hosts, userinfo, HTTP and arbitrary same-origin paths',()=>{expect(allowedHostURL('https://csagent.tsim.tech/desktop-host')).toBe(true);for(const url of ['http://csagent.tsim.tech/desktop-host','https://csagent.tsim.tech.evil.example/desktop-host','https://user@csagent.tsim.tech/desktop-host','https://csagent.tsim.tech/admin'])expect(allowedHostURL(url)).toBe(false);expect(approvedHostFrame('https://csagent.tsim.tech/embed/operator')).toBe(false);});
  it('blocks customer sends and arbitrary writes while permitting verified read-only eSIM info',()=>{expect(allowedRemoteRequest('https://csapi.tsim.tech/agent/translate','POST')).toBe(true);expect(allowedRemoteRequest('https://csapi.tsim.tech/agent/package-query/perform','POST')).toBe(true);expect(allowedRemoteRequest('https://csapi.tsim.tech/agent/package-query/esim-info','POST')).toBe(true);for(const path of ['/agent/messages','/agent/messages/send','/agent/operations/refund','/agent/query_records/upsert','/agent/package-query/esim-cancel'])expect(allowedRemoteRequest(`https://csapi.tsim.tech${path}`,'POST')).toBe(false);expect(allowedRemoteRequest('wss://csapi.tsim.tech/socket.io','GET')).toBe(false);expect(allowedRemoteRequest('https://evil.example/agent/translate','POST')).toBe(false);});
});
describe('late-result guards',()=>{
  it('rejects draft changes, conversation/identity/login changes and navigation restarts',()=>{
    const snapshot=request.context;
    expect(mayAcceptResponse(snapshot,snapshot,1,1,1,1)).toBe(true);
    for(const changed of [{...snapshot,draftRevision:2},{...snapshot,generation:2},{...snapshot,conversationKey:'manual-other'},{...snapshot,accountScope:'other'},{...snapshot,authGeneration:2}]) expect(mayAcceptResponse(snapshot,changed,1,1,1,1)).toBe(false);
    expect(mayAcceptResponse(snapshot,snapshot,1,2,1,1)).toBe(false);
    expect(mayAcceptResponse(snapshot,snapshot,1,1,2,1)).toBe(false);
    expect(mayAcceptResponse(snapshot,snapshot,1,1,1,2)).toBe(false);
  });
});
