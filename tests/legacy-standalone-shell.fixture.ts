import { beforeAll,beforeEach,describe,it,expect,vi } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const fake=vi.hoisted(()=>{
  const conversion={workArea:{x:0,y:0,width:1920,height:1080},scale:1,displayId:1,toDip:(rect:any)=>rect,toPhysical:(rect:any)=>rect};
  const handlers=new Map<string,(event:any,value?:unknown)=>any>();const windows:any[]=[];const appEvents=new Map<string,Function>();
  const makeContents=()=>({mainFrame:{url:''},invalidate:vi.fn(),session:{setPermissionCheckHandler:vi.fn(),setPermissionRequestHandler:vi.fn(),on:vi.fn(),webRequest:{onBeforeRequest:vi.fn()}},send:vi.fn(),on:vi.fn(),setWindowOpenHandler:vi.fn()});
  class Window{webContents=makeContents();events=new Map<string,Function>();bounds={x:0,y:0,width:360,height:760};visible=false;destroyed=false;minimized=false;topmost=false;constructor(public options:any){windows.push(this);}getBounds(){return this.bounds;}setBounds=vi.fn((bounds:any)=>{this.bounds=bounds;});setPosition=vi.fn((x:number,y:number)=>{this.bounds={...this.bounds,x,y};});on(name:string,fn:Function){this.events.set(name,fn);}once(name:string,fn:Function){this.events.set(name,fn);}loadFile(path:string,options?:any){this.webContents.mainFrame.url=pathToFileURL(path).href+(options?.hash?'#'+options.hash:'');return Promise.resolve();}show(){this.visible=true;}isVisible(){return this.visible;}isAlwaysOnTop(){return this.topmost;}showInactive=vi.fn(()=>{this.visible=true;});hide=vi.fn(()=>{this.visible=false;});setAlwaysOnTop=vi.fn((value:boolean)=>{this.topmost=value;});setSkipTaskbar=vi.fn();isDestroyed(){return this.destroyed;}destroy=vi.fn(()=>{this.destroyed=true;this.visible=false;this.events.get('closed')?.();});isMinimized(){return this.minimized;}minimize(){this.minimized=true;}restore(){this.minimized=false;}focus(){this.events.get('focus')?.();}getNativeWindowHandle(){return Buffer.from([1,0,0,0,0,0,0,0]);}}
  const tray={setToolTip:vi.fn(),setContextMenu:vi.fn(),on:vi.fn(),destroy:vi.fn()}; const menu:any[]=[];
  const clipboard={writeText:vi.fn()};
  const native={start:vi.fn(),stop:vi.fn(),list:vi.fn(async()=>[]),bind:vi.fn(async()=>{}),unbind:vi.fn(async()=>{}),setCompanionWindows:vi.fn(async()=>{})};let nativeState:(state:any)=>void;
  const extra:any={orderEntries:[],orderViewport:{width:1000,height:700,dpr:1},messageSurface:{active:true,toolbarRect:{x:200,y:600,width:500,height:40}}};
  let listener:(state:any)=>void=()=>{};
  let surfaceRevision=0;
  const service={getSurfaceMeasurementRevision:()=>surfaceRevision,getState:vi.fn(()=>({attached:!!state,...extra})),getBrowserProfile:()=>({browserPath:'msedge.exe',profileDirectory:'Default'}),onState:vi.fn((fn:any)=>listener=fn),setWindowState:vi.fn((value:any)=>{state=value;listener(service.getState());}),setNativeStatus:vi.fn(),setBrowserOpen:vi.fn(),reportBrowserFailure:vi.fn(),connectComposer:vi.fn(),confirmOrderEntry:vi.fn(async()=>{}),readDraft:vi.fn(),translate:vi.fn(),setTranslationOptions:vi.fn(),cancelTranslation:vi.fn(),resumeTranslation:vi.fn(),replaceDraft:vi.fn(),openLogin:vi.fn(),logout:vi.fn(),refreshSession:vi.fn(async()=>{}),dispose:vi.fn()};let state:any;
  const orderStore={state:null as any,load:vi.fn(async()=>{}),update:vi.fn(),flush:vi.fn(async()=>{})};let windowMeasurement:(value:any)=>void;
  let browserFailure:(code:'BROWSER_PLACEMENT_FAILED')=>void;
  const browser={open:vi.fn(async(_selection:any,_bounds:any,_maximized=false)=>{}),close:vi.fn(async()=>{}),place:vi.fn(),ownsGeometry:vi.fn((_launchId:string)=>true),handleLost:vi.fn()};
  return{orderStore,setWindowMeasurement:(fn:any)=>windowMeasurement=fn,emitWindowMeasurement:(value:any)=>windowMeasurement(value),tray,menu,clipboard,conversion,setBrowserFailure:(fn:any)=>browserFailure=fn,failBrowser:()=>browserFailure('BROWSER_PLACEMENT_FAILED'),startup:[] as string[],handlers,appEvents,windows,Window,native,service,browser,setExtra:(value:any)=>{if('orderViewport'in value||'messageSurface'in value)surfaceRevision++;Object.assign(extra,value);listener(service.getState());},setNativeState:(fn:any)=>nativeState=fn,emit:(state:any)=>nativeState(state)};
});
vi.mock('electron',()=>({Tray:class{constructor(){return fake.tray;}},Menu:{buildFromTemplate:(items:any[])=>{fake.menu.splice(0,fake.menu.length,...items);return items;}},nativeImage:{createFromBitmap:vi.fn(()=>({}))},clipboard:fake.clipboard,app:{disableHardwareAcceleration:()=>fake.startup.push('software-rendering'),whenReady:()=>{fake.startup.push('ready');return Promise.resolve();},requestSingleInstanceLock:()=>true,on:vi.fn((name:string,handler:Function)=>{fake.appEvents.set(name,handler);}),getAppPath:()=>process.cwd(),getPath:()=>resolve('work/test-profile'),isPackaged:false,exit:vi.fn(),quit:vi.fn()},BrowserWindow:fake.Window,ipcMain:{handle:(name:string,fn:any)=>fake.handlers.set(name,fn)},screen:{getAllDisplays:()=>[{workArea:{x:0,y:0,width:1920,height:1080}}],getDisplayMatching:()=>({id:fake.conversion.displayId,scaleFactor:fake.conversion.scale,workArea:fake.conversion.workArea}),screenToDipRect:(_window:unknown,rect:unknown)=>fake.conversion.toDip(rect),dipToScreenRect:(_window:unknown,rect:unknown)=>fake.conversion.toPhysical(rect)},shell:{openExternal:vi.fn()}}));
vi.mock('../electron/native-adapter',()=>({NativeAdapter:class{constructor(_path:string,state:any,_availability:any,_lost:any,_geometry:any,measurement:any){fake.setNativeState(state);fake.setWindowMeasurement(measurement);return fake.native;}}}));
vi.mock('../electron/order-window-state',async importOriginal=>{const actual=await importOriginal<typeof import('../electron/order-window-state')>();return{...actual,OrderWindowStore:class{constructor(){return fake.orderStore;}}};});
vi.mock('../electron/companion-service',()=>({CompanionService:class{constructor(){return fake.service;}}}));
vi.mock('../electron/profile-browser',()=>({ProfileBrowser:class{constructor(_native:unknown,_session:unknown,failure:any){fake.setBrowserFailure(failure);return fake.browser;}}}));
const activeWindows=()=>fake.windows.filter(window=>!window.isDestroyed());
const panel=()=>activeWindows().find(window=>window.options.title==='翻译设置');
const composer=()=>activeWindows().find(window=>window.options.title==='消息翻译');
const entryWindow=(index=0)=>activeWindows().filter(window=>window.options.title==='订单标识')[index];
const rendererEvent=(window:any)=>({sender:window.webContents,senderFrame:window.webContents.mainFrame});
const panelEvent=()=>rendererEvent(panel()?.webContents.mainFrame.url.startsWith('file:')?panel():composer());
const orderEvent=()=>rendererEvent(composer());
function invoke(name:string,value?:unknown,event=panelEvent()){return fake.handlers.get(`standalone:${name}`)!(event,value);}
const state=(overrides={})=>({targetInstanceId:'1:2:3',bounds:{x:100,y:100,width:1000,height:800},visible:true,minimized:false,foreground:true,groupForeground:true,dpi:96,clientBounds:{x:100,y:100,width:1000,height:800},...overrides});
const nextFollow=()=>new Promise<void>(resolve=>setImmediate(resolve));
beforeAll(async()=>{vi.stubGlobal('__dirname',resolve('dist-electron'));await import('../electron/main');await vi.waitFor(()=>expect(activeWindows()).toHaveLength(1));});
beforeEach(async()=>{await nextFollow();vi.clearAllMocks();});
describe('standalone local window shell',()=>{
  it('starts with only the composer renderer and creates, destroys and recreates settings on demand',async()=>{
    composer().events.get('ready-to-show')!();fake.emit(null);
    expect(activeWindows()).toEqual([composer()]);expect(panel()).toBeUndefined();
    fake.setExtra({error:'composer_unavailable',composerSource:'unavailable'});expect(panel()).toBeUndefined();
    await invoke('open-settings');const first=panel();expect(first.visible).toBe(true);expect(first.bounds).toMatchObject({width:360,height:480});
    const oldEvent=rendererEvent(first);await invoke('close',undefined,oldEvent);
    expect(first.destroy).toHaveBeenCalledOnce();expect(first.isDestroyed()).toBe(true);expect(panel()).toBeUndefined();
    expect(()=>invoke('state',undefined,oldEvent)).toThrow('UNAUTHORIZED');
    fake.emit(null);await invoke('state');expect(panel()).toBeUndefined();
    await invoke('open-settings');expect(panel()).not.toBe(first);expect(panel().visible).toBe(true);
    await invoke('close');fake.setExtra({error:null,composerSource:undefined});
  });
  it('clears settings after an OS close and restores a fresh renderer from the tray',async()=>{
    fake.emit(null);await invoke('open-settings');const first=panel();first.destroy();
    expect(panel()).toBeUndefined();expect(()=>invoke('state',undefined,rendererEvent(first))).toThrow('UNAUTHORIZED');
    if(process.platform==='win32'){
      fake.menu.find(item=>item.label==='打开连接设置').click();await nextFollow();
      expect(panel()).not.toBe(first);expect(panel().visible).toBe(true);expect(fake.menu.find(item=>item.label==='退出助手')).toBeDefined();await invoke('close');
    }
  });
  it('clamps settings and translation windows into a small monitor work area',async()=>{
    fake.conversion.workArea={x:2000,y:100,width:320,height:400};
    try{
      await invoke('open-settings');expect(panel().bounds).toEqual({x:2000,y:100,width:320,height:400});
      await invoke('open-translation');expect(panel().bounds).toEqual({x:2000,y:100,width:320,height:400});
    }finally{await invoke('close');fake.conversion.workArea={x:0,y:0,width:1920,height:1080};}
  });
  it('shares a concurrent settings load and refreshes authentication when settings gains focus',async()=>{
    let release!:()=>void;const loading=new Promise<void>(resolve=>release=resolve);
    const load=vi.spyOn(fake.Window.prototype,'loadFile').mockImplementationOnce(()=>loading);
    try{
      const first=invoke('open-settings'),current=panel(),second=invoke('open-settings');
      expect(load).toHaveBeenCalledOnce();expect(panel()).toBe(current);expect(current.visible).toBe(false);
      expect(fake.service.refreshSession).not.toHaveBeenCalled();release();await Promise.all([first,second]);
      expect(current.visible).toBe(true);expect(fake.service.refreshSession).toHaveBeenCalledOnce();
      current.focus();expect(fake.service.refreshSession).toHaveBeenCalledTimes(2);
      fake.service.refreshSession.mockRejectedValueOnce(new Error('session unavailable'));current.focus();await nextFollow();
      expect(current.visible).toBe(true);
    }finally{release();load.mockRestore();await invoke('close');}
  });
  it('honors the latest settings navigation while translation is still loading in the same window',async()=>{
    await invoke('open-settings');const current=panel();
    const loads:{hash:string;commit:()=>void}[]=[];
    const load=vi.spyOn(current,'loadFile').mockImplementation((path:any,options?:any)=>new Promise<void>(resolve=>{
      loads.push({hash:options.hash,commit:()=>{current.webContents.mainFrame.url=pathToFileURL(path).href+'#'+options.hash;resolve();}});
    }));
    try{
      const translation=invoke('open-translation');expect(current.webContents.mainFrame.url).toMatch(/#settings$/);
      const settings=invoke('open-settings');expect(loads.map(item=>item.hash)).toEqual(['translation','settings']);
      loads[0]!.commit();await translation;expect(current.webContents.mainFrame.url).toMatch(/#translation$/);
      loads[1]!.commit();await settings;expect(panel()).toBe(current);expect(current.webContents.mainFrame.url).toMatch(/#settings$/);
      expect(current.bounds.height).toBe(480);expect(current.visible).toBe(true);
    }finally{for(const pending of loads)pending.commit();load.mockRestore();await invoke('close');}
  });
  it.each(['resolve','reject'] as const)('does not revive settings closed during a pending load that will %s',async outcome=>{
    let release!:()=>void,reject!:(reason:Error)=>void;
    const loading=new Promise<void>((done,fail)=>{release=done;reject=fail;});
    const load=vi.spyOn(fake.Window.prototype,'loadFile').mockImplementationOnce(()=>loading),error=vi.spyOn(console,'error').mockImplementation(()=>{});
    const opening=invoke('open-settings'),closed=panel();
    try{
      await invoke('close');expect(closed.isDestroyed()).toBe(true);expect(panel()).toBeUndefined();
      await invoke('open-settings');const replacement=panel();expect(replacement).not.toBe(closed);expect(replacement.visible).toBe(true);
      const refreshCount=fake.service.refreshSession.mock.calls.length;
      if(outcome==='resolve')release();else reject(new Error('ERR_ABORTED'));
      await opening;expect(panel()).toBe(replacement);expect(closed.visible).toBe(false);expect(replacement.visible).toBe(true);
      expect(fake.service.refreshSession).toHaveBeenCalledTimes(refreshCount);expect(error).not.toHaveBeenCalled();
    }finally{release();await opening;load.mockRestore();error.mockRestore();await invoke('close');}
  });
  it('selects the verified software renderer before Windows app readiness',()=>{
    if(process.platform==='win32')expect(fake.startup.slice(0,2)).toEqual(['software-rendering','ready']);
    else expect(fake.startup).toEqual(['ready']);
  });
  it('does not resize, re-show or restack overlays on repeated native polls and own focus',async()=>{
    fake.emit(state());
    const toolbar=composer();
    vi.clearAllMocks();
    for(let index=0;index<20;index++)fake.emit(state());
    toolbar.focus();
    expect(toolbar.setBounds).not.toHaveBeenCalled();
    expect(toolbar.showInactive).not.toHaveBeenCalled();
    expect(toolbar.hide).not.toHaveBeenCalled();
    expect(toolbar.setAlwaysOnTop).not.toHaveBeenCalled();
    expect(toolbar.webContents.invalidate).not.toHaveBeenCalled();
    expect(fake.service.setWindowState).not.toHaveBeenCalled();
    expect(fake.browser.place).not.toHaveBeenCalled();
    fake.emit(state({bounds:{x:120,y:100,width:1000,height:800},clientBounds:{x:120,y:100,width:1000,height:800}}));
    expect(toolbar.setPosition).not.toHaveBeenCalled();
    await nextFollow();
    expect(toolbar.setBounds).not.toHaveBeenCalled();
    expect(toolbar.setPosition).toHaveBeenCalledExactlyOnceWith(320,796);
    expect(toolbar.showInactive).not.toHaveBeenCalled();
    fake.emit(state({foreground:false,groupForeground:false}));
    expect(toolbar.hide).toHaveBeenCalledOnce();
    fake.emit(state({foreground:false,groupForeground:false}));
    expect(toolbar.hide).toHaveBeenCalledOnce();
    fake.emit(state());
    expect(toolbar.webContents.invalidate).toHaveBeenCalledOnce();
  });
  it('moves once to the latest drag position without business publication, IPC, repaint or resize',async()=>{
    fake.emit(state());await nextFollow();vi.clearAllMocks();
    for(let index=1;index<=120;index++)fake.emit(state({bounds:{x:100+index,y:100+index,width:1000,height:800},clientBounds:{x:100+index,y:100+index,width:1000,height:800}}));
    const toolbar=composer();
    expect(toolbar.setPosition).not.toHaveBeenCalled();
    await nextFollow();
    expect(toolbar.bounds).toEqual({x:420,y:916,width:500,height:44});
    expect(toolbar.setPosition).toHaveBeenCalledExactlyOnceWith(420,916);
    expect(toolbar.setBounds).not.toHaveBeenCalled();
    expect(toolbar.webContents.invalidate).not.toHaveBeenCalled();
    expect(fake.service.setWindowState).not.toHaveBeenCalled();
    expect(fake.service.getState).not.toHaveBeenCalled();
    expect(fake.windows.every(window=>window.webContents.send.mock.calls.length===0)).toBe(true);
    expect(fake.browser.place).not.toHaveBeenCalled();
    for(const window of fake.windows){expect(window.showInactive).not.toHaveBeenCalled();expect(window.hide).not.toHaveBeenCalled();}
  });
  it('follows geometry arriving on separate event-loop turns',async()=>{
    fake.emit(state());await nextFollow();vi.clearAllMocks();
    const toolbar=composer();
    for(let index=1;index<=3;index++){
      fake.emit(state({bounds:{x:100+index,y:100,width:1000,height:800},clientBounds:{x:100+index,y:100,width:1000,height:800}}));
      await nextFollow();
      expect(toolbar.setPosition).toHaveBeenCalledTimes(index);
      expect(toolbar.setPosition).toHaveBeenLastCalledWith(300+index,796);
    }
  });
  it.each([
    ['hidden',{visible:false}],
    ['minimized',{minimized:true}],
    ['unrelated foreground',{foreground:false,groupForeground:false}],
  ])('applies %s context immediately and never replays pending movement',async(_name,context)=>{
    fake.emit(state());await nextFollow();vi.clearAllMocks();
    const toolbar=composer();
    fake.emit(state({bounds:{x:220,y:220,width:1000,height:800},clientBounds:{x:220,y:220,width:1000,height:800}}));
    expect(toolbar.setPosition).not.toHaveBeenCalled();
    fake.emit(state(context));
    expect(toolbar.visible).toBe(false);
    expect(fake.service.setWindowState).toHaveBeenCalledExactlyOnceWith(state(context));
    expect(toolbar.hide).toHaveBeenCalledOnce();
    vi.clearAllMocks();await nextFollow();
    expect(toolbar.setPosition).not.toHaveBeenCalled();
    expect(toolbar.showInactive).not.toHaveBeenCalled();
    expect(fake.service.setWindowState).not.toHaveBeenCalled();
  });
  it.each([['target loss',null],['target replacement',state({targetInstanceId:'4:5:6'})]])('handles %s immediately without replaying an old frame',async(_name,next)=>{
    fake.emit(state());await nextFollow();vi.clearAllMocks();
    const toolbar=composer();
    fake.emit(state({bounds:{x:220,y:220,width:1000,height:800},clientBounds:{x:220,y:220,width:1000,height:800}}));
    expect(toolbar.setPosition).not.toHaveBeenCalled();
    fake.emit(next);
    expect(fake.service.setWindowState).toHaveBeenCalledExactlyOnceWith(next);
    expect(fake.browser.close).toHaveBeenCalledOnce();
    expect(toolbar.visible).toBe(next!==null);
    await Promise.resolve();vi.clearAllMocks();await nextFollow();
    expect(toolbar.setPosition).not.toHaveBeenCalled();
    expect(toolbar.showInactive).not.toHaveBeenCalled();
    expect(toolbar.webContents.invalidate).not.toHaveBeenCalled();
    expect(fake.service.setWindowState).not.toHaveBeenCalled();
  });
  it('creates sandboxed local contents and throttles only the on-demand settings renderer',async()=>{
    expect(activeWindows()).toEqual([composer()]);expect(composer().options.webPreferences.backgroundThrottling).toBe(false);
    await invoke('open-settings');expect(panel().options.webPreferences.backgroundThrottling).toBe(true);
    for(const window of activeWindows()){expect(window.webContents.mainFrame.url).toMatch(/^file:/);expect(window.options.webPreferences).toMatchObject({sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true});}
    expect(composer().webContents.mainFrame.url).toContain('#composer');await invoke('close');
  });
  it('allows only exact active local main frames to invoke the bridge',async()=>{
    expect(()=>invoke('state',undefined,{sender:{},senderFrame:panelEvent().senderFrame})).toThrow('UNAUTHORIZED');
    expect(()=>invoke('state',undefined,{sender:panelEvent().sender,senderFrame:{url:panelEvent().senderFrame.url}})).toThrow('UNAUTHORIZED');
    expect(()=>invoke('state',undefined,orderEvent())).not.toThrow();await invoke('open-settings');expect(()=>invoke('state',undefined,panelEvent())).not.toThrow();await invoke('close');
  });
  it('hides all attached surfaces when unrelated app is foreground or target minimized',()=>{fake.emit(state());expect(panel()?.visible??false).toBe(false);expect(composer().visible).toBe(true);fake.emit(state({foreground:false,groupForeground:false}));expect(panel()?.visible??false).toBe(false);expect(composer().visible).toBe(false);expect(fake.browser.place.mock.calls.every(call=>call[1]===false)).toBe(true);fake.emit(state({minimized:true}));expect(panel()?.visible??false).toBe(false);});
  it('keeps tools visible while own window or Edge group owns foreground',()=>{fake.emit(state({foreground:false,groupForeground:true}));expect(composer().visible).toBe(true);});
  it('shows primary controls inside the composer and hides them outside Messages',()=>{
    fake.emit(state());expect(composer().bounds).toEqual({x:300,y:796,width:500,height:44});expect(panel()?.visible??false).toBe(false);
    fake.setExtra({messageSurface:{active:false,toolbarRect:null}});fake.emit(state());expect(composer().visible).toBe(false);
    fake.setExtra({messageSurface:{active:true,toolbarRect:{x:200,y:600,width:500,height:40}}});
  });
  it('only passes a language to translation and never exposes a send IPC',async()=>{await invoke('translate','ja');expect(fake.service.translate).toHaveBeenCalledWith('ja');expect(()=>invoke('translate',{text:'arbitrary'})).toThrow('INVALID_TARGET_LANGUAGE');expect(fake.handlers.has('standalone:send')).toBe(false);await invoke('replace-draft');expect(fake.service.replaceDraft).toHaveBeenCalled();});
  it('opens a 1200 by 900 independent order window and closes it only on explicit close or target loss',async()=>{
    fake.emit(state());await invoke('open-order',{identifier:'订单 001',type:'order_number'},orderEvent());
    expect(fake.browser.open).toHaveBeenCalledWith(expect.objectContaining({identifier:'订单 001',identifierType:'order_number',requestId:expect.any(String)}),{x:0,y:50,width:1200,height:900},false);
    expect(activeWindows()).toHaveLength(1);expect(composer().visible).toBe(false);
    vi.clearAllMocks();
    for(const context of [{visible:false},{minimized:true},{foreground:false,groupForeground:false},{dpi:144,bounds:{x:2000,y:40,width:900,height:600},clientBounds:{x:2000,y:40,width:900,height:600}}]){fake.emit(state(context));await nextFollow();}
    fake.setExtra({orderViewport:{width:300,height:200,dpr:2},messageSurface:{active:false,toolbarRect:null}});
    composer().focus();
    expect(fake.browser.place).not.toHaveBeenCalled();expect(fake.browser.close).not.toHaveBeenCalled();expect(fake.browser.open).not.toHaveBeenCalled();
    fake.emit(null);await Promise.resolve();expect(fake.browser.close).toHaveBeenCalledOnce();expect(fake.service.setBrowserOpen).toHaveBeenCalledWith(false);
    await expect(invoke('open-order',{identifier:'001',type:'order_number'})).rejects.toThrow('TARGET_REQUIRED');
    fake.setExtra({orderViewport:{width:1000,height:700,dpr:1},messageSurface:{active:true,toolbarRect:{x:200,y:600,width:500,height:40}}});
  });
  it('restores saved DIP geometry in physical pixels and persists only the owned native lease',async()=>{
    fake.emit(state());fake.orderStore.state={bounds:{x:400,y:120,width:1000,height:800},maximized:true};
    fake.conversion.toPhysical=rect=>({x:rect.x*1.5,y:rect.y*1.5,width:rect.width*1.5,height:rect.height*1.5});
    fake.conversion.toDip=rect=>({x:rect.x/1.5,y:rect.y/1.5,width:rect.width/1.5,height:rect.height/1.5});
    try{
      await invoke('open-order',{identifier:'001',type:'order_number'},orderEvent());
      expect(fake.browser.open).toHaveBeenLastCalledWith(expect.any(Object),{x:600,y:180,width:1500,height:1200},true);
      const measurement={launchId:'owned',bounds:{x:900,y:150,width:1500,height:1200},maximized:false};
      fake.browser.ownsGeometry.mockReturnValueOnce(false);fake.emitWindowMeasurement(measurement);expect(fake.orderStore.update).not.toHaveBeenCalled();
      fake.emitWindowMeasurement(measurement);expect(fake.orderStore.update).toHaveBeenCalledExactlyOnceWith({bounds:{x:600,y:100,width:1000,height:800},maximized:false});
      await invoke('close-order');fake.browser.ownsGeometry.mockReturnValueOnce(false);fake.emitWindowMeasurement(measurement);expect(fake.orderStore.update).toHaveBeenCalledOnce();
    }finally{fake.orderStore.state=null;fake.conversion.toPhysical=rect=>rect;fake.conversion.toDip=rect=>rect;fake.emit(state());}
  });
  it('saves an adopted lease initial geometry while open is pending and rejects foreign leases',async()=>{
    fake.emit(state());let release!:()=>void;
    fake.browser.open.mockImplementationOnce(()=>new Promise<void>(resolve=>release=resolve));
    fake.browser.ownsGeometry.mockImplementation(launchId=>launchId==='adopted-lease');
    const opening=invoke('open-order',{identifier:'001',type:'order_number'},orderEvent());
    try{
      expect(fake.browser.open).toHaveBeenCalledOnce();expect(fake.service.setBrowserOpen).not.toHaveBeenCalledWith(true);
      const bounds={x:120,y:140,width:1200,height:900};
      fake.emitWindowMeasurement({launchId:'foreign-lease',bounds,maximized:false});expect(fake.orderStore.update).not.toHaveBeenCalled();
      fake.emitWindowMeasurement({launchId:'adopted-lease',bounds,maximized:true});
      expect(fake.orderStore.update).toHaveBeenCalledExactlyOnceWith({bounds,maximized:true});
      expect(fake.service.setBrowserOpen).not.toHaveBeenCalledWith(true);
      release();await opening;expect(fake.service.setBrowserOpen).toHaveBeenLastCalledWith(true);
    }finally{release();await opening;fake.browser.ownsGeometry.mockImplementation(()=>true);await invoke('close-order');}
  });
  it('opens without query-space or page-anchor measurements while preserving the message-page requirement',async()=>{
    fake.emit(state());fake.setExtra({orderViewport:null,messageSurface:{active:true,toolbarRect:null}});
    await invoke('open-order',{identifier:'001',type:'order_number'},orderEvent());expect(fake.browser.open).toHaveBeenCalledOnce();
    await invoke('close-order');expect(fake.browser.close).toHaveBeenCalled();
    fake.setExtra({messageSurface:{active:false,toolbarRect:null}});
    await expect(invoke('open-order',{identifier:'001',type:'order_number'},orderEvent())).rejects.toThrow('MESSAGE_PAGE_REQUIRED');
    fake.setExtra({orderViewport:{width:1000,height:700,dpr:1},messageSurface:{active:true,toolbarRect:{x:200,y:600,width:500,height:40}}});
  });
  it('keeps explicit settings available even before native foreground state catches up',async()=>{
    fake.emit(state({foreground:false,groupForeground:false}));await invoke('open-settings');expect(panel().visible).toBe(true);
    await invoke('close');expect(panel()?.visible??false).toBe(false);
  });
  it('reuses an already open normal settings window without restoring or hiding it on focus callbacks',async()=>{
    fake.emit(state());await invoke('open-settings');const current=panel(),restore=vi.spyOn(current,'restore');current.hide.mockClear();
    try{fake.appEvents.get('second-instance')!();await nextFollow();expect(panel()).toBe(current);expect(restore).not.toHaveBeenCalled();expect(current.hide).not.toHaveBeenCalled();expect(current.visible).toBe(true);}finally{restore.mockRestore();await invoke('close');}
  });
  it('marks settings open before restoring a minimized window that synchronously invokes follow',async()=>{
    fake.emit(state());await invoke('open-settings');const current=panel();current.minimized=true;
    const restore=vi.spyOn(current,'restore').mockImplementation(()=>{current.minimized=false;current.events.get('focus')?.();current.events.get('restore')?.();});current.hide.mockClear();
    try{fake.appEvents.get('second-instance')!();await nextFollow();expect(restore).toHaveBeenCalledOnce();expect(current.hide).not.toHaveBeenCalled();expect(current.visible).toBe(true);}finally{restore.mockRestore();await invoke('close');}
  });
  it('restores composer and reports an Edge placement failure',async()=>{
    fake.emit(state());await invoke('open-order',{identifier:'001',type:'order_number'},orderEvent());
    expect(composer().visible).toBe(false);expect(fake.browser.open).toHaveBeenCalled();
    fake.failBrowser();
    expect(composer().visible).toBe(true);
    expect(fake.service.setBrowserOpen).toHaveBeenLastCalledWith(false);
    expect(fake.service.reportBrowserFailure).toHaveBeenCalledWith('BROWSER_PLACEMENT_FAILED');
  });
  it('uses individual range windows and verifies their current identifier before opening',async()=>{
    const entry={identifier:'123456789012345678',identifierType:'order_number',rect:{x:250,y:300,width:130,height:20}};
    fake.setExtra({orderEntries:[entry],orderViewport:{width:1000,height:700,dpr:1}});fake.emit(state({clientBounds:{x:100,y:100,width:1000,height:800}}));
    const overlay=entryWindow();expect(overlay.options.transparent).toBe(true);expect(overlay.bounds).toEqual({x:350,y:500,width:130,height:20});expect(overlay.visible).toBe(true);
    const event={sender:overlay.webContents,senderFrame:overlay.webContents.mainFrame};
    await expect(invoke('open-order',{identifier:'other-order',type:'order_number'},event)).rejects.toThrow('ORDER_ENTRY_CHANGED');
    await invoke('open-order',{identifier:entry.identifier,type:entry.identifierType},event);expect(fake.service.confirmOrderEntry).toHaveBeenCalledWith(0,entry);expect(overlay.visible).toBe(false);
    fake.emit(null);expect(overlay.visible).toBe(false);
  });

});

describe('outbound translation shell integration',()=>{
 it('accepts validated translation options and routes pause/resume through trusted IPC',async()=>{
   await invoke('translation-options',{language:'ko',autoTranslate:false,shortcutEnabled:false});expect(fake.service.setTranslationOptions).toHaveBeenCalledWith({language:'ko',autoTranslate:false,shortcutEnabled:false});
   expect(()=>invoke('translation-options',{language:'invalid'})).toThrow('INVALID_OPTIONS');expect(()=>invoke('translation-options',{autoTranslate:'yes'})).toThrow('INVALID_OPTIONS');expect(()=>invoke('translation-options',{shortcutEnabled:'yes'})).toThrow('INVALID_OPTIONS');
   await invoke('cancel-translation');await invoke('resume-translation');expect(fake.service.cancelTranslation).toHaveBeenCalledOnce();expect(fake.service.resumeTranslation).toHaveBeenCalledOnce();
 });
 it('copies only the current authorized ready preview and rejects renderer text and stale state',async()=>{
   fake.setExtra({auth:'ready',phase:'ready',preview:'当前译文'});await invoke('copy-translation','renderer supplied text');expect(fake.clipboard.writeText).toHaveBeenCalledExactlyOnceWith('当前译文');
   fake.setExtra({phase:'stale'});expect(()=>invoke('copy-translation')).toThrow('PREVIEW_STALE');fake.setExtra({phase:'ready',auth:'needs_login'});expect(()=>invoke('copy-translation')).toThrow('PREVIEW_STALE');
   fake.setExtra({auth:undefined,phase:undefined,preview:undefined});
 });
 it('expands above the reply, hides it during order lookup, then restores the same anchored rectangle',async()=>{
   fake.emit(state());fake.setExtra({draft:{text:'你好',canReplace:true},messageSurface:{active:true,toolbarRect:{x:200,y:600,width:500,height:40},composerRect:{x:200,y:600,width:500,height:100}}});
   expect(composer().bounds).toEqual({x:300,y:610,width:500,height:230});
   await invoke('open-order',{identifier:'TS123456',type:'order_number'},orderEvent());expect(composer().visible).toBe(false);await invoke('close-order');expect(composer().visible).toBe(true);expect(composer().bounds.y+composer().bounds.height).toBe(840);
   fake.setExtra({draft:undefined,messageSurface:{active:true,toolbarRect:{x:200,y:600,width:500,height:40},composerRect:null}});
 });
 it('opens the full translation view from the compact preview action',async()=>{
   await invoke('open-translation');expect(panel().webContents.mainFrame.url).toMatch(/#translation$/);await invoke('open-settings');expect(panel().webContents.mainFrame.url).toMatch(/#settings$/);await invoke('close');
 });
});

 describe('final shell shutdown',()=>{
  it('cancels pending geometry before asynchronous shutdown cleanup',async()=>{
    fake.emit(state());await nextFollow();vi.clearAllMocks();
    fake.emit(state({bounds:{x:220,y:220,width:1000,height:800},clientBounds:{x:220,y:220,width:1000,height:800}}));
    const preventDefault=vi.fn();
    fake.appEvents.get('before-quit')!({preventDefault});
    expect(preventDefault).toHaveBeenCalledOnce();
    await nextFollow();
    expect(fake.windows.every(window=>window.setPosition.mock.calls.length===0)).toBe(true);
    expect(fake.service.dispose).toHaveBeenCalledOnce();
    expect(fake.native.stop).toHaveBeenCalledOnce();
  });
});

