import {afterEach,describe,expect,it,vi} from 'vitest';
import {vendorOwnerPID,watchVendorOwner} from '../electron/vendor-owner';
const owner={pid:42,executable:'/Applications/旅游商家桌面版.app/Contents/MacOS/旅游商家桌面版',startedAt:'2026-10-16T00:00:00Z'};
afterEach(()=>vi.useRealTimers());
describe('automatic companion process lifetime',()=>{
  it('accepts exactly one explicit owner PID',()=>{
    expect(vendorOwnerPID(['--acceptance'])).toBeUndefined();expect(vendorOwnerPID(['--vendor-owner=42'])).toBe(42);
    for(const args of [['--vendor-owner=0'],['--vendor-owner=42','--vendor-owner=43'],['--vendor-owner=42oops']])expect(()=>vendorOwnerPID(args)).toThrow('INVALID_VENDOR_OWNER');
  });
  it('refuses an unrelated owner and quits once after PID reuse',async()=>{
    vi.useFakeTimers();const exit=vi.fn(),inspect=vi.fn(async()=>({...owner}));
    await expect(watchVendorOwner(42,inspect,'/other',exit)).rejects.toThrow('INVALID_VENDOR_OWNER');
    const stop=await watchVendorOwner(42,inspect,owner.executable,exit);
    await vi.advanceTimersByTimeAsync(1000);expect(exit).not.toHaveBeenCalled();
    inspect.mockResolvedValue({...owner,startedAt:'2026-10-16T00:01:00Z'});
    await vi.advanceTimersByTimeAsync(3000);expect(exit).toHaveBeenCalledOnce();stop();
  });
  it('quits after disappearance and cancels pending checks on cleanup',async()=>{
    vi.useFakeTimers();const exit=vi.fn(),inspect=vi.fn(async()=>({...owner}));
    const stop=await watchVendorOwner(42,inspect,owner.executable,exit);stop();
    await vi.advanceTimersByTimeAsync(3000);expect(inspect).toHaveBeenCalledOnce();
    await watchVendorOwner(42,inspect,owner.executable,exit);inspect.mockRejectedValue(new Error('gone'));
    await vi.advanceTimersByTimeAsync(2000);expect(exit).toHaveBeenCalledOnce();
  });
});
