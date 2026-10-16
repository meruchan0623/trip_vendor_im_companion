import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeAdapter, NativeDraftSnapshot, WindowState } from '../electron/native-adapter';
const fake=vi.hoisted(()=>({identity:{accountScope:'psim:test',authGeneration:1,permissions:[]} as {accountScope:string;authGeneration:number;permissions:string[]}|null,changed:undefined as undefined|((identity:any)=>void),translate:vi.fn(),sync:vi.fn(),openLogin:vi.fn(),backgroundPolling:vi.fn(),sessionOptions:undefined as undefined|{backgroundPolling?:boolean;onStatus?:(status:'connecting'|'needs_login'|'ready'|'failed',errorCode?:string)=>void}}));
vi.mock('../electron/browser-profile-session',()=>({BrowserProfileSessionService:class{
  private observed:string|undefined;
  constructor(changed:(identity:any)=>void,options:{backgroundPolling?:boolean}){fake.changed=changed;fake.sessionOptions=options;}
  setBackgroundPolling(enabled:boolean){fake.backgroundPolling(enabled);}
  identity(){return fake.identity;}
  async sync(){await fake.sync();const value=JSON.stringify(fake.identity);if(value!==this.observed){this.observed=value;fake.changed?.(fake.identity);fake.sessionOptions?.onStatus?.(fake.identity?'ready':'needs_login');}}
  translate(...args:unknown[]){return fake.translate(...args);}dispose(){}logout(){fake.identity=null;fake.changed?.(null);fake.sessionOptions?.onStatus?.('needs_login');return Promise.resolve();}openLogin(){return fake.openLogin();}
}}));
vi.mock('../electron/external-composer',()=>({connectExternalComposer:vi.fn()}));
import { CompanionService } from '../electron/companion-service';
import {connectExternalComposer} from '../electron/external-composer';
import type {VerifiedComposerSnapshot} from '../src/shared/workbench';
describe('external draft replacement service',()=>{
  let service:CompanionService,draft:NativeDraftSnapshot,native:{readDraft:ReturnType<typeof vi.fn>;replaceDraft:ReturnType<typeof vi.fn>};
  const window:WindowState={targetInstanceId:'1:2:3',bounds:{x:0,y:0,width:800,height:600},visible:true,minimized:false,foreground:true,groupForeground:true,dpi:96};
  beforeEach(()=>{
    vi.useFakeTimers();fake.identity={accountScope:'psim:test',authGeneration:1,permissions:[]};
    fake.sync.mockReset();fake.sync.mockResolvedValue(undefined);fake.openLogin.mockReset();fake.openLogin.mockResolvedValue(undefined);fake.backgroundPolling.mockReset();
    draft={targetInstanceId:'1:2:3',editorIdentity:'editor',text:'你好',revision:'A'.repeat(64),bounds:{x:100,y:400,width:500,height:100},canReplace:true};
    native={readDraft:vi.fn(async()=>structuredClone(draft)),replaceDraft:vi.fn(async(_expected,text)=>{draft={...draft,text,revision:'B'.repeat(64)};return structuredClone(draft);})};
    fake.translate.mockReset();fake.translate.mockResolvedValue({success:true,data:{translated_text:'こんにちは'}});
    service=new CompanionService(native as unknown as NativeAdapter,async()=>{});service.setWindowState(window);
  });
  afterEach(async()=>{await service.dispose();vi.useRealTimers();});
  it('has no editor timer before binding and starts one stable timer only while attached',async()=>{
    await service.dispose();native.readDraft.mockClear();fake.backgroundPolling.mockClear();
    service=new CompanionService(native as unknown as NativeAdapter,async()=>{});
    await Promise.resolve();await Promise.resolve();expect(fake.sessionOptions?.backgroundPolling).toBe(false);expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60000);expect(native.readDraft).not.toHaveBeenCalled();
    service.setWindowState(window);expect(fake.backgroundPolling).toHaveBeenLastCalledWith(true);expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(250);service.setWindowState({...window,bounds:{...window.bounds,x:20}});expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(250);expect(native.readDraft).toHaveBeenCalledOnce();
    service.setWindowState(null);expect(fake.backgroundPolling).toHaveBeenLastCalledWith(false);expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60000);expect(native.readDraft).toHaveBeenCalledOnce();
    service.setWindowState(window);await vi.advanceTimersByTimeAsync(500);expect(native.readDraft).toHaveBeenCalledTimes(2);
    await service.dispose();expect(vi.getTimerCount()).toBe(0);expect(fake.backgroundPolling).toHaveBeenLastCalledWith(false);
    service.setWindowState(window);await vi.advanceTimersByTimeAsync(60000);expect(vi.getTimerCount()).toBe(0);expect(native.readDraft).toHaveBeenCalledTimes(2);
  });
  it('starts with connecting until the first browser scan completes',async()=>{
    await service.dispose();let release!:()=>void;fake.sync.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
    service=new CompanionService(native as unknown as NativeAdapter,async()=>{});expect(service.getState().auth).toBe('connecting');
    release();await Promise.resolve();await Promise.resolve();expect(service.getState().auth).toBe('ready');
  });
  it('mounts and renews the local panel while authentication is pending',async()=>{
    await service.dispose();let release!:()=>void;
    fake.sync.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
    fake.identity=null;
    service=new CompanionService(native as unknown as NativeAdapter,async()=>{},()=>{},{},true);service.setWindowState(window);
    const external={targetInstanceId:'1:2:3',mountWorkbench:vi.fn(async()=>{}),updateWorkbench:vi.fn(async()=>{}),read:vi.fn(async()=>({writeVerified:false,reason:'COMPOSER_UNAVAILABLE'})),renew:vi.fn(async()=>{}),replace:vi.fn(async()=>{}),close:vi.fn(async()=>{})};
    vi.mocked(connectExternalComposer).mockResolvedValueOnce(external);
    await service.connectComposer();
    expect(external.mountWorkbench).toHaveBeenCalledWith(expect.objectContaining({auth:'connecting'}),expect.any(Function));
    expect(fake.translate).not.toHaveBeenCalled();expect(external.replace).not.toHaveBeenCalled();
    service.setWindowState({...window,foreground:false,groupForeground:false});
    await vi.advanceTimersByTimeAsync(7000);expect(external.renew).toHaveBeenCalled();expect(external.close).not.toHaveBeenCalled();
    release();await Promise.resolve();await Promise.resolve();
  });
  it('keeps a pending local connection through auth recovery but rejects a changed window',async()=>{
    for(const changeWindow of [false,true]){
      let resolve!: (value:any)=>void;
      vi.mocked(connectExternalComposer).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
      const pending=service.connectComposer();await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));
      fake.changed?.(fake.identity);
      if(changeWindow)service.setWindowState({...window,targetInstanceId:'4:5:6'});
      const external={targetInstanceId:'1:2:3',mountWorkbench:vi.fn(async()=>{}),read:vi.fn(async()=>({writeVerified:false,reason:'COMPOSER_UNAVAILABLE'})),renew:vi.fn(async()=>{}),replace:vi.fn(async()=>{}),close:vi.fn(async()=>{})};
      resolve(external);await pending;
      if(changeWindow){expect(external.mountWorkbench).not.toHaveBeenCalled();expect(external.close).toHaveBeenCalled();}
      else expect(external.mountWorkbench).toHaveBeenCalled();
    }
  });
  it('cancels obsolete window discovery immediately instead of waiting for its timeout',async()=>{
    let signal:AbortSignal|undefined;
    vi.mocked(connectExternalComposer).mockImplementationOnce((_id,current)=>new Promise((_resolve,reject)=>{
      signal=current;current!.addEventListener('abort',()=>reject(new Error('CONNECTION_SUPERSEDED')),{once:true});
    }));
    const pending=service.connectComposer();await vi.waitFor(()=>expect(signal).toBeDefined());
    service.setWindowState({...window,targetInstanceId:'4:5:6'});
    await pending;expect(signal!.aborted).toBe(true);
    expect(service.getState().targetInstanceId).toBe('4:5:6');expect(service.getState().error).toBeNull();
  });
  it('retains permission failures as failed and clears their error on background recovery',async()=>{
    await Promise.resolve();await Promise.resolve();fake.identity=null;fake.changed?.(null);
    expect(service.getState().auth).toBe('connecting');
    fake.sessionOptions?.onStatus?.('failed','BROWSER_SESSION_ACCESS_DENIED');
    expect(service.getState()).toMatchObject({auth:'failed',phase:'failed'});expect(service.getState().error).toContain('系统阻止读取浏览器登录态');
    service.reportBrowserFailure('BROWSER_PLACEMENT_FAILED');expect(service.getState().error).toContain('系统阻止读取浏览器登录态');
    fake.identity={accountScope:'psim:test',authGeneration:2,permissions:[]};fake.changed?.(fake.identity);fake.sessionOptions?.onStatus?.('ready');
    expect(service.getState()).toMatchObject({auth:'ready',phase:'idle',error:null});
  });
  it('shows needs_login only after a completed no-session scan',async()=>{
    await Promise.resolve();await Promise.resolve();fake.identity=null;fake.changed?.(null);fake.sessionOptions?.onStatus?.('needs_login');
    expect(service.getState()).toMatchObject({auth:'needs_login',error:null});
  });
  it('discovers the existing browser identity at startup and opens only the browser session entry',async()=>{
    await Promise.resolve();await Promise.resolve();
    expect(fake.sync).toHaveBeenCalledOnce();expect(service.getState()).toMatchObject({auth:'ready',accountScope:'psim:test'});
    await service.openLogin();expect(fake.openLogin).toHaveBeenCalledOnce();
  });
  it('syncs the browser identity before translation and rejects an account change before replacement',async()=>{
    await service.translate('ja');expect(fake.sync).toHaveBeenCalledTimes(2);
    fake.identity={accountScope:'psim:other',authGeneration:2,permissions:[]};
    await service.replaceDraft();expect(fake.sync).toHaveBeenCalledTimes(3);expect(native.replaceDraft).not.toHaveBeenCalled();expect(service.getState().preview).toBeNull();
  });
  it('revokes a delayed translation when the browser session changes',async()=>{
    let complete!:(value:any)=>void;fake.translate.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
    const pending=service.translate('ja');await vi.waitFor(()=>expect(fake.translate).toHaveBeenCalled());
    fake.identity=null;fake.changed?.(null);fake.sessionOptions?.onStatus?.('needs_login');complete({success:true,data:{translated_text:'旧账户译文'}});await pending;
    expect(service.getState()).toMatchObject({auth:'needs_login',preview:null});expect(native.replaceDraft).not.toHaveBeenCalled();
  });
  it('reads the source from the real textbox and replaces only a reviewed response with readback',async()=>{
    await service.translate('ja');expect(service.getState().phase).toBe('ready');
    expect(fake.translate.mock.calls[0][0]).toMatchObject({text:'你好',purpose:'outbound',source_lang:'zh',target_lang:'ja'});
    await service.replaceDraft();expect(native.replaceDraft).toHaveBeenCalledOnce();expect(service.getState()).toMatchObject({phase:'replaced',preview:null,draft:{text:'こんにちは'}});
  });
  it.each(['translate','replace','read'] as const)('waits for an in-flight background observation before the user %s action',async action=>{
    if(action==='replace')await service.translate('ja');else await service.readDraft();
    let release!:(value:NativeDraftSnapshot)=>void;
    native.readDraft.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    await vi.advanceTimersByTimeAsync(500);
    const reads=native.readDraft.mock.calls.length;
    let finished=false;
    const operation=(action==='translate'?service.translate('ja'):action==='replace'?service.replaceDraft():service.readDraft()).then(()=>{finished=true;});
    await Promise.resolve();await Promise.resolve();
    expect(finished).toBe(false);
    expect(native.readDraft).toHaveBeenCalledTimes(reads);
    release(structuredClone(draft));await operation;
    expect(native.readDraft.mock.calls.length).toBeGreaterThan(reads);
    expect(service.getState().phase).toBe(action==='translate'?'ready':action==='replace'?'replaced':'idle');
    if(action==='replace')expect(native.replaceDraft).toHaveBeenCalledOnce();
  });
  it('does not write a queued replacement when the observation discovers a changed draft',async()=>{
    await service.translate('ja');
    let release!:(value:NativeDraftSnapshot)=>void;
    native.readDraft.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    await vi.advanceTimersByTimeAsync(500);
    const pending=service.replaceDraft();
    draft={...draft,text:'更新后的草稿',revision:'C'.repeat(64)};
    release(structuredClone(draft));await pending;
    expect(native.replaceDraft).not.toHaveBeenCalled();
    expect(service.getState()).toMatchObject({phase:'stale',preview:null,draft:{text:'更新后的草稿'}});
  });
  it('does not translate a different bound window after waiting for an observation',async()=>{
    await service.readDraft();fake.translate.mockClear();
    let release!:(value:NativeDraftSnapshot)=>void;
    native.readDraft.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    await vi.advanceTimersByTimeAsync(500);
    const pending=service.translate('ja');
    service.setWindowState({...window,targetInstanceId:'4:5:6'});
    release(structuredClone(draft));await pending;
    expect(fake.translate).not.toHaveBeenCalled();
    expect(service.getState()).toMatchObject({targetInstanceId:'4:5:6',draft:null,preview:null});
  });
  it('rejects replacement after edits even if the preview has not polled yet',async()=>{
    await service.translate('ja');draft={...draft,text:'另一条回复',revision:'C'.repeat(64)};
    await service.replaceDraft();expect(native.replaceDraft).not.toHaveBeenCalled();expect(service.getState().preview).toBeNull();
  });
  it('rejects a delayed translation after window binding changes',async()=>{
    let complete!:(value:any)=>void;fake.translate.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
    const pending=service.translate('ja');await vi.waitFor(()=>expect(fake.translate).toHaveBeenCalled());
    service.setWindowState({...window,targetInstanceId:'4:5:6'});complete({success:true,data:{translated_text:'旧客户译文'}});await pending;
    expect(service.getState().preview).toBeNull();expect(native.replaceDraft).not.toHaveBeenCalled();
  });
  it('a logout revokes a ready replacement',async()=>{
    await service.translate('ja');await service.logout();await service.replaceDraft();expect(native.replaceDraft).not.toHaveBeenCalled();expect(service.getState().preview).toBeNull();
  });
  it('never writes when the native textbox only exposes readable text',async()=>{
    draft.canReplace=false;await service.translate('ja');await service.replaceDraft();expect(native.replaceDraft).not.toHaveBeenCalled();expect(service.getState().phase).toBe('failed');
  });
  it('rechecks visible identifier positions at click time even during a translation',async()=>{
    const snapshot:VerifiedComposerSnapshot={text:'你好',conversationId:'customer-a',revision:1,composing:false,scopeGeneration:1,authGeneration:1,editorIdentity:'editor',docFingerprint:'plain-doc',isPlainText:true,platformAccountScope:'vendor-a',composerId:'editor',documentGeneration:1};
    const entry={identifier:'OD-12345678',identifierType:'order_number' as const,rect:{x:10,y:100,width:150,height:20}};
    const entries=[entry];
    const external={targetInstanceId:'1:2:3',read:vi.fn(async()=>({snapshot:structuredClone(snapshot),writeVerified:true,orderEntries:structuredClone(entries),orderViewport:{width:800,height:600,dpr:1}})),renew:vi.fn(async()=>{}),replace:vi.fn(async()=>{}),close:vi.fn(async()=>{})};
    vi.mocked(connectExternalComposer).mockResolvedValueOnce(external);await service.connectComposer();
    expect(service.getState().orderEntries).toEqual(entries);await expect(service.confirmOrderEntry(0,entry)).resolves.toBeUndefined();
    entries[0]={...entry,rect:{...entry.rect,y:50}};
    await expect(service.confirmOrderEntry(0,entry)).rejects.toThrow('ORDER_ENTRY_STALE');
    entries[0]=entry;snapshot.conversationId='customer-b';snapshot.scopeGeneration++;
    await expect(service.confirmOrderEntry(0,entry)).rejects.toThrow('ORDER_ENTRY_STALE');expect(external.replace).not.toHaveBeenCalled();
  });
  it('revokes write authorization if logout happens during final document verification',async()=>{
    const snapshot:VerifiedComposerSnapshot={text:'你好',conversationId:'customer-a',revision:1,composing:false,scopeGeneration:1,authGeneration:1,editorIdentity:'editor',docFingerprint:'plain-doc',isPlainText:true,platformAccountScope:'vendor-a',composerId:'editor',documentGeneration:1};
    let release!:(value:void)=>void;const verification=new Promise<void>(resolve=>{release=resolve;});
    let writes=0;
    const external={targetInstanceId:'1:2:3',read:vi.fn(async()=>({snapshot:structuredClone(snapshot),writeVerified:true,orderEntries:[],orderViewport:{width:800,height:600,dpr:1}})),renew:vi.fn(async()=>{}),replace:vi.fn(async(_expected:VerifiedComposerSnapshot,text:string,authorize:()=>void|Promise<void>)=>{await verification;await authorize();writes++;snapshot.text=text;}),close:vi.fn(async()=>{})};
    vi.mocked(connectExternalComposer).mockResolvedValueOnce(external);await service.connectComposer();await service.translate('ja');
    const pending=service.replaceDraft();await vi.waitFor(()=>expect(external.replace).toHaveBeenCalledOnce());
    // Browser logout is not pushed yet: only the final fresh sync can observe it.
    fake.sync.mockImplementationOnce(async()=>{fake.identity=null;});release();await pending;
    expect(writes).toBe(0);expect(snapshot.text).toBe('你好');expect(service.getState().preview).toBeNull();
  });
  it('closes the old order if a new conversation is first observed by an immediate translation',async()=>{
    await service.dispose();const changed=vi.fn();service=new CompanionService(native as unknown as NativeAdapter,async()=>{},changed);service.setWindowState(window);
    const snapshot:VerifiedComposerSnapshot={text:'你好',conversationId:'customer-a',revision:1,composing:false,scopeGeneration:1,authGeneration:1,editorIdentity:'editor',docFingerprint:'plain-doc',isPlainText:true,platformAccountScope:'vendor-a',composerId:'editor',documentGeneration:1};
    const external={targetInstanceId:'1:2:3',read:vi.fn(async()=>({snapshot:structuredClone(snapshot),writeVerified:true,orderEntries:[],orderViewport:{width:800,height:600,dpr:1}})),renew:vi.fn(async()=>{}),replace:vi.fn(async()=>{}),close:vi.fn(async()=>{})};
    vi.mocked(connectExternalComposer).mockResolvedValueOnce(external);await service.connectComposer();
    snapshot.conversationId='customer-b';snapshot.scopeGeneration++;await service.translate('ja');
    expect(changed).toHaveBeenCalledOnce();expect(service.getState()).toMatchObject({phase:'stale',preview:null,customerLanguage:'unknown',followCustomerLanguage:true});
  });
  it('clears composer and order overlays and invalidates review immediately when messages navigation becomes inactive',async()=>{
    const snapshot:VerifiedComposerSnapshot={text:'你好',conversationId:'customer-a',revision:1,composing:false,scopeGeneration:1,authGeneration:1,editorIdentity:'editor',docFingerprint:'plain-doc',isPlainText:true,platformAccountScope:'vendor-a',composerId:'editor',documentGeneration:1};let active=true;
    const entry={identifier:'0012345678901234',identifierType:'order_number' as const,rect:{x:700,y:100,width:150,height:20}};
    const external={targetInstanceId:'1:2:3',read:vi.fn(async()=>active?{snapshot:structuredClone(snapshot),writeVerified:true,orderEntries:[entry],orderViewport:{width:800,height:600,dpr:1},messageSurface:{active:true,composerRect:{x:100,y:400,width:500,height:200},toolbarRect:{x:300,y:400,width:300,height:40}}}:{writeVerified:false,reason:'MESSAGE_PAGE_INACTIVE',messageSurface:{active:false,composerRect:null,toolbarRect:null},orderEntries:[]}),renew:vi.fn(async()=>{}),replace:vi.fn(async()=>{}),close:vi.fn(async()=>{})};
    vi.mocked(connectExternalComposer).mockResolvedValueOnce(external);await service.connectComposer();await service.translate('ja');expect(service.getState()).toMatchObject({phase:'ready',messageSurface:{active:true},orderEntries:[entry]});
    active=false;await service.readDraft();expect(service.getState()).toMatchObject({draft:null,preview:null,composerSource:'unavailable',messageSurface:{active:false,composerRect:null,toolbarRect:null},orderEntries:[],orderViewport:null});await service.replaceDraft();expect(external.replace).not.toHaveBeenCalled();
  });
  it('clears only a failed initial capture when normal foreground observation recovers the verified editor',async()=>{
    const snapshot:VerifiedComposerSnapshot={text:'你好',conversationId:'customer-a',revision:1,composing:false,scopeGeneration:1,authGeneration:1,editorIdentity:'editor',docFingerprint:'plain-doc',isPlainText:true,platformAccountScope:'vendor-a',composerId:'editor',documentGeneration:1};let active=false;
    const external={targetInstanceId:'1:2:3',read:vi.fn(async()=>active?{snapshot:structuredClone(snapshot),writeVerified:true,orderEntries:[],orderViewport:{width:800,height:600,dpr:1},messageSurface:{active:true,composerRect:{x:100,y:400,width:500,height:200},toolbarRect:{x:300,y:400,width:300,height:40}}}:{writeVerified:false,reason:'MESSAGE_PAGE_INACTIVE',messageSurface:{active:false,composerRect:null,toolbarRect:null},orderEntries:[]}),renew:vi.fn(async()=>{}),replace:vi.fn(async()=>{}),close:vi.fn(async()=>{})};
    vi.mocked(connectExternalComposer).mockResolvedValueOnce(external);await service.connectComposer();expect(service.getState()).toMatchObject({phase:'failed',composerSource:'unavailable'});expect(service.getState().error).not.toBeNull();
    active=true;await vi.advanceTimersByTimeAsync(500);await service.setTranslationOptions({language:'ja'});expect(service.getState()).toMatchObject({phase:'waiting',error:null,composerSource:'verified-editor',messageSurface:{active:true}});
    fake.translate.mockRejectedValueOnce(new Error('SERVICE_UNAVAILABLE'));await service.translate('ja');const translationError=service.getState().error;expect(service.getState().phase).toBe('failed');
    active=false;await vi.advanceTimersByTimeAsync(500);active=true;await vi.advanceTimersByTimeAsync(500);expect(service.getState()).toMatchObject({phase:'failed',error:translationError,composerSource:'verified-editor'});
    await service.translate('ja');expect(service.getState().phase).toBe('ready');snapshot.revision++;await vi.advanceTimersByTimeAsync(500);expect(service.getState().phase).toBe('waiting');active=false;await vi.advanceTimersByTimeAsync(500);active=true;await vi.advanceTimersByTimeAsync(500);expect(service.getState().phase).toBe('waiting');await service.setTranslationOptions({language:'ja'});expect(service.getState().phase).toBe('waiting');
  });
  async function verified(){
    const snapshot:VerifiedComposerSnapshot={text:'你好',conversationId:'customer-a',revision:1,composing:false,scopeGeneration:1,authGeneration:1,editorIdentity:'editor',docFingerprint:'plain-doc',isPlainText:true,platformAccountScope:'vendor-a',composerId:'editor',documentGeneration:1};
    let notify:((event:any)=>void)|undefined;const unsubscribe=vi.fn(()=>{notify=undefined;});
    const external={onInteraction:vi.fn((listener:(event:any)=>void)=>{notify=listener;return unsubscribe;}),setInteractionOptions:vi.fn(async(_options:{shortcutEnabled:boolean})=>{}),targetInstanceId:'1:2:3',read:vi.fn(async()=>({snapshot:structuredClone(snapshot),writeVerified:true,orderEntries:[],orderViewport:{width:800,height:600,dpr:1},messageSurface:{active:true,composerRect:{x:100,y:400,width:500,height:200},toolbarRect:{x:300,y:400,width:300,height:40}}})),renew:vi.fn(async()=>{}),replace:vi.fn(async(_expected:VerifiedComposerSnapshot,text:string,authorize:()=>unknown)=>{await authorize();snapshot.text=text;snapshot.revision++;}),close:vi.fn(async()=>{})};
    vi.mocked(connectExternalComposer).mockResolvedValueOnce(external);await service.connectComposer();await service.setTranslationOptions({language:'ja'});return{snapshot,external,notify:(event:any)=>notify?.(event),unsubscribe};
  }
  const languageKey=(snapshot:VerifiedComposerSnapshot)=>JSON.stringify(['1:2:3',snapshot.conversationId,snapshot.scopeGeneration,snapshot.platformAccountScope]);
  it('retains a detected customer language after an unknown scan and while manual language is selected',async()=>{
    const {snapshot}=await verified();await service.followCustomerLanguage();
    await service.reportCustomerLanguage('en',languageKey(snapshot));await service.reportCustomerLanguage('unknown',languageKey(snapshot));
    expect(service.getState()).toMatchObject({customerLanguage:'en',language:'en',followCustomerLanguage:true});
    await service.setTranslationOptions({language:'ko'});await service.reportCustomerLanguage('unknown',languageKey(snapshot));
    expect(service.getState()).toMatchObject({customerLanguage:'en',language:'ko',followCustomerLanguage:false});
  });
  it.each(['MESSAGE_PAGE_INACTIVE','COMPOSER_UNAVAILABLE','READ_FAILED'])('retains same-customer preferences through a temporary %s read failure',async code=>{
    const {snapshot,external}=await verified();await service.reportCustomerLanguage('en',languageKey(snapshot));await service.translate('ja');
    external.read.mockRejectedValueOnce(new Error(code));await service.readDraft();
    expect(service.getState()).toMatchObject({preview:null,draft:null,customerLanguage:'en',language:'ja',followCustomerLanguage:false});
    await service.readDraft();expect(service.getState()).toMatchObject({customerLanguage:'en',language:'ja',followCustomerLanguage:false,draft:{canReplace:true}});
  });
  it.each(['conversation','document','account'] as const)('resets customer preferences if %s changes while captures are unavailable',async change=>{
    const {snapshot,external}=await verified();await service.reportCustomerLanguage('en',languageKey(snapshot));
    external.read.mockRejectedValueOnce(new Error('COMPOSER_UNAVAILABLE'));await service.readDraft();
    if(change==='conversation')snapshot.conversationId='customer-b';else if(change==='document')snapshot.documentGeneration++;else snapshot.platformAccountScope='vendor-b';
    await service.readDraft();expect(service.getState()).toMatchObject({customerLanguage:'unknown',language:'en',followCustomerLanguage:true,preview:null});
  });
  it('resets preferences on a changed authenticated account after temporary identity absence',async()=>{
    const {snapshot}=await verified();await service.reportCustomerLanguage('en',languageKey(snapshot));
    fake.changed?.(null);expect(service.getState().language).toBe('ja');
    fake.identity={accountScope:'psim:other',authGeneration:2,permissions:[]};fake.changed?.(fake.identity);
    expect(service.getState()).toMatchObject({customerLanguage:'unknown',language:'en',followCustomerLanguage:true,preview:null});
  });
  it('detects customer language on an unsupported document but refuses automatic/manual translation and send',async()=>{
    const {snapshot,external}=await verified();snapshot.isPlainText=false;snapshot.text='';snapshot.revision++;
    await service.readDraft();await service.followCustomerLanguage();await service.reportCustomerLanguage('en',languageKey(snapshot));
    expect(service.getState()).toMatchObject({customerLanguage:'en',language:'en',draft:{text:'',canReplace:false}});
    await vi.advanceTimersByTimeAsync(2000);await service.translate('en');await service.replaceDraft();
    expect(fake.translate).not.toHaveBeenCalled();expect(external.replace).not.toHaveBeenCalled();
  });
  it.each([false,true])('keeps customer language across editor remounts, with capture gap=%s',async gap=>{
    const {snapshot,external}=await verified();await service.followCustomerLanguage();await service.reportCustomerLanguage('en',languageKey(snapshot));await service.translate('en');
    if(gap){external.read.mockRejectedValueOnce(new Error('COMPOSER_UNAVAILABLE'));await service.readDraft();}
    snapshot.scopeGeneration++;snapshot.editorIdentity='remounted-editor';snapshot.composerId='remounted-editor';
    await service.readDraft();await service.reportCustomerLanguage('unknown',languageKey(snapshot));
    expect(service.getState()).toMatchObject({customerLanguage:'en',language:'en',followCustomerLanguage:true,preview:null});
    await service.replaceDraft();expect(external.replace).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);expect(fake.translate).toHaveBeenCalledTimes(2);expect(service.getState().phase).toBe('ready');
  });
  it('invalidates old order context when only the editor scope changes',async()=>{
    await service.dispose();const changed=vi.fn();service=new CompanionService(native as unknown as NativeAdapter,async()=>{},changed);service.setWindowState(window);
    const {snapshot}=await verified();await service.reportCustomerLanguage('en',languageKey(snapshot));await service.translate('ja');
    snapshot.scopeGeneration++;await service.readDraft();
    expect(changed).toHaveBeenCalledOnce();expect(service.getState()).toMatchObject({customerLanguage:'en',language:'ja',followCustomerLanguage:false,preview:null});
  });
  it('keeps manual selection and pause across a same-customer editor remount',async()=>{
    const {snapshot}=await verified();await service.reportCustomerLanguage('en',languageKey(snapshot));await service.cancelTranslation();
    snapshot.scopeGeneration++;snapshot.editorIdentity='remounted-editor';await service.readDraft();
    expect(service.getState()).toMatchObject({customerLanguage:'en',language:'ja',followCustomerLanguage:false,translationPaused:true});
    await vi.advanceTimersByTimeAsync(2000);expect(fake.translate).not.toHaveBeenCalled();
    snapshot.documentGeneration++;await service.readDraft();expect(service.getState()).toMatchObject({customerLanguage:'unknown',followCustomerLanguage:true,translationPaused:false});
  });
  it('retries the current text after unsupported quote content disappears even if its snapshot returns unchanged',async()=>{
    const {snapshot}=await verified();await service.translate('ja');const plain=structuredClone(snapshot);
    snapshot.isPlainText=false;snapshot.text='';snapshot.docFingerprint='quoted-doc';await service.readDraft();
    expect(service.getState().preview).toBeNull();await vi.advanceTimersByTimeAsync(1000);expect(fake.translate).toHaveBeenCalledOnce();
    Object.assign(snapshot,plain);await service.readDraft();await vi.advanceTimersByTimeAsync(1500);
    expect(fake.translate).toHaveBeenCalledTimes(2);expect(service.getState().phase).toBe('ready');
  });
  it.each(['en','ja'] as const)('does not translate a new customer with the old %s target after a capture gap',async target=>{
    const {snapshot,external}=await verified();await service.setTranslationOptions({language:target});await service.reportCustomerLanguage('ja',languageKey(snapshot));
    external.read.mockRejectedValueOnce(new Error('COMPOSER_UNAVAILABLE'));await service.readDraft();
    snapshot.conversationId='customer-b';snapshot.scopeGeneration++;
    await service.translate(target);await vi.advanceTimersByTimeAsync(2000);
    expect(fake.translate).not.toHaveBeenCalled();expect(service.getState()).toMatchObject({customerLanguage:'unknown',followCustomerLanguage:true,language:'en',preview:null});
  });
  it('adopts the fresh customer and revokes an old preview when a language report discovers a mismatch',async()=>{
    const {snapshot}=await verified();await service.followCustomerLanguage();await service.reportCustomerLanguage('en',languageKey(snapshot));await service.translate('en');
    const oldKey=languageKey(snapshot);snapshot.conversationId='customer-b';snapshot.scopeGeneration++;
    await service.reportCustomerLanguage('ja',oldKey);await service.replaceDraft();
    expect(service.getState()).toMatchObject({customerLanguage:'unknown',followCustomerLanguage:true,preview:null,draft:{text:'你好'}});
    expect(fake.translate).toHaveBeenCalledOnce();
  });
  it('rejects an old language report whose editor read finishes after target change',async()=>{
    const {snapshot,external}=await verified();let release!:(value:any)=>void;
    external.read.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const pending=service.reportCustomerLanguage('en',languageKey(snapshot));await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    service.setWindowState({...window,targetInstanceId:'other-window'});release({snapshot:structuredClone(snapshot),writeVerified:true});await pending;
    expect(service.getState()).toMatchObject({targetInstanceId:'other-window',customerLanguage:'unknown',draft:null,preview:null});
  });
  it('does not start old-customer translation when the customer changes during authentication wait',async()=>{
    const {snapshot}=await verified();let release!:()=>void;fake.sync.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
    const pending=service.translate('ja');await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    snapshot.conversationId='customer-b';snapshot.scopeGeneration++;release();await pending;
    expect(fake.translate).not.toHaveBeenCalled();expect(service.getState()).toMatchObject({customerLanguage:'unknown',followCustomerLanguage:true,preview:null});
  });
  it('rejects a delayed completion after observed A to B to A transitions even when A returns with the exact old snapshot',async()=>{
    const {snapshot}=await verified();const original=structuredClone(snapshot);let finish!:(value:any)=>void;
    fake.translate.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const pending=service.translate('ja');await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
    snapshot.conversationId='customer-b';snapshot.scopeGeneration++;await service.readDraft();Object.assign(snapshot,original);await service.readDraft();
    finish({data:{translated_text:'old customer result'}});await pending;await vi.advanceTimersByTimeAsync(1500);
    expect(service.getState()).toMatchObject({customerLanguage:'unknown',followCustomerLanguage:true,preview:null});expect(fake.translate).toHaveBeenCalledOnce();
  });
  it('rejects replacement and clears old language when a same-text different customer is first seen by apply',async()=>{
    const {snapshot,external}=await verified();await service.reportCustomerLanguage('ja',languageKey(snapshot));await service.translate('ja');
    snapshot.conversationId='customer-b';snapshot.scopeGeneration++;await service.replaceDraft();
    expect(external.replace).not.toHaveBeenCalled();expect(service.getState()).toMatchObject({customerLanguage:'unknown',followCustomerLanguage:true,preview:null});
  });
  it('continues renewing an attached background editor every 500ms and stops after detaching',async()=>{
    const {external,unsubscribe}=await verified();service.setWindowState({...window,foreground:false,groupForeground:false});
    external.read.mockClear();await vi.advanceTimersByTimeAsync(5500);
    expect(external.renew).toHaveBeenCalledTimes(11);expect(external.read).not.toHaveBeenCalled();
    service.setWindowState(null);expect(external.close).toHaveBeenCalledOnce();expect(unsubscribe).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10000);expect(external.renew).toHaveBeenCalledTimes(11);expect(external.read).not.toHaveBeenCalled();
  });
  it('debounces settled verified drafts, restarts after typing and never retransmits unchanged polls',async()=>{
    const {snapshot,notify}=await verified();await vi.advanceTimersByTimeAsync(400);expect(fake.translate).not.toHaveBeenCalled();
    snapshot.text='新的回复';snapshot.revision++;notify({type:'draft-changed'});await vi.advanceTimersByTimeAsync(0);expect(fake.translate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(499);expect(fake.translate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);expect(fake.translate).toHaveBeenCalledOnce();expect(fake.translate.mock.calls[0][0].text).toBe('新的回复');
    await vi.advanceTimersByTimeAsync(5000);expect(fake.translate).toHaveBeenCalledOnce();expect(service.getState().phase).toBe('ready');
  });
  it('waits for IME composition to finish and ignores empty drafts',async()=>{
    const {snapshot}=await verified();snapshot.composing=true;snapshot.revision++;await vi.advanceTimersByTimeAsync(4000);expect(fake.translate).not.toHaveBeenCalled();
    snapshot.composing=false;snapshot.revision++;await vi.advanceTimersByTimeAsync(500);await vi.advanceTimersByTimeAsync(499);expect(fake.translate).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);expect(fake.translate).toHaveBeenCalledOnce();
    snapshot.text='  ';snapshot.revision++;await vi.advanceTimersByTimeAsync(5000);expect(fake.translate).toHaveBeenCalledOnce();expect(service.getState().preview).toBeNull();
  });
  it('observes while a slow provider ignores abort and lets the latest language win',async()=>{
    const {snapshot}=await verified();let complete!:(value:any)=>void;fake.translate.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
    const old=service.translate('ja');await vi.waitFor(()=>expect(fake.translate).toHaveBeenCalledOnce());
    snapshot.text='新的回复';snapshot.revision++;await vi.advanceTimersByTimeAsync(500);expect(service.getState().draft?.text).toBe('新的回复');expect(fake.translate.mock.calls[0][2].aborted).toBe(true);
    await service.setTranslationOptions({language:'en'});await vi.advanceTimersByTimeAsync(1500);expect(fake.translate).toHaveBeenCalledTimes(2);expect(fake.translate.mock.calls[1][0].target_lang).toBe('en');
    complete({data:{translated_text:'旧译文'}});await old;expect(service.getState()).toMatchObject({language:'en',preview:'こんにちは',phase:'ready'});
  });
  it('rejects a same-text ABA revision and conversation transition from an old request',async()=>{
    const {snapshot}=await verified();let complete!:(value:any)=>void;fake.translate.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
    const old=service.translate('ja');await vi.waitFor(()=>expect(fake.translate).toHaveBeenCalledOnce());
    snapshot.revision+=2;snapshot.conversationId='customer-b';snapshot.scopeGeneration++;await vi.advanceTimersByTimeAsync(500);
    complete({data:{translated_text:'旧客户译文'}});await old;expect(service.getState().preview).toBeNull();expect(service.getState()).toMatchObject({phase:'stale',customerLanguage:'unknown',followCustomerLanguage:true});
  });
  it('pauses the current conversation through edits and resumes explicitly or on route change',async()=>{
    const {snapshot}=await verified();await service.cancelTranslation();snapshot.text='改写';snapshot.revision++;await vi.advanceTimersByTimeAsync(4000);expect(fake.translate).not.toHaveBeenCalled();expect(service.getState().translationPaused).toBe(true);
    await service.resumeTranslation();await vi.advanceTimersByTimeAsync(1500);expect(fake.translate).toHaveBeenCalledOnce();
    await service.cancelTranslation();snapshot.conversationId='customer-b';snapshot.scopeGeneration++;await vi.advanceTimersByTimeAsync(2000);expect(service.getState().translationPaused).toBe(false);expect(fake.translate).toHaveBeenCalledOnce();
  });
  it('does not auto retry provider failure but permits manual retry',async()=>{
    await verified();fake.translate.mockRejectedValueOnce(new Error('SERVICE_UNAVAILABLE'));await vi.advanceTimersByTimeAsync(6000);expect(fake.translate).toHaveBeenCalledOnce();expect(service.getState().phase).toBe('failed');
    await service.translate('ja');expect(fake.translate).toHaveBeenCalledTimes(2);expect(service.getState().phase).toBe('ready');
  });
  it('preserves replacement feedback and suppresses inserted text until a genuine edit or language action',async()=>{
    const {snapshot,external}=await verified();await service.translate('ja');await service.replaceDraft();expect(external.replace).toHaveBeenCalledOnce();expect(service.getState().phase).toBe('replaced');
    await vi.advanceTimersByTimeAsync(6000);expect(fake.translate).toHaveBeenCalledOnce();expect(service.getState().phase).toBe('replaced');
    snapshot.text+='!';snapshot.revision++;await vi.advanceTimersByTimeAsync(2000);expect(fake.translate).toHaveBeenCalledTimes(2);
    await service.replaceDraft();await service.setTranslationOptions({language:'en'});await vi.advanceTimersByTimeAsync(1500);expect(fake.translate).toHaveBeenCalledTimes(3);
  });
  it('disables auto translation independently and invalidates previews on language changes',async()=>{
    await verified();await service.setTranslationOptions({autoTranslate:false});await vi.advanceTimersByTimeAsync(4000);expect(fake.translate).not.toHaveBeenCalled();
    await service.translate('ja');expect(service.getState().preview).toBeTruthy();await service.setTranslationOptions({language:'ko'});expect(service.getState().preview).toBeNull();await vi.advanceTimersByTimeAsync(4000);expect(fake.translate).toHaveBeenCalledOnce();
    await service.setTranslationOptions({autoTranslate:true});await vi.advanceTimersByTimeAsync(1500);expect(fake.translate).toHaveBeenCalledTimes(2);
  });
  it('holds debounce in background, resumes aborted requests, and retains a ready review across focus changes',async()=>{
    await verified();service.setWindowState({...window,foreground:false,groupForeground:false});await vi.advanceTimersByTimeAsync(4000);expect(fake.translate).not.toHaveBeenCalled();
    service.setWindowState(window);let complete!:(value:any)=>void;fake.translate.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));await vi.advanceTimersByTimeAsync(1500);expect(fake.translate).toHaveBeenCalledOnce();
    service.setWindowState({...window,foreground:false,groupForeground:false});expect(fake.translate.mock.calls[0][2].aborted).toBe(true);service.setWindowState(window);await vi.advanceTimersByTimeAsync(1500);expect(fake.translate).toHaveBeenCalledTimes(2);
    complete({data:{translated_text:'旧结果'}});await Promise.resolve();await Promise.resolve();const preview=service.getState().preview;
    service.setWindowState({...window,foreground:false,groupForeground:false});await service.replaceDraft();expect(service.getState()).toMatchObject({preview,phase:'ready'});service.setWindowState(window);await vi.advanceTimersByTimeAsync(3000);expect(fake.translate).toHaveBeenCalledTimes(2);
  });

  it('queues result verification behind an active order read instead of silently dropping the result',async()=>{
    const {snapshot,external}=await verified();let finish!:(value:any)=>void;fake.translate.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const pending=service.translate('ja');await vi.waitFor(()=>expect(fake.translate).toHaveBeenCalledOnce());
    let release!:(value:any)=>void;external.read.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const entry={identifier:'OD-123456',identifierType:'order_number' as const,rect:{x:10,y:10,width:100,height:20}};
    // No such entry: the order read will reject, but must still release the editor lease.
    const order=service.confirmOrderEntry(0,entry).catch(()=>{});await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    finish({data:{translated_text:'保留译文'}});await Promise.resolve();expect(service.getState().preview).toBeNull();
    release({snapshot:structuredClone(snapshot),writeVerified:true,orderEntries:[],orderViewport:{width:800,height:600,dpr:1}});await order;await pending;expect(service.getState()).toMatchObject({phase:'ready',preview:'保留译文'});
  });
  it('retranslates after a transient message-page capture failure clears a successful preview',async()=>{
    const {external}=await verified();await service.translate('ja');external.read.mockRejectedValueOnce(new Error('MESSAGE_PAGE_INACTIVE'));
    await vi.advanceTimersByTimeAsync(500);expect(service.getState().preview).toBeNull();await vi.advanceTimersByTimeAsync(2000);expect(fake.translate).toHaveBeenCalledTimes(2);expect(service.getState().followCustomerLanguage).toBe(false);await service.setTranslationOptions({language:'ja'});await vi.advanceTimersByTimeAsync(1500);expect(fake.translate).toHaveBeenCalledTimes(2);expect(service.getState().phase).toBe('ready');
  });
  it('restores automatic translation after browser authentication is revoked and restored',async()=>{
    await verified();await service.translate('ja');const identity=fake.identity;fake.identity=null;fake.changed?.(null);expect(service.getState().preview).toBeNull();
    fake.identity=identity;fake.changed?.(identity);await vi.advanceTimersByTimeAsync(1500);expect(fake.translate).toHaveBeenCalledTimes(2);expect(service.getState().phase).toBe('ready');
  });
  it('completes a manual retry when fresh authentication is first discovered during that click',async()=>{
    const {snapshot}=await verified();await service.setTranslationOptions({autoTranslate:false});
    fake.identity=null;fake.changed?.(null);
    const recovered={accountScope:'psim:test',authGeneration:2,permissions:[]};snapshot.authGeneration=2;
    fake.sync.mockImplementationOnce(async()=>{fake.identity=recovered;});
    await service.translate('ja');
    expect(fake.translate).toHaveBeenCalledOnce();expect(fake.translate.mock.calls[0][1]).toEqual(recovered);
    expect(service.getState()).toMatchObject({auth:'ready',accountScope:'psim:test',phase:'ready',preview:'こんにちは'});
  });
  it.each(['cancel','window'] as const)('does not revive a manual translate intent after %s while authenticating',async action=>{
    await verified();await service.setTranslationOptions({autoTranslate:false});
    let release!:()=>void;fake.sync.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
    const pending=service.translate('ja');await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    if(action==='cancel')await service.cancelTranslation();else service.setWindowState({...window,targetInstanceId:'new-window'});
    release();await pending;expect(fake.translate).not.toHaveBeenCalled();
  });

  it.each(['language','cancel','foreground'] as const)('does not execute stale translate intent queued behind observation after %s changes',async action=>{
    const {snapshot,external}=await verified();let release!:(value:any)=>void;external.read.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));await vi.advanceTimersByTimeAsync(500);
    const pending=service.translate('ja');await Promise.resolve();await Promise.resolve();
    if(action==='language')await service.setTranslationOptions({language:'en'});else if(action==='cancel')await service.cancelTranslation();else service.setWindowState({...window,foreground:false,groupForeground:false});
    release({snapshot:structuredClone(snapshot),writeVerified:true,orderEntries:[],orderViewport:{width:800,height:600,dpr:1}});await pending;expect(fake.translate).not.toHaveBeenCalled();expect(service.getState().preview).toBeNull();
  });
  it('acquires the response editor lease atomically against a simultaneous explicit read',async()=>{
    const {snapshot,external}=await verified();let finish!:(value:any)=>void;fake.translate.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const pending=service.translate('ja');await vi.waitFor(()=>expect(fake.translate).toHaveBeenCalledOnce());let release!:(value:any)=>void;external.read.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    finish({data:{translated_text:'最新结果'}});const read=service.readDraft();await vi.waitFor(()=>expect(release).toBeTypeOf('function'));const calls=external.read.mock.calls.length;
    await Promise.resolve();await Promise.resolve();expect(external.read).toHaveBeenCalledTimes(calls);
    release({snapshot:structuredClone(snapshot),writeVerified:true,orderEntries:[],orderViewport:{width:800,height:600,dpr:1}});await read;await pending;expect(service.getState()).toMatchObject({phase:'ready',preview:'最新结果'});
  });
  it.each(['MESSAGE_PAGE_INACTIVE','COMPOSER_UNAVAILABLE'])('recovers from an explicit %s read without losing automatic scheduling',async code=>{
    const {external}=await verified();await service.translate('ja');external.read.mockRejectedValueOnce(new Error(code));await service.readDraft();expect(service.getState().preview).toBeNull();await vi.advanceTimersByTimeAsync(500);if(code==='MESSAGE_PAGE_INACTIVE')await service.setTranslationOptions({language:'ja'});await vi.advanceTimersByTimeAsync(2000);expect(fake.translate).toHaveBeenCalledTimes(2);
  });

  it('invalidates a provider request immediately on input, before the poll, then debounces the latest input once',async()=>{
    const {snapshot,notify}=await verified();let finish!:(value:any)=>void;fake.translate.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const pending=service.translate('ja');await vi.waitFor(()=>expect(fake.translate).toHaveBeenCalledOnce());const signal=fake.translate.mock.calls[0][2];snapshot.text='new input';snapshot.revision++;notify({type:'draft-changed'});expect(signal.aborted).toBe(true);expect(service.getState().preview).toBeNull();await vi.advanceTimersByTimeAsync(0);expect(service.getState().draft?.text).toBe('new input');await vi.advanceTimersByTimeAsync(400);expect(fake.translate).toHaveBeenCalledOnce();snapshot.text='latest input';snapshot.revision++;notify({type:'draft-changed'});await vi.advanceTimersByTimeAsync(0);await vi.advanceTimersByTimeAsync(499);expect(fake.translate).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(1);expect(fake.translate).toHaveBeenCalledTimes(2);expect(fake.translate.mock.calls[1][0].text).toBe('latest input');finish({data:{translated_text:'obsolete'}});await pending;expect(service.getState().preview).toBe('こんにちは');await vi.advanceTimersByTimeAsync(2500);expect(fake.translate).toHaveBeenCalledTimes(2);
  });
  it('uses the exact captured native shortcut once and suppresses replacement feedback retranslations',async()=>{const {snapshot,notify,external}=await verified();await service.translate('ja');const expected=structuredClone(snapshot);notify({type:'replace-shortcut',snapshot:expected});notify({type:'replace-shortcut',snapshot:expected});await vi.advanceTimersByTimeAsync(0);expect(external.replace).toHaveBeenCalledOnce();expect(service.getState().phase).toBe('replaced');await vi.advanceTimersByTimeAsync(3000);expect(fake.translate).toHaveBeenCalledOnce();expect(native.replaceDraft).not.toHaveBeenCalled();});
  it.each(['stale','paused','disabled','background','auth','no-preview'] as const)('refuses a native shortcut when %s',async mode=>{const {snapshot,notify,external}=await verified();if(mode!=='no-preview')await service.translate('ja');let expected=structuredClone(snapshot);if(mode==='stale')expected.revision--;if(mode==='paused')await service.cancelTranslation();if(mode==='disabled')await service.setTranslationOptions({shortcutEnabled:false});if(mode==='background')service.setWindowState({...window,foreground:false,groupForeground:false});if(mode==='auth'){fake.identity=null;fake.changed?.(null);}notify({type:'replace-shortcut',snapshot:expected});await vi.advanceTimersByTimeAsync(0);expect(external.replace).not.toHaveBeenCalled();});
  it('does not apply a shortcut queued behind an observation when its old preview changes',async()=>{const {snapshot,notify,external}=await verified();await service.translate('ja');const expected=structuredClone(snapshot);let release!:(value:any)=>void;external.read.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));await vi.advanceTimersByTimeAsync(500);notify({type:'replace-shortcut',snapshot:expected});await service.setTranslationOptions({language:'en'});release({snapshot:structuredClone(snapshot),writeVerified:true});await vi.advanceTimersByTimeAsync(0);expect(external.replace).not.toHaveBeenCalled();});
  it('synchronizes shortcut toggles and detaches interaction listeners on target change',async()=>{const {notify,external,unsubscribe}=await verified();expect(external.setInteractionOptions).toHaveBeenLastCalledWith({shortcutEnabled:true});await service.setTranslationOptions({shortcutEnabled:false});expect(external.setInteractionOptions).toHaveBeenLastCalledWith({shortcutEnabled:false});await service.setTranslationOptions({shortcutEnabled:true});await service.cancelTranslation();expect(external.setInteractionOptions).toHaveBeenLastCalledWith({shortcutEnabled:true});fake.identity=null;fake.changed?.(null);expect(external.setInteractionOptions).toHaveBeenLastCalledWith({shortcutEnabled:true});await service.resumeTranslation();expect(external.setInteractionOptions).toHaveBeenLastCalledWith({shortcutEnabled:true});service.setWindowState({...window,targetInstanceId:'4:5:6'});expect(unsubscribe).toHaveBeenCalledOnce();notify({type:'draft-changed'});expect(service.getState().targetInstanceId).toBe('4:5:6');expect(service.getState().draft).toBeNull();});

});
