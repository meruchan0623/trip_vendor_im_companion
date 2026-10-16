import {afterEach,describe,expect,it,vi} from 'vitest';
import {OwnedPsimService,type OwnedSessionStore} from '../host/owned-service';
const session={accessToken:'opaque-access-token',sessionRef:'session-1'};
const profile={success:true,data:{id:42,is_active:true,permissions:['translate']}};
const auth=(value=session)=>({success:true,data:{access_token:value.accessToken,session_ref:value.sessionRef,token_type:'bearer'}});
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
function fixture(initial:unknown=null){
  let saved=initial;
  const store={load:vi.fn(async()=>saved),save:vi.fn(async(value:typeof session)=>{saved=structuredClone(value);}),clear:vi.fn(async()=>{saved=null;})};
  const fetcher=vi.fn<(url:string,init:RequestInit)=>Promise<Response>>();
  const changed=vi.fn();
  const create=()=>new OwnedPsimService(fetcher,changed,store as OwnedSessionStore);
  return{store,fetcher,changed,create,get saved(){return saved;}};
}
afterEach(()=>vi.useRealTimers());
describe('owned service durable session',()=>{
  it('persists verified login and restores it in a new process without credentials',async()=>{
    const f=fixture();f.fetcher.mockResolvedValueOnce(response(auth())).mockResolvedValueOnce(response(profile));
    const service=f.create();expect(await service.login('agent','password')).toMatchObject({accountScope:'psim:42'});expect(f.saved).toEqual(session);
    service.dispose();expect(f.saved).toEqual(session);f.fetcher.mockResolvedValueOnce(response(profile));
    const restarted=f.create();expect(restarted.identity()).toBeNull();expect(await restarted.restore()).toMatchObject({accountScope:'psim:42'});
    expect(f.fetcher.mock.calls.at(-1)?.[0]).toBe('https://csapi.tsim.tech/agent/profile');expect(f.fetcher.mock.calls.at(-1)?.[1].headers).toMatchObject({Authorization:`Bearer ${session.accessToken}`});
  });
  it('does not fabricate identity from a stored token or JWT payload',async()=>{
    const f=fixture(session),pending=deferred<Response>();f.fetcher.mockReturnValueOnce(pending.promise);const service=f.create(),restored=service.restore();
    await vi.waitFor(()=>expect(f.fetcher).toHaveBeenCalledOnce());expect(service.identity()).toBeNull();pending.resolve(response(profile));await restored;
  });
  it('returns null for missing store or missing session',async()=>{
    expect(await new OwnedPsimService().restore()).toBeNull();const f=fixture();expect(await f.create().restore()).toBeNull();expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([{},[],{...session,extra:true},{...session,accessToken:''},{...session,accessToken:'token\r\nsecret'},{...session,sessionRef:''},{...session,sessionRef:'x'.repeat(2049)}])('rejects malformed stored values safely: %#',async(value)=>{
    const f=fixture(value);await expect(f.create().restore()).rejects.toThrow('INVALID_STORED_SESSION');expect(f.saved).toBeNull();expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('preserves durable token after a network failure and retries server validation',async()=>{
    const f=fixture(session);f.fetcher.mockRejectedValueOnce(new Error('network unavailable'));const service=f.create();
    await expect(service.restore()).rejects.toThrow('network unavailable');expect(service.identity()).toBeNull();expect(f.saved).toEqual(session);expect(f.store.clear).not.toHaveBeenCalled();
    f.fetcher.mockResolvedValueOnce(response(profile));expect(await service.ensureSession()).toMatchObject({accountScope:'psim:42'});
  });
  it.each([401,423])('removes a revoked or locked session on HTTP %s',async(status)=>{
    const f=fixture(session);f.fetcher.mockResolvedValueOnce(response({},status));const service=f.create();
    await expect(service.restore()).rejects.toThrow(`PSIM_HTTP_${status}`);expect(f.saved).toBeNull();expect(service.identity()).toBeNull();
  });
  it.each([{success:false},{success:true,data:{...profile.data,is_active:false}},{success:true,data:{...profile.data,id:'bad/id'}},{success:true,data:{...profile.data,permissions:[12]}}])('rejects explicitly unverified profiles and clears cache: %#',async(value)=>{
    const f=fixture(session);f.fetcher.mockResolvedValueOnce(response(value));const service=f.create();await expect(service.restore()).rejects.toThrow('PROFILE_UNVERIFIED');expect(f.saved).toBeNull();expect(service.identity()).toBeNull();
  });
  it('persists token and session rotation only after server profile verification',async()=>{
    const f=fixture(session),rotated={accessToken:'rotated-token',sessionRef:'session-2'};f.fetcher.mockResolvedValueOnce(response(profile));const service=f.create();await service.restore();
    f.fetcher.mockResolvedValueOnce(response(auth(rotated))).mockResolvedValueOnce(response(profile));expect(await service.refresh()).toMatchObject({accountScope:'psim:42'});expect(f.saved).toEqual(rotated);
    expect(f.fetcher.mock.calls[1][0]).toBe('https://csapi.tsim.tech/agent/auth/refresh');expect(f.fetcher.mock.calls[1][1].body).toBeUndefined();expect(f.fetcher.mock.calls[2][1].headers).toMatchObject({Authorization:'Bearer rotated-token'});
  });
  it('keeps durable token but revokes identity if refresh fails on the network',async()=>{
    const f=fixture(session);f.fetcher.mockResolvedValueOnce(response(profile));const service=f.create();await service.restore();f.fetcher.mockRejectedValueOnce(new Error('offline'));
    await expect(service.refresh()).rejects.toThrow('offline');expect(service.identity()).toBeNull();expect(f.saved).toEqual(session);
  });
  it('clears persistence on invalid refresh responses',async()=>{
    const f=fixture(session);f.fetcher.mockResolvedValueOnce(response(profile));const service=f.create();await service.restore();f.fetcher.mockResolvedValueOnce(response({success:true,data:{access_token:''}}));
    await expect(service.refresh()).rejects.toThrow('REFRESH_RESPONSE_INVALID');expect(f.saved).toBeNull();expect(service.identity()).toBeNull();
  });
  it('clears local credentials even if logout cannot reach the server',async()=>{
    const f=fixture(session);f.fetcher.mockResolvedValueOnce(response(profile));const service=f.create();await service.restore();f.fetcher.mockRejectedValueOnce(new Error('offline'));
    const logout=service.logout();expect(service.identity()).toBeNull();await expect(logout).rejects.toThrow('offline');expect(f.saved).toBeNull();
  });
  it('revokes the server session even if local deletion fails and rejects the leftover session on restart',async()=>{
    const f=fixture(session);let revoked=false;
    f.fetcher.mockImplementation(async url=>{
      if(url.endsWith('/logout')){revoked=true;return response({success:true});}
      return revoked?response({},401):response(profile);
    });
    const service=f.create();await service.restore();f.store.clear.mockRejectedValueOnce(new Error('SESSION_STORAGE_DELETE_FAILED'));
    await expect(service.logout()).rejects.toThrow('SESSION_STORAGE_DELETE_FAILED');expect(service.identity()).toBeNull();expect(revoked).toBe(true);expect(f.saved).toEqual(session);
    expect(f.fetcher.mock.calls.map(([url])=>new URL(url).pathname)).toEqual(['/agent/profile','/agent/logout']);
    const restarted=f.create();await expect(restarted.restore()).rejects.toThrow('PSIM_HTTP_401');expect(restarted.identity()).toBeNull();expect(f.saved).toBeNull();
  });
  it('prevents a late restore load from reviving a logged out session',async()=>{
    const f=fixture(session),loaded=deferred<typeof session|null>();f.store.load.mockReturnValueOnce(loaded.promise);const service=f.create(),restored=service.restore();const rejected=expect(restored).rejects.toThrow('AUTH_CHANGED');
    await vi.waitFor(()=>expect(f.store.load).toHaveBeenCalledOnce());const logout=service.logout();loaded.resolve(session);await rejected;await logout;expect(service.identity()).toBeNull();expect(f.saved).toBeNull();expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('prevents a late refresh response from saving after logout',async()=>{
    const f=fixture(session);f.fetcher.mockResolvedValueOnce(response(profile));const service=f.create();await service.restore();const pending=deferred<Response>();f.fetcher.mockReturnValueOnce(pending.promise);
    const refresh=service.refresh(),rejected=expect(refresh).rejects.toThrow('AUTH_CHANGED');await vi.waitFor(()=>expect(f.fetcher).toHaveBeenCalledTimes(2));f.fetcher.mockResolvedValueOnce(response({success:true}));const logout=service.logout();
    pending.resolve(response(auth({accessToken:'late-token',sessionRef:'late-session'})));await rejected;await logout;expect(f.saved).toBeNull();expect(f.store.save).not.toHaveBeenCalled();
  });
  it('orders logout deletion after a durable save already in flight',async()=>{
    const f=fixture(),saving=deferred<void>();f.store.save.mockImplementationOnce(async value=>{await saving.promise;await f.store.save(value);});
    f.fetcher.mockResolvedValueOnce(response(auth())).mockResolvedValueOnce(response(profile));const service=f.create(),login=service.login('agent','password'),rejected=expect(login).rejects.toThrow('AUTH_CHANGED');
    await vi.waitFor(()=>expect(f.store.save).toHaveBeenCalledOnce());f.fetcher.mockResolvedValueOnce(response({success:true}));const logout=service.logout();saving.resolve();await rejected;await logout;expect(f.saved).toBeNull();
  });
  it('does not save a late login response after disposal',async()=>{
    const f=fixture(),pending=deferred<Response>();f.fetcher.mockReturnValueOnce(pending.promise);const service=f.create(),login=service.login('agent','password'),rejected=expect(login).rejects.toThrow('AUTH_CHANGED');
    await vi.waitFor(()=>expect(f.fetcher).toHaveBeenCalledOnce());service.dispose();pending.resolve(response(auth()));await rejected;expect(f.store.save).not.toHaveBeenCalled();expect(service.identity()).toBeNull();
  });
  it('does not delete an existing durable session on disposal during restore',async()=>{
    const f=fixture(session),pending=deferred<Response>();f.fetcher.mockReturnValueOnce(pending.promise);const service=f.create(),restore=service.restore(),rejected=expect(restore).rejects.toThrow('AUTH_CHANGED');
    await vi.waitFor(()=>expect(f.fetcher).toHaveBeenCalledOnce());service.dispose();pending.resolve(response(profile));await rejected;expect(f.saved).toEqual(session);expect(f.store.clear).not.toHaveBeenCalled();
  });
  it('reports storage save failure safely and withholds the identity until a successful retry',async()=>{
    const f=fixture();f.store.save.mockRejectedValueOnce(new Error('secret token in provider error'));f.fetcher.mockResolvedValueOnce(response(auth())).mockResolvedValueOnce(response(profile));const service=f.create();
    await expect(service.login('agent','password')).rejects.toThrow('PSIM_SESSION_SAVE_FAILED');expect(service.identity()).toBeNull();expect(f.saved).toBeNull();f.fetcher.mockResolvedValueOnce(response(profile));await service.ensureSession();expect(f.saved).toEqual(session);expect(service.identity()).not.toBeNull();
  });
  it('sanitizes store read and clear errors',async()=>{
    const f=fixture();f.store.load.mockRejectedValueOnce(new Error('sensitive'));await expect(f.create().restore()).rejects.toThrow('PSIM_SESSION_LOAD_FAILED');f.store.clear.mockRejectedValueOnce(new Error('sensitive'));await expect(f.create().logout()).rejects.toThrow('PSIM_SESSION_CLEAR_FAILED');
  });
  it('does not rewrite unchanged restored credentials on periodic checks',async()=>{
    const f=fixture(session);f.fetcher.mockImplementation(async()=>response(profile));const service=f.create();await service.restore();await service.ensureSession();await service.ensureSession();expect(f.store.save).not.toHaveBeenCalled();
  });
  it('preserves safe storage diagnostic codes and rejects arbitrary provider details',async()=>{
    const f=fixture();f.store.load.mockRejectedValueOnce(new Error('SESSION_STORAGE_LOCKED'));await expect(f.create().restore()).rejects.toThrow('SESSION_STORAGE_LOCKED');
    f.store.clear.mockRejectedValueOnce(new Error('SESSION_STORAGE_secret value'));await expect(f.create().logout()).rejects.toThrow('PSIM_SESSION_CLEAR_FAILED');
  });
  it('keeps existing in-memory clients compatible when no store is supplied',async()=>{
    const f=fixture();f.fetcher.mockResolvedValueOnce(response(auth())).mockResolvedValueOnce(response(profile)).mockResolvedValueOnce(response(auth())).mockResolvedValueOnce(response(profile)).mockResolvedValueOnce(response({success:true}));
    const service=new OwnedPsimService(f.fetcher);expect(await service.login('agent','password')).toMatchObject({accountScope:'psim:42'});expect(await service.refresh()).toMatchObject({accountScope:'psim:42'});await service.logout();expect(service.identity()).toBeNull();
  });
  it('refreshes opaque tokens after thirty minutes using serial session checks',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));const f=fixture(session);f.fetcher.mockImplementation(async url=>response(url.endsWith('/refresh')?auth({accessToken:'rotated',sessionRef:'rotated-ref'}):profile));const service=f.create();
    await service.restore();vi.setSystemTime(Date.now()+29*60_000);await service.ensureSession();expect(f.fetcher.mock.calls.filter(([url])=>url.endsWith('/refresh'))).toHaveLength(0);
    vi.setSystemTime(Date.now()+60_000);await Promise.all([service.ensureSession(),service.ensureSession()]);expect(f.fetcher.mock.calls.filter(([url])=>url.endsWith('/refresh'))).toHaveLength(1);expect(f.saved).toEqual({accessToken:'rotated',sessionRef:'rotated-ref'});
  });
  it('uses JWT exp only to refresh a server verified session near expiry',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));const token=`header.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+240,id:'untrusted'})).toString('base64url')}.signature`;
    const f=fixture({...session,accessToken:token});f.fetcher.mockResolvedValueOnce(response(profile)).mockResolvedValueOnce(response(auth())).mockResolvedValueOnce(response(profile));const service=f.create();expect(await service.ensureSession()).toMatchObject({accountScope:'psim:42'});
    expect(f.fetcher.mock.calls.map(([url])=>new URL(url).pathname)).toEqual(['/agent/profile','/agent/auth/refresh','/agent/profile']);expect(f.saved).toEqual(session);
  });
});
