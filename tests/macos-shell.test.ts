import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const fake=vi.hoisted(()=>{
  const handlers=new Map<string,(event:any,value?:unknown)=>any>(),appEvents=new Map<string,Function>(),windows:any[]=[],menu:any[]=[];
  const contents=()=>({mainFrame:{url:''},session:{setPermissionCheckHandler:vi.fn(),setPermissionRequestHandler:vi.fn(),on:vi.fn(),webRequest:{onBeforeRequest:vi.fn()}},send:vi.fn(),on:vi.fn(),setWindowOpenHandler:vi.fn()});
  class Window{
    events=new Map<string,Function>();webContents=contents();visible=false;destroyed=false;bounds={x:0,y:0,width:360,height:480};
    constructor(public options:any){windows.push(this);}on(name:string,fn:Function){this.events.set(name,fn);}isDestroyed(){return this.destroyed;}getBounds(){return this.bounds;}setBounds(value:any){this.bounds=value;}
    isMinimized(){return false;}restore(){}minimize(){}show(){this.visible=true;}focus(){}destroy(){this.destroyed=true;this.events.get('closed')?.();}getNativeWindowHandle(){return Buffer.from([1,0,0,0,0,0,0,0]);}
    loadFile(path:string,options:any){this.webContents.mainFrame.url=pathToFileURL(path).href+'#'+options.hash;return Promise.resolve();}
  }
  const app={disableHardwareAcceleration:vi.fn(),requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),on:(name:string,fn:Function)=>appEvents.set(name,fn),getAppPath:()=>'/project',getPath:()=>'/test-user-data',isPackaged:false,quit:vi.fn(),exit:vi.fn(),focus:vi.fn(),setActivationPolicy:vi.fn(),dock:{hide:vi.fn()}};
  const service={getState:vi.fn(()=>({attached:false,auth:'ready',phase:'idle',preview:null})),getOrderStatus:vi.fn(()=>'idle'),setWindowState:vi.fn(),onState:vi.fn(),setNativeStatus:vi.fn(),connectComposer:vi.fn(async()=>{}),dispose:vi.fn(async()=>{}),refreshSession:vi.fn(async()=>{})};
  const native={start:vi.fn(),stop:vi.fn(),list:vi.fn(async()=>[] as {targetInstanceId:string}[]),setCompanionWindows:vi.fn(async()=>{})};
  const resident={dispose:vi.fn(),setBound:vi.fn(),start:vi.fn(),notifyTargetAvailable:vi.fn(),connect:vi.fn(async(resolveTarget:(current:()=>boolean)=>Promise<string>)=>{resident.target=await resolveTarget(()=>true);}),disconnect:vi.fn(),target:''};
  return{handlers,appEvents,windows,menu,Window,app,service,native,resident,helperPath:'',bitmap:undefined as undefined|{pixels:Buffer;options:any},tray:{setToolTip:vi.fn(),setContextMenu:vi.fn(),on:vi.fn(),destroy:vi.fn()},trays:0,startExternalClient:vi.fn(async()=>4242),spawn:vi.fn()};
});
vi.mock('electron',()=>({app:fake.app,BrowserWindow:fake.Window,ipcMain:{handle:(name:string,handler:any)=>fake.handlers.set(name,handler)},shell:{openExternal:vi.fn()},clipboard:{writeText:vi.fn()},screen:{getDisplayMatching:()=>({workArea:{x:0,y:0,width:1440,height:900}})},Tray:class{constructor(){fake.trays++;return fake.tray;}},Menu:{buildFromTemplate:(items:any[])=>{fake.menu.splice(0,fake.menu.length,...items);return items;}},nativeImage:{createFromBitmap:(pixels:Buffer,options:any)=>{fake.bitmap={pixels,options};return{};}}}));
vi.mock('../electron/native-adapter',()=>({NativeAdapter:class{constructor(path:string){fake.helperPath=path;return fake.native;}}}));
vi.mock('../electron/companion-service',()=>({CompanionService:class{constructor(){return fake.service;}}}));
vi.mock('../electron/resident-connection',()=>({ResidentConnection:class{constructor(){return fake.resident;}}}));
vi.mock('../electron/external-composer',()=>({startExternalClient:fake.startExternalClient}));
vi.mock('../runtime/platform',()=>({createLaunchPlatform:()=>({processIdentity:async(pid:number)=>({pid,executable:'C:\\Program Files\\vbk-electron\\旅游商家桌面版.exe',startedAt:`start-${pid}`})})}));
vi.mock('node:child_process',async importOriginal=>({...await importOriginal<typeof import('node:child_process')>(),spawn:fake.spawn}));
const platform=Object.getOwnPropertyDescriptor(process,'platform')!;
const tick=()=>new Promise<void>(done=>setImmediate(done));
async function boot(os:NodeJS.Platform,packaged=false){
  vi.resetModules();vi.clearAllMocks();fake.handlers.clear();fake.appEvents.clear();fake.windows.length=0;fake.menu.length=0;fake.bitmap=undefined;fake.trays=0;fake.resident.target='';
  fake.app.isPackaged=packaged;Object.defineProperty(process,'platform',{...platform,value:os});(process as {resourcesPath?:string}).resourcesPath='/Bundle/Contents/Resources';
  vi.stubGlobal('__dirname',resolve('dist-electron'));await import('../electron/main');await tick();
}
async function settings(){fake.menu.find(item=>item.label==='打开连接设置')?.click();await tick();const window=fake.windows.filter(item=>!item.isDestroyed()).at(-1);return{window,event:{sender:window.webContents,senderFrame:window.webContents.mainFrame}};}
const invoke=(event:unknown,name:string,value?:unknown)=>fake.handlers.get('standalone:'+name)!(event,value);
function windowsBitmap(){const pixels=Buffer.alloc(20*20*4);for(let y=0;y<20;y++)for(let x=0;x<20;x++){const letter=y>=5&&y<=7&&x>=4&&x<=15||y>=7&&y<=15&&x>=8&&x<=11;pixels.set(letter?[255,255,255,255]:[190,100,30,255],(y*20+x)*4);}return pixels;}
afterEach(()=>{Object.defineProperty(process,'platform',platform);delete (process as {resourcesPath?:string}).resourcesPath;vi.unstubAllGlobals();});

describe('macOS tray-resident Electron shell',()=>{
  it('accepts automatic owner handoff without opening settings',async()=>{
    await boot('darwin');
    fake.appEvents.get('second-instance')?.({},['helper','--vendor-owner=42']);await tick();
    fake.appEvents.get('second-instance')?.({},['helper','--vendor-owner=43']);await tick();
    expect(fake.windows).toHaveLength(0);expect(fake.app.quit).not.toHaveBeenCalled();
    fake.appEvents.get('before-quit')?.({preventDefault(){}});await tick();
    expect(fake.service.dispose).toHaveBeenCalledOnce();
  });
  it('never opens or reopens settings on activation or repeated launches',async()=>{
    await boot('win32');
    fake.appEvents.get('activate')?.();
    fake.appEvents.get('second-instance')?.({},['helper']);await tick();
    expect(fake.windows).toHaveLength(0);
    const {window,event}=await settings();expect(window.visible).toBe(true);
    invoke(event,'close');
    fake.appEvents.get('activate')?.();
    fake.appEvents.get('second-instance')?.({},['helper']);
    fake.appEvents.get('second-instance')?.({},['helper','--vendor-owner=42']);await tick();
    expect(fake.windows.filter(item=>!item.isDestroyed())).toHaveLength(0);
  });
  it('hides the Dock and menu bar icons while starting resident auto-binding',async()=>{
    await boot('darwin');
    expect(fake.app.dock.hide).toHaveBeenCalledOnce();expect(fake.app.disableHardwareAcceleration).not.toHaveBeenCalled();
    expect(fake.helperPath).toBe(join('/project','native/macos/bin/TravelMerchant.WindowHelper'));
    expect(fake.native.start).toHaveBeenCalledOnce();expect(fake.resident.start).toHaveBeenCalledOnce();expect(fake.service.setNativeStatus).not.toHaveBeenCalledWith('windows_required');
    expect(fake.app.setActivationPolicy).toHaveBeenCalledWith('accessory');expect(fake.trays).toBe(0);expect(fake.bitmap).toBeUndefined();
    fake.appEvents.get('activate')?.();fake.appEvents.get('window-all-closed')?.();expect(fake.windows).toHaveLength(0);expect(fake.app.quit).not.toHaveBeenCalled();
    expect(fake.menu).toHaveLength(0);
  });
  it('uses the packaged helper inside Contents/Resources',async()=>{
    await boot('darwin',true);expect(fake.helperPath).toBe(join('/Bundle/Contents/Resources','native/macos/TravelMerchant.WindowHelper'));
  });
  it('starts the client through the shared launcher and binds only the new pid window',async()=>{
    await boot('win32');const {event}=await settings();
    fake.native.list.mockResolvedValueOnce([{targetInstanceId:'99:1700000000000:5'},{targetInstanceId:'4242:1700000000123:77'}]);
    await invoke(event,'start-client');expect(fake.startExternalClient).toHaveBeenCalledOnce();expect(fake.resident.target).toBe('4242:1700000000123:77');
    await invoke(event,'bind-window','4242:1700000000123:77');expect(fake.resident.connect).toHaveBeenCalledTimes(2);
    await expect(invoke(event,'bind-window','4242:1700000000.123:77')).rejects.toThrow('INVALID_TARGET');
  });
});

describe('platform gating outside macOS',()=>{
  it('keeps the Windows helper path, 20px tray bitmap, hardware-acceleration and companion registration',async()=>{
    await boot('win32');
    expect(fake.app.disableHardwareAcceleration).toHaveBeenCalledOnce();expect(fake.app.dock.hide).not.toHaveBeenCalled();
    expect(fake.helperPath).toBe(join('/project','native/windows/bin/publish/TravelMerchant.WindowHelper.exe'));
    expect(fake.bitmap?.options).toEqual({width:20,height:20,scaleFactor:1});expect(fake.bitmap?.pixels.equals(windowsBitmap())).toBe(true);
    await settings();expect(fake.app.focus).not.toHaveBeenCalled();expect(fake.native.setCompanionWindows).toHaveBeenLastCalledWith(['1']);
    fake.appEvents.get('window-all-closed')?.();expect(fake.app.quit).not.toHaveBeenCalled();
  });
  it('uses the packaged Windows helper path unchanged',async()=>{
    await boot('win32',true);expect(fake.helperPath).toBe(join('/Bundle/Contents/Resources','native/windows/TravelMerchant.WindowHelper.exe'));
  });
  it('reports windows_required and starts nothing on other platforms',async()=>{
    await boot('linux');
    expect(fake.service.setNativeStatus).toHaveBeenCalledWith('windows_required');expect(fake.native.start).not.toHaveBeenCalled();expect(fake.trays).toBe(0);
    expect(fake.startExternalClient).not.toHaveBeenCalled();
    fake.appEvents.get('window-all-closed')?.();expect(fake.app.quit).toHaveBeenCalled();
  });
});

describe('owned login opener',()=>{
  const login=`http://127.0.0.1:34567/auth/${'a'.repeat(64)}`;
  async function client(os:NodeJS.Platform){
    vi.resetModules();vi.clearAllMocks();Object.defineProperty(process,'platform',{...platform,value:os});
    const opener=new EventEmitter() as EventEmitter&{unref:()=>void};opener.unref=vi.fn();fake.spawn.mockImplementation(()=>{setImmediate(()=>opener.emit('spawn'));return opener;});
    const child=Object.assign(new EventEmitter(),{connected:true,send:(_message:unknown,callback?:(error:Error|null)=>void)=>callback?.(null),disconnect:vi.fn()});
    const {OwnedAuthClient}=await import('../runtime/auth-client');
    const owned=new OwnedAuthClient({executable:'owned-node',workerEntry:'owned-runtime.cjs',spawn:(()=>child) as unknown as typeof spawn});
    const started=owned.start();child.emit('message',{type:'ready',loginURL:login});child.emit('message',{type:'auth',identity:null});await started;
    return{owned,opener};
  }
  it('opens the validated loopback login URL with /usr/bin/open on macOS',async()=>{
    const {owned,opener}=await client('darwin');
    try{await owned.openLogin();expect(fake.spawn).toHaveBeenCalledExactlyOnceWith('/usr/bin/open',[login],{shell:false,detached:true,stdio:'ignore'});expect(opener.unref).toHaveBeenCalledOnce();}finally{owned.dispose();}
  });
  it('keeps rundll32 on Windows and refuses other platforms without an opener',async()=>{
    const windows=await client('win32');
    try{await windows.owned.openLogin();expect(fake.spawn).toHaveBeenCalledExactlyOnceWith('rundll32.exe',['url.dll,FileProtocolHandler',login],{shell:false,detached:true,windowsHide:true,stdio:'ignore'});}finally{windows.owned.dispose();}
    const other=await client('linux');
    try{await expect(other.owned.openLogin()).rejects.toThrow('OWNED_LOGIN_OPENER_REQUIRED');expect(fake.spawn).not.toHaveBeenCalled();}finally{other.owned.dispose();}
  });
});
