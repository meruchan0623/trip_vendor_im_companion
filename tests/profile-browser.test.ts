import{describe,it,expect,vi,afterEach}from'vitest';
import{request}from'node:http';
import{ProfileBrowser,startProfileBootstrap,type BrowserProfileSelection}from'../electron/profile-browser';
import{operatorURL}from'../electron/system-browser';
const selection={identifier:'fixture-order',identifierType:'order_number' as const,requestId:'550e8400-e29b-41d4-a716-446655440000'};
const bounds={x:1,y:2,width:800,height:600};
const id='450e8400-e29b-41d4-a716-446655440000';
function fixture(){return{launchProfileBrowser:vi.fn(async(_options:{launchId:string;browserKind:string;profileDirectory:string;bootstrapURL:string})=>{}),adoptProfileBrowser:vi.fn(async(_id:string)=>{}),cleanupProfileBrowser:vi.fn(async(_id:string)=>({complete:true})),heartbeatProfileBrowser:vi.fn(async(_id:string)=>{}),placeBrowser:vi.fn(async()=>{})};}
const profile:BrowserProfileSelection={browser:'edge',profileDirectory:'Default'};
afterEach(()=>vi.useRealTimers());
describe('same-profile nonce bootstrap (local HTTP and mocks only)',()=>{
  it('requires a nonce path, exact Host/Origin and GET; exposes no arbitrary redirect endpoint',async()=>{
    const server=await startProfileBootstrap(id,operatorURL(selection));
    try{
      const page=await fetch(server.url);expect(page.status).toBe(200);const html=await page.text();expect(html).toContain(`TSim Companion Bootstrap ${id}`);expect(html).toContain('location.replace(target)');expect(html).not.toMatch(/<iframe|password|document.cookie|localStorage/i);
      expect(await(await fetch(server.url+'/ready')).json()).toEqual({ready:false,cancelled:false});
      for(const [url,options]of[[server.url+'?redirect=https://evil.test',{}],[server.url.replace(id,'wrong'),{}],[server.url,{method:'POST'}],[server.url,{headers:{Origin:'https://evil.test'}}]]as const)expect((await fetch(url,options)).status).toBe(403);
      // Fetch may normalize Host; use the raw HTTP client to exercise the server boundary.
      expect(await new Promise<number|undefined>((resolve,reject)=>{const req=request(server.url,{headers:{Host:'evil.test'}},response=>{response.resume();resolve(response.statusCode);});req.on('error',reject);req.end();})).toBe(403);
      server.release();expect(await(await fetch(server.url+'/ready')).json()).toEqual({ready:true,cancelled:false});server.cancel();server.release();expect(await(await fetch(server.url+'/ready')).json()).toEqual({ready:false,cancelled:true});
    }finally{await server.close();}
  });
  it('rejects foreign/operator redirect URLs before listening',async()=>{
    await expect(startProfileBootstrap(id,'https://evil.test/embed/operator')).rejects.toThrow('INVALID_OPERATOR_URL');
    await expect(startProfileBootstrap(id,operatorURL(selection)+'&redirect=https://evil.test')).rejects.toThrow('INVALID_OPERATOR_URL');
    await expect(startProfileBootstrap(id,operatorURL(selection)+'&companionLease='+selection.requestId)).rejects.toThrow('INVALID_OPERATOR_URL');
  });
  it('releases exact operator navigation only after native nonce adoption and hidden placement',async()=>{
    const native=fixture();let url='';
    native.launchProfileBrowser.mockImplementation(async options=>{url=options.bootstrapURL;expect(options).toMatchObject({browserKind:'edge',profileDirectory:'Default'});expect(new URL(url).pathname).toBe('/bootstrap/'+options.launchId);});
    native.adoptProfileBrowser.mockImplementation(async launchId=>{expect(url).toContain(launchId);expect(await(await fetch(url+'/ready')).json()).toEqual({ready:false,cancelled:false});});
    native.placeBrowser.mockImplementationOnce(async()=>{expect(await(await fetch(url+'/ready')).json()).toEqual({ready:false,cancelled:false});});
    const browser=new ProfileBrowser(native,()=>profile);await browser.open(selection,bounds);
    const leaseId=native.launchProfileBrowser.mock.calls[0][0].launchId;
    const bootstrapHTML=await(await fetch(url)).text();expect(bootstrapHTML).toContain('companionLease='+leaseId);expect(browser.ownsGeometry(leaseId)).toBe(true);expect(browser.ownsGeometry(selection.requestId)).toBe(false);
    expect(await(await fetch(url+'/ready')).json()).toEqual({ready:true,cancelled:false});expect(native.placeBrowser).toHaveBeenCalledWith({bounds,visible:false,maximized:false});expect(native.placeBrowser.mock.calls).toEqual([[{bounds,visible:false,maximized:false}],[{bounds,visible:true}]]);await browser.close();
    expect(native.cleanupProfileBrowser).toHaveBeenCalledWith(native.launchProfileBrowser.mock.calls[0][0].launchId);expect(browser.ownsGeometry(leaseId)).toBe(false);await expect(fetch(url)).rejects.toThrow();
  });
  it('restores maximized state before its single visible placement',async()=>{const native=fixture(),browser=new ProfileBrowser(native,()=>profile);await browser.open(selection,bounds,true);expect(native.placeBrowser.mock.calls).toEqual([[{bounds,visible:false,maximized:true}],[{bounds,visible:true}]]);await browser.close();});
  it('captures selected profile for each new nonce without touching shared process identity',async()=>{
    const native=fixture();let selected=profile;const browser=new ProfileBrowser(native,()=>selected);await browser.open(selection,bounds);await browser.close();
    selected={browser:'chrome',profileDirectory:'Profile 2'};await browser.open(selection,bounds);await browser.close();
    const first=native.launchProfileBrowser.mock.calls[0][0],second=native.launchProfileBrowser.mock.calls[1][0];expect(first.launchId).not.toBe(second.launchId);expect(second).toMatchObject({browserKind:'chrome',profileDirectory:'Profile 2'});expect(Object.keys(second).sort()).toEqual(['bootstrapURL','browserKind','launchId','profileDirectory']);
  });
  it('refuses unknown profile folders rather than silently creating a new profile',async()=>{
    const native=fixture(),browser=new ProfileBrowser(native,()=>({browser:'edge',profileDirectory:'../../ordinary'}));await expect(browser.open(selection,bounds)).rejects.toThrow('BROWSER_PROFILE_REQUIRED');expect(native.launchProfileBrowser).not.toHaveBeenCalled();
  });
  it('does not navigate an ambiguous new window and cleans only that nonce lease',async()=>{
    const native=fixture();native.adoptProfileBrowser.mockRejectedValueOnce(new Error('browser_window_ambiguous'));const browser=new ProfileBrowser(native,()=>profile);await expect(browser.open(selection,bounds)).rejects.toThrow('browser_window_ambiguous');expect(native.placeBrowser).not.toHaveBeenCalled();expect(native.cleanupProfileBrowser).toHaveBeenCalledWith(native.launchProfileBrowser.mock.calls[0][0].launchId);
  });
  it('cancels an unresolved launch before any redirect or placement, including cleanup of its late window',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date']});
    const native=fixture();let release!:()=>void,launched!:()=>void,cleanupBegan!:()=>void;const began=new Promise<void>(resolve=>launched=resolve),cleanupStarted=new Promise<void>(resolve=>cleanupBegan=resolve);
    native.launchProfileBrowser.mockImplementation(async()=>{launched();await new Promise<void>(resolve=>release=resolve);});
    native.cleanupProfileBrowser.mockImplementationOnce(async()=>{cleanupBegan();return{complete:false};});
    const browser=new ProfileBrowser(native,()=>profile);const opening=browser.open(selection,bounds);await began;const closing=browser.close();release();await cleanupStarted;await vi.advanceTimersByTimeAsync(100);await opening;await closing;
    expect(native.adoptProfileBrowser).not.toHaveBeenCalled();expect(native.placeBrowser).not.toHaveBeenCalled();expect(native.cleanupProfileBrowser).toHaveBeenCalledTimes(2);
    expect(native.cleanupProfileBrowser.mock.calls.map(call=>call[0])).toEqual([native.launchProfileBrowser.mock.calls[0][0].launchId,native.launchProfileBrowser.mock.calls[0][0].launchId]);
  });
  it('uses a native heartbeat for its own popup and closes on explicit detach',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date']});
    const native=fixture(),browser=new ProfileBrowser(native,()=>profile);await browser.open(selection,bounds);await vi.advanceTimersByTimeAsync(2100);
    expect(native.heartbeatProfileBrowser).toHaveBeenCalledExactlyOnceWith(native.launchProfileBrowser.mock.calls[0][0].launchId);
    await browser.close();expect(native.cleanupProfileBrowser).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(4000);expect(native.heartbeatProfileBrowser).toHaveBeenCalledOnce();
  });
  it('keeps distinct foreground restacks even when geometry is unchanged and a placement is pending',async()=>{
    const native=fixture(),browser=new ProfileBrowser(native,()=>profile);await browser.open(selection,bounds);
    browser.place(bounds,true);expect(native.placeBrowser).toHaveBeenCalledTimes(2);
    let release!:()=>void;native.placeBrowser.mockImplementationOnce(()=>new Promise<void>(resolve=>release=resolve));
    browser.place(bounds,true,true);await vi.waitFor(()=>expect(native.placeBrowser).toHaveBeenCalledTimes(3));
    browser.place(bounds,true,true);release();await vi.waitFor(()=>expect(native.placeBrowser).toHaveBeenCalledTimes(4));
    expect(native.placeBrowser.mock.calls.slice(2)).toEqual([[{bounds,visible:true,restack:true}],[{bounds,visible:true,restack:true}]]);
    browser.place(bounds,false);await vi.waitFor(()=>expect(native.placeBrowser).toHaveBeenLastCalledWith({bounds,visible:false}));await browser.close();
  });
});
