import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserProfileSessionService,OUTBOUND_SYNC_REUSE_MS} from '../electron/browser-profile-session';
import {CompanionService,AUTO_TRANSLATE_DELAY_MS} from '../electron/companion-service';

function deferred<T=void>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};}
/** Lets promise chains (and fetch body streams) progress; setImmediate stays real under mocked timers. */
const settle=async(rounds=40)=>{for(let index=0;index<rounds;index++)await new Promise<void>(resolve=>setImmediate(resolve));};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const profile={browserPath:'C:\\Edge\\msedge.exe',userDataDir:'C:\\Edge\\User Data',profileDirectory:'Default'};
let serial=0;
const outbound=(text='你好')=>({text,target_lang:'en' as const,source_lang:'zh' as const,purpose:'outbound' as const,draft_request_id:`req-${++serial}`,composer_content_version:`v-${serial}`});
const live=()=>new AbortController().signal;

/** Windows browser-profile session over fake disk and network. A full check is one `GET /agent/profile`. */
function browserWorld(){
  const world={clock:0,token:'token-a' as string|null,profileStatus:200,translateStatus:200,profileGate:undefined as Promise<void>|undefined,translateGate:undefined as Promise<void>|undefined,onTranslate:undefined as undefined|(()=>void),calls:[] as string[],authorizations:[] as string[]};
  const fetcher=async(input:unknown,init:any)=>{
    const path=new URL(String(input)).pathname;world.calls.push(`${init.method} ${path}`);
    if(path==='/agent/profile'){await world.profileGate;return world.profileStatus===200?json({success:true,data:{id:'7',is_active:true,permissions:['translate']}}):json({success:false},world.profileStatus);}
    if(path==='/agent/translate'){
      world.authorizations.push(init.headers.Authorization);const body=JSON.parse(init.body);
      await Promise.race([world.translateGate,new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}))]);
      world.onTranslate?.();
      return world.translateStatus===200?json({success:true,data:{translated_text:'Hello',draft_request_id:body.draft_request_id,composer_content_version:body.composer_content_version}}):json({success:false},world.translateStatus);
    }
    throw new Error('unexpected '+path);
  };
  const options={discoverProfiles:async()=>[profile],readToken:async()=>world.token,fetcher:fetcher as unknown as typeof fetch,now:()=>world.clock,backgroundPolling:false};
  return{world,options,checks:()=>world.calls.filter(call=>call==='GET /agent/profile').length,posts:()=>world.calls.filter(call=>call==='POST /agent/translate').length};
}
async function verifiedSession(){
  const browser=browserWorld(),session=new BrowserProfileSessionService(()=>{},browser.options);
  await session.sync();assert.equal(browser.checks(),1);const identity=session.identity();assert.ok(identity);
  return{...browser,session,identity};
}

test('outbound translation reuses a successful check started within the window and re-checks after it',async()=>{
  const f=await verifiedSession();
  try{
    f.world.clock=OUTBOUND_SYNC_REUSE_MS;
    await f.session.translate(outbound(),f.identity,live());
    assert.equal(f.checks(),1);assert.equal(f.posts(),1);
    await f.session.sync({reuseRecent:true});assert.equal(f.checks(),1);
    f.world.clock=OUTBOUND_SYNC_REUSE_MS+1;
    await f.session.translate(outbound(),f.identity,live());
    assert.equal(f.checks(),2,'outside the window the translation runs its own full check');assert.equal(f.posts(),2);
    // Callers that do not opt in (background poll, order lookup, replace/send) always run a full check.
    await f.session.sync();assert.equal(f.checks(),3);
  }finally{f.session.dispose();}
});

test('an in-flight check is joined before sending, never skipped',async()=>{
  const f=await verifiedSession(),gate=deferred();
  try{
    f.world.profileGate=gate.promise;
    const checking=f.session.sync(),translating=f.session.translate(outbound(),f.identity,live());
    await settle();assert.equal(f.posts(),0);
    gate.resolve();await checking;await translating;
    assert.equal(f.checks(),2);assert.equal(f.posts(),1);
  }finally{f.session.dispose();}
});

test('a failed, revoked or switched check is never reused and the old identity is refused',async t=>{
  for(const mode of ['profile-unavailable','profile-401','translate-401','translate-423','browser-account-switch','logout'])await t.test(mode,async()=>{
    const f=await verifiedSession();
    try{
      if(mode==='profile-unavailable'){f.world.profileStatus=503;await assert.rejects(f.session.sync(),/SERVICE_UNAVAILABLE/);f.world.profileStatus=200;}
      if(mode==='profile-401'){f.world.profileStatus=401;await assert.rejects(f.session.sync(),/PSIM_LOGIN_REQUIRED/);f.world.profileStatus=200;}
      if(mode==='translate-401'||mode==='translate-423'){f.world.translateStatus=mode==='translate-401'?401:423;// The 401/423 revocation bumps the generation first, so the request reports AUTH_CHANGED (unchanged behavior).
        await assert.rejects(f.session.translate(outbound(),f.identity,live()),/AUTH_CHANGED|PSIM_LOGIN_REQUIRED/);f.world.translateStatus=200;}
      if(mode==='browser-account-switch'){f.world.token='token-b';await f.session.sync();assert.notEqual(f.session.identity()?.authGeneration,f.identity.authGeneration);}
      if(mode==='logout')await f.session.logout();
      if(mode!=='browser-account-switch')assert.equal(f.session.identity(),null);
      const checks=f.checks(),posts=f.posts();
      f.world.clock=1;// still inside the window of the original successful check
      await assert.rejects(f.session.translate(outbound(),f.identity,live()),/AUTH_CHANGED/);
      assert.equal(f.posts(),posts,'the old identity never reaches the translation endpoint');
      if(mode==='logout')assert.equal(f.checks(),checks,'a logged-out session stays suspended');
      else if(mode==='browser-account-switch')assert.equal(f.checks(),checks,'the newer successful check may stand in, but authGeneration still refuses the old identity');
      else{assert.equal(f.checks(),checks+1,'a full check replaces the discarded one');assert.notEqual(f.session.identity()?.authGeneration,f.identity.authGeneration);}
    }finally{f.session.dispose();}
  });
});

test('a token rotated on disk is still refused after the POST while a recent check stands in',async t=>{
  for(const when of ['before-send','during-request'])await t.test(when,async()=>{
    const f=await verifiedSession();
    try{
      f.world.clock=1000;
      if(when==='before-send')f.world.token='token-b';else f.world.onTranslate=()=>{f.world.token='token-b';};
      await assert.rejects(f.session.translate(outbound(),f.identity,live()),/AUTH_CHANGED/);
      // The reused check skips the pre-send disk read, so the old bearer may be sent once; its result is discarded.
      assert.deepEqual(f.world.authorizations,['Bearer token-a']);assert.equal(f.session.identity(),null);
      await f.session.sync({reuseRecent:true});
      assert.equal(f.checks(),2,'rotation revokes the reusable check');assert.notEqual(f.session.identity()?.authGeneration,f.identity.authGeneration);
    }finally{f.session.dispose();}
  });
});

test('a permission refusal keeps the session but makes the next translation re-check first',async()=>{
  const f=await verifiedSession();
  try{
    f.world.translateStatus=403;await assert.rejects(f.session.translate(outbound(),f.identity,live()),/TRANSLATION_PERMISSION_REQUIRED/);
    assert.deepEqual(f.session.identity(),f.identity);f.world.translateStatus=200;
    await f.session.translate(outbound(),f.identity,live());assert.equal(f.checks(),2);
  }finally{f.session.dispose();}
});

test('a superseded request is dropped before its POST but runs to completion once sent',async()=>{
  const f=await verifiedSession();
  try{
    const early=new AbortController();early.abort();
    await assert.rejects(f.session.translate(outbound(),f.identity,live(),early.signal),/REQUEST_SUPERSEDED/);assert.equal(f.posts(),0);
    // Superseded while the pre-send check is still running.
    f.world.clock=OUTBOUND_SYNC_REUSE_MS+1;const gate=deferred();f.world.profileGate=gate.promise;
    const checking=new AbortController(),pending=f.session.translate(outbound(),f.identity,live(),checking.signal);
    await settle();checking.abort();await assert.rejects(pending,/REQUEST_SUPERSEDED/);gate.resolve();await settle();assert.equal(f.posts(),0);
    // Once on the wire only the hard signal aborts it.
    f.world.profileGate=undefined;const sent=deferred();f.world.translateGate=sent.promise;
    const revision=new AbortController(),request=f.session.translate(outbound(),f.identity,live(),revision.signal);
    await settle();assert.equal(f.posts(),1);revision.abort();sent.resolve();
    assert.equal((await request).data.translated_text,'Hello');
  }finally{f.session.dispose();}
});

type Pending={body:any;identity:any;signal:AbortSignal;revision?:AbortSignal;resolve:(value:unknown)=>void;reject:(error:unknown)=>void};
const snapshot=(text:string,overrides:Record<string,unknown>={})=>({text,conversationId:'customer-1',revision:text.length,composing:false,scopeGeneration:1,authGeneration:1,editorIdentity:'editor-1',docFingerprint:`doc:${text}`,isPlainText:true,platformAccountScope:'vendor:1',composerId:'composer-1',documentGeneration:1,...overrides});
const captured=(value:ReturnType<typeof snapshot>)=>({source:'verified-editor',snapshot:value,orderEntries:[],orderViewport:null,messageSurface:{active:true,composerRect:null,toolbarRect:null},currentOrderHint:null});
const reply=(request:Pending,text:string)=>request.resolve({success:true,data:{translated_text:text,draft_request_id:request.body.draft_request_id,composer_content_version:request.body.composer_content_version}});
/** Puts the service on a verified, foreground draft with automatic translation armed (500 ms debounce running). */
function attachDraft(fixture:any){
  Object.assign(fixture.state,{auth:'ready',attached:true,targetInstanceId:'1:2:3',autoTranslate:true,translationPaused:false,messageSurface:{active:true,composerRect:null,toolbarRect:null}});
  fixture.foreground=true;fixture.external={targetInstanceId:'1:2:3',close:async()=>{},renew:async()=>{}};fixture.publish=()=>{};
  let draft=snapshot('你好');fixture.capture=async()=>captured(draft);
  fixture.adopt(captured(draft));fixture.state.followCustomerLanguage=false;fixture.state.language='en';fixture.schedule();
  // Each edit is what the settle read or the safety observation adopts.
  return(text:string,overrides:Record<string,unknown>={})=>{draft=snapshot(text,overrides);fixture.adopt(captured(draft));};
}
async function companion(t:any){
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  let identity={accountScope:'psim:7',authGeneration:1,permissions:[] as string[]},changed!:(value:unknown)=>void;
  const requests:Pending[]=[],syncs:unknown[]=[];
  const session={identity:()=>identity,sync:async(options?:unknown)=>{syncs.push(options);},setBackgroundPolling(){},getBrowserProfile:()=>null,operatorGrant:()=>null,
    translate:(body:any,requestIdentity:unknown,signal:AbortSignal,revision?:AbortSignal)=>new Promise((resolve,reject)=>{requests.push({body,identity:requestIdentity,signal,revision,resolve,reject});signal.addEventListener('abort',()=>reject(new Error('REQUEST_ABORTED')),{once:true});}),
    queryOriginalIdentifier:async()=>{throw new Error('unused');},openLogin:async()=>{},logout:async()=>{},dispose(){}};
  const service=new CompanionService({} as never,async()=>{},()=>{},{enabled:false},true,(callback:any)=>{changed=callback;return session as never;}),fixture=service as any;
  await fixture.sessionStarting;await fixture.translationOptionsStarting;
  changed(identity);// the initial publication, as the real session does after its first check
  const edit=attachDraft(fixture);
  return{service,fixture,requests,syncs,edit,tick:(ms:number)=>t.mock.timers.tick(ms),
    switchAccount(){identity={accountScope:'psim:8',authGeneration:2,permissions:[]};changed(identity);}};
}

test('edits during an in-flight translation send only the latest draft once it settles',async t=>{
  const f=await companion(t);
  try{
    f.tick(AUTO_TRANSLATE_DELAY_MS);await settle();
    assert.equal(f.requests.length,1);const first=f.requests[0];assert.equal(first.body.text,'你好');
    f.edit('你好，请问');f.edit('你好，请问订单');
    assert.equal(first.signal.aborted,false,'a same-draft edit does not abort the request on the wire');assert.equal(first.revision?.aborted,true);
    assert.equal(f.fixture.state.preview,null);
    f.tick(AUTO_TRANSLATE_DELAY_MS);await settle();
    assert.equal(f.requests.length,1,'no second request is queued behind the one in flight');assert.equal(f.fixture.state.phase,'waiting');
    reply(first,'Hi');await settle();f.tick(1);await settle();
    assert.equal(f.requests.length,2);assert.equal(f.requests[1].body.text,'你好，请问订单');
    assert.equal(f.fixture.state.preview,null,'the superseded result is discarded by the version check');
    reply(f.requests[1],'Hello, about the order');await settle();
    assert.equal(f.fixture.state.preview,'Hello, about the order');assert.equal(f.fixture.state.phase,'ready');
    assert.deepEqual(f.syncs.slice(1),[{reuseRecent:true},{reuseRecent:true}],'each translation asks for a reusable pre-flight check');
  }finally{await f.service.dispose();}
});

test('a request that settles early still lets the latest draft finish its 500 ms debounce',async t=>{
  const f=await companion(t);
  try{
    f.tick(AUTO_TRANSLATE_DELAY_MS);await settle();const first=f.requests[0];
    f.edit('你好，再见');reply(first,'Hi');await settle();
    assert.equal(f.requests.length,1);
    f.tick(AUTO_TRANSLATE_DELAY_MS-1);await settle();assert.equal(f.requests.length,1);
    f.tick(1);await settle();assert.equal(f.requests.length,2);assert.equal(f.requests[1].body.text,'你好，再见');
  }finally{await f.service.dispose();}
});

test('a superseded request dropped before its POST surfaces no error and the latest draft follows',async t=>{
  const f=await companion(t);
  try{
    f.tick(AUTO_TRANSLATE_DELAY_MS);await settle();const first=f.requests[0];
    f.edit('你好，请问');first.reject(new Error('REQUEST_SUPERSEDED'));await settle();
    assert.equal(f.fixture.state.error,null);assert.equal(first.signal.aborted,false);
    f.tick(AUTO_TRANSLATE_DELAY_MS);await settle();assert.equal(f.requests.length,2);assert.equal(f.requests[1].body.text,'你好，请问');
  }finally{await f.service.dispose();}
});

test('conversation, cleared draft, account, foreground, pause and language changes still abort at once',async t=>{
  for(const mode of ['conversation','cleared','account','foreground','pause','language'])for(const stage of ['sending','superseded'])await t.test(`${mode} while ${stage}`,async st=>{
    const f=await companion(st);
    try{
      f.tick(AUTO_TRANSLATE_DELAY_MS);await settle();assert.equal(f.requests.length,1);const first=f.requests[0];
      if(stage==='superseded'){
        f.edit('你好，请问');f.tick(AUTO_TRANSLATE_DELAY_MS);await settle();
        assert.equal(first.signal.aborted,false);assert.equal(f.fixture.latestPending,true);
      }
      if(mode==='conversation')f.edit('你好，请问',{conversationId:'customer-2'});
      if(mode==='cleared')f.edit('');
      if(mode==='account')f.switchAccount();
      if(mode==='foreground')f.service.setWindowState({targetInstanceId:'1:2:3',bounds:{x:0,y:0,width:800,height:600},visible:true,minimized:false,foreground:false,groupForeground:false,dpi:96} as any);
      if(mode==='pause')await f.service.cancelTranslation();
      if(mode==='language')await f.service.setTranslationOptions({language:'ja'});
      assert.equal(first.signal.aborted,true,`${mode} aborts the request immediately`);
      assert.equal(f.fixture.superseded,undefined);assert.equal(f.fixture.latestPending,false);
      await settle();f.tick(AUTO_TRANSLATE_DELAY_MS);await settle();
      // The obsolete pending version is never sent; only a new target may start its own request.
      if(mode==='language')assert.ok(f.requests.slice(1).every(request=>request.body.target_lang==='ja'));
      else if(mode==='account')assert.ok(f.requests.slice(1).every(request=>request.identity.accountScope==='psim:8'));
      else assert.equal(f.requests.length,1);
    }finally{await f.service.dispose();}
  });
});

test('Windows translation runs at most one full session check, and none right after a recent one',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const browser=browserWorld();
  const service=new CompanionService({} as never,async()=>{},()=>{},browser.options,true),fixture=service as any;
  try{
    await fixture.sessionStarting;assert.equal(browser.checks(),1);assert.equal(fixture.state.auth,'ready');
    const edit=attachDraft(fixture);
    browser.world.clock=1000;t.mock.timers.tick(AUTO_TRANSLATE_DELAY_MS);await settle();
    assert.equal(browser.posts(),1);assert.equal(browser.checks(),1,'both pre-flight checks reuse the check started 1 s ago');
    assert.equal(fixture.state.preview,'Hello');
    browser.world.clock=10_000;edit('你好，请问');t.mock.timers.tick(AUTO_TRANSLATE_DELAY_MS);await settle();
    assert.equal(browser.posts(),2);assert.equal(browser.checks(),2,'a stale check is repeated once, then reused by the session');
  }finally{await service.dispose();}
});
