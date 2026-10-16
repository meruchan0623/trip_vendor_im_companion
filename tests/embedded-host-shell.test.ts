import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const fake=vi.hoisted(()=>{
  const handlers=new Map<string,(event:any,value?:unknown)=>any>(),appEvents=new Map<string,Function>(),windows:any[]=[],menu:any[]=[];
  const contents=()=>({mainFrame:{url:''},session:{setPermissionCheckHandler:vi.fn(),setPermissionRequestHandler:vi.fn(),on:vi.fn(),webRequest:{onBeforeRequest:vi.fn()}},send:vi.fn(),on:vi.fn(),setWindowOpenHandler:vi.fn()});
  class Window{
    events=new Map<string,Function>();webContents=contents();visible=false;destroyed=false;minimized=false;bounds={x:0,y:0,width:360,height:480};
    constructor(public options:any){windows.push(this);}on(name:string,fn:Function){this.events.set(name,fn);}isDestroyed(){return this.destroyed;}getBounds(){return this.bounds;}setBounds(value:any){this.bounds=value;}
    isMinimized(){return this.minimized;}minimize(){this.minimized=true;}restore(){this.minimized=false;}show(){this.visible=true;}focus(){this.events.get('focus')?.();}
    destroy(){this.destroyed=true;this.visible=false;this.events.get('closed')?.();}getNativeWindowHandle(){return Buffer.from([1,0,0,0,0,0,0,0]);}
    loadFile(path:string,options:any){this.webContents.mainFrame.url=pathToFileURL(path).href+'#'+options.hash;return fake.delay??Promise.resolve();}
  }
  let state:any=null,stateCallback:(state:any)=>void=()=>{};
  const service={getState:vi.fn(()=>({attached:!!state,auth:'ready',phase:'idle',preview:null})),setWindowState:vi.fn((value:any)=>{state=value;}),onState:vi.fn(),setNativeStatus:vi.fn(),connectComposer:vi.fn(async()=>{}),dispose:vi.fn(async()=>{}),refreshSession:vi.fn(async()=>{}),readDraft:vi.fn(),translate:vi.fn(),setTranslationOptions:vi.fn(),cancelTranslation:vi.fn(),resumeTranslation:vi.fn(),replaceDraft:vi.fn(),openLogin:vi.fn(),logout:vi.fn()};
  const native={start:vi.fn(),stop:vi.fn(),list:vi.fn(async()=>[]),bind:vi.fn(async()=>{}),unbind:vi.fn(async()=>{}),setCompanionWindows:vi.fn(async()=>{})};
  const input={on:vi.fn(),close:vi.fn()};
  return{handlers,appEvents,windows,menu,Window,service,native,input,createInput:vi.fn((_options:unknown)=>input),delay:undefined as Promise<void>|undefined,setStateCallback:(fn:any)=>stateCallback=fn,emitState:(value:any)=>stateCallback(value),resident:{dispose:vi.fn(),setBound:vi.fn(),start:vi.fn(),notifyTargetAvailable:vi.fn(),connect:vi.fn(),disconnect:vi.fn()},tray:{setToolTip:vi.fn(),setContextMenu:vi.fn(),on:vi.fn(),destroy:vi.fn()},quit:vi.fn()};
});
vi.mock('node:readline',()=>({createInterface:fake.createInput}));
vi.mock('electron',()=>({app:{disableHardwareAcceleration:vi.fn(),requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),on:(name:string,fn:Function)=>fake.appEvents.set(name,fn),getAppPath:()=>process.cwd(),isPackaged:false,quit:fake.quit,exit:vi.fn(),focus:vi.fn(),dock:{hide:vi.fn()}},BrowserWindow:fake.Window,ipcMain:{handle:(name:string,handler:any)=>fake.handlers.set(name,handler)},shell:{openExternal:vi.fn()},clipboard:{writeText:vi.fn()},screen:{getDisplayMatching:()=>({workArea:{x:0,y:0,width:320,height:400}})},Tray:class{constructor(){return fake.tray;}},Menu:{buildFromTemplate:(items:any[])=>{fake.menu.splice(0,fake.menu.length,...items);return items;}},nativeImage:{createFromBitmap:()=>({})}}));
vi.mock('../electron/native-adapter',()=>({NativeAdapter:class{constructor(_path:string,onState:any){fake.setStateCallback(onState);return fake.native;}}}));
vi.mock('../electron/companion-service',()=>({CompanionService:class{constructor(){return fake.service;}}}));
vi.mock('../electron/resident-connection',()=>({ResidentConnection:class{constructor(){return fake.resident;}}}));
vi.mock('../electron/external-composer',()=>({startExternalClient:vi.fn()}));
const current=()=>fake.windows.filter(window=>!window.isDestroyed()).at(-1);
const event=(window=current())=>({sender:window.webContents,senderFrame:window.webContents.mainFrame});
const invoke=(name:string,value?:unknown,source=event())=>fake.handlers.get('standalone:'+name)!(source,value);
const tick=()=>new Promise<void>(done=>setImmediate(done));
async function open(){fake.menu.find(item=>item.label==='打开连接设置')?.click();await tick();return current();}
const originalPlatform=Object.getOwnPropertyDescriptor(process,'platform')!;
afterAll(()=>Object.defineProperty(process,'platform',originalPlatform));
beforeAll(async()=>{Object.defineProperty(process,'platform',{...originalPlatform,value:'win32'});vi.stubGlobal('__dirname',resolve('dist-electron'));await import('../electron/main');await tick();});
afterEach(()=>{fake.delay=undefined;if(current())invoke('close');});
describe('embedded desktop settings shell',()=>{
  it('creates no daily business window at startup or on native geometry notifications',()=>{
    expect(fake.createInput).not.toHaveBeenCalled();
    expect(fake.windows).toHaveLength(0);fake.emitState({targetInstanceId:'1:2:3',visible:true,minimized:false,foreground:true,groupForeground:true,bounds:{x:10,y:20,width:800,height:600}});
    fake.emitState({targetInstanceId:'1:2:3',visible:true,minimized:false,foreground:true,groupForeground:true,bounds:{x:200,y:200,width:900,height:700}});
    expect(fake.windows).toHaveLength(0);expect(fake.service.connectComposer).toHaveBeenCalledOnce();
  });
  it('opens only sandboxed settings and clamps them inside the monitor',async()=>{
    const window=await open();expect(window.options).toMatchObject({title:'翻译设置',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}});expect(window.bounds).toEqual({x:0,y:0,width:320,height:400});expect(window.visible).toBe(true);
    expect(fake.service.refreshSession).toHaveBeenCalled();
  });
  it('rejects remote, child-frame and closed-renderer IPC',async()=>{
    const window=await open(),source=event(window),url=window.webContents.mainFrame.url;
    expect(()=>invoke('state',undefined,{sender:source.sender,senderFrame:{url}})).toThrow('UNAUTHORIZED_RENDERER');
    window.webContents.mainFrame.url='https://example.com/#settings';expect(()=>invoke('state',undefined,source)).toThrow('UNAUTHORIZED_RENDERER');window.webContents.mainFrame.url=url;
    invoke('close');expect(()=>invoke('state',undefined,source)).toThrow('UNAUTHORIZED_RENDERER');
  });
  it('shares a concurrent settings load and cannot revive a window closed before loading finishes',async()=>{
    let release!:()=>void;fake.delay=new Promise<void>(done=>release=done);fake.menu.find(item=>item.label==='打开连接设置')?.click();fake.menu.find(item=>item.label==='打开连接设置')?.click();const window=current();
    expect(fake.windows.filter(item=>!item.isDestroyed())).toHaveLength(1);expect(window.visible).toBe(false);
    invoke('close');release();await tick();expect(window.isDestroyed()).toBe(true);expect(window.visible).toBe(false);expect(current()).toBeUndefined();
  });
  it('closing settings keeps the native client and authenticated host running',async()=>{
    await open();const stops=fake.native.stop.mock.calls.length,disposals=fake.service.dispose.mock.calls.length;invoke('close');
    expect(fake.native.stop).toHaveBeenCalledTimes(stops);expect(fake.service.dispose).toHaveBeenCalledTimes(disposals);expect(fake.quit).not.toHaveBeenCalled();
  });
  it('discards a failed settings load so the next tray action can retry',async()=>{
    fake.delay=Promise.reject(new Error('load failed'));const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{fake.menu.find(item=>item.label==='打开连接设置')?.click();await tick();expect(current()).toBeUndefined();fake.delay=undefined;await open();expect(current().visible).toBe(true);}finally{log.mockRestore();}
  });
  it('refuses the old external order flow and never creates another business window',async()=>{
    await open();const count=fake.windows.length;expect(()=>invoke('open-order',{identifier:'000123',type:'order_number'})).toThrow('USE_EMBEDDED_ORDER_PANEL');await invoke('open-translation');expect(fake.windows).toHaveLength(count);expect(current().options.title).toBe('翻译设置');
  });
  it('keeps tray access and explicitly disposes the host and helper when the assistant quits',async()=>{
    if(process.platform==='win32'||process.platform==='darwin')expect(fake.menu.map(item=>item.label)).toContain('打开连接设置');
    const preventDefault=vi.fn();fake.appEvents.get('before-quit')?.({preventDefault});await tick();expect(preventDefault).toHaveBeenCalled();expect(fake.resident.dispose).toHaveBeenCalledOnce();expect(fake.service.dispose).toHaveBeenCalledOnce();expect(fake.native.stop).toHaveBeenCalledOnce();expect(fake.quit).toHaveBeenCalled();
  });
});

describe('acceptance-only graceful shutdown',()=>{
  it('accepts exactly one quit line without echoing stdin and uses the normal cleanup path',async()=>{
    vi.resetModules();const originalArgs=process.argv;process.argv=[...originalArgs,'--acceptance'];
    const log=vi.spyOn(console,'log').mockImplementation(()=>{}),quitCalls=fake.quit.mock.calls.length,disposeCalls=fake.service.dispose.mock.calls.length;
    try{
      await import('../electron/main');await tick();expect(fake.createInput).toHaveBeenCalledOnce();
      expect(fake.createInput.mock.calls[0]?.[0]).toMatchObject({input:process.stdin,terminal:false});
      const line=fake.input.on.mock.calls.find(call=>call[0]==='line')?.[1] as (value:string)=>void;
      line('secret-do-not-log');line(' quit ');expect(fake.quit).toHaveBeenCalledTimes(quitCalls);expect(log).not.toHaveBeenCalled();
      line('quit');line('quit');expect(fake.quit).toHaveBeenCalledTimes(quitCalls+1);expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({event:'acceptance_quit_requested'}));
      fake.appEvents.get('before-quit')?.({preventDefault:vi.fn()});await tick();
      expect(fake.input.close).toHaveBeenCalledOnce();expect(fake.service.dispose).toHaveBeenCalledTimes(disposeCalls+1);
    }finally{process.argv=originalArgs;log.mockRestore();}
  });
});
