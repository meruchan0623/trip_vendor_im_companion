import { afterEach,describe,expect,it,vi } from 'vitest';
import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname,join,posix } from 'node:path';
import { EventEmitter } from 'node:events';
import { BrowserProfileSessionService,discoverBrowserProfiles,openBrowserProfile,type BrowserProfile } from '../electron/browser-profile-session';
import type { OutboundBody } from '../src/shared/workbench';

// System /Applications is simulated so discovery tests do not depend on browsers installed on the host.
const installed=vi.hoisted(()=>new Set<string>());
const deniedRoots=vi.hoisted(()=>new Set<string>());
const launch=vi.hoisted(()=>({spawn:vi.fn()}));
vi.mock('node:child_process',()=>({spawn:launch.spawn}));
vi.mock('node:fs/promises',async importOriginal=>{const actual=await importOriginal<typeof import('node:fs/promises')>();return{...actual,readdir:((...args:Parameters<typeof actual.readdir>)=>{if(deniedRoots.has(String(args[0])))return Promise.reject(Object.assign(new Error('private path'),{code:'EPERM'}));return actual.readdir(...args);}) as typeof actual.readdir,access:async(path:Parameters<typeof actual.access>[0],mode?:number)=>{const value=String(path);if(!value.startsWith('/Applications/'))return actual.access(path,mode);if(!installed.has(value))throw Object.assign(new Error('ENOENT'),{code:'ENOENT'});}};});
const profile:BrowserProfile={browserPath:'C:/Program Files/Microsoft/Edge/Application/msedge.exe',userDataDir:'C:/synthetic-edge/User Data',profileDirectory:'Default'};
const body:OutboundBody={text:'请确认订单',target_lang:'ja',source_lang:'zh',purpose:'outbound',draft_request_id:'draft-123',composer_content_version:'version-1'};
const response=(data:any)=>new Response(JSON.stringify(data));
const goodProfile=(id=42,permissions=['complaint_records'])=>({success:true,data:{id,is_active:true,permissions}});
const goodTranslation=()=>({success:true,data:{translated_text:'注文をご確認ください',draft_request_id:body.draft_request_id,composer_content_version:body.composer_content_version}});
const services:BrowserProfileSessionService[]=[];
afterEach(()=>{for(const service of services.splice(0))service.dispose();vi.useRealTimers();});
async function fixture(options:{timeout?:number;interval?:number;backgroundPolling?:boolean}={}){
  let token:string|null='synthetic-token-a';const changed=vi.fn(),discover=vi.fn(async()=>[profile]),readToken=vi.fn(async(_directory:string)=>token),fetcher=vi.fn<typeof fetch>(async url=>response(String(url).endsWith('/profile')?goodProfile():goodTranslation())),openExternal=vi.fn(async(_url:string)=>{});
  const openProfile=vi.fn(async(_profile:BrowserProfile,_url:string)=>{});
  const service=new BrowserProfileSessionService(changed,{discoverProfiles:discover,readToken,fetcher,openExternal,openProfile,syncIntervalMs:options.interval??60000,requestTimeoutMs:options.timeout??20000,backgroundPolling:options.backgroundPolling});services.push(service);await service.sync();
  return {service,changed,discover,readToken,fetcher,openExternal,openProfile,setToken:(value:string|null)=>{token=value;}};
}
describe('browser profile session',()=>{
  it.each(['translate','order'] as const)('reports post-validation storage denial during %s as failed',async operation=>{
    const onStatus=vi.fn();let reads=0,denied=false;
    const service=new BrowserProfileSessionService(()=>{},{onStatus,discoverProfiles:async()=>[profile],readToken:async()=>{reads++;if(denied||operation==='order'&&reads===5)throw new Error('BROWSER_SESSION_ACCESS_DENIED');return 'synthetic';},fetcher:async url=>{if(String(url).endsWith('/profile'))return response(goodProfile());denied=true;return response(goodTranslation());},backgroundPolling:false});services.push(service);await service.sync();
    const pending=operation==='translate'?service.translate(body,service.identity()!,new AbortController().signal):service.queryOriginalIdentifier('ORDER1',new AbortController().signal);
    await expect(pending).rejects.toThrow('BROWSER_SESSION_ACCESS_DENIED');expect(service.identity()).toBeNull();expect(onStatus).toHaveBeenLastCalledWith('failed','BROWSER_SESSION_ACCESS_DENIED');
  });
  it('keeps a rotated nonempty disk token connecting rather than requesting login',async()=>{
    const onStatus=vi.fn();let token='before';
    const service=new BrowserProfileSessionService(()=>{},{onStatus,discoverProfiles:async()=>[profile],readToken:async()=>token,fetcher:async url=>{if(String(url).endsWith('/profile'))return response(goodProfile());token='after';return response(goodTranslation());},backgroundPolling:false});services.push(service);await service.sync();
    await expect(service.translate(body,service.identity()!,new AbortController().signal)).rejects.toThrow('AUTH_CHANGED');expect(onStatus).toHaveBeenLastCalledWith('connecting',undefined);await service.sync();expect(onStatus).toHaveBeenLastCalledWith('ready',undefined);
  });

  it('reports completed scans separately from failures and recovers without publishing credentials',async()=>{
    const onStatus=vi.fn(),discover=vi.fn<()=>Promise<BrowserProfile[]>>();
    let release!:(profiles:BrowserProfile[])=>void;
    discover.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const service=new BrowserProfileSessionService(()=>{},{discoverProfiles:discover,onStatus,backgroundPolling:false,readToken:async()=> 'synthetic-secret',fetcher:async()=>response(goodProfile())});services.push(service);
    const starting=service.sync();expect(onStatus).not.toHaveBeenCalled();release([]);await starting;expect(onStatus).toHaveBeenLastCalledWith('needs_login',undefined);
    discover.mockRejectedValueOnce(new Error('BROWSER_SESSION_ACCESS_DENIED'));
    await expect(service.sync()).rejects.toThrow('BROWSER_SESSION_ACCESS_DENIED');expect(onStatus).toHaveBeenLastCalledWith('failed','BROWSER_SESSION_ACCESS_DENIED');
    discover.mockResolvedValue([profile]);await service.sync();expect(onStatus).toHaveBeenLastCalledWith('ready',undefined);expect(service.identity()?.accountScope).toBe('psim:42');expect(JSON.stringify(onStatus.mock.calls)).not.toContain('synthetic-secret');
  });
  it('reports network failures as failed while revoking the old identity',async()=>{
    const onStatus=vi.fn(),fetcher=vi.fn<typeof fetch>(async()=>response(goodProfile()));
    const service=new BrowserProfileSessionService(()=>{},{onStatus,discoverProfiles:async()=>[profile],readToken:async()=> 'synthetic',fetcher,backgroundPolling:false});services.push(service);await service.sync();
    fetcher.mockRejectedValueOnce(new TypeError('network'));
    await expect(service.sync()).rejects.toThrow('SERVICE_UNAVAILABLE');expect(service.identity()).toBeNull();expect(onStatus).toHaveBeenLastCalledWith('failed','SERVICE_UNAVAILABLE');
    await service.sync();expect(onStatus).toHaveBeenLastCalledWith('ready',undefined);
  });
  it('does not misreport a protected browser directory as no login',async()=>{
    const home='/synthetic-permission-test',root=posix.join(home,'Library/Application Support/Microsoft Edge');installed.add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');deniedRoots.add(root);
    try{await expect(discoverBrowserProfiles({HOME:home},'darwin')).rejects.toThrow('BROWSER_SESSION_ACCESS_DENIED');}finally{deniedRoots.delete(root);installed.delete('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');}
  });
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
    await f.service.openLogin();await f.service.sync();expect(f.openProfile).toHaveBeenCalledOnce();expect(f.openExternal).not.toHaveBeenCalled();expect(f.discover).toHaveBeenCalledTimes(7);expect(vi.getTimerCount()).toBe(0);
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
  it('opens the bound browser profile even when another browser becomes the first discovered candidate',async()=>{
    const f=await fixture(),other={...profile,browserPath:'C:/Chrome/chrome.exe',userDataDir:'C:/Chrome/User Data'};
    f.discover.mockResolvedValue([other,profile]);await f.service.openLogin();
    expect(f.openProfile).toHaveBeenCalledExactlyOnceWith(profile,'https://csagent.tsim.tech/login');
    expect(f.openExternal).not.toHaveBeenCalled();expect(f.service.getBrowserProfile()).toEqual(profile);
  });
  it('allows an explicit login to recover a missing bound profile without an extra logout',async()=>{
    const f=await fixture(),other={...profile,profileDirectory:'Profile 2'};
    f.discover.mockResolvedValue([other]);await f.service.sync();expect(f.service.identity()).toBeNull();
    await f.service.openLogin();
    expect(f.openProfile).toHaveBeenCalledExactlyOnceWith(other,'https://csagent.tsim.tech/login');expect(f.service.getBrowserProfile()).toEqual(other);
  });
  it('does not restore authentication if logout happens while the profile login opener is pending',async()=>{
    const f=await fixture();let release!:()=>void;f.openProfile.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
    const opening=f.service.openLogin();const rejected=expect(opening).rejects.toThrow('AUTH_CHANGED');
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));await f.service.logout();release();await rejected;
    await f.service.sync();expect(f.service.identity()).toBeNull();
  });
  it.each(['discover','opener'] as const)('resumes session observation after a failed login %s',async stage=>{
    vi.useFakeTimers();const f=await fixture({interval:4000});
    if(stage==='discover')f.discover.mockRejectedValueOnce(new Error('DISCOVERY_FAILED'));else f.openProfile.mockRejectedValueOnce(new Error('BROWSER_LOGIN_OPEN_FAILED'));
    await expect(f.service.openLogin()).rejects.toThrow(stage==='discover'?'DISCOVERY_FAILED':'BROWSER_LOGIN_OPEN_FAILED');
    expect(f.service.identity()).toBeNull();expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4000);expect(f.service.identity()?.accountScope).toBe('psim:42');
  });
  it('keeps an explicit logout suspended if opening its new login fails',async()=>{
    vi.useFakeTimers();const f=await fixture({interval:4000});await f.service.logout();
    f.openProfile.mockRejectedValueOnce(new Error('BROWSER_LOGIN_OPEN_FAILED'));await expect(f.service.openLogin()).rejects.toThrow('BROWSER_LOGIN_OPEN_FAILED');
    expect(vi.getTimerCount()).toBe(0);await vi.advanceTimersByTimeAsync(8000);await f.service.sync();expect(f.service.identity()).toBeNull();
  });
  it('deduplicates repeated login clicks and prevents an old profile scan restoring a discarded session',async()=>{
    const f=await fixture();let finish!:(value:Response)=>void;f.fetcher.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const syncing=f.service.sync();const rejected=expect(syncing).rejects.toThrow('AUTH_CHANGED');
    await vi.waitFor(()=>expect(f.fetcher).toHaveBeenCalledTimes(2));
    const opening=f.service.openLogin(),duplicate=f.service.openLogin();expect(f.service.identity()).toBeNull();
    finish(response(goodProfile()));await rejected;await Promise.all([opening,duplicate]);
    expect(f.openProfile).toHaveBeenCalledOnce();expect(f.service.identity()?.accountScope).toBe('psim:42');
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
    const f=await fixture();await f.service.logout();await f.service.sync();expect(f.service.identity()).toBeNull();expect(f.fetcher.mock.calls.some(([url])=>String(url).endsWith('/logout'))).toBe(false);await f.service.openLogin();await f.service.sync();expect(f.openProfile).toHaveBeenCalledWith(profile,'https://csagent.tsim.tech/login');expect(f.openExternal).not.toHaveBeenCalled();expect(f.service.identity()?.accountScope).toBe('psim:42');
  });
  it('dispose prevents a delayed profile response from restoring identity',async()=>{
    const f=await fixture();let finish!:(value:Response)=>void;f.fetcher.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const syncing=f.service.sync();await vi.waitFor(()=>expect(f.fetcher).toHaveBeenCalledTimes(2));f.service.dispose();finish(response(goodProfile()));await expect(syncing).rejects.toThrow('AUTH_CHANGED');expect(f.service.identity()).toBeNull();
  });
});
describe('profile login launcher',()=>{
  it.each([
    {...profile,browserPath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',userDataDir:'C:\\Users\\Agent\\AppData\\Local\\Google\\Chrome\\User Data',profileDirectory:'Profile 2'},
    {...profile,browserPath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',userDataDir:'/Users/agent/Library/Application Support/Google/Chrome',profileDirectory:'Default'},
  ])('passes exact executable and profile arguments without a shell: $browserPath',async selected=>{
    const child=Object.assign(new EventEmitter(),{unref:vi.fn()});launch.spawn.mockReset();launch.spawn.mockReturnValue(child);
    const opening=openBrowserProfile(selected,'https://csagent.tsim.tech/login');child.emit('spawn');await opening;
    expect(launch.spawn).toHaveBeenCalledExactlyOnceWith(selected.browserPath,[`--user-data-dir=${selected.userDataDir}`,`--profile-directory=${selected.profileDirectory}`,'https://csagent.tsim.tech/login'],{shell:false,detached:true,windowsHide:false,stdio:'ignore'});
    expect(child.unref).toHaveBeenCalledOnce();
  });
  it('reports a browser launch failure and rejects an unofficial login destination',async()=>{
    const child=Object.assign(new EventEmitter(),{unref:vi.fn()});launch.spawn.mockReset();launch.spawn.mockReturnValue(child);
    const opening=openBrowserProfile(profile,'https://csagent.tsim.tech/login');child.emit('error',new Error('spawn failed'));
    await expect(opening).rejects.toThrow('BROWSER_LOGIN_OPEN_FAILED');expect(child.unref).not.toHaveBeenCalled();
    await expect(openBrowserProfile(profile,'https://example.com/login')).rejects.toThrow('BROWSER_LOGIN_URL_INVALID');expect(launch.spawn).toHaveBeenCalledOnce();
  });
});
describe('browser profile discovery',()=>{
  const roots:string[]=[];
  afterEach(async()=>{installed.clear();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
  const temp=async()=>{const root=await mkdtemp(join(tmpdir(),'tmc-profiles-'));roots.push(root);return root;};
  const touch=async(path:string)=>{await mkdir(dirname(path),{recursive:true});await writeFile(path,'');};
  const storage=(userDataDir:string,name:string)=>touch(join(userDataDir,name,'Local Storage','leveldb','CURRENT'));
  const macEdge='/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',macChrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  it.each(['valid','empty'] as const)('collects protected Edge failures while scanning a %s Chrome session',async mode=>{
    const home=await temp(),edgeData=posix.join(home,'Library','Application Support','Microsoft Edge'),chromeData=posix.join(home,'Library','Application Support','Google','Chrome');
    installed.add(macEdge);installed.add(macChrome);deniedRoots.add(edgeData);await storage(chromeData,'Default');
    const onStatus=vi.fn(),errors:Error[]=[];
    try{
      const profiles=await discoverBrowserProfiles({HOME:home},'darwin',error=>errors.push(error));expect(profiles).toHaveLength(1);expect(errors.map(error=>error.message)).toEqual(['BROWSER_SESSION_ACCESS_DENIED']);
      const service=new BrowserProfileSessionService(()=>{},{onStatus,discoverProfiles:onError=>discoverBrowserProfiles({HOME:home},'darwin',onError),readToken:async()=>mode==='valid'?'synthetic':null,fetcher:async()=>response(goodProfile()),backgroundPolling:false});services.push(service);
      if(mode==='valid'){
        await service.sync();expect(service.getBrowserProfile()?.browserPath).toBe(macChrome);const identity=service.identity();await service.sync();expect(service.identity()).toEqual(identity);expect(onStatus).toHaveBeenLastCalledWith('ready',undefined);
      }else{await expect(service.sync()).rejects.toThrow('BROWSER_SESSION_ACCESS_DENIED');expect(onStatus).toHaveBeenLastCalledWith('failed','BROWSER_SESSION_ACCESS_DENIED');}
    }finally{deniedRoots.delete(edgeData);}
  });
  it('finds macOS Edge and Chrome profiles in the user Library with the same profile filter and CURRENT check',async()=>{
    const home=await temp(),edgeData=posix.join(home,'Library','Application Support','Microsoft Edge'),chromeData=posix.join(home,'Library','Application Support','Google','Chrome');
    const userEdge=posix.join(home,'Applications','Microsoft Edge.app','Contents','MacOS','Microsoft Edge');await touch(userEdge);installed.add(macChrome);
    for(const name of ['Profile 2','Default','Guest Profile','Profile 0','System Profile'])await storage(edgeData,name);
    await mkdir(join(edgeData,'Profile 3'),{recursive:true});await storage(chromeData,'Profile 1');
    expect(await discoverBrowserProfiles({HOME:home},'darwin')).toEqual([
      {browserPath:userEdge,userDataDir:edgeData,profileDirectory:'Default'},{browserPath:userEdge,userDataDir:edgeData,profileDirectory:'Profile 2'},
      {browserPath:macChrome,userDataDir:chromeData,profileDirectory:'Profile 1'},
    ]);
  });
  it('prefers /Applications, skips browsers that are not installed and requires HOME on macOS',async()=>{
    const home=await temp(),edgeData=posix.join(home,'Library','Application Support','Microsoft Edge');
    await touch(posix.join(home,'Applications','Microsoft Edge.app','Contents','MacOS','Microsoft Edge'));installed.add(macEdge);
    await storage(edgeData,'Default');await storage(posix.join(home,'Library','Application Support','Google','Chrome'),'Default');
    expect(await discoverBrowserProfiles({HOME:home},'darwin')).toEqual([{browserPath:macEdge,userDataDir:edgeData,profileDirectory:'Default'}]);
    expect(await discoverBrowserProfiles({LOCALAPPDATA:home},'darwin')).toEqual([]);
    expect(await discoverBrowserProfiles({HOME:home},'linux')).toEqual([]);
  });
  it('keeps Windows discovery on Program Files and LOCALAPPDATA User Data',async()=>{
    const root=await temp(),local=join(root,'local'),programs=join(root,'programs'),programs86=join(root,'programs86');
    await touch(join(programs,'Microsoft','Edge','Application','msedge.exe'));await touch(join(local,'Microsoft','Edge','Application','msedge.exe'));await touch(join(local,'Google','Chrome','Application','chrome.exe'));
    await storage(join(local,'Microsoft','Edge','User Data'),'Default');await storage(join(local,'Google','Chrome','User Data'),'Profile 1');installed.add(macEdge);installed.add(macChrome);
    const env={LOCALAPPDATA:local,ProgramFiles:programs,'ProgramFiles(x86)':programs86,HOME:root};
    expect(await discoverBrowserProfiles(env,'win32')).toEqual([
      {browserPath:join(programs,'Microsoft','Edge','Application','msedge.exe'),userDataDir:join(local,'Microsoft','Edge','User Data'),profileDirectory:'Default'},
      {browserPath:join(local,'Google','Chrome','Application','chrome.exe'),userDataDir:join(local,'Google','Chrome','User Data'),profileDirectory:'Profile 1'},
    ]);
    expect(await discoverBrowserProfiles({HOME:root},'win32')).toEqual([]);
  });
});
