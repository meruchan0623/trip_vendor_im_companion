import { afterEach,describe,expect,it,vi } from 'vitest';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect,type Socket } from 'node:net';
import { BrowserSessionService,parseBrowserSession,validateBrowserBody } from '../electron/browser-session';
import type { OutboundBody } from '../src/shared/workbench';
import vm from 'node:vm';

const body:OutboundBody={text:'请确认订单',target_lang:'ja',source_lang:'zh',purpose:'outbound',draft_request_id:'draft-123',composer_content_version:'version-1'};
const profile={accountScope:'psim:42',permissions:['complaint_records'],sessionKey:`${'a'.repeat(64)}:12`};
const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'tsim-browser-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));
  const changed=vi.fn(),openExternal=vi.fn(async(_url:string)=>{}),service=new BrowserSessionService(changed,{directory,openExternal,requestTimeoutMs:150,syncIntervalMs:60000});cleanup.push(async()=>service.dispose());
  let discovery:any;await vi.waitFor(async()=>{discovery=JSON.parse(await readFile(join(directory,'session.json'),'utf8'));},{timeout:4000});
  const socket=connect(discovery.pipe);cleanup.push(async()=>socket.destroy());await new Promise<void>(resolve=>socket.once('connect',resolve));
  const requests:any[]=[];let buffer='';socket.setEncoding('utf8');socket.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){requests.push(JSON.parse(buffer.slice(0,i)));buffer=buffer.slice(i+1);}});
  const send=(value:unknown)=>socket.write(JSON.stringify(value)+'\n');
  const response=(request:any,value:unknown)=>send({type:'response',id:request.id,ok:true,value});
  send({type:'hello',capability:discovery.capability});
  await vi.waitFor(()=>expect(requests.some(r=>r.action==='sync')).toBe(true));response(requests.find(r=>r.action==='sync'),profile);
  await vi.waitFor(()=>expect(service.identity()?.accountScope).toBe('psim:42'));
  return {service,socket,requests,response,send,changed,openExternal,endpoint:discovery.pipe as string};
}
describe('browser session bridge',()=>{
  it('keeps projected identities immutable and rotates generation when token or tab changes',async()=>{
    const f=await fixture(),before=f.service.identity()!;before.permissions.length=0;expect(f.service.identity()!.permissions).toEqual(['complaint_records']);
    const pending=f.service.sync();await vi.waitFor(()=>expect(f.requests.filter(r=>r.action==='sync')).toHaveLength(2));f.response(f.requests.at(-1),{...profile,sessionKey:`${'a'.repeat(64)}:13`});await pending;
    expect(f.service.identity()!.authGeneration).toBeGreaterThan(before.authGeneration);
  });
  it('relays exact translation only and rejects cross-draft echoes',async()=>{
    const f=await fixture(),identity=f.service.identity()!;const request=f.service.translate(body,identity,new AbortController().signal);const assertion=expect(request).rejects.toThrow('OUTBOUND_ECHO_MISMATCH');
    await vi.waitFor(()=>expect(f.requests.some(r=>r.action==='translate')).toBe(true));const sent=f.requests.find(r=>r.action==='translate');expect(sent.payload).toEqual({body,sessionKey:profile.sessionKey});
    f.response(sent,{success:true,data:{translated_text:'確認します',draft_request_id:body.draft_request_id,composer_content_version:'another'}});await assertion;
  });
  it('invalidates in-flight work on session change and ignores its late reply',async()=>{
    const f=await fixture();const translation=f.service.translate(body,f.service.identity()!,new AbortController().signal);const assertion=expect(translation).rejects.toThrow('AUTH_CHANGED');
    await vi.waitFor(()=>expect(f.requests.some(r=>r.action==='translate')).toBe(true));const sync=f.service.sync();await vi.waitFor(()=>expect(f.requests.filter(r=>r.action==='sync')).toHaveLength(2));f.response(f.requests.at(-1),null);await sync;await assertion;expect(f.service.identity()).toBeNull();
    f.response(f.requests.find(r=>r.action==='translate'),{success:true,data:{translated_text:'late',draft_request_id:body.draft_request_id,composer_content_version:body.composer_content_version}});expect(f.service.identity()).toBeNull();
  });
  it('cancels on caller abort, bounds timeout and only disconnects companion on logout',async()=>{
    const f=await fixture(),controller=new AbortController();const promise=f.service.translate(body,f.service.identity()!,controller.signal);const assertion=expect(promise).rejects.toThrow('REQUEST_ABORTED');
    await vi.waitFor(()=>expect(f.requests.some(r=>r.action==='translate')).toBe(true));controller.abort();await assertion;await vi.waitFor(()=>expect(f.requests.some(r=>r.type==='cancel')).toBe(true));
    await expect(f.service.translate(body,f.service.identity()!,new AbortController().signal)).rejects.toThrow('BROWSER_BRIDGE_TIMEOUT');await f.service.logout();expect(f.service.identity()).toBeNull();await f.service.sync();expect(f.requests.some(r=>r.action==='logout')).toBe(false);
  });
  it('opens only the official login if no extension is available',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'tsim-browser-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));const openExternal=vi.fn(async(_url:string)=>{}),service=new BrowserSessionService(()=>{},{directory,openExternal});cleanup.push(async()=>service.dispose());await service.openLogin();expect(openExternal).toHaveBeenCalledWith('https://csagent.tsim.tech/login');
  });
  it('rejects credential fields and malformed projected sessions',()=>{
    expect(()=>validateBrowserBody({...body,token:'do-not-relay'} as OutboundBody)).toThrow('INVALID_OUTBOUND_REQUEST');expect(()=>parseBrowserSession({...profile,token:'do-not-relay'})).toThrow('INVALID_BROWSER_SESSION');expect(()=>parseBrowserSession({...profile,sessionKey:'token'})).toThrow('INVALID_BROWSER_SESSION');
  });
  it('invalidates the session when the authenticated pipe is lost',async()=>{
    const f=await fixture();f.send({type:'anything'});await vi.waitFor(()=>expect(f.service.identity()).toBeNull());expect(f.socket.destroyed).toBe(true);
  });
  it('rejects a wrong pipe capability without replacing the authenticated browser',async()=>{
    const f=await fixture(),rogue=connect(f.endpoint);cleanup.push(async()=>rogue.destroy());await new Promise<void>(resolve=>rogue.once('connect',resolve));rogue.write(JSON.stringify({type:'hello',capability:'wrong'})+'\n');await vi.waitFor(()=>expect(rogue.destroyed).toBe(true));expect(f.service.identity()?.accountScope).toBe('psim:42');
  });
  it('closes a peer that exceeds the bounded frame size',async()=>{
    const f=await fixture();f.socket.write('x'.repeat(262145));await vi.waitFor(()=>expect(f.service.identity()).toBeNull());
  });
});

describe('extension MAIN-world fixed API',()=>{
  async function pageFixture(){
    let token='synthetic-test-token';const fetch=vi.fn(async(url:string)=>new Response(JSON.stringify(url.endsWith('/profile')?{success:true,data:{id:42,is_active:true,permissions:['complaint_records']}}:{success:true,data:{translated_text:'確認します',draft_request_id:body.draft_request_id,composer_content_version:body.composer_content_version}})));
    const event={addListener:()=>{}},native={onMessage:event,onDisconnect:event,postMessage:()=>{}};
    const context=vm.createContext({chrome:{runtime:{connectNative:()=>native,onStartup:event,onInstalled:event},alarms:{onAlarm:event},action:{onClicked:event},windows:{onRemoved:event},tabs:{onRemoved:event,onUpdated:event}},location:{origin:'https://csagent.tsim.tech'},localStorage:{getItem:()=>token},crypto:globalThis.crypto,TextEncoder,TextDecoder,AbortController,setTimeout,clearTimeout,fetch});
    vm.runInContext(await readFile(join(process.cwd(),'browser-extension/background.js'),'utf8')+'\nglobalThis.testPage=pageRequest;',context);
    return {run:context.testPage as (...args:any[])=>Promise<any>,fetch,setToken:(value:string)=>{token=value;}};
  }
  it('projects profile without exporting token and sends only the fixed translation endpoint',async()=>{
    const f=await pageFixture(),identity=await f.run('sync',null,null,'s');expect(identity.ok).toBe(true);expect(JSON.stringify(identity)).not.toContain('synthetic-test-token');
    const result=await f.run('translate',{body,expectedAccount:'psim:42',expectedPermissions:['complaint_records']},identity.value.hash,'t');expect(result.value.data.translated_text).toBe('確認します');expect(f.fetch.mock.calls.map(c=>c[0])).toEqual(['https://csapi.tsim.tech/agent/profile','https://csapi.tsim.tech/agent/profile','https://csapi.tsim.tech/agent/translate']);
    expect((await f.run('arbitrary',null,null,'x')).error).toBe('INVALID_BROWSER_ACTION');
  });
  it('rejects token rotation before issuing a translation',async()=>{const f=await pageFixture(),identity=await f.run('sync',null,null,'s');f.setToken('rotated-test-token');expect((await f.run('translate',{body},identity.value.hash,'t')).error).toBe('AUTH_CHANGED');expect(f.fetch).toHaveBeenCalledTimes(1);});
});

describe('extension owned popup lifecycle',()=>{
  async function extensionFixture(){
    let onMessage!:(message:any)=>void,onDisconnect!:()=>void,onRemoved!:(id:number)=>void;
    const event={addListener:()=>{}},postMessage=vi.fn(),remove=vi.fn(async(_id:number)=>{}),create=vi.fn(async(_options:unknown)=>({id:7}));
    const native={onMessage:{addListener:(fn:any)=>{onMessage=fn;}},onDisconnect:{addListener:(fn:any)=>{onDisconnect=fn;}},postMessage};
    const context=vm.createContext({URLSearchParams,chrome:{runtime:{connectNative:()=>native,getURL:(path:string)=>`chrome-extension://iiepfpjonkacmepbnhgacllpipibhphh/${path}`,onStartup:event,onInstalled:event},alarms:{onAlarm:event},action:{onClicked:event},windows:{create,remove,onRemoved:{addListener:(fn:any)=>{onRemoved=fn;}}},tabs:{onRemoved:event,onUpdated:event}}});
    vm.runInContext(await readFile(join(process.cwd(),'browser-extension/background.js'),'utf8'),context);
    const opening={type:'request',id:'00000000-0000-4000-8000-000000000001',action:'openOrder',payload:{selection:{identifier:'order-123',identifierType:'order_number',requestId:'req-123'},bounds:{x:0,y:0,width:600,height:700},marker:'00000000-0000-4000-8000-000000000002'}};
    return {onMessage,onDisconnect,onRemoved,postMessage,create,remove,opening};
  }
  it('closes only owned popups when the native pipe disconnects',async()=>{
    const f=await extensionFixture();f.onMessage(f.opening);await vi.waitFor(()=>expect(f.postMessage).toHaveBeenCalled());f.onDisconnect();await vi.waitFor(()=>expect(f.remove).toHaveBeenCalledWith(7));
    expect(f.remove).toHaveBeenCalledTimes(1);
  });
  it('acknowledges an owned window already closed by the user',async()=>{
    const f=await extensionFixture();f.onMessage(f.opening);await vi.waitFor(()=>expect(f.postMessage).toHaveBeenCalled());f.onRemoved(7);
    f.onMessage({type:'request',id:'00000000-0000-4000-8000-000000000003',action:'closeOrder',payload:{windowId:7}});await vi.waitFor(()=>expect(f.postMessage).toHaveBeenCalledTimes(2));expect(f.postMessage.mock.calls[1][0].ok).toBe(true);expect(f.remove).not.toHaveBeenCalled();
    f.onMessage({...f.opening,id:'00000000-0000-4000-8000-000000000004'});await vi.waitFor(()=>expect(f.create).toHaveBeenCalledTimes(2));
  });
  it('immediately closes a late popup after its opening request was cancelled',async()=>{
    const f=await extensionFixture();let finish!:(window:{id:number})=>void;f.create.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));f.onMessage(f.opening);
    f.onMessage({type:'cancel',id:f.opening.id});finish({id:9});await vi.waitFor(()=>expect(f.remove).toHaveBeenCalledWith(9));await vi.waitFor(()=>expect(f.postMessage).toHaveBeenCalled());expect(f.postMessage.mock.calls[0][0]).toMatchObject({ok:false,error:'REQUEST_ABORTED'});
  });
  it('closes an owned popup when cancel arrives after its response was already posted',async()=>{
    const f=await extensionFixture();f.onMessage(f.opening);await vi.waitFor(()=>expect(f.postMessage).toHaveBeenCalled());f.onMessage({type:'cancel',id:f.opening.id});await vi.waitFor(()=>expect(f.remove).toHaveBeenCalledWith(7));expect(f.remove).toHaveBeenCalledTimes(1);
  });
});
