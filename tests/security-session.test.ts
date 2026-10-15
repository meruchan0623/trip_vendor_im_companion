import {describe,it,expect,vi} from 'vitest';
import {lockLocalSession} from '../electron/security';
const session=()=>({setPermissionCheckHandler:vi.fn(),setPermissionRequestHandler:vi.fn(),on:vi.fn(),webRequest:{onBeforeRequest:vi.fn()}});
describe('local renderer session security',()=>{
  it('installs security handlers once per shared Session across recreated windows',()=>{
    const shared=session(),other=session();
    for(let index=0;index<20;index++)lockLocalSession(shared as any);
    lockLocalSession(other as any);
    for(const value of [shared,other]){
      expect(value.setPermissionCheckHandler).toHaveBeenCalledOnce();expect(value.setPermissionRequestHandler).toHaveBeenCalledOnce();
      expect(value.on).toHaveBeenCalledExactlyOnceWith('will-download',expect.any(Function));expect(value.webRequest.onBeforeRequest).toHaveBeenCalledOnce();
    }
    expect(shared.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
    const permission=vi.fn();shared.setPermissionRequestHandler.mock.calls[0][0]({},'camera',permission);expect(permission).toHaveBeenCalledExactlyOnceWith(false);
    const preventDefault=vi.fn();shared.on.mock.calls[0][1]({preventDefault});expect(preventDefault).toHaveBeenCalledOnce();
    const filter=shared.webRequest.onBeforeRequest.mock.calls[0][0];
    for(const [url,cancel] of [['file:///local/index.html',false],['https://evil.test/',true],['http://127.0.0.1:3000/',true]] as const){const result=vi.fn();filter({url},result);expect(result).toHaveBeenCalledExactlyOnceWith({cancel});}
  });
});
