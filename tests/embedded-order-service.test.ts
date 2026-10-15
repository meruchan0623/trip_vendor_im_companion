import {afterEach,describe,expect,it,vi} from 'vitest';
import {BrowserProfileSessionService} from '../electron/browser-profile-session';
const services:BrowserProfileSessionService[]=[];
afterEach(()=>services.splice(0).forEach(s=>s.dispose()));
async function fixture(permissions=['complaint_records']){
 let token:string|null='synthetic';
 const fetcher=vi.fn<typeof fetch>(async input=>{const url=new URL(String(input));let data:unknown;
  if(url.pathname==='/agent/profile')data={success:true,data:{id:1,is_active:true,permissions}};
  else if(url.pathname.endsWith('/perform'))data={code:1,result:{query_id:'q-1'}};
  else if(url.pathname.endsWith('/dataplan-list'))data={code:1,result:[{card_dataplan_id:'c-1'}]};
  else data={code:1,result:{iccid:'89880000000000000001',channel_dataplan_name:'<img src=x onerror=alert(1)>',secret:'must-not-leave',nested:{token:'hidden'}}};
  return new Response(JSON.stringify(data));
 });
 const service=new BrowserProfileSessionService(()=>{},{backgroundPolling:false,discoverProfiles:async()=>[{browserPath:'C:/fake.exe',userDataDir:'C:/synthetic',profileDirectory:'Default'}],readToken:async()=>token,fetcher});services.push(service);await service.sync();
 return{service,fetcher,setToken:(v:string|null)=>{token=v;}};
}
describe('embedded read-only order query',()=>{
 it('uses only query endpoints and projects allowed scalar fields without losing string IDs',async()=>{
  const f=await fixture(),result=await f.service.queryOriginalIdentifier('001600000000000202',new AbortController().signal);
  expect(result.identifier).toBe('001600000000000202');expect(result.found).toBe(true);expect(result.fields).toHaveLength(2);expect(JSON.stringify(result)).not.toContain('must-not-leave');
  const calls=f.fetcher.mock.calls.filter(([u])=>!String(u).endsWith('/profile'));expect(calls.map(([u])=>new URL(String(u)).pathname)).toEqual(['/agent/package-query/perform','/agent/package-query/dataplan-list','/agent/package-query/detail']);
  expect(JSON.parse(calls[0][1]!.body as string)).toEqual({order_nums:'001600000000000202'});expect(calls.slice(1).every(([,i])=>i?.method==='GET')).toBe(true);
 });
 it('denies missing permission and malformed identifiers before query',async()=>{
  const f=await fixture([]);await expect(f.service.queryOriginalIdentifier('123',new AbortController().signal)).rejects.toThrow('ORDER_PERMISSION_REQUIRED');await expect(f.service.queryOriginalIdentifier('123\n456',new AbortController().signal)).rejects.toThrow('INVALID_ORDER_IDENTIFIER');expect(f.fetcher.mock.calls.every(([u])=>String(u).endsWith('/profile'))).toBe(true);
 });
 it('rejects logout while a query is in flight without publishing its result',async()=>{
  const f=await fixture();const original=f.fetcher.getMockImplementation()!;let release!:()=>void;
  f.fetcher.mockImplementation(async(input,init)=>{if(String(input).includes('/perform'))await new Promise<void>(r=>{release=r;});return original(input,init);});
  const pending=f.service.queryOriginalIdentifier('123',new AbortController().signal);await vi.waitFor(()=>expect(release).toBeTypeOf('function'));f.setToken(null);release();await expect(pending).rejects.toThrow('AUTH_CHANGED');expect(f.fetcher.mock.calls.some(([u])=>String(u).includes('/detail'))).toBe(false);
 });
 it('does not present provider errors as empty success',async()=>{
  const f=await fixture(),original=f.fetcher.getMockImplementation()!;f.fetcher.mockImplementation(async(u,i)=>String(u).includes('/dataplan-list')?new Response(JSON.stringify({code:0,result:[]})):original(u,i));await expect(f.service.queryOriginalIdentifier('123',new AbortController().signal)).rejects.toThrow('ORDER_RESPONSE_INVALID');
 });
 it('honors cancellation before any query',async()=>{const f=await fixture(),c=new AbortController();c.abort();await expect(f.service.queryOriginalIdentifier('123',c.signal)).rejects.toThrow('REQUEST_ABORTED');expect(f.fetcher.mock.calls).toHaveLength(1);});
});
