import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {discoverBrowserProfiles} from '../electron/browser-profile-session';
import {PersistentSessionService} from '../electron/owned-session';
import {SecureSessionStore} from '../electron/secure-session-store';
import {CompanionService} from '../electron/companion-service';
import {invokeEmbeddedAction} from '../electron/embedded-host';
import {validWorkbenchAction} from '../runtime/workbench-action';
import {operatorFrameURL,parseOperatorChildMessage} from '../runtime/page/operator-overlay';
import type {OutboundBody,PsimIdentity} from '../src/shared/workbench';

const identity:PsimIdentity={accountScope:'psim:7',authGeneration:1,permissions:['complaint_records']};
const outbound:OutboundBody={text:'你好',target_lang:'en',source_lang:'zh',purpose:'outbound',draft_request_id:'owned-test',composer_content_version:'fixture-v1'};
const response=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}

test('macOS profile discovery never examines browser paths or environment',async()=>{
  let reads=0;
  const environment=new Proxy({},{get(){reads++;throw new Error('must not inspect browser paths');}});
  assert.deepEqual(await discoverBrowserProfiles(environment,'darwin'),[]);
  assert.equal(reads,0);
});

test('owned credentials use encrypted private storage and deletion',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'tsim-credential-test-'));
  try{
    const key=randomBytes(32),path=join(directory,'account','session.enc');
    const crypto={isEncryptionAvailable:()=>true,encryptString(value:string){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);return Buffer.concat([nonce,cipher.update(value,'utf8'),cipher.final(),cipher.getAuthTag()]);},decryptString(value:Buffer){const decipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(-16));return Buffer.concat([decipher.update(value.subarray(12,-16)),decipher.final()]).toString('utf8');}};
    const store=new SecureSessionStore(path,crypto),saved={accessToken:'fixture-access-token',sessionRef:'fixture-session-reference'};
    await store.save(saved);
    const bytes=await readFile(path);assert.equal(bytes.includes(saved.accessToken),false);assert.equal(bytes.includes(saved.sessionRef),false);
    assert.equal((await stat(path)).mode&0o777,0o600);assert.deepEqual(await store.load(),saved);
    await store.clear();assert.equal(await store.load(),null);
    const unavailable=new SecureSessionStore(path,{...crypto,isEncryptionAvailable:()=>false});
    await assert.rejects(unavailable.save(saved),/SESSION_STORAGE_ENCRYPTION_UNAVAILABLE/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('in-app login restores the owned account, translates, queries and clears logout credentials',{timeout:10000},async()=>{
  let stored:{accessToken:string;sessionRef:string}|null=null,opened='',closed=0,browserReads=0;
  const calls:string[]=[];
  let pendingDetail:ReturnType<typeof deferred<Response>>|undefined,detailStarted:ReturnType<typeof deferred<void>>|undefined;
  const store={load:async()=>stored,save:async(value:{accessToken:string;sessionRef:string})=>{stored={...value};},clear:async()=>{stored=null;}};
  const fetcher:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));calls.push(`${init?.method} ${url.pathname}`);
    assert.equal(url.origin,'https://csapi.tsim.tech');
    if(url.pathname==='/agent/login'){
      assert.equal((init?.body as FormData).get('username'),'fixture-user');assert.equal((init?.body as FormData).get('password'),'fixture-password');
      return response({success:true,data:{access_token:'fixture-token',session_ref:'fixture-ref',token_type:'bearer'}});
    }
    assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer fixture-token');
    if(url.pathname==='/agent/profile')return response({success:true,data:{id:7,is_active:true,permissions:['complaint_records']}});
    if(url.pathname==='/agent/translate')return response({success:true,data:{translated_text:'Hello',draft_request_id:outbound.draft_request_id,composer_content_version:outbound.composer_content_version}});
    if(url.pathname==='/agent/package-query/perform')return response({code:1,result:{query_id:10}});
    if(url.pathname==='/agent/package-query/dataplan-list')return response({code:1,result:[{card_dataplan_id:11}]});
    if(url.pathname==='/agent/package-query/detail'){
      if(pendingDetail){detailStarted?.resolve();return pendingDetail.promise;}
      return response({code:1,result:{status:'active',iccid:'89900123456789012345',private_token:'must-not-project'}});
    }
    if(url.pathname==='/agent/logout')return response({success:true});
    throw new Error(`Unexpected fixture endpoint ${url.pathname}`);
  };
  const options={fetcher,embeddedLogin:false,backgroundPolling:false,openExternal:async(url:string)=>{opened=url;},closeLogin:()=>{closed++;},discoverProfiles:async()=>{browserReads++;throw new Error('external browser forbidden');},readToken:async()=>{browserReads++;throw new Error('external storage forbidden');}};
  const session=new PersistentSessionService(()=>{},options,store);
  let restored:PersistentSessionService|undefined;
  try{
    await session.sync();assert.equal(session.identity(),null);
    await session.openLogin();assert.match(opened,/^http:\/\/127\.0\.0\.1:\d+\/auth\/[a-f0-9]{64}$/);
    const document=await fetch(opened);assert.equal(document.status,200);
    const html=await document.text(),csrf=JSON.parse(/const csrf=("[^"]+"),embedded=/.exec(html)![1]);
    const submit=async(origin:string,token:string)=>fetch(`${opened}/login`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify({username:'fixture-user',password:'fixture-password'})});
    assert.equal((await submit('https://untrusted.invalid',csrf)).status,403);
    assert.equal((await submit(new URL(opened).origin,'invalid')).status,403);
    const loggedIn=await submit(new URL(opened).origin,csrf);assert.equal(loggedIn.status,200);assert.deepEqual(await loggedIn.json(),{ok:true,authenticated:true});
    assert.equal(session.identity()?.accountScope,'psim:7');assert.deepEqual(stored,{accessToken:'fixture-token',sessionRef:'fixture-ref'});
    assert.deepEqual(Object.keys(session.identity()!).sort(),['accountScope','authGeneration','permissions']);
    assert.deepEqual(session.operatorGrant(session.identity()!),{accessToken:'fixture-token',sessionRef:'fixture-ref'});
    assert.equal(session.operatorGrant({...session.identity()!,authGeneration:-1}),null);
    assert.equal((await session.translate(outbound,session.identity()!,new AbortController().signal)).data.translated_text,'Hello');
    const order=await session.queryOriginalIdentifier('ABC123',new AbortController().signal);assert.equal(order.found,true);assert.equal(order.fields.some(field=>field.label==='private_token'),false);
    restored=new PersistentSessionService(()=>{},options,store);await restored.sync();assert.equal(restored.identity()?.accountScope,'psim:7');await restored.dispose();restored=undefined;
    pendingDetail=deferred<Response>();detailStarted=deferred<void>();const pending=session.queryOriginalIdentifier('OLD123',new AbortController().signal);const rejected=assert.rejects(pending,/AUTH_CHANGED/);
    const before=session.identity()!;
    await detailStarted.promise;await session.logout();pendingDetail.resolve(response({code:1,result:{status:'stale'}}));await rejected;
    assert.equal(session.operatorGrant(before),null);
    assert.equal(stored,null);assert.equal(session.identity(),null);assert.ok(closed>0);assert.equal(browserReads,0);
    await assert.rejects(fetch(opened));
    assert.deepEqual([...new Set(calls.map(call=>call.split(' ')[1]))].sort(),['/agent/login','/agent/logout','/agent/package-query/dataplan-list','/agent/package-query/detail','/agent/package-query/perform','/agent/profile','/agent/translate'].sort());
  }finally{await restored?.dispose();await session.dispose();}
});

test('owned order bridge rejects the old customer and drops a response after close',{timeout:10000},async()=>{
  const result=deferred<{identifier:string;found:boolean;fields:{label:string;value:string}[]}>(),started=deferred<void>();let queries=0;
  const session={identity:()=>identity,sync:async()=>{},setBackgroundPolling(){},getBrowserProfile:()=>null,translate:async()=>({success:true as const,data:{translated_text:'Hello',draft_request_id:outbound.draft_request_id,composer_content_version:outbound.composer_content_version}}),queryOriginalIdentifier:async()=>{queries++;started.resolve();return result.promise;},openLogin:async()=>{},logout:async()=>{},dispose(){}};
  const service=new CompanionService({} as never,async()=>{},()=>{},{enabled:false},true,()=>session);
  const fixture=service as any;
  try{
    fixture.state={...service.getState(),sessionMode:'owned',auth:'ready',attached:true,targetInstanceId:'1:2:3',messageSurface:{active:true,composerRect:null,toolbarRect:null}};
    fixture.foreground=true;fixture.external={close:async()=>{}};
    fixture.captured={source:'verified-editor',snapshot:{conversationId:'new-customer',scopeGeneration:1,platformAccountScope:'vendor:1'}};
    fixture.capture=async()=>fixture.captured;fixture.adopt=()=>{};fixture.waitForObservation=async()=>true;
    await assert.rejects(invokeEmbeddedAction(service,'queryOrder',[{identifier:'ABC123',identifierType:'order_number',conversationKey:'old-customer'}]),/ORDER_CONTEXT_CHANGED/);assert.equal(queries,0);
    const pending=invokeEmbeddedAction(service,'queryOrder',[{identifier:'ABC123',identifierType:'order_number',conversationKey:fixture.context()}]);
    await started.promise;assert.equal(service.getOrderStatus(),'loading');await service.closeOrder();
    result.resolve({identifier:'ABC123',found:true,fields:[{label:'status',value:'stale'}]});await pending;assert.equal(service.getOrderStatus(),'idle');
  }finally{await service.dispose();}
});

test('page bridge accepts the owned order intent the panel actually sends',()=>{
  const intent={identifier:'1128150626575931',identifierType:'order_number',conversationKey:'["1:2:3","customer",1,"vendor:1"]'};
  assert.equal(validWorkbenchAction('queryOrder',[intent]),true);
  assert.equal(validWorkbenchAction('openOrder',[intent]),true);
  assert.equal(validWorkbenchAction('operatorSession',[intent]),true);
  assert.equal(validWorkbenchAction('operatorSession',[]),false);
  assert.equal(validWorkbenchAction('queryOrder',[{identifier:intent.identifier}]),false);
  assert.equal(validWorkbenchAction('queryOrder',[{...intent,identifier:'bad id'}]),false);
  assert.equal(validWorkbenchAction('queryOrder',[{...intent,url:'https://example.invalid'}]),false);
  assert.equal(validWorkbenchAction('openLogin',[]),true);
  assert.equal(validWorkbenchAction('openLogin',['x']),false);
  assert.equal(validWorkbenchAction('send',[]),false);
});

test('owned order query reports login and resolves before the remote lookup completes',{timeout:10000},async()=>{
  const result=deferred<{identifier:string;found:boolean;fields:{label:string;value:string}[]}>();let current:PsimIdentity|null=null,queries=0;
  const session={identity:()=>current,sync:async()=>{},setBackgroundPolling(){},getBrowserProfile:()=>null,translate:async()=>{throw new Error('unused');},queryOriginalIdentifier:async()=>{queries++;return result.promise;},openLogin:async()=>{},logout:async()=>{},dispose(){}};
  const service=new CompanionService({} as never,async()=>{},()=>{},{enabled:false},true,()=>session as never);
  const fixture=service as any;
  try{
    fixture.state={...service.getState(),sessionMode:'owned',auth:'needs_login',attached:true,targetInstanceId:'1:2:3',messageSurface:{active:true,composerRect:null,toolbarRect:null}};
    fixture.foreground=true;fixture.external={close:async()=>{}};
    fixture.captured={source:'verified-editor',snapshot:{conversationId:'customer',scopeGeneration:1,platformAccountScope:'vendor:1'}};
    fixture.capture=async()=>fixture.captured;fixture.adopt=()=>{};fixture.waitForObservation=async()=>true;
    const intent={identifier:'ABC123',identifierType:'order_number',conversationKey:fixture.context()};
    await invokeEmbeddedAction(service,'queryOrder',[intent]);
    assert.equal(service.getOrderStatus(),'failed');assert.match(fixture.order.error,/登录/);assert.equal(queries,0);
    current=identity;fixture.state.auth='ready';
    await invokeEmbeddedAction(service,'queryOrder',[intent]);
    assert.equal(service.getOrderStatus(),'loading');
    result.resolve({identifier:'ABC123',found:true,fields:[{label:'status',value:'active'}]});
    for(let i=0;i<20&&service.getOrderStatus()==='loading';i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(service.getOrderStatus(),'ready');assert.equal(queries,1);
  }finally{await service.dispose();}
});

test('in-page operator receives the session only for the visible conversation and current account',{timeout:10000},async()=>{
  let current:PsimIdentity|null=null;
  const session={identity:()=>current,sync:async()=>{},setBackgroundPolling(){},getBrowserProfile:()=>null,operatorGrant:(value:PsimIdentity)=>current&&value.authGeneration===current.authGeneration?{accessToken:'fixture-token',sessionRef:'fixture-ref'}:null,translate:async()=>{throw new Error('unused');},queryOriginalIdentifier:async()=>{throw new Error('unused');},openLogin:async()=>{},logout:async()=>{},dispose(){}};
  const service=new CompanionService({} as never,async()=>{},()=>{},{enabled:false},true,()=>session as never);
  const fixture=service as any;
  try{
    fixture.state={...service.getState(),auth:'needs_login',attached:true,targetInstanceId:'1:2:3',messageSurface:{active:true,composerRect:null,toolbarRect:null}};
    fixture.foreground=true;fixture.external={close:async()=>{}};
    fixture.captured={source:'verified-editor',snapshot:{conversationId:'customer',scopeGeneration:1,platformAccountScope:'vendor:1'}};
    const intent={identifier:'ABC123',identifierType:'order_number',conversationKey:fixture.context()};
    await assert.rejects(invokeEmbeddedAction(service,'operatorSession',[intent]),/PSIM_LOGIN_REQUIRED/);
    current=identity;fixture.state.auth='ready';
    await assert.rejects(invokeEmbeddedAction(service,'operatorSession',[{...intent,conversationKey:'old-customer'}]),/ORDER_CONTEXT_CHANGED/);
    await assert.rejects(invokeEmbeddedAction(service,'operatorSession',[{identifier:'ABC123'}]),/INVALID_ACTION/);
    assert.deepEqual(await invokeEmbeddedAction(service,'operatorSession',[intent]),{accessToken:'fixture-token',sessionRef:'fixture-ref'});
    fixture.foreground=false;
    await assert.rejects(invokeEmbeddedAction(service,'operatorSession',[intent]),/MESSAGE_PAGE_REQUIRED/);
    assert.equal('orderWindowMode' in fixture.embeddedState(),false);
  }finally{await service.dispose();}
});

test('operator frame requests the companion session for its own request only',()=>{
  const request={identifier:'1128150626575931',identifierType:'order_number' as const,requestId:'6f1c2f9e-3b1a-4c8d-9e2f-1a2b3c4d5e6f'};
  const url=new URL(operatorFrameURL('https://csagent.tsim.tech',request));
  assert.equal(url.pathname,'/embed/operator');assert.equal(url.searchParams.get('session'),'handoff');assert.equal(url.searchParams.get('source'),'travel-merchant-companion');
  const message={type:'TSIM_OPERATOR_NEEDS_SESSION',version:2,identifier:request.identifier,requestId:request.requestId};
  assert.deepEqual(parseOperatorChildMessage(message,request),message);
  assert.equal(parseOperatorChildMessage({...message,requestId:'00000000-0000-4000-8000-000000000000'},request),null);
  assert.equal(parseOperatorChildMessage({...message,identifier:'other'},request),null);
});
