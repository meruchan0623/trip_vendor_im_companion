import { afterEach,describe,expect,it,vi } from 'vitest';
import { BrowserProfileSessionService,type BrowserProfile } from '../electron/browser-profile-session';
import type { OutboundBody } from '../src/shared/workbench';

const profile:BrowserProfile={browserPath:'C:/Program Files/Microsoft/Edge/Application/msedge.exe',userDataDir:'C:/synthetic-edge/User Data',profileDirectory:'Default'};
const body:OutboundBody={text:'请确认订单',target_lang:'ja',source_lang:'zh',purpose:'outbound',draft_request_id:'draft-123',composer_content_version:'version-1'};
const response=(data:any)=>new Response(JSON.stringify(data));
const goodProfile=(id=42,permissions=['complaint_records'])=>({success:true,data:{id,is_active:true,permissions}});
const goodTranslation=()=>({success:true,data:{translated_text:'注文をご確認ください',draft_request_id:body.draft_request_id,composer_content_version:body.composer_content_version}});
const services:BrowserProfileSessionService[]=[];
afterEach(()=>{for(const service of services.splice(0))service.dispose();vi.useRealTimers();});
async function fixture(options:{timeout?:number;interval?:number;backgroundPolling?:boolean}={}){
  let token:string|null='synthetic-token-a';const changed=vi.fn(),discover=vi.fn(async()=>[profile]),readToken=vi.fn(async(_directory:string)=>token),fetcher=vi.fn<typeof fetch>(async url=>response(String(url).endsWith('/profile')?goodProfile():goodTranslation())),openExternal=vi.fn(async(_url:string)=>{});
  const service=new BrowserProfileSessionService(changed,{discoverProfiles:discover,readToken,fetcher,openExternal,syncIntervalMs:options.interval??60000,requestTimeoutMs:options.timeout??20000,backgroundPolling:options.backgroundPolling});services.push(service);await service.sync();
  return {service,changed,discover,readToken,fetcher,openExternal,setToken:(value:string|null)=>{token=value;}};
}
describe('browser profile session',()=>{
  it('performs one initial validation without idle scans while background polling is paused',async()=>{
    vi.useFakeTimers();const f=await fixture({interval:4000,backgroundPolling:false});
    expect(vi.getTimerCount()).toBe(0);const reads=f.readToken.mock.calls.length,requests=f.fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.discover).toHaveBeenCalledOnce();expect(f.readToken).toHaveBeenCalledTimes(reads);expect(f.fetcher).toHaveBeenCalledTimes(requests);
    f.service.setBackgroundPolling(true);f.service.setBackgroundPolling(true);expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4000);expect(f.discover).toHaveBeenCalledTimes(2);
    f.service.setBackgroundPolling(false);expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(12000);expect(f.discover).toHaveBeenCalledTimes(2);
    f.service.setBackgroundPolling(true);await vi.advanceTimersByTimeAsync(4000);expect(f.discover).toHaveBeenCalledTimes(3);
    f.service.dispose();f.service.setBackgroundPolling(true);expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(12000);expect(f.discover).toHaveBeenCalledTimes(3);
  });
  it('validates explicit operations while paused and rejects a stale identity before sending translation',async()=>{
    vi.useFakeTimers();const f=await fixture({backgroundPolling:false});
    await f.service.sync();expect(f.discover).toHaveBeenCalledTimes(2);
    await f.service.translate(body,f.service.identity()!,new AbortController().signal);expect(f.discover).toHaveBeenCalledTimes(3);
    const identity=f.service.identity()!,translations=f.fetcher.mock.calls.filter(([url])=>String(url).endsWith('/translate')).length;
    f.setToken('synthetic-token-b');await expect(f.service.translate(body,identity,new AbortController().signal)).rejects.toThrow('AUTH_CHANGED');
    expect(f.fetcher.mock.calls.filter(([url])=>String(url).endsWith('/translate'))).toHaveLength(translations);
    await f.service.openLogin();await f.service.sync();expect(f.openExternal).toHaveBeenCalledOnce();expect(f.discover).toHaveBeenCalledTimes(5);expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps logout suspended when background polling resumes and login preserves the paused state',async()=>{
    vi.useFakeTimers();const f=await fixture({interval:4000});await f.service.logout();expect(vi.getTimerCount()).toBe(0);
    f.service.setBackgroundPolling(false);f.service.setBackgroundPolling(true);await f.service.sync();await vi.advanceTimersByTimeAsync(8000);
    expect(f.discover).toHaveBeenCalledOnce();expect(f.service.identity()).toBeNull();expect(vi.getTimerCount()).toBe(0);
    f.service.setBackgroundPolling(false);await f.service.openLogin();await f.service.sync();expect(f.service.identity()?.accountScope).toBe('psim:42');expect(vi.getTimerCount()).toBe(0);
  });
  it('verifies a projected account and never exposes a token in identity or browser profile',async()=>{
    const f=await fixture();expect(f.service.identity()).toMatchObject({accountScope:'psim:42',permissions:['complaint_records']});expect(f.service.getBrowserProfile()).toEqual(profile);
    expect(JSON.stringify(f.changed.mock.calls)).not.toContain('synthetic-token');expect(JSON.stringify(f.service.getBrowserProfile())).not.toContain('synthetic-token');
    const identity=f.service.identity()!;identity.permissions.length=0;expect(f.service.identity()!.permissions).toEqual(['complaint_records']);
    const browser=f.service.getBrowserProfile()!;browser.profileDirectory='other';expect(f.service.getBrowserProfile()?.profileDirectory).toBe('Default');
  });
  it('keeps stable sessions stable, and rotates generation on token, account or permissions changes',async()=>{
    const f=await fixture(),initial=f.service.identity()!.authGeneration;await f.service.sync();expect(f.service.identity()!.authGeneration).toBe(initial);
    f.setToken('synthetic-token-b');await f.service.sync();const rotated=f.service.identity()!.authGeneration;expect(rotated).toBeGreaterThan(initial);
    f.fetcher.mockResolvedValueOnce(response(goodProfile(43)));await f.service.sync();const account=f.service.identity()!.authGeneration;expect(account).toBeGreaterThan(rotated);expect(f.service.identity()!.accountScope).toBe('psim:43');
    f.fetcher.mockResolvedValueOnce(response(goodProfile(43,['translation'])));await f.service.sync();expect(f.service.identity()!.authGeneration).toBeGreaterThan(account);
  });
  it('revokes immediately when storage deletion or read failure is observed',async()=>{
    const f=await fixture();f.setToken(null);await f.service.sync();expect(f.service.identity()).toBeNull();expect(f.service.getBrowserProfile()).toBeNull();
    f.setToken('synthetic-token-c');await f.service.sync();f.readToken.mockRejectedValueOnce(new Error('STORAGE_INCONSISTENT'));await expect(f.service.sync()).rejects.toThrow('STORAGE_INCONSISTENT');expect(f.service.identity()).toBeNull();
  });
  it('automatically notices disk-side logout on the four-second polling loop',async()=>{
    vi.useFakeTimers();const f=await fixture({interval:4000});f.setToken(null);await vi.advanceTimersByTimeAsync(4000);expect(f.service.identity()).toBeNull();
  });
  it('does not fall back to another account when its selected profile disappears',async()=>{
    const f=await fixture();f.discover.mockResolvedValue([{...profile,profileDirectory:'Profile 2'}]);await f.service.sync();expect(f.service.identity()).toBeNull();
    const reads=f.readToken.mock.calls.length;await f.service.sync();await f.service.sync();expect(f.service.identity()).toBeNull();expect(f.readToken).toHaveBeenCalledTimes(reads);
    await f.service.logout();await f.service.openLogin();await f.service.sync();expect(f.service.identity()?.accountScope).toBe('psim:42');expect(f.service.getBrowserProfile()?.profileDirectory).toBe('Profile 2');
  });
  it('skips an expired initial candidate and binds only the next verified profile',async()=>{
    const second={...profile,profileDirectory:'Profile 2'},changed=vi.fn(),readToken=vi.fn(async(directory:string)=>directory.includes('Profile 2')?'synthetic-valid-token':'synthetic-expired-token');
    const fetcher=vi.fn<typeof fetch>(async(_url,init)=>new Headers(init?.headers).get('Authorization')==='Bearer synthetic-expired-token'?new Response('',{status:401}):response(goodProfile(43)));
    const service=new BrowserProfileSessionService(changed,{discoverProfiles:async()=>[profile,second],readToken,fetcher,syncIntervalMs:60000});services.push(service);await service.sync();
    expect(service.getBrowserProfile()).toEqual(second);expect(service.identity()?.accountScope).toBe('psim:43');expect(fetcher).toHaveBeenCalledTimes(2);expect(changed.mock.calls.filter(([identity])=>identity!==null)).toHaveLength(1);
    fetcher.mockClear();await service.sync();expect(fetcher).toHaveBeenCalledTimes(1);expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer synthetic-valid-token');
  });
  it('does not bind an inactive initial profile before trying a valid candidate',async()=>{
    const second={...profile,profileDirectory:'Profile 2'},fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(response({success:true,data:{id:42,is_active:false,permissions:[]}})).mockResolvedValue(response(goodProfile(43)));
    const service=new BrowserProfileSessionService(()=>{},{discoverProfiles:async()=>[profile,second],readToken:async()=>'synthetic-token',fetcher,syncIntervalMs:60000});services.push(service);await service.sync();expect(service.getBrowserProfile()).toEqual(second);expect(service.identity()?.accountScope).toBe('psim:43');
  });
  it('retains the selected profile binding after a token read failure',async()=>{
    const f=await fixture();f.readToken.mockRejectedValueOnce(new Error('STORAGE_INCONSISTENT'));await expect(f.service.sync()).rejects.toThrow('STORAGE_INCONSISTENT');expect(f.service.identity()).toBeNull();
    f.discover.mockResolvedValue([{...profile,profileDirectory:'Profile 2'}]);const reads=f.readToken.mock.calls.length;await f.service.sync();await f.service.sync();expect(f.readToken).toHaveBeenCalledTimes(reads);expect(f.service.identity()).toBeNull();
    f.discover.mockResolvedValue([profile]);await f.service.sync();expect(f.service.getBrowserProfile()?.profileDirectory).toBe('Default');
  });
  it('disabled mode never discovers profiles, reads tokens, opens a browser or requests APIs',async()=>{
    vi.useFakeTimers();const discoverProfiles=vi.fn(async()=>[profile]),readToken=vi.fn(async()=>'synthetic-token'),fetcher=vi.fn<typeof fetch>(),openExternal=vi.fn(async(_url:string)=>{});
    const service=new BrowserProfileSessionService(()=>{},{enabled:false,discoverProfiles,readToken,fetcher,openExternal,syncIntervalMs:10});services.push(service);
    await service.sync();await service.openLogin();await vi.advanceTimersByTimeAsync(60000);await expect(service.translate(body,{accountScope:'psim:42',permissions:[],authGeneration:0},new AbortController().signal)).rejects.toThrow('BROWSER_SESSION_DISABLED');
    expect(discoverProfiles).not.toHaveBeenCalled();expect(readToken).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();expect(openExternal).not.toHaveBeenCalled();expect(service.identity()).toBeNull();expect(service.getBrowserProfile()).toBeNull();
  });
  it('will not publish a session if its token disappeared during profile verification',async()=>{
    const f=await fixture();let finish!:(value:Response)=>void;f.fetcher.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const syncing=f.service.sync();await vi.waitFor(()=>expect(f.fetcher).toHaveBeenCalledTimes(2));f.setToken(null);finish(response(goodProfile()));await expect(syncing).rejects.toThrow('AUTH_CHANGED');expect(f.service.identity()).toBeNull();
  });
  it('sends only the fixed translation payload and validates exact draft echoes',async()=>{
    const f=await fixture();const result=await f.service.translate(body,f.service.identity()!,new AbortController().signal);expect(result).toEqual(goodTranslation());
    const [url,init]=f.fetcher.mock.calls.find(([url])=>String(url).endsWith('/translate'))!;expect(url).toBe('https://csapi.tsim.tech/agent/translate');expect(init?.method).toBe('POST');expect(JSON.parse(init?.body as string)).toEqual(body);expect(init?.redirect).toBe('error');
    f.fetcher.mockImplementation(async url=>response(String(url).endsWith('/profile')?goodProfile():{success:true,data:{...goodTranslation().data,composer_content_version:'different'}}));await expect(f.service.translate(body,f.service.identity()!,new AbortController().signal)).rejects.toThrow('OUTBOUND_ECHO_MISMATCH');
  });
  it('rejects injected credential fields and stale identities before translation',async()=>{
    const f=await fixture();await expect(f.service.translate({...body,token:'not-relayed'} as OutboundBody,f.service.identity()!,new AbortController().signal)).rejects.toThrow('INVALID_OUTBOUND_REQUEST');
    const identity=f.service.identity()!;f.setToken('synthetic-token-b');await expect(f.service.translate(body,identity,new AbortController().signal)).rejects.toThrow('AUTH_CHANGED');expect(f.fetcher.mock.calls.some(([url])=>String(url).endsWith('/translate'))).toBe(false);
  });
  it('discards a completed translation if the browser logged out meanwhile',async()=>{
    const f=await fixture();let finish!:(value:Response)=>void;f.fetcher.mockImplementation(async url=>String(url).endsWith('/profile')?response(goodProfile()):new Promise(resolve=>{finish=resolve;}));
    const promise=f.service.translate(body,f.service.identity()!,new AbortController().signal);const assertion=expect(promise).rejects.toThrow('AUTH_CHANGED');await vi.waitFor(()=>expect(f.fetcher.mock.calls.some(([url])=>String(url).endsWith('/translate'))).toBe(true));f.setToken(null);finish(response(goodTranslation()));await assertion;expect(f.service.identity()).toBeNull();
  });
  it('caller abort interrupts waiting for shared profile sync without publishing a translation',async()=>{
    const f=await fixture();let finish!:(value:Response)=>void;f.fetcher.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const controller=new AbortController();const promise=f.service.translate(body,f.service.identity()!,controller.signal);const assertion=expect(promise).rejects.toThrow('REQUEST_ABORTED');await vi.waitFor(()=>expect(f.fetcher).toHaveBeenCalledTimes(2));controller.abort();await assertion;finish(response(goodProfile()));await f.service.sync();expect(f.fetcher.mock.calls.some(([url])=>String(url).endsWith('/translate'))).toBe(false);
  });
  it('403 translation permission failure preserves the verified login',async()=>{
    const f=await fixture();f.fetcher.mockImplementation(async url=>String(url).endsWith('/profile')?response(goodProfile()):new Response('',{status:403}));await expect(f.service.translate(body,f.service.identity()!,new AbortController().signal)).rejects.toThrow('TRANSLATION_PERMISSION_REQUIRED');expect(f.service.identity()?.accountScope).toBe('psim:42');
  });
  it('rejects malformed profiles and bounded oversized server responses',async()=>{
    const f=await fixture();f.fetcher.mockResolvedValueOnce(response({success:true,data:{id:42,is_active:false,permissions:[]}}));await expect(f.service.sync()).rejects.toThrow('PROFILE_UNVERIFIED');expect(f.service.identity()).toBeNull();
    f.fetcher.mockResolvedValueOnce(new Response('x'.repeat(200001)));await expect(f.service.sync()).rejects.toThrow('INVALID_SERVICE_RESPONSE');expect(f.service.identity()).toBeNull();
  });
  it('logout disconnects only this companion, while login opens only the official website',async()=>{
    const f=await fixture();await f.service.logout();await f.service.sync();expect(f.service.identity()).toBeNull();expect(f.fetcher.mock.calls.some(([url])=>String(url).endsWith('/logout'))).toBe(false);await f.service.openLogin();await f.service.sync();expect(f.openExternal).toHaveBeenCalledWith('https://csagent.tsim.tech/login');expect(f.service.identity()?.accountScope).toBe('psim:42');
  });
  it('dispose prevents a delayed profile response from restoring identity',async()=>{
    const f=await fixture();let finish!:(value:Response)=>void;f.fetcher.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const syncing=f.service.sync();await vi.waitFor(()=>expect(f.fetcher).toHaveBeenCalledTimes(2));f.service.dispose();finish(response(goodProfile()));await expect(syncing).rejects.toThrow('AUTH_CHANGED');expect(f.service.identity()).toBeNull();
  });
});
