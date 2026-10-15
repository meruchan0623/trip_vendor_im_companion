import { describe,it,expect,vi,beforeEach,afterEach } from 'vitest';
import { resolve } from 'node:path';
import { SystemBrowser,operatorURL,edgeArguments } from '../electron/system-browser';
const bounds={x:10,y:20,width:800,height:600};
const selection={identifier:'001 订单&=',identifierType:'order_number' as const,requestId:'550e8400-e29b-41d4-a716-446655440000'};
function fixture(){return {launchBrowser:vi.fn(async(options:{launchId:string})=>({launchId:options.launchId,processId:123,startedAtTicks:'639000000000000000'})),adoptBrowser:vi.fn(async(_proof:unknown)=>{}),placeBrowser:vi.fn(async()=>{}),cleanupBrowserLaunch:vi.fn(async(_key:unknown)=>({complete:true}))};}
beforeEach(()=>vi.clearAllMocks());afterEach(()=>vi.useRealTimers());
describe('native leased system Edge window',()=>{
  it('loads only the direct typed operator route and dedicated profile arguments',()=>{const url=new URL(operatorURL(selection));expect(url.origin).toBe('https://csagent.tsim.tech');expect(url.pathname).toBe('/embed/operator');expect(url.searchParams.get('identifier')).toBe(selection.identifier);expect(url.searchParams.get('identifierType')).toBe('order_number');expect(url.searchParams.get('requestId')).toBe(selection.requestId);expect(url.searchParams.get('source')).toBe('travel-merchant-companion');const args=edgeArguments('work/profile',url.href,bounds);expect(args).toContain(`--user-data-dir=${resolve('work/profile')}`);expect(args.join(' ')).not.toMatch(/remote-debugging|access_token/);});
  it('records native spawn identity before adopting and cleans its capability on close',async()=>{const native=fixture(),browser=new SystemBrowser(native,'work/system-browser-profile');browser.place(bounds,true);await browser.open(selection,bounds);const launch=native.launchBrowser.mock.calls[0][0];expect(launch).toMatchObject({profilePath:resolve('work/system-browser-profile'),appURL:operatorURL(selection)});expect(native.adoptBrowser).toHaveBeenCalledWith({launchId:launch.launchId,processId:123,startedAtTicks:'639000000000000000'});expect(native.placeBrowser).toHaveBeenCalledWith({bounds,visible:true});await browser.close();expect(native.cleanupBrowserLaunch).toHaveBeenCalledWith({launchId:launch.launchId});});
  it('cleans a spawn whose reply was lost using the pre-recorded launch capability',async()=>{const native=fixture();native.launchBrowser.mockRejectedValueOnce(new Error('helper_timeout'));const browser=new SystemBrowser(native,'work/system-browser-profile');await expect(browser.open(selection,bounds)).rejects.toThrow('BROWSER_ADOPTION_FAILED');expect(native.cleanupBrowserLaunch).toHaveBeenCalledWith({launchId:native.launchBrowser.mock.calls[0][0].launchId});expect(native.adoptBrowser).not.toHaveBeenCalled();});
  it('cancels an unresolved launch without ever adopting or showing its late window',async()=>{const native=fixture();let finish!:(value:any)=>void;native.launchBrowser.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));const browser=new SystemBrowser(native,'work/system-browser-profile');const opening=browser.open(selection,bounds);await Promise.resolve();await Promise.resolve();const closing=browser.close();finish({launchId:native.launchBrowser.mock.calls[0][0].launchId,processId:123,startedAtTicks:'639000000000000000'});await opening;await closing;expect(native.cleanupBrowserLaunch).toHaveBeenCalledOnce();expect(native.adoptBrowser).not.toHaveBeenCalled();expect(native.placeBrowser).not.toHaveBeenCalled();});
  it('cleans every ambiguous launch before allowing the next request to spawn',async()=>{vi.useFakeTimers();const native=fixture();native.adoptBrowser.mockRejectedValueOnce(new Error('browser_window_ambiguous'));native.cleanupBrowserLaunch.mockResolvedValueOnce({complete:false}).mockResolvedValueOnce({complete:false});const browser=new SystemBrowser(native,'work/system-browser-profile');const failed=browser.open(selection,bounds);const assertion=expect(failed).rejects.toThrow('BROWSER_ADOPTION_FAILED');await vi.advanceTimersByTimeAsync(300);await assertion;expect(native.cleanupBrowserLaunch).toHaveBeenCalledTimes(3);await browser.open(selection,bounds);expect(native.launchBrowser).toHaveBeenCalledTimes(2);expect(native.placeBrowser).toHaveBeenCalledOnce();});
  it('cleans a cancelled pending adoption rather than waiting for an adoptable HWND',async()=>{vi.useFakeTimers();const native=fixture();native.adoptBrowser.mockRejectedValue(new Error('browser_window_pending'));const browser=new SystemBrowser(native,'work/system-browser-profile');const opening=browser.open(selection,bounds);await vi.advanceTimersByTimeAsync(1);const closing=browser.close();await vi.advanceTimersByTimeAsync(150);await opening;await closing;expect(native.cleanupBrowserLaunch).toHaveBeenCalledOnce();expect(native.placeBrowser).not.toHaveBeenCalled();});
  it('cleans after the adoption deadline, including windows arriving during cleanup',async()=>{vi.useFakeTimers();const native=fixture();native.adoptBrowser.mockRejectedValue(new Error('browser_window_pending'));const browser=new SystemBrowser(native,'work/system-browser-profile');const result=expect(browser.open(selection,bounds)).rejects.toThrow('BROWSER_ADOPTION_FAILED');await vi.advanceTimersByTimeAsync(8200);await result;expect(native.cleanupBrowserLaunch).toHaveBeenCalledOnce();expect(native.placeBrowser).not.toHaveBeenCalled();});
  it('refuses reuse if the helper dies before cleanup is confirmed',async()=>{const native=fixture();native.adoptBrowser.mockRejectedValueOnce(new Error('helper_stopped'));native.cleanupBrowserLaunch.mockRejectedValue(new Error('helper_unavailable'));const browser=new SystemBrowser(native,'work/system-browser-profile');await expect(browser.open(selection,bounds)).rejects.toThrow('BROWSER_CLEANUP_UNCONFIRMED');await expect(browser.open(selection,bounds)).rejects.toThrow('BROWSER_CLEANUP_UNCONFIRMED');expect(native.launchBrowser).toHaveBeenCalledOnce();});
  it('cleans remaining broker popups when the adopted window closes manually',async()=>{const native=fixture(),browser=new SystemBrowser(native,'work/system-browser-profile');await browser.open(selection,bounds);browser.handleLost();await browser.close();expect(native.cleanupBrowserLaunch).toHaveBeenCalledOnce();});
  it('retries an unchanged show request after its first native rejection without another main request',async()=>{
    vi.useFakeTimers();const native=fixture(),failed=vi.fn(),browser=new SystemBrowser(native,'work/system-browser-profile',failed);
    await browser.open(selection,bounds);native.placeBrowser.mockClear();native.placeBrowser.mockRejectedValueOnce(new Error('temporary_native_failure'));
    browser.place(bounds,true);await vi.advanceTimersByTimeAsync(150);
    expect(native.placeBrowser).toHaveBeenCalledTimes(2);expect(native.placeBrowser).toHaveBeenLastCalledWith({bounds,visible:true});
    // Only a successful native acknowledgement authorizes deduplication.
    browser.place({...bounds},true);await vi.advanceTimersByTimeAsync(0);expect(native.placeBrowser).toHaveBeenCalledTimes(2);
    expect(failed).not.toHaveBeenCalled();expect(native.cleanupBrowserLaunch).not.toHaveBeenCalled();await browser.close();
  });
  it('coalesces a newer hide request instead of retrying the stale show bounds',async()=>{
    vi.useFakeTimers();const native=fixture(),browser=new SystemBrowser(native,'work/system-browser-profile');await browser.open(selection,bounds);
    native.placeBrowser.mockClear();native.placeBrowser.mockRejectedValueOnce(new Error('temporary_native_failure'));
    browser.place(bounds,true);await vi.advanceTimersByTimeAsync(1);const moved={...bounds,x:300};browser.place(moved,false);
    await vi.advanceTimersByTimeAsync(150);expect(native.placeBrowser).toHaveBeenCalledTimes(2);expect(native.placeBrowser).toHaveBeenLastCalledWith({bounds:moved,visible:false});await browser.close();
  });
  it('retires the owned lease then reports exhausted placement retries exactly once',async()=>{
    vi.useFakeTimers();const native=fixture(),events:string[]=[],failed=vi.fn(()=>events.push('failure'));
    native.cleanupBrowserLaunch.mockImplementation(async()=>{events.push('cleanup');return{complete:true};});
    const browser=new SystemBrowser(native,'work/system-browser-profile',failed);await browser.open(selection,bounds);
    native.placeBrowser.mockClear();native.placeBrowser.mockRejectedValue(new Error('persistent_native_failure'));
    browser.place(bounds,true);browser.place({...bounds},true);await vi.advanceTimersByTimeAsync(450);
    expect(native.placeBrowser).toHaveBeenCalledTimes(3);expect(native.cleanupBrowserLaunch).toHaveBeenCalledOnce();expect(events).toEqual(['cleanup','failure']);expect(failed).toHaveBeenCalledExactlyOnceWith('BROWSER_PLACEMENT_FAILED');
    browser.place(bounds,true);await vi.advanceTimersByTimeAsync(1000);expect(native.placeBrowser).toHaveBeenCalledTimes(3);await browser.close();
  });
  it('does not retry a placement or report stale failure after explicit close',async()=>{
    vi.useFakeTimers();const native=fixture(),failed=vi.fn(),browser=new SystemBrowser(native,'work/system-browser-profile',failed);await browser.open(selection,bounds);
    native.placeBrowser.mockClear();native.placeBrowser.mockRejectedValue(new Error('temporary_native_failure'));
    browser.place(bounds,true);await vi.advanceTimersByTimeAsync(1);await browser.close();await vi.advanceTimersByTimeAsync(1000);
    expect(native.placeBrowser).toHaveBeenCalledOnce();expect(failed).not.toHaveBeenCalled();expect(native.cleanupBrowserLaunch).toHaveBeenCalledOnce();
  });
  it('awaits initial placement recovery and rejects exhaustion with a visible error code',async()=>{
    vi.useFakeTimers();const native=fixture(),failed=vi.fn(),browser=new SystemBrowser(native,'work/system-browser-profile',failed);
    native.placeBrowser.mockRejectedValueOnce(new Error('temporary_native_failure'));const opening=browser.open(selection,bounds);await vi.advanceTimersByTimeAsync(150);await opening;
    expect(native.placeBrowser).toHaveBeenCalledTimes(2);expect(failed).not.toHaveBeenCalled();await browser.close();
    native.placeBrowser.mockRejectedValue(new Error('persistent_native_failure'));const rejected=expect(browser.open(selection,bounds)).rejects.toThrow('BROWSER_PLACEMENT_FAILED');await vi.advanceTimersByTimeAsync(450);await rejected;
    expect(native.cleanupBrowserLaunch).toHaveBeenCalledTimes(2);expect(failed).not.toHaveBeenCalled();
  });
});
