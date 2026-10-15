import{describe,it,expect,vi}from'vitest';
import{EventEmitter}from'node:events';
const mocks=vi.hoisted(()=>({spawn:vi.fn(),execFile:Object.assign(vi.fn(),{[Symbol.for('nodejs.util.promisify.custom')]:async()=>({stdout:JSON.stringify({pid:77,startedAt:'2026-10-14T09:00:00Z',executable:'C:\\Program Files\\vbk-electron\\旅游商家桌面版.exe'}),stderr:''})})}));
vi.mock('node:child_process',()=>mocks);
import{WindowsLaunchPlatform}from'../../runtime/windows-platform';
import{VERIFIED_RUNTIME_BUILD}from'../../runtime/identity';
describe('Windows original-process independence, fake child only',()=>{
  it('requests a detached visible GUI with independent stdio and unrefs its parent handle',async()=>{const child=Object.assign(new EventEmitter(),{pid:77,unref:vi.fn()});mocks.spawn.mockImplementation(()=>{queueMicrotask(()=>child.emit('spawn'));return child;});const platform=new WindowsLaunchPlatform();await platform.spawnOriginal(VERIFIED_RUNTIME_BUILD.executable,['--remote-debugging-port=19321'],{shell:false,modifyEnvironment:false});expect(mocks.spawn).toHaveBeenCalledWith(VERIFIED_RUNTIME_BUILD.executable,['--remote-debugging-port=19321'],{shell:false,detached:true,windowsHide:false,stdio:'ignore'});expect(child.unref).toHaveBeenCalledOnce();});
});
