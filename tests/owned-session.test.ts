import {afterEach,describe,expect,it,vi} from 'vitest';
import {PersistentSessionService} from '../electron/owned-session';
import type {OwnedSessionStore} from '../host/owned-service';
import type {BrowserProfileSessionOptions} from '../electron/browser-profile-session';
const services:PersistentSessionService[]=[];
afterEach(async()=>{for(const service of services.splice(0))await service.dispose();vi.useRealTimers();});
const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status});
const profile={success:true,data:{id:7,is_active:true,permissions:['complaint_records']}};
function setup(initial:{accessToken:string;sessionRef:string}|null=null){
  let stored=initial,url='';
  const store:OwnedSessionStore={load:vi.fn(async()=>stored),save:vi.fn(async value=>{stored={...value};}),clear:vi.fn(async()=>{stored=null;})};
  const status=vi.fn(),changed=vi.fn();
  const fetcher=vi.fn<typeof fetch>(async input=>String(input).endsWith('/login')||String(input).endsWith('/refresh')?response({success:true,data:{access_token:'owned-token',session_ref:'session',token_type:'bearer'}}):response(profile));
  const options:BrowserProfileSessionOptions={fetcher,backgroundPolling:false,onStatus:status,openExternal:async value=>{url=value;}};
  const service=new PersistentSessionService(changed,options,store);services.push(service);
  return{service,store,status,changed,fetcher,options,url:()=>url,stored:()=>stored};
}
async function login(f:ReturnType<typeof setup>){
  await f.service.openLogin();const page=await fetch(f.url());const html=await page.text();
  const csrf=/const csrf="([a-f0-9]+)"/.exec(html)![1];
  const result=await fetch(f.url()+'/login',{method:'POST',headers:{'Content-Type':'application/json','Origin':new URL(f.url()).origin,'X-CSRF-Token':csrf},body:JSON.stringify({username:'test-user',password:'test-password'})});
  return{result,csrf,html};
}
describe('desktop persistent session integration',()=>{
  it('offers login recovery for corrupt saved credentials without treating outages as logout',async()=>{
    const f=setup();vi.mocked(f.store.load).mockRejectedValueOnce(new Error('SESSION_STORAGE_CORRUPT'));
    await expect(f.service.sync()).rejects.toThrow('SESSION_STORAGE_CORRUPT');
    expect(f.status).toHaveBeenLastCalledWith('needs_login',undefined);
    expect(f.store.clear).not.toHaveBeenCalled();
    const {result}=await login(f);expect(result.status).toBe(200);
    expect(f.status).toHaveBeenLastCalledWith('ready',undefined);
    expect(f.stored()).toEqual({accessToken:'owned-token',sessionRef:'session'});
  });
  it('opens a bounded login page, saves the login, restores after restart and clears on logout',async()=>{
    const f=setup();await f.service.sync();expect(f.status).toHaveBeenLastCalledWith('needs_login',undefined);
    const {result,html}=await login(f);expect(result.status).toBe(200);expect(html).toContain('不会保存密码');expect(f.stored()).toEqual({accessToken:'owned-token',sessionRef:'session'});
    expect(f.status).toHaveBeenLastCalledWith('ready',undefined);expect(f.service.identity()?.accountScope).toBe('psim:7');
    await f.service.dispose();expect(f.stored()).not.toBeNull();
    const restarted=new PersistentSessionService(f.changed,f.options,f.store);services.push(restarted);await restarted.sync();expect(restarted.identity()?.accountScope).toBe('psim:7');
    await restarted.logout();expect(f.stored()).toBeNull();expect(f.status).toHaveBeenLastCalledWith('needs_login',undefined);
    expect(JSON.stringify(f.changed.mock.calls)).not.toMatch(/owned-token|test-password/);
  });
  it('does not permit cross-origin login and never sends credentials to the merchant renderer',async()=>{
    const f=setup();await f.service.openLogin();
    const result=await fetch(f.url()+'/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.test'},body:JSON.stringify({username:'test',password:'test'})});
    expect(result.status).toBe(403);expect(f.fetcher).not.toHaveBeenCalled();expect(f.stored()).toBeNull();
  });
  it('keeps an encrypted session on transient outage and recovers to ready',async()=>{
    const f=setup({accessToken:'owned-token',sessionRef:'session'});await f.service.sync();
    f.fetcher.mockRejectedValueOnce(new Error('private server diagnostic'));
    await expect(f.service.sync()).rejects.toThrow();expect(f.status).toHaveBeenLastCalledWith('failed','SERVICE_UNAVAILABLE');expect(f.stored()).not.toBeNull();expect(f.service.identity()).toBeNull();
    await f.service.sync();expect(f.status).toHaveBeenLastCalledWith('ready',undefined);
  });
  it('publishes ready after rotation and publishes needs_login on real revocation',async()=>{
    vi.useFakeTimers();const f=setup({accessToken:'owned-token',sessionRef:'session'});await f.service.sync();
    vi.setSystemTime(Date.now()+31*60000);await f.service.sync();expect(f.status).toHaveBeenLastCalledWith('ready',undefined);expect(f.fetcher.mock.calls.some(([url])=>String(url).endsWith('/refresh'))).toBe(true);
    f.fetcher.mockResolvedValueOnce(response({},401));await expect(f.service.sync()).rejects.toThrow('PSIM_HTTP_401');expect(f.status).toHaveBeenLastCalledWith('needs_login',undefined);expect(f.stored()).toBeNull();
  });
});
