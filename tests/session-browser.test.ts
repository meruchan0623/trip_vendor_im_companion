import {describe,it,expect,vi} from 'vitest';
import {SessionBrowser} from '../electron/session-browser';
const bounds={x:1,y:2,width:800,height:600};
const selection={identifier:'123456',identifierType:'order_number' as const,requestId:'request'};
function setup(){
 const native={adoptSharedBrowser:vi.fn(async()=>{}),releaseSharedBrowser:vi.fn(async()=>{}),placeBrowser:vi.fn(async(_value:unknown)=>{})};
 const session={openOrder:vi.fn(async()=>({windowId:12,marker:'12345678-1234-1234-1234-123456789012'})),closeOrder:vi.fn(async()=>{})};
 const failed=vi.fn();return{native,session,failed,browser:new SessionBrowser(native,session,failed)};
}
describe('existing browser session order window',()=>{
 it('opens through the session and releases only the tracked popup',async()=>{
  const x=setup();await x.browser.open(selection,bounds);expect(x.session.openOrder).toHaveBeenCalledWith(selection,bounds);
  expect(x.native.adoptSharedBrowser).toHaveBeenCalledWith('12345678-1234-1234-1234-123456789012');
  await x.browser.close();expect(x.session.closeOrder).toHaveBeenCalledWith(12);expect(x.native.releaseSharedBrowser).toHaveBeenCalledOnce();
 });
 it('closes a late popup when the request was cancelled',async()=>{
  const x=setup();let resolve!:(value:{windowId:number;marker:string})=>void;
  x.session.openOrder.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
  const opening=x.browser.open(selection,bounds);await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));
  const closing=x.browser.close();resolve({windowId:12,marker:'12345678-1234-1234-1234-123456789012'});await opening;await closing;
  expect(x.session.closeOrder).toHaveBeenCalledWith(12);expect(x.native.adoptSharedBrowser).not.toHaveBeenCalled();
 });
 it('retries a failed show without relying on another follow event',async()=>{
  const x=setup();await x.browser.open(selection,bounds);
  x.native.placeBrowser.mockRejectedValueOnce(new Error('browser_placement_failed'));
  x.browser.place(bounds,true);await vi.waitFor(()=>expect(x.native.placeBrowser).toHaveBeenCalledTimes(3));
  expect(x.failed).not.toHaveBeenCalled();await x.browser.close();
 });
 it('cleans up and reports bounded placement failures',async()=>{
  const x=setup();await x.browser.open(selection,bounds);x.native.placeBrowser.mockRejectedValue(new Error('failed'));
  x.browser.place(bounds,true);await vi.waitFor(()=>expect(x.failed).toHaveBeenCalledWith('BROWSER_PLACEMENT_FAILED'),{timeout:2000});
  expect(x.session.closeOrder).toHaveBeenCalledWith(12);expect(x.native.placeBrowser).toHaveBeenCalledTimes(4);
 });
});
