import {afterEach,describe,expect,it,vi} from 'vitest';
import {ResidentConnection} from '../electron/resident-connection';
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};};
function fixture(){
  const adapter={list:vi.fn(async()=>[] as {targetInstanceId:string}[]),bind:vi.fn(async(_id:string)=>{}),unbind:vi.fn(async()=>{})};
  const before=vi.fn(async()=>{}),bound=vi.fn();
  return{adapter,before,bound,resident:new ResidentConnection(adapter,before,2000,bound)};
}
afterEach(()=>vi.useRealTimers());
describe('resident connection lifecycle',()=>{
  it('uses a quiet 30-second fallback and stops its timer once bound',async()=>{
    vi.useFakeTimers();const {adapter,before}=fixture(),resident=new ResidentConnection(adapter,before);
    resident.start();await vi.advanceTimersByTimeAsync(0);expect(adapter.list).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(29999);expect(adapter.list).toHaveBeenCalledOnce();
    adapter.list.mockResolvedValue([{targetInstanceId:'available'}]);await vi.advanceTimersByTimeAsync(1);
    expect(adapter.bind).toHaveBeenCalledExactlyOnceWith('available');expect(vi.getTimerCount()).toBe(0);
    resident.notifyTargetAvailable();await vi.advanceTimersByTimeAsync(90000);expect(adapter.list).toHaveBeenCalledTimes(2);
    resident.setBound(false);await vi.advanceTimersByTimeAsync(0);expect(adapter.bind).toHaveBeenCalledTimes(2);resident.dispose();
  });
  it('debounces native target arrival for 150ms and ignores notifications while paused or disposed',async()=>{
    vi.useFakeTimers();const {adapter,before}=fixture(),resident=new ResidentConnection(adapter,before);
    resident.notifyTargetAvailable();expect(vi.getTimerCount()).toBe(0);resident.start();await vi.advanceTimersByTimeAsync(0);
    resident.notifyTargetAvailable();await vi.advanceTimersByTimeAsync(100);resident.notifyTargetAvailable();
    await vi.advanceTimersByTimeAsync(149);expect(adapter.list).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);expect(adapter.list).toHaveBeenCalledTimes(2);
    await resident.disconnect();resident.notifyTargetAvailable();await vi.advanceTimersByTimeAsync(30000);expect(adapter.list).toHaveBeenCalledTimes(2);
    resident.dispose();resident.notifyTargetAvailable();expect(vi.getTimerCount()).toBe(0);
  });

  it('waits quietly, selects the first prioritized client and reconnects after loss',async()=>{
    const {adapter,resident,bound}=fixture();
    await resident.discover();expect(adapter.bind).not.toHaveBeenCalled();
    adapter.list.mockResolvedValue([{targetInstanceId:'one'},{targetInstanceId:'two'}]);await resident.discover();
    expect(adapter.bind).toHaveBeenCalledExactlyOnceWith('one');
    adapter.list.mockResolvedValue([{targetInstanceId:'late'}]);await resident.discover();
    expect(adapter.bind).toHaveBeenCalledOnce();expect(bound).toHaveBeenCalledOnce();
    resident.setBound(false);await resident.discover();expect(adapter.bind).toHaveBeenCalledTimes(2);resident.dispose();
  });
  it('tries the next eligible client if the preferred window disappears during binding',async()=>{
    const {adapter,resident}=fixture();
    adapter.list.mockResolvedValue([{targetInstanceId:'gone'},{targetInstanceId:'available'}]);
    adapter.bind.mockRejectedValueOnce(new Error('target_lost'));
    await resident.discover();
    expect(adapter.bind.mock.calls).toEqual([['gone'],['available']]);resident.dispose();
  });
  it('does not overlap polls or schedule another poll after disposal',async()=>{
    vi.useFakeTimers();const {adapter,resident}=fixture(),pending=deferred<{targetInstanceId:string}[]>();
    adapter.list.mockReturnValue(pending.promise);resident.start();
    await vi.advanceTimersByTimeAsync(20000);await resident.discover();expect(adapter.list).toHaveBeenCalledOnce();
    resident.dispose();pending.resolve([{targetInstanceId:'old'}]);await vi.advanceTimersByTimeAsync(20000);
    expect(adapter.list).toHaveBeenCalledOnce();expect(adapter.bind).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });
  it('manual disconnect cancels pending discovery and suspends automatic binding until manual connect',async()=>{
    const {adapter,resident}=fixture(),pending=deferred<{targetInstanceId:string}[]>();adapter.list.mockReturnValueOnce(pending.promise);
    const discovery=resident.discover();await resident.disconnect();pending.resolve([{targetInstanceId:'stale'}]);await discovery;
    await resident.discover();expect(adapter.bind).not.toHaveBeenCalled();expect(adapter.list).toHaveBeenCalledOnce();
    await resident.connect(async()=> 'manual');expect(adapter.bind).toHaveBeenCalledExactlyOnceWith('manual');
    resident.setBound(false);adapter.list.mockResolvedValue([{targetInstanceId:'restarted'}]);await resident.discover();expect(adapter.bind).toHaveBeenLastCalledWith('restarted');resident.dispose();
  });
  it('a delayed launch cannot replace a later explicit binding',async()=>{
    const {adapter,resident}=fixture(),launch=deferred<string>();
    const old=resident.connect(()=>launch.promise).catch(error=>error.message);
    await resident.connect(async()=> 'selected');launch.resolve('launched');
    expect(await old).toBe('CONNECTION_SUPERSEDED');expect(adapter.bind).toHaveBeenCalledExactlyOnceWith('selected');resident.dispose();
  });
  it('serializes an in-flight old bind before a newer disconnect and ignores stale completion',async()=>{
    const {adapter,resident,bound}=fixture(),binding=deferred<void>();
    adapter.list.mockResolvedValue([{targetInstanceId:'old'}]);adapter.bind.mockReturnValueOnce(binding.promise);
    const discovery=resident.discover();await vi.waitFor(()=>expect(adapter.bind).toHaveBeenCalledOnce());
    const disconnect=resident.disconnect();expect(adapter.unbind).not.toHaveBeenCalled();binding.resolve();await Promise.all([discovery,disconnect]);
    expect(adapter.unbind).toHaveBeenCalledOnce();expect(bound).not.toHaveBeenCalled();await resident.discover();expect(adapter.bind).toHaveBeenCalledOnce();resident.dispose();
  });
  it('invalidates launch and queued binding when quitting',async()=>{
    const {adapter,resident}=fixture(),launch=deferred<string>();
    const result=resident.connect(()=>launch.promise).catch(error=>error.message);resident.dispose();launch.resolve('late');
    expect(await result).toBe('CONNECTION_SUPERSEDED');expect(adapter.bind).not.toHaveBeenCalled();
  });
  it('rejects a new launch after disposal before executing any launch side effect',async()=>{
    const {resident,adapter}=fixture(),launch=vi.fn(async()=> 'late');resident.dispose();
    await expect(resident.connect(launch)).rejects.toThrow('CONNECTION_SUPERSEDED');
    expect(launch).not.toHaveBeenCalled();expect(adapter.bind).not.toHaveBeenCalled();
  });
  it('does not overwrite native target loss with an older bind acknowledgement',async()=>{
    const {adapter,resident,bound}=fixture(),binding=deferred<void>();
    adapter.list.mockResolvedValue([{targetInstanceId:'lost'}]);adapter.bind.mockReturnValueOnce(binding.promise);
    const discovery=resident.discover();await vi.waitFor(()=>expect(adapter.bind).toHaveBeenCalledOnce());
    resident.setBound(false);binding.resolve();await discovery;expect(bound).not.toHaveBeenCalled();
    adapter.list.mockResolvedValue([{targetInstanceId:'restarted'}]);await resident.discover();
    expect(adapter.bind).toHaveBeenLastCalledWith('restarted');expect(bound).toHaveBeenCalledOnce();resident.dispose();
  });
  it('keeps discovery enabled after loss during a manually requested bind',async()=>{
    const {adapter,resident}=fixture();
    adapter.bind.mockImplementationOnce(async()=>{resident.setBound(false);});
    await resident.connect(async()=> 'lost');
    adapter.list.mockResolvedValue([{targetInstanceId:'replacement'}]);await resident.discover();
    expect(adapter.bind).toHaveBeenLastCalledWith('replacement');resident.dispose();
  });
});
