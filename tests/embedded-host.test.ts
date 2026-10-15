import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelState, VerifiedComposerSnapshot } from '../src/shared/workbench';
import type { WindowState, NativeAdapter } from '../electron/native-adapter';
const fake=vi.hoisted(()=>({changed:undefined as undefined|((identity:any)=>void),identity:{accountScope:'psim:test',authGeneration:1,permissions:[]} as any,query:vi.fn(),connect:vi.fn()}));
vi.mock('../electron/browser-profile-session',()=>({BrowserProfileSessionService:class {
  private observed='';constructor(changed:any){fake.changed=changed;}setBackgroundPolling(){}identity(){return fake.identity;}
  async sync(){const key=JSON.stringify(fake.identity);if(key!==this.observed){this.observed=key;fake.changed?.(fake.identity);}}
  queryOriginalIdentifier(...args:unknown[]){return fake.query(...args);}translate(){return Promise.resolve({success:true,data:{translated_text:'hello'}});}openLogin(){return Promise.resolve();}logout(){fake.identity=null;fake.changed?.(null);return Promise.resolve();}dispose(){}
}}));
vi.mock('../electron/external-composer',()=>({connectExternalComposer:fake.connect}));
import { CompanionService } from '../electron/companion-service';
import { invokeEmbeddedAction } from '../electron/embedded-host';

describe('embedded companion host',()=>{
  const window:WindowState={targetInstanceId:'1:2:3',bounds:{x:0,y:0,width:800,height:600},visible:true,minimized:false,foreground:true,groupForeground:true,dpi:96};
  let service:CompanionService,states:PanelState[],action:(action:string,args:unknown[])=>Promise<void>,invalidated:()=>void,snapshot:VerifiedComposerSnapshot,external:any,native:any;
  beforeEach(async()=>{
    vi.useFakeTimers();fake.identity={accountScope:'psim:test',authGeneration:1,permissions:[]};fake.query.mockReset();fake.connect.mockReset();states=[];
    snapshot={text:'你好',conversationId:'chat-1',revision:1,composing:false,scopeGeneration:1,authGeneration:1,editorIdentity:'editor-1',docFingerprint:'draft-1',isPlainText:true,platformAccountScope:'merchant-1',composerId:'composer-1',documentGeneration:1};
    external={targetInstanceId:'1:2:3',read:vi.fn(async()=>({snapshot:structuredClone(snapshot),writeVerified:true,messageSurface:{active:true,composerRect:null,toolbarRect:null},orderEntries:[]})),renew:vi.fn(async()=>{}),replace:vi.fn(async()=>{}),close:vi.fn(async()=>{}),mountWorkbench:vi.fn(async(state:PanelState,handler:typeof action)=>{states.push(state);action=handler;}),updateWorkbench:vi.fn(async(state:PanelState)=>{states.push(state);}),onInvalidated:(handler:()=>void)=>{invalidated=handler;return()=>{};}};
    fake.connect.mockResolvedValue(external);native={readDraft:vi.fn()};service=new CompanionService(native as NativeAdapter,async()=>{},()=>{},{},true);service.setWindowState(window);await service.connectComposer();await service.setTranslationOptions({autoTranslate:false});
    fake.query.mockResolvedValue({identifier:'000123',found:true,fields:[{label:'订单ID',value:'000123'}]});
  });
  afterEach(async()=>{await service.dispose();vi.useRealTimers();});
  it('mounts the verified page port with current auth while retaining credentials in the host',async()=>{
    expect(external.mountWorkbench).toHaveBeenCalledOnce();expect(native.readDraft).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({auth:'ready',target:'en',followCustomer:{following:true,lang:'unknown'},draft:{text:'你好'}});
    expect(JSON.stringify(states)).not.toContain('psim:test');
  });
  it('defaults to automatic unknown, follows observed customers, supports override, and resets on conversation change',async()=>{
    await service.setTranslationOptions({autoTranslate:true});await vi.advanceTimersByTimeAsync(3000);expect(service.getState().preview).toBeNull();
    await action('retry',[]);expect(service.getState().preview).toBeNull();
    const key=states.at(-1)!.conversationKey!;await action('customerLanguage',[{lang:'ko',conversationKey:key}]);
    expect(service.getState()).toMatchObject({language:'ko',customerLanguage:'ko',followCustomerLanguage:true});await vi.advanceTimersByTimeAsync(1500);expect(service.getState().phase).toBe('ready');
    await action('setTarget',[{lang:'ja',source:'manual'}]);expect(service.getState().preview).toBeNull();await action('customerLanguage',[{lang:'en',conversationKey:key}]);expect(service.getState()).toMatchObject({language:'ja',customerLanguage:'en',followCustomerLanguage:false});
    await action('followCustomer',[]);expect(service.getState()).toMatchObject({language:'en',followCustomerLanguage:true});
    snapshot.conversationId='chat-2';snapshot.scopeGeneration++;await service.readDraft();expect(service.getState()).toMatchObject({customerLanguage:'unknown',followCustomerLanguage:true,preview:null});
    await action('customerLanguage',[{lang:'ja',conversationKey:key}]);await vi.advanceTimersByTimeAsync(2000);expect(service.getState()).toMatchObject({customerLanguage:'unknown',preview:null});
  });
  it('does not accept a language report if a fresh editor read discovers another conversation',async()=>{
    const key=states.at(-1)!.conversationKey!;snapshot.conversationId='chat-2';snapshot.scopeGeneration++;await action('customerLanguage',[{lang:'ja',conversationKey:key}]);expect(service.getState()).toMatchObject({customerLanguage:'unknown',followCustomerLanguage:true});
  });
  it('revokes a reviewed translation when a same-language report sees a changed draft before the poll',async()=>{const key=states.at(-1)!.conversationKey!;await action('customerLanguage',[{lang:'ja',conversationKey:key}]);await service.translate('ja');expect(service.getState().phase).toBe('ready');snapshot.text='改写';snapshot.revision++;await action('customerLanguage',[{lang:'ja',conversationKey:key}]);expect(service.getState().preview).toBeNull();await action('apply',[{mode:'replace'}]);expect(external.replace).not.toHaveBeenCalled();});
  it('rejects sending, text injection, automatic language follow and unrecognized order metadata',async()=>{
    for(const [name,args] of [['apply',[{mode:'replace-send'}]],['apply',[{mode:'replace',text:'inject'}]],['setTarget',[{lang:'en',source:'auto'}]],['queryOrder',[{identifier:'123',identifierType:'iccid'}]],['queryOrder',[{identifier:'123\n456'}]],['evaluate',['alert(1)']]] as [string,unknown[]][]){await expect(action(name,args)).rejects.toThrow('INVALID_ACTION');}
    expect(fake.query).not.toHaveBeenCalled();expect(external.replace).not.toHaveBeenCalled();
  });
  it('rejects the retired order query intent even with a previously valid string identifier',async()=>{
    await expect(action('queryOrder',[{identifier:'000123'}])).rejects.toThrow('INVALID_ACTION');
    await expect(invokeEmbeddedAction(service,'queryOrder',[{identifier:'000123'}])).rejects.toThrow('INVALID_ACTION');
    expect(fake.query).not.toHaveBeenCalled();
  });
  it('keeps legacy host order results out of every renderer state',async()=>{
    await service.queryOrder('000123');
    expect(fake.query.mock.calls[0][0]).toBe('000123');expect(service.getOrderStatus()).toBe('ready');
    for(const state of states)expect(state).not.toHaveProperty('order');
    expect(JSON.stringify(states)).not.toContain('000123');
    expect(JSON.stringify(states)).not.toContain('订单ID');
  });
  it('discards an old order when a newer explicit query completes first',async()=>{
    let resolve!:(value:any)=>void;fake.query.mockImplementationOnce(()=>new Promise(done=>resolve=done));
    const first=service.queryOrder('000123');await vi.waitFor(()=>expect(fake.query).toHaveBeenCalledOnce());
    fake.query.mockResolvedValueOnce({identifier:'000456',found:false,fields:[]});await service.queryOrder('000456');
    resolve({identifier:'000123',found:true,fields:[{label:'old',value:'old'}]});await first;
    expect(service.getOrderStatus()).toBe('empty');
    for(const state of states)expect(state).not.toHaveProperty('order');
  });
  it.each(['account','conversation','target'] as const)('drops pending order results after %s changes',async kind=>{
    let resolve!:(value:any)=>void;fake.query.mockImplementationOnce(()=>new Promise(done=>resolve=done));const query=service.queryOrder('000123');await vi.waitFor(()=>expect(fake.query).toHaveBeenCalledOnce());
    if(kind==='account'){fake.identity={accountScope:'psim:other',authGeneration:2,permissions:[]};fake.changed?.(fake.identity);}
    else if(kind==='conversation'){snapshot={...snapshot,conversationId:'chat-2',scopeGeneration:2};await service.readDraft();}
    else service.setWindowState(null);
    resolve({identifier:'000123',found:true,fields:[{label:'old',value:'old'}]});await query;
    expect(service.getOrderStatus()).toBe('idle');
    for(const state of states)expect(state).not.toHaveProperty('order');
  });
  it('immediately retires a lost document, revokes its callback and reattaches after backoff',async()=>{
    invalidated();expect(service.getState()).toMatchObject({draft:null,composerSource:'unavailable',preview:null});
    await expect(action('retry',[])).rejects.toThrow('RUNTIME_TARGET_CHANGED');expect(external.close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);expect(fake.connect).toHaveBeenCalledTimes(2);
  });
  it('validates every intent even when called without the driver',async()=>{await expect(invokeEmbeddedAction(service,'queryOrder',[{identifier:'1',url:'https://bad.test'}])).rejects.toThrow('INVALID_ACTION');});
  it('discards the legacy order when the post-query read discovers a different conversation',async()=>{
    fake.query.mockImplementationOnce(async()=>{snapshot={...snapshot,conversationId:'chat-2',scopeGeneration:2};return{identifier:'000123',found:true,fields:[{label:'old',value:'old'}]};});
    await service.queryOrder('000123');expect(service.getOrderStatus()).toBe('idle');
    for(const state of states)expect(state).not.toHaveProperty('order');
  });
  it('retires the page bridge if publishing state fails rather than leaving a usable stale preview',async()=>{
    external.updateWorkbench.mockRejectedValueOnce(new Error('transport lost'));await service.setTranslationOptions({language:'en'});await Promise.resolve();await Promise.resolve();
    expect(service.getState()).toMatchObject({composerSource:'unavailable',draft:null,preview:null});expect(external.close).toHaveBeenCalled();
  });
  it.each(['read','renew'] as const)('reconnects after an expired %s lease even without a transport invalidation event',async path=>{
    if(path==='renew'){service.setWindowState({...window,foreground:false,groupForeground:false});external.renew.mockRejectedValueOnce(new Error('NATIVE_LEASE_ENDED'));}
    else external.read.mockRejectedValueOnce(new Error('RUNTIME_LEASE_ENDED'));
    await vi.advanceTimersByTimeAsync(500);expect(external.close).toHaveBeenCalled();expect(service.getState()).toMatchObject({composerSource:'unavailable',draft:null});
    await vi.advanceTimersByTimeAsync(1500);expect(fake.connect).toHaveBeenCalledTimes(2);expect(external.mountWorkbench).toHaveBeenCalledTimes(2);
  });
});
