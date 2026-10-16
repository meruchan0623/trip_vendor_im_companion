import{describe,it,expect,vi}from'vitest';
import{createHash}from'node:crypto';
import{VERIFIED_RUNTIME_BUILD,type BuildFingerprint}from'../../runtime/identity';
import{LiveRuntimeDriver}from'../../runtime/driver';
import{RuntimeAttachment}from'../../runtime/attachment';
import{LoopbackCDPTransport,approvedSocketURL,type CDPEvent,type EventCDPTransport}from'../../runtime/transport';
// This fake-wire suite exercises byte verification without requiring a private vendor dump.
const {html,renderer}=vi.hoisted(()=>({html:'<!doctype html><div id="root"></div>',renderer:'/* deterministic vendor renderer fixture */'}));
vi.mock('../../runtime/build-manifest',async importOriginal=>{
  const original=await importOriginal<typeof import('../../runtime/build-manifest')>();
  const {createHash}=await import('node:crypto');
  const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
  return {...original,VERIFIED_RUNTIME_BUILD:{...original.VERIFIED_RUNTIME_BUILD,htmlSha256:digest(html),rendererSha256:digest(renderer)}};
});
const fingerprint:BuildFingerprint={executable:VERIFIED_RUNTIME_BUILD.executable,executableVersion:VERIFIED_RUNTIME_BUILD.executableVersion,packageVersion:VERIFIED_RUNTIME_BUILD.packageVersion,aresVersion:VERIFIED_RUNTIME_BUILD.aresVersion,executableSha256:VERIFIED_RUNTIME_BUILD.executableSha256,asarSha256:VERIFIED_RUNTIME_BUILD.asarSha256,htmlSha256:VERIFIED_RUNTIME_BUILD.htmlSha256,rendererSha256:VERIFIED_RUNTIME_BUILD.rendererSha256};
const bundle='/* own factory test fixture */',hash=createHash('sha256').update(bundle).digest('hex');
class FakeWire implements EventCDPTransport{
  htmlWait:Promise<unknown>|undefined;nativeFactory=false;sessionTargets=new Map<string,string>();targetVisibility:Record<string,{visible:boolean;focused:boolean}>={};
  events=new Set<(event:CDPEvent)=>void>();disconnects=new Set<()=>void>();calls:{method:string;params:Record<string,unknown>;sessionId?:string}[]=[];session=0;active='';capture='';badScript=false;badHtml=false;multiple=false;childScript=false;heartbeatFail=false;boundaryFail=false;scriptWait:Promise<unknown>|undefined;
  emit(method:string,params:Record<string,unknown>,sessionId=this.active){for(const callback of [...this.events])callback({method,params,sessionId});}
  async send(method:string,params:Record<string,unknown>,sessionId?:string):Promise<any>{this.calls.push({method,params,sessionId});
    if(method==='Target.getTargets'){const target={targetId:'im',type:'page',url:VERIFIED_RUNTIME_BUILD.documentURL};return{targetInfos:this.multiple?[target,{...target,targetId:'im-2'}]:[target]};}
    if(method==='Target.attachToTarget'){this.active=`s${++this.session}`;this.sessionTargets.set(this.active,params.targetId as string);return{sessionId:this.active};}
    if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'main-frame',url:VERIFIED_RUNTIME_BUILD.documentURL}}};
    if(method==='Page.getResourceContent')return this.htmlWait??{content:this.badHtml?'unknown html':html,base64Encoded:false};
    if(method==='Runtime.enable'){this.emit('Runtime.executionContextCreated',{context:{id:4,auxData:{frameId:'main-frame',isDefault:true}}});return{};}
    if(method==='Debugger.enable'){this.emit('Debugger.scriptParsed',{scriptId:'100',executionContextId:this.childScript?10:4,url:VERIFIED_RUNTIME_BUILD.rendererURL});return{};}
    if(method==='Debugger.getScriptSource')return this.scriptWait??{scriptSource:this.badScript?'unknown renderer':renderer};
    if(method==='Page.createIsolatedWorld')return{executionContextId:88};
    if(method==='Runtime.evaluate'){if(params.expression==='({visible:document.visibilityState==="visible",focused:document.hasFocus()})')return{result:{value:this.targetVisibility[this.sessionTargets.get(sessionId??'')??'']??{visible:true,focused:false}}};if(this.nativeFactory&&String(params.expression).includes('tsimNativeComposerFactory'))return{result:{objectId:'native-factory'}};if(params.expression===bundle)return{result:{type:'undefined'}};if(params.expression==='window.tsimRuntimeFactory')return{result:{objectId:'factory'}};if(['window','document','document.documentElement','document.body'].includes(params.expression as string))return{result:{objectId:params.expression}};throw new Error('UNEXPECTED_EVALUATION');}
    if(method==='DOMDebugger.getEventListeners')return{listeners:params.objectId===this.capture?[{type:'keydown',useCapture:true}]:[]};
    if(method==='Runtime.callFunctionOn'){if(this.nativeFactory&&(params.functionDeclaration as string).includes('this.create'))return{result:{objectId:'native-editor'}};if((params.functionDeclaration as string).includes('this.mount'))return{result:{objectId:'owned-handle'}};if((this.heartbeatFail&&(params.functionDeclaration as string).includes('this.heartbeat'))||(this.boundaryFail&&(params.functionDeclaration as string).includes('this.boundary')))return{exceptionDetails:{}};return{result:{value:true}};}
    return{};
  }
  onEvent(callback:(event:CDPEvent)=>void){this.events.add(callback);return()=>this.events.delete(callback);}
  onDisconnect(callback:()=>void){this.disconnects.add(callback);return()=>this.disconnects.delete(callback);}
  async disconnect(){for(const callback of [...this.disconnects])callback();this.disconnects.clear();}
}
describe('actual driver with fake CDP wire, no client connection',()=>{
  const initialState={auth:'needs_login',conversationKey:null,draft:null,enabled:false,target:'en',followCustomer:{lang:null,following:false,manualEnabled:false},status:'unavailable',preview:null,error:null,busy:false} as const;
  it('keeps one connection and renews only native metadata while hidden, then mounts automatically on visibility',async()=>{
    const wire=new FakeWire();wire.nativeFactory=true;const driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);await driver.verifyCurrentTarget(driver.target);
    await driver.externalComposer('native fixture',createHash('sha256').update('native fixture').digest('hex'));
    wire.targetVisibility.im={visible:false,focused:false};vi.useFakeTimers();
    const policy=(driver as any).policy,renew=vi.spyOn(policy,'renewNative'),poll=vi.spyOn(policy,'pollNative'),mount=vi.spyOn(policy,'mountUi'),sessions=wire.calls.filter(call=>call.method==='Target.attachToTarget').length;
    try{
      const pending=driver.mountCompanion(initialState,async()=>{});await vi.advanceTimersByTimeAsync(8500);
      expect(mount).not.toHaveBeenCalled();expect(poll).not.toHaveBeenCalled();expect(renew).toHaveBeenCalledTimes(8);
      expect(wire.calls.filter(call=>call.method==='Target.attachToTarget')).toHaveLength(sessions);
      wire.targetVisibility.im={visible:true,focused:true};await vi.advanceTimersByTimeAsync(500);const handle=await pending;
      expect(mount).toHaveBeenCalledOnce();await handle.detach();await driver.disconnect();expect(vi.getTimerCount()).toBe(0);
    }finally{vi.useRealTimers();await driver.disconnect();}
  });
  it('cancels a hidden mount immediately when disposed without mounting or retaining its wait timer',async()=>{
    const wire=new FakeWire(),driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);await driver.verifyCurrentTarget(driver.target);wire.targetVisibility.im={visible:false,focused:false};vi.useFakeTimers();
    try{
      const pending=driver.mountCompanion(initialState,async()=>{}),rejected=expect(pending).rejects.toThrow('RUNTIME_TARGET_CHANGED');await vi.advanceTimersByTimeAsync(0);
      await driver.disconnect();await rejected;expect(wire.calls.some(call=>String(call.params.functionDeclaration).includes('this.mount'))).toBe(false);expect(vi.getTimerCount()).toBe(0);
    }finally{vi.useRealTimers();await driver.disconnect();}
  });
  it('cancels hidden waiting on a target navigation without waiting for the next visibility tick',async()=>{
    const wire=new FakeWire(),driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);await driver.verifyCurrentTarget(driver.target);wire.targetVisibility.im={visible:false,focused:false};vi.useFakeTimers();
    try{
      const pending=driver.mountCompanion(initialState,async()=>{}),rejected=expect(pending).rejects.toThrow('RUNTIME_TARGET_CHANGED');await vi.advanceTimersByTimeAsync(0);
      wire.emit('Page.frameStartedLoading',{frameId:'main-frame'});await rejected;expect(vi.getTimerCount()).toBe(0);
    }finally{vi.useRealTimers();await driver.disconnect();}
  });
  it('retries a visibility race inside the same connection without reinstalling artifacts or reporting a mount failure',async()=>{
    const wire=new FakeWire(),driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);await driver.verifyCurrentTarget(driver.target);const policy=(driver as any).policy;
    const mount=vi.spyOn(policy,'mountUi');mount.mockImplementationOnce(async()=>{wire.targetVisibility.im={visible:false,focused:false};throw new Error('IM_TARGET_INACTIVE');});vi.useFakeTimers();
    try{
      const pending=driver.mountCompanion(initialState,async()=>{});await vi.advanceTimersByTimeAsync(1000);expect(mount).toHaveBeenCalledOnce();
      wire.targetVisibility.im={visible:true,focused:true};await vi.advanceTimersByTimeAsync(500);const handle=await pending;expect(mount).toHaveBeenCalledTimes(2);
      expect(wire.calls.filter(call=>call.method==='Runtime.evaluate'&&call.params.expression===bundle)).toHaveLength(1);await handle.detach();await driver.disconnect();
    }finally{vi.useRealTimers();await driver.disconnect();}
  });
  it('cleans up once when an invalidation callback synchronously closes the same driver',async()=>{
    const wire=new FakeWire(),driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);await driver.verifyCurrentTarget(driver.target);
    const disconnect=vi.spyOn(wire,'disconnect'),closeUi=vi.spyOn((driver as any).policy,'detachUi');let reentrant:Promise<void>|undefined;
    driver.watchInvalidation(driver.target,()=>{reentrant=driver.disconnect();});
    await driver.disconnect();await reentrant;expect(closeUi).toHaveBeenCalledOnce();expect(disconnect).toHaveBeenCalledOnce();
  });
  it('does not read a mounted background editor unless the main navigation explicitly selects messages',async()=>{
    const wire=new FakeWire();wire.nativeFactory=true;const driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);await driver.verifyCurrentTarget(driver.target);
    const source='/* native test factory */',port=await driver.externalComposer(source,createHash('sha256').update(source).digest('hex'));
    vi.spyOn((driver as any).policy,'readMessageNavigation').mockResolvedValue({active:false,dpr:1,width:800,height:600});const poll=vi.spyOn((driver as any).policy,'pollNative');
    expect(await port.read(0)).toMatchObject({writeVerified:false,messageSurface:{active:false,composerRect:null,toolbarRect:null},orderEntries:[]});expect(poll).not.toHaveBeenCalled();await driver.disconnect();
  });
  it('renews a foreground inactive-message lease beyond six seconds and reads again when messages return',async()=>{
    const wire=new FakeWire();wire.nativeFactory=true;const driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);await driver.verifyCurrentTarget(driver.target);
    const source='/* native test factory */',port=await driver.externalComposer(source,createHash('sha256').update(source).digest('hex'));
    vi.useFakeTimers();try{
      let active=false,lastHeartbeat=Date.now();const policy=(driver as any).policy;
      const renew=vi.spyOn(policy,'renewNative').mockImplementation(async()=>{if(Date.now()-lastHeartbeat>=6000)throw new Error('NATIVE_LEASE_ENDED');lastHeartbeat=Date.now();});
      vi.spyOn(policy,'readMessageNavigation').mockImplementation(async()=>({active,dpr:1,width:800,height:600}));
      const snapshot={text:'fixture',conversationId:'fixture',revision:1},poll=vi.spyOn(policy,'pollNative').mockImplementation(async()=>{if(Date.now()-lastHeartbeat>=6000)throw new Error('NATIVE_POLL_FAILED');return{snapshot,writeVerified:true,messageSurface:{active:true,composerRect:{x:100,y:400,width:500,height:200},toolbarRect:{x:300,y:400,width:300,height:40}},orderViewport:{width:800,height:600,dpr:1}};});
      for(let tick=0;tick<4;tick++){await vi.advanceTimersByTimeAsync(4000);expect((await port.read(0)).messageSurface?.active).toBe(false);}
      expect(renew).toHaveBeenCalledTimes(4);expect(poll).not.toHaveBeenCalled();active=true;expect((await port.read(0)).snapshot?.text).toBe('fixture');expect(poll).toHaveBeenCalledTimes(2);
    }finally{vi.useRealTimers();await driver.disconnect();}
  });
  it('rechecks nav after awaited editor poll so switching pages during verification revokes replacement',async()=>{
    const wire=new FakeWire();wire.nativeFactory=true;const driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);await driver.verifyCurrentTarget(driver.target);
    const source='/* native test factory */',port=await driver.externalComposer(source,createHash('sha256').update(source).digest('hex'));
    let active=true;vi.spyOn((driver as any).policy,'readMessageNavigation').mockImplementation(async()=>({active,dpr:1,width:800,height:600}));vi.spyOn((driver as any).policy,'pollNative').mockImplementation(async()=>{active=false;return{messageSurface:{active:true,composerRect:{x:0,y:0,width:500,height:200},toolbarRect:null}};});
    const authorize=vi.fn(),write=vi.spyOn((driver as any).policy,'replaceNative');await expect(port.replace({authGeneration:0} as any,'reviewed',authorize)).rejects.toThrow('MESSAGE_PAGE_INACTIVE');expect(write).not.toHaveBeenCalled();expect(authorize).not.toHaveBeenCalled();await driver.disconnect();
  });
  it('rejects replacement when messages navigation changes while fresh browser authorization is pending',async()=>{
    const wire=new FakeWire();wire.nativeFactory=true;const driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);await driver.verifyCurrentTarget(driver.target);
    const source='/* native test factory */',port=await driver.externalComposer(source,createHash('sha256').update(source).digest('hex')),policy=(driver as any).policy;
    let active=true;vi.spyOn(policy,'readMessageNavigation').mockImplementation(async()=>({active,dpr:1,width:800,height:600}));
    vi.spyOn(policy,'pollNative').mockResolvedValue({messageSurface:{active:true,composerRect:{x:0,y:0,width:500,height:200},toolbarRect:null}});
    let release!:()=>void,entered!:()=>void;const authorization=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    const authorize=vi.fn(async()=>{entered();await authorization;}),write=vi.spyOn(policy,'replaceNative');
    try{
      const pending=port.replace({authGeneration:0} as any,'reviewed',authorize),rejected=expect(pending).rejects.toThrow('MESSAGE_PAGE_INACTIVE');
      await started;active=false;release();await rejected;
      expect(authorize).toHaveBeenCalledOnce();expect(write).not.toHaveBeenCalled();
    }finally{release();await driver.disconnect();}
  });
  it('rejects replacement before mutation when the runtime target invalidates during browser authorization',async()=>{
    const wire=new FakeWire();wire.nativeFactory=true;const driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);await driver.verifyCurrentTarget(driver.target);
    const source='/* native test factory */',port=await driver.externalComposer(source,createHash('sha256').update(source).digest('hex')),policy=(driver as any).policy;
    vi.spyOn(policy,'readMessageNavigation').mockResolvedValue({active:true,dpr:1,width:800,height:600});
    vi.spyOn(policy,'pollNative').mockResolvedValue({messageSurface:{active:true,composerRect:{x:0,y:0,width:500,height:200},toolbarRect:null}});
    let release!:()=>void,entered!:()=>void;const authorization=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    const authorize=vi.fn(async()=>{entered();await authorization;}),write=vi.spyOn(policy,'replaceNative');
    try{
      const pending=port.replace({authGeneration:0} as any,'reviewed',authorize),rejected=expect(pending).rejects.toThrow('RUNTIME_TARGET_CHANGED');
      await started;wire.emit('Page.frameStartedLoading',{frameId:'main-frame'});release();await rejected;
      expect(write).not.toHaveBeenCalled();
    }finally{release();await driver.disconnect();}
  });
  it('runs the synchronous authorization guard after the final awaited navigation check',async()=>{
    const wire=new FakeWire();wire.nativeFactory=true;const driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);await driver.verifyCurrentTarget(driver.target);
    const source='/* native test factory */',port=await driver.externalComposer(source,createHash('sha256').update(source).digest('hex')),policy=(driver as any).policy;
    let browserAuthorized=false,accountCurrent=true;
    vi.spyOn(policy,'readMessageNavigation').mockImplementation(async()=>{if(browserAuthorized)accountCurrent=false;return{active:true,dpr:1,width:800,height:600};});
    vi.spyOn(policy,'pollNative').mockResolvedValue({messageSurface:{active:true,composerRect:{x:0,y:0,width:500,height:200},toolbarRect:null}});
    const guard=vi.fn(()=>{if(!accountCurrent)throw new Error('AUTH_CHANGED');}),authorize=vi.fn(async()=>{await Promise.resolve();browserAuthorized=true;return guard;}),write=vi.spyOn(policy,'replaceNative');
    try{
      await expect(port.replace({authGeneration:0} as any,'reviewed',authorize)).rejects.toThrow('AUTH_CHANGED');
      expect(authorize).toHaveBeenCalledOnce();expect(guard).toHaveBeenCalledOnce();expect(write).not.toHaveBeenCalled();
    }finally{await driver.disconnect();}
  });
  it('external editor does not mount UI and checks authorization after async document verification',async()=>{
    const wire=new FakeWire();wire.nativeFactory=true;
    const driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);await driver.verifyCurrentTarget(driver.target);
    const source='/* native test factory */',port=await driver.externalComposer(source,createHash('sha256').update(source).digest('hex'));
    vi.spyOn((driver as any).policy,'readMessageNavigation').mockResolvedValue({active:true,dpr:1,width:800,height:600});vi.spyOn((driver as any).policy,'pollNative').mockResolvedValue({messageSurface:{active:true,composerRect:{x:0,y:0,width:500,height:200},toolbarRect:{x:200,y:0,width:300,height:40}}});
    let release!:(value:unknown)=>void;wire.htmlWait=new Promise(resolve=>{release=resolve;});
    let authenticated=true;const authorize=vi.fn(()=>{if(!authenticated)throw new Error('AUTH_CHANGED');});
    const write=port.replace({} as any,'translated draft',authorize);authenticated=false;release({content:html,base64Encoded:false});
    await expect(write).rejects.toThrow('AUTH_CHANGED');expect(authorize).toHaveBeenCalledOnce();
    expect(wire.calls.some(call=>call.method==='Runtime.callFunctionOn'&&/this\.replaceDraft|this\.mount|this\.clickSend/.test(String(call.params.functionDeclaration)))).toBe(false);
    expect(wire.calls.filter(call=>call.method==='Runtime.addBinding').map(call=>call.params)).toEqual([{name:expect.stringMatching(/^tsim_native_[a-f0-9]{32}$/),executionContextId:4}]);await driver.disconnect();
  });
  it('verifies loaded static resources and main context before isolated-world mount, then restores via own handle',async()=>{const wire=new FakeWire();const driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);const lifecycle=new RuntimeAttachment(driver);await lifecycle.attach(driver.target);await lifecycle.heartbeat();await lifecycle.close();expect(wire.calls.find(call=>call.method==='Debugger.getScriptSource')?.params.scriptId).toBe('100');const install=wire.calls.find(call=>call.method==='Runtime.evaluate'&&call.params.expression===bundle)!;expect(install.params.contextId).toBe(88);expect(wire.calls.filter(call=>call.method==='DOMDebugger.getEventListeners').map(call=>call.params.objectId)).toEqual(['window','document','document.documentElement','document.body']);expect(wire.calls.filter(call=>call.method==='Runtime.evaluate'&&call.params.expression==='document').every(call=>call.params.contextId===4)).toBe(true);expect(wire.calls.some(call=>/Browser.close|Page.reload|Storage|Network|getProperties/.test(call.method))).toBe(false);});
  it('rejects ambiguous targets and mismatched loaded HTML/script even when disk fingerprint is approved',async()=>{for(const kind of ['multiple','badHtml','badScript']as const){const wire=new FakeWire();wire[kind]=true;if(kind==='multiple')await expect(LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash)).rejects.toThrow('AMBIGUOUS');else{const driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);const lifecycle=new RuntimeAttachment(driver);await expect(lifecycle.attach(driver.target)).rejects.toThrow('HASH_MISMATCH');expect(wire.calls.some(call=>call.method==='Runtime.evaluate'&&call.params.expression===bundle)).toBe(false);await lifecycle.close();}}});
  it('selects the sole visible verified target or the uniquely focused visible target without depending on enumeration order',async()=>{for(const visibility of [{'im':{visible:false,focused:false},'im-2':{visible:true,focused:false}},{'im':{visible:true,focused:false},'im-2':{visible:true,focused:true}}]){const wire=new FakeWire();wire.multiple=true;wire.targetVisibility=visibility;const driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);expect(driver.target.targetId).toBe('im-2');await driver.verifyCurrentTarget(driver.target);await driver.disconnect();expect(wire.calls.filter(call=>call.method==='Target.attachToTarget').length).toBe(wire.calls.filter(call=>call.method==='Target.detachFromTarget').length);}});
  it('revokes the old target before reading any draft after focus switches to another account view',async()=>{const wire=new FakeWire();wire.multiple=true;wire.nativeFactory=true;wire.targetVisibility={'im':{visible:true,focused:true},'im-2':{visible:true,focused:false}};const driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);await driver.verifyCurrentTarget(driver.target);const source='native fixture',port=await driver.externalComposer(source,createHash('sha256').update(source).digest('hex')),poll=vi.spyOn((driver as any).policy,'pollNative'),invalidated=vi.fn();driver.watchInvalidation(driver.target,invalidated);wire.targetVisibility={'im':{visible:true,focused:false},'im-2':{visible:true,focused:true}};await expect(port.read(0)).rejects.toThrow('RUNTIME_TARGET_CHANGED');expect(poll).not.toHaveBeenCalled();expect(invalidated).toHaveBeenCalledOnce();await driver.disconnect();});
  it('records parent captures without mistaking them for iframe ancestors, and requires actual own-frame proof',async()=>{for(const ancestor of ['window','document','document.documentElement','document.body']){const wire=new FakeWire();wire.capture=ancestor;const driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);const lifecycle=new RuntimeAttachment(driver);await lifecycle.attach(driver.target);expect(driver.parentCaptureDiagnostics).toEqual([{target:ancestor,type:'keydown'}]);expect(wire.calls.some(call=>call.method==='Runtime.callFunctionOn'&&(call.params.functionDeclaration as string).includes('this.boundary'))).toBe(true);await lifecycle.close();}const wire=new FakeWire();wire.boundaryFail=true;const driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);const lifecycle=new RuntimeAttachment(driver);await expect(lifecycle.attach(driver.target)).rejects.toThrow('OWNED_FRAME_BOUNDARY_FAILED');await lifecycle.close();});
  it('invalidates navigation while verification is awaiting a source response',async()=>{const wire=new FakeWire();let complete!:(value:unknown)=>void;wire.scriptWait=new Promise(resolve=>{complete=resolve;});const driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);const lifecycle=new RuntimeAttachment(driver);const pending=lifecycle.attach(driver.target);await vi.waitFor(()=>expect(wire.calls.some(call=>call.method==='Debugger.getScriptSource')).toBe(true));wire.emit('Page.frameStartedLoading',{frameId:'main-frame'});complete({scriptSource:renderer});await expect(pending).rejects.toThrow();await lifecycle.close();expect(wire.calls.some(call=>call.method==='Runtime.evaluate'&&call.params.expression===bundle)).toBe(false);});
  it('broken own-frame boundary or UI lease expiry revoke an attached panel',async()=>{for(const kind of ['boundaryFail','heartbeatFail']as const){const wire=new FakeWire();const driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);const lifecycle=new RuntimeAttachment(driver);await lifecycle.attach(driver.target);wire[kind]=true;await lifecycle.heartbeat();expect(lifecycle.status).toBe('detached');expect(wire.calls.some(call=>call.method==='Runtime.callFunctionOn'&&(call.params.functionDeclaration as string).includes('this.detach'))).toBe(true);await lifecycle.close();}});
});
describe('driver routes page intents to the controller with fixed argument shapes',()=>{
  async function attached(){const wire=new FakeWire();const driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);await driver.verifyCurrentTarget(driver.target);
    const actions={customerLanguage:vi.fn(),followCustomer:vi.fn(),setEnabled:vi.fn(),setTarget:vi.fn(),retry:vi.fn(async()=>{}),apply:vi.fn(async()=>{}),openLogin:vi.fn(async()=>{}),queryOrder:vi.fn(async()=>{}),cancel:vi.fn(async()=>{}),resume:vi.fn(async()=>{})};const state={auth:'needs_login',conversationKey:null,draft:null,enabled:false,target:'en',followCustomer:{lang:null,following:false,manualEnabled:false},status:'unavailable',preview:null,error:null,busy:false} as const;const handle=await driver.mountCompanion(state,async(action,args)=>{const value=(actions as any)[action];if(action==='apply')await value((args[0] as any).mode);else await value(...args);});const lifecycle={close:async()=>{await handle.detach();await driver.disconnect();}};
    const binding=(driver as any).bindingName as string,context=(driver as any).policy.context as number;
    const call=async(payload:unknown,options:{name?:string;context?:number}={})=>{const before=wire.calls.length;wire.emit('Runtime.bindingCalled',{name:options.name??binding,executionContextId:options.context??context,payload:typeof payload==='string'?payload:JSON.stringify(payload)});await vi.waitFor(()=>{});await new Promise(resolve=>setTimeout(resolve,0));return wire.calls.slice(before).filter(item=>item.method==='Runtime.callFunctionOn'&&String(item.params.functionDeclaration).includes('respondWorkbench')).map(item=>(item.params.arguments as {value:unknown}[]).map(arg=>arg.value));};
    return{wire,driver,lifecycle,actions,call};}
  it('valid intents reach the controller and are answered ok',async()=>{const f=await attached();
    expect(await f.call({id:'1',action:'setEnabled',args:[false]})).toEqual([['1',true]]);expect(f.actions.setEnabled).toHaveBeenCalledWith(false);
    expect(await f.call({id:'2',action:'setTarget',args:[{lang:'ja',source:'manual'}]})).toEqual([['2',true]]);expect(f.actions.setTarget).toHaveBeenLastCalledWith({lang:'ja',source:'manual'});
    expect(await f.call({id:'3',action:'setTarget',args:[{lang:'ko',source:'auto',conversationKey:'c1'}]})).toEqual([['3',false]]);
    expect(await f.call({id:'4',action:'retry',args:[]})).toEqual([['4',true]]);expect(f.actions.retry).toHaveBeenCalledOnce();
    expect(await f.call({id:'5',action:'apply',args:[{mode:'replace'}]})).toEqual([['5',true]]);expect(f.actions.apply).toHaveBeenCalledWith('replace');
    expect(await f.call({id:'6',action:'openLogin',args:[]})).toEqual([['6',true]]);expect(f.actions.openLogin).toHaveBeenCalledOnce();expect(await f.call({id:'7',action:'queryOrder',args:[{identifier:'000000123'}]})).toEqual([['7',true]]);expect(f.actions.queryOrder).toHaveBeenCalledWith({identifier:'000000123'});await f.lifecycle.close();});
  it('permits only bounded language reports and the no-argument automatic-follow intent',async()=>{const f=await attached();expect(await f.call({id:'31',action:'customerLanguage',args:[{lang:'unknown',conversationKey:'current'}]})).toEqual([['31',true]]);expect(f.actions.customerLanguage).toHaveBeenCalledWith({lang:'unknown',conversationKey:'current'});expect(await f.call({id:'32',action:'followCustomer',args:[]})).toEqual([['32',true]]);for(const [id,args] of [['33',[{lang:'xx',conversationKey:'current'}]],['34',[{lang:'en',conversationKey:'current',text:'secret'}]],['35',[{lang:'en',conversationKey:'x'.repeat(1025)}]]] as [string,unknown[]][]){expect(await f.call({id,action:'customerLanguage',args})).toEqual([[id,false]]);}expect(await f.call({id:'36',action:'followCustomer',args:['ja']})).toEqual([['36',false]]);expect(f.actions.customerLanguage).toHaveBeenCalledOnce();expect(f.actions.followCustomer).toHaveBeenCalledOnce();await f.lifecycle.close();});
  it('controller failures are answered not-ok',async()=>{const f=await attached();f.actions.apply.mockRejectedValueOnce(new Error('REVIEW_EXPIRED'));expect(await f.call({id:'7',action:'apply',args:[{mode:'replace'}]})).toEqual([['7',false]]);await f.lifecycle.close();});
  it('rejects unknown actions, extra keys, text payloads and wrong shapes without touching the controller',async()=>{const f=await attached();
    for(const payload of [{id:'90',action:'queryOrder',args:[{identifier:'123',extra:1}]},{id:'91',action:'queryOrder',args:[{identifier:123}]},{id:'92',action:'queryOrder',args:[{identifier:''}]},{id:'93',action:'queryOrder',args:[{identifier:'x'.repeat(129)}]},{id:'94',action:'queryOrder',args:[{identifier:'123\n'}]},{id:'99',action:'apply',args:[{mode:'replace-send'}]},{id:'1',action:'send',args:['hello']},{id:'2',action:'setEnabled',args:['yes']},{id:'3',action:'setTarget',args:[{lang:'zh',source:'manual'}]},{id:'4',action:'setTarget',args:[{lang:'ja',source:'manual',text:'x'}]},{id:'5',action:'setTarget',args:[{lang:'ja',source:'auto'}]},{id:'6',action:'apply',args:[{mode:'send'}]},{id:'7',action:'apply',args:[{mode:'replace',text:'injected'}]},{id:'8',action:'retry',args:[1]},{id:'9',action:'apply',args:[]},{id:'10',action:'setTarget',args:[{lang:'x'.repeat(17),source:'auto',conversationKey:'c'}]}])expect(await f.call(payload)).toEqual([[payload.id,false]]);
    expect(await f.call({id:'x',action:'retry',args:[]})).toEqual([]);expect(await f.call({id:'11',action:'retry',args:[],extra:1})).toEqual([]);expect(await f.call('not json')).toEqual([]);expect(await f.call({id:'12',action:'retry',args:[]},{name:'tsim_'+'0'.repeat(32)})).toEqual([]);expect(await f.call({id:'13',action:'retry',args:[]},{context:4})).toEqual([]);
    for(const action of Object.values(f.actions))expect(action).not.toHaveBeenCalled();await f.lifecycle.close();});
});
class FakeSocket{
  readyState=1;sent:string[]=[];listeners=new Map<string,Set<(event:any)=>void>>();close=vi.fn(()=>{this.readyState=3;});
  send(data:string){this.sent.push(data);}addEventListener(type:string,listener:(event:any)=>void){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type)!.add(listener);}removeEventListener(type:string,listener:(event:any)=>void){this.listeners.get(type)?.delete(listener);}message(value:unknown){for(const listener of this.listeners.get('message')??[])listener({data:JSON.stringify(value)});}
}
describe('wire request identity and fail closed transport',()=>{
  it('binds response session to the exact request instead of accepting only a matching numeric id',async()=>{const socket=new FakeSocket(),transport=new LoopbackCDPTransport(socket);const result=transport.send('Page.createIsolatedWorld',{frameId:'main-frame'},'s1');socket.message({id:1,sessionId:'s2',result:{executionContextId:99}});await expect(result).rejects.toThrow('CDP_DISCONNECTED');expect(socket.close).toHaveBeenCalledOnce();});
  it('root requests reject a foreign session and forbidden commands are never sent',async()=>{const socket=new FakeSocket(),transport=new LoopbackCDPTransport(socket);for(const method of ['Browser.close','Page.reload','Network.getAllCookies','Storage.getCookies','Runtime.getProperties'])await expect(transport.send(method,{})).rejects.toThrow('FORBIDDEN');const request=transport.send('Target.getTargets',{});socket.message({id:1,sessionId:'foreign',result:{targetInfos:[]}});await expect(request).rejects.toThrow('DISCONNECTED');expect(socket.sent).toHaveLength(1);});
  it('a timeout closes the transport and rejects every pending operation',async()=>{vi.useFakeTimers();try{const socket=new FakeSocket(),transport=new LoopbackCDPTransport(socket,20);const first=transport.send('Target.getTargets',{}),second=transport.send('Target.getTargetInfo',{targetId:'im'});const results=Promise.allSettled([first,second]);vi.advanceTimersByTime(20);expect((await results).every(result=>result.status==='rejected')).toBe(true);expect(socket.close).toHaveBeenCalledOnce();}finally{vi.useRealTimers();}});
  it('websocket URL cannot leave the owned IPv4 loopback port or contain credentials/query/other routes',()=>{expect(approvedSocketURL('ws://127.0.0.1:19321/devtools/browser/test-id',19321)).toBe(true);for(const url of ['ws://localhost:19321/devtools/browser/id','ws://0.0.0.0:19321/devtools/browser/id','ws://127.0.0.1:19322/devtools/browser/id','ws://u:p@127.0.0.1:19321/devtools/browser/id','ws://127.0.0.1:19321/devtools/browser/id?x=y','ws://127.0.0.1:19321/devtools/page/id'])expect(approvedSocketURL(url,19321)).toBe(false);});
});

describe('native wakeups are private-drain hints',()=>{
 it('rejects wrong context, session, name and payload; a page wake cannot fabricate a replacement',async()=>{const wire=new FakeWire();wire.nativeFactory=true;const driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);await driver.verifyCurrentTarget(driver.target);const source='native fixture',port=await driver.externalComposer(source,createHash('sha256').update(source).digest('hex')),policy=(driver as any).policy;const name=wire.calls.find(call=>call.method==='Runtime.addBinding')!.params.name,listener=vi.fn(),stop=port.onInteraction(listener),drain=vi.spyOn(policy,'drainNativeInteractions').mockResolvedValue([]);try{for(const [params,session] of [[{name,executionContextId:88,payload:'wake'},wire.active],[{name,executionContextId:4,payload:'wake'},'retired'],[{name:'other',executionContextId:4,payload:'wake'},wire.active],[{name,executionContextId:4,payload:'{"type":"replace-shortcut"}'},wire.active]] as const)wire.emit('Runtime.bindingCalled',params,session);expect(drain).not.toHaveBeenCalled();wire.emit('Runtime.bindingCalled',{name,executionContextId:4,payload:'wake'});await Promise.resolve();await Promise.resolve();expect(drain).toHaveBeenCalledOnce();expect(listener).not.toHaveBeenCalled();drain.mockResolvedValueOnce([{type:'draft-changed'}]);wire.emit('Runtime.bindingCalled',{name,executionContextId:4,payload:'wake'});await Promise.resolve();await Promise.resolve();expect(listener).toHaveBeenCalledExactlyOnceWith({type:'draft-changed'});stop();drain.mockResolvedValueOnce([{type:'draft-changed'}]);wire.emit('Runtime.bindingCalled',{name,executionContextId:4,payload:'wake'});await Promise.resolve();await Promise.resolve();expect(listener).toHaveBeenCalledOnce();}finally{await driver.disconnect();}expect(wire.calls.some(call=>call.method==='Runtime.removeBinding'&&call.params.name===name)).toBe(true);});
 it('discards a private drain result that arrives after document invalidation',async()=>{const wire=new FakeWire();wire.nativeFactory=true;const driver=await LiveRuntimeDriver.discover(wire,fingerprint,bundle,hash);await driver.verifyCurrentTarget(driver.target);const source='native fixture',port=await driver.externalComposer(source,createHash('sha256').update(source).digest('hex')),policy=(driver as any).policy,name=wire.calls.find(call=>call.method==='Runtime.addBinding')!.params.name,listener=vi.fn();port.onInteraction(listener);let release!:(events:unknown[])=>void;vi.spyOn(policy,'drainNativeInteractions').mockImplementation(()=>new Promise(resolve=>{release=resolve;}));wire.emit('Runtime.bindingCalled',{name,executionContextId:4,payload:'wake'});wire.emit('Page.frameStartedLoading',{frameId:'main-frame'});release([{type:'replace-shortcut',snapshot:{text:'fabricated'}}]);await Promise.resolve();await Promise.resolve();expect(listener).not.toHaveBeenCalled();await driver.disconnect();});
});
