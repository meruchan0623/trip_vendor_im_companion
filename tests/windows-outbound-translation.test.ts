import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserProfileSessionService,OUTBOUND_SYNC_REUSE_MS} from '../electron/browser-profile-session';
import {CompanionService} from '../electron/companion-service';
const INITIAL_WAIT_MS=800;
function enableClock(t:any){
  t.mock.timers.enable({apis:['setTimeout','setInterval']});let now=0;
  t.mock.method(performance,'now',()=>now);
  const tick=t.mock.timers.tick.bind(t.mock.timers);
  t.mock.method(t.mock.timers,'tick',(ms:number)=>{now+=ms;tick(ms);});
}


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
  const world={clock:0,token:'token-a' as string|null,profileStatus:200,translateStatus:200,bounds:undefined as unknown,profileGate:undefined as Promise<void>|undefined,translateGate:undefined as Promise<void>|undefined,onTranslate:undefined as undefined|(()=>void),calls:[] as string[],authorizations:[] as string[]};
  const fetcher=async(input:unknown,init:any)=>{
    const path=new URL(String(input)).pathname;world.calls.push(`${init.method} ${path}`);
    if(path==='/agent/profile'){await world.profileGate;return world.profileStatus===200?json({success:true,data:{id:'7',is_active:true,permissions:['translate'],outbound_wait:world.bounds}}):json({success:false},world.profileStatus);}
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
    // Callers that do not opt in (background poll, order lookup) always run a full check.
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
/** Puts the service on a verified, foreground draft with automatic translation armed (adaptive wait running). */
function attachDraft(fixture:any){
  Object.assign(fixture.state,{auth:'ready',attached:true,targetInstanceId:'1:2:3',autoTranslate:true,translationPaused:false,messageSurface:{active:true,composerRect:null,toolbarRect:null}});
  fixture.foreground=true;fixture.external={targetInstanceId:'1:2:3',close:async()=>{},renew:async()=>{}};fixture.publish=()=>{};
  let draft=snapshot('你好');fixture.capture=async()=>captured(draft);
  fixture.adopt(captured(draft));fixture.state.followCustomerLanguage=false;fixture.state.language='en';fixture.schedule();
  // Each edit is what the settle read or the safety observation adopts.
  return(text:string,overrides:Record<string,unknown>={})=>{draft=snapshot(text,overrides);fixture.adopt(captured(draft));};
}
async function companion(t:any,store?:any){
  enableClock(t);
  let identity={accountScope:'psim:7',authGeneration:1,permissions:[] as string[]},changed!:(value:unknown)=>void;
  const requests:Pending[]=[],syncs:unknown[]=[];
  const session={identity:()=>identity,sync:async(options?:unknown)=>{syncs.push(options);},setBackgroundPolling(){},getBrowserProfile:()=>null,operatorGrant:()=>null,
    translate:(body:any,requestIdentity:unknown,signal:AbortSignal,revision?:AbortSignal)=>new Promise((resolve,reject)=>{requests.push({body,identity:requestIdentity,signal,revision,resolve,reject});signal.addEventListener('abort',()=>reject(new Error('REQUEST_ABORTED')),{once:true});}),
    queryOriginalIdentifier:async()=>{throw new Error('unused');},openLogin:async()=>{},logout:async()=>{},dispose(){}};
  const service=new CompanionService({} as never,async()=>{},()=>{},{enabled:false},true,(callback:any)=>{changed=callback;return session as never;},undefined,undefined,store),fixture=service as any;
  await fixture.sessionStarting;await fixture.translationOptionsStarting;
  changed(identity);// the initial publication, as the real session does after its first check
  await fixture.waitStarting;const edit=attachDraft(fixture);
  return{service,fixture,session,requests,syncs,edit,tick:(ms:number)=>t.mock.timers.tick(ms),
    switchAccount(){identity={accountScope:'psim:8',authGeneration:2,permissions:[]};changed(identity);}};
}

test('edits during an in-flight translation send only the latest draft once it settles',async t=>{
  const f=await companion(t);
  try{
    f.tick(INITIAL_WAIT_MS);await settle();
    assert.equal(f.requests.length,1);const first=f.requests[0];assert.equal(first.body.text,'你好');
    f.edit('你好，请问');f.edit('你好，请问订单');
    assert.equal(first.signal.aborted,false,'a same-draft edit does not abort the request on the wire');assert.equal(first.revision?.aborted,true);
    assert.equal(f.fixture.state.preview,null);
    f.tick(INITIAL_WAIT_MS);await settle();
    assert.equal(f.requests.length,1,'no second request is queued behind the one in flight');assert.equal(f.fixture.state.phase,'waiting');
    reply(first,'Hi');await settle();f.tick(1);await settle();
    assert.equal(f.requests.length,2);assert.equal(f.requests[1].body.text,'你好，请问订单');
    assert.equal(f.fixture.state.preview,null,'the superseded result is discarded by the version check');
    reply(f.requests[1],'Hello, about the order');await settle();
    assert.equal(f.fixture.state.preview,'Hello, about the order');assert.equal(f.fixture.state.phase,'ready');
    assert.deepEqual(f.syncs.slice(1),[{reuseRecent:true},{reuseRecent:true}],'each translation asks for a reusable pre-flight check');
  }finally{await f.service.dispose();}
});

test('a request that settles early still lets the latest draft finish its current debounce',async t=>{
  const f=await companion(t);
  try{
    f.tick(INITIAL_WAIT_MS);await settle();const first=f.requests[0];
    f.edit('你好，再见');reply(first,'Hi');await settle();
    assert.equal(f.requests.length,1);
    f.tick(INITIAL_WAIT_MS-1);await settle();assert.equal(f.requests.length,1);
    f.tick(1);await settle();assert.equal(f.requests.length,2);assert.equal(f.requests[1].body.text,'你好，再见');
  }finally{await f.service.dispose();}
});

test('a superseded request dropped before its POST surfaces no error and the latest draft follows',async t=>{
  const f=await companion(t);
  try{
    f.tick(INITIAL_WAIT_MS);await settle();const first=f.requests[0];
    f.edit('你好，请问');first.reject(new Error('REQUEST_SUPERSEDED'));await settle();
    assert.equal(f.fixture.state.error,null);assert.equal(first.signal.aborted,false);
    f.tick(INITIAL_WAIT_MS);await settle();assert.equal(f.requests.length,2);assert.equal(f.requests[1].body.text,'你好，请问');
  }finally{await f.service.dispose();}
});

test('conversation, cleared draft, account, foreground, pause and language changes still abort at once',async t=>{
  for(const mode of ['conversation','cleared','account','foreground','pause','language'])for(const stage of ['sending','superseded'])await t.test(`${mode} while ${stage}`,async st=>{
    const f=await companion(st);
    try{
      f.tick(INITIAL_WAIT_MS);await settle();assert.equal(f.requests.length,1);const first=f.requests[0];
      if(stage==='superseded'){
        f.edit('你好，请问');f.tick(INITIAL_WAIT_MS);await settle();
        assert.equal(first.signal.aborted,false);assert.equal(f.service.getOutboundWaitDiagnostics().pending,true);
      }
      if(mode==='conversation')f.edit('你好，请问',{conversationId:'customer-2'});
      if(mode==='cleared')f.edit('');
      if(mode==='account')f.switchAccount();
      if(mode==='foreground')f.service.setWindowState({targetInstanceId:'1:2:3',bounds:{x:0,y:0,width:800,height:600},visible:true,minimized:false,foreground:false,groupForeground:false,dpi:96} as any);
      if(mode==='pause')await f.service.cancelTranslation();
      if(mode==='language')await f.service.setTranslationOptions({language:'ja'});
      assert.equal(first.signal.aborted,true,`${mode} aborts the request immediately`);
      assert.equal(f.fixture.superseded,undefined);
      await settle();f.tick(INITIAL_WAIT_MS);await settle();
      // The obsolete pending version is never sent; only a new target may start its own request.
      if(mode==='language')assert.ok(f.requests.slice(1).every(request=>request.body.target_lang==='ja'));
      else if(mode==='account')assert.ok(f.requests.slice(1).every(request=>request.identity.accountScope==='psim:8'));
      else assert.equal(f.requests.length,1);
    }finally{await f.service.dispose();}
  });
});

test('Windows translation runs at most one full session check, and none right after a recent one',async t=>{
  enableClock(t);
  const browser=browserWorld();
  const service=new CompanionService({} as never,async()=>{},()=>{},browser.options,true),fixture=service as any;
  try{
    await fixture.sessionStarting;assert.equal(browser.checks(),1);assert.equal(fixture.state.auth,'ready');
    const edit=attachDraft(fixture);
    browser.world.clock=1000;t.mock.timers.tick(INITIAL_WAIT_MS);await settle();
    assert.equal(browser.posts(),1);assert.equal(browser.checks(),1,'both pre-flight checks reuse the check started 1 s ago');
    assert.equal(fixture.state.preview,'Hello');
    browser.world.clock=10_000;edit('你好，请问');t.mock.timers.tick(INITIAL_WAIT_MS);await settle();
    assert.equal(browser.posts(),2);assert.equal(browser.checks(),2,'a stale check is repeated once, then reused by the session');
  }finally{await service.dispose();}
});

/** Gives the attached fake editor replace/send; capture() reads back the written text until it is sent. */
function writableEditor(fixture:any){
  const writes:string[]=[],sent:string[]=[],read=fixture.capture;let written:string|undefined;
  fixture.capture=async()=>written===undefined?read():captured(snapshot(written));
  Object.assign(fixture.external,{
    replace:async(_current:unknown,text:string,authorize:()=>Promise<()=>void>)=>{(await authorize())();written=text;writes.push(text);},
    send:async(current:{text:string},authorize:()=>Promise<()=>void>)=>{(await authorize())();sent.push(current.text);written=undefined;}});
  return{writes,sent};
}

test('replace and send ask for reusable checks, and an account change seen while authorizing still blocks the write',async t=>{
  const f=await companion(t);
  try{
    const editor=writableEditor(f.fixture);
    f.tick(INITIAL_WAIT_MS);await settle();reply(f.requests[0],'Hello');await settle();assert.equal(f.fixture.state.phase,'ready');
    let before=f.syncs.length;
    await f.service.replaceDraft(undefined,'send');
    assert.deepEqual(editor.writes,['Hello']);assert.deepEqual(editor.sent,['Hello']);
    assert.deepEqual(f.syncs.slice(before),[{reuseRecent:true},{reuseRecent:true},{reuseRecent:true}],'pre-write check, write and send authorizations');
    f.edit('你好，请问');f.tick(INITIAL_WAIT_MS);await settle();reply(f.requests.at(-1)!,'Hi, may I ask');await settle();assert.equal(f.fixture.state.phase,'ready');
    const sync=f.fixture.psim.sync;let calls=0;before=f.syncs.length;
    // The write authorization's check observes a new account (as a full check or background poll would).
    f.fixture.psim.sync=async(options:unknown)=>{await sync(options);if(++calls===2)f.switchAccount();};
    await f.service.replaceDraft(undefined,'send');
    assert.deepEqual(editor.writes,['Hello'],'the write is refused');assert.deepEqual(editor.sent,['Hello']);
    assert.equal(f.syncs.length-before,2);
  }finally{await f.service.dispose();}
});

test('Windows replace and send reuse a recent check and repeat an expired one once',async t=>{
  enableClock(t);
  const browser=browserWorld();
  const service=new CompanionService({} as never,async()=>{},()=>{},browser.options,true),fixture=service as any;
  try{
    await fixture.sessionStarting;assert.equal(browser.checks(),1);
    const edit=attachDraft(fixture),editor=writableEditor(fixture);
    browser.world.clock=1000;t.mock.timers.tick(INITIAL_WAIT_MS);await settle();assert.equal(fixture.state.preview,'Hello');
    browser.world.clock=2000;await service.replaceDraft(undefined,'send');
    assert.deepEqual(editor.sent,['Hello']);assert.equal(browser.checks(),1,'the pre-write check and both authorizations reuse the check started 2 s ago');
    edit('你好，请问');browser.world.clock=2500;t.mock.timers.tick(INITIAL_WAIT_MS);await settle();assert.equal(fixture.state.preview,'Hello');
    browser.world.clock=OUTBOUND_SYNC_REUSE_MS+1;await service.replaceDraft(undefined,'send');
    assert.deepEqual(editor.sent,['Hello','Hello']);assert.equal(browser.checks(),2,'an expired check runs once, then both authorizations reuse it');
  }finally{await service.dispose();}
});


test('same-draft polling preserves useful feedback and safe adoption counts it immediately',async t=>{
  const f=await companion(t);
  try{
    f.tick(800);await settle();reply(f.requests[0],'Hello');await settle();
    f.tick(300);f.fixture.adopt(f.fixture.captured);f.tick(300);
    assert.equal(f.service.getOutboundWaitDiagnostics().useful,1);
    assert.equal(f.service.getOutboundWaitDiagnostics().waitMs,750);
    assert.deepEqual(f.service.getOutboundWaitDiagnostics().usefulWaitMs,[800]);
    const editor=writableEditor(f.fixture);f.edit('你好啊');f.tick(750);await settle();reply(f.requests[1],'Hi');await settle();
    await f.service.replaceDraft();assert.equal(editor.writes.length,1);
    assert.equal(f.service.getOutboundWaitDiagnostics().useful,2);assert.equal(f.service.getOutboundWaitDiagnostics().waitMs,700);
  }finally{await f.service.dispose();}
});

test('IME confirmation restarts the full adaptive wait without posting during composition',async t=>{
  const f=await companion(t);
  try{
    f.tick(700);f.edit('你好啊',{composing:true});f.tick(2000);await settle();assert.equal(f.requests.length,0);
    f.edit('你好啊',{composing:false});f.tick(799);await settle();assert.equal(f.requests.length,0);
    f.tick(1);await settle();assert.equal(f.requests.length,1);assert.equal(f.requests[0].body.text,'你好啊');
  }finally{await f.service.dispose();}
});

test('manual translation and Enter share the automatic in-flight gate and Enter never sends an edited version',async t=>{
  const f=await companion(t);
  try{
    const editor=writableEditor(f.fixture);const request=f.service.translate('en');await settle();assert.equal(f.requests.length,1,'manual action is immediate');
    await f.service.translate('en');assert.equal(f.requests.length,1);
    await f.fixture.sendShortcut(f.fixture.captured.snapshot);assert.equal(f.requests.length,1);assert.equal(f.fixture.state.sendPending,true);
    f.edit('你好，请问');reply(f.requests[0],'Obsolete');await request;await settle();
    assert.deepEqual(editor.sent,[]);assert.equal(f.service.getOutboundWaitDiagnostics().wasted,1);assert.equal(f.service.getOutboundWaitDiagnostics().waitMs,950);
    f.tick(800);await settle();assert.equal(f.requests.length,2);
    reply(f.requests[1],'Latest');await settle();assert.deepEqual(editor.sent,[]);
    await f.fixture.sendShortcut(f.fixture.captured.snapshot);await settle();assert.deepEqual(editor.sent,['Latest']);
  }finally{await f.service.dispose();}
});

test('Enter starts an idle draft immediately and sends only its reviewed result',async t=>{
  const f=await companion(t);
  try{
    const editor=writableEditor(f.fixture);await f.fixture.sendShortcut(f.fixture.captured.snapshot);await settle();
    assert.equal(f.requests.length,1);assert.deepEqual(editor.sent,[]);
    reply(f.requests[0],'Hello');await settle();assert.deepEqual(editor.sent,['Hello']);assert.equal(f.service.getOutboundWaitDiagnostics().useful,1);
  }finally{await f.service.dispose();}
});

test('remote profile bounds update on every sync without changing identity or postponing equal bounds',async t=>{
  enableClock(t);const browser=browserWorld(),service=new CompanionService({} as never,async()=>{},()=>{},browser.options,true),fixture=service as any;
  try{
    await fixture.sessionStarting;attachDraft(fixture);const identity=fixture.psim.identity();
    t.mock.timers.tick(200);browser.world.bounds={enabled:false,min_ms:300,max_ms:1800};await service.refreshSession();
    assert.deepEqual(fixture.psim.identity(),identity);const due=service.getOutboundWaitDiagnostics().dueAt;
    t.mock.timers.tick(100);await service.refreshSession();assert.equal(service.getOutboundWaitDiagnostics().dueAt,due);
    t.mock.timers.tick(1699);await settle();assert.equal(browser.posts(),0);t.mock.timers.tick(1);await settle();assert.equal(browser.posts(),1);
    assert.equal(service.getOutboundWaitDiagnostics().effectiveWaitMs,1800);
  }finally{await service.dispose();}
});

test('account controllers are isolated and logout clears only the current record',async t=>{
  const records=new Map<string,any>(),cleared:string[]=[],writes:string[]=[];
  const store={load:async(scope:string)=>records.get(scope)??null,save:async(scope:string,value:any)=>{writes.push(scope);records.set(scope,value);},clear:async(scope:string)=>{cleared.push(scope);records.delete(scope);}};
  const f=await companion(t,store);
  try{
    f.tick(800);await settle();const old=f.fixture.waitController;
    f.edit('你好啊');reply(f.requests[0],'Old');await settle();assert.equal(old.snapshot().waitMs,950);
    assert.deepEqual(writes,['psim:7']);f.switchAccount();await settle();assert.notEqual(f.fixture.waitController,old);
    assert.equal(f.service.getOutboundWaitDiagnostics().waitMs,800);old.onResponse(1,'superseded');assert.equal(f.service.getOutboundWaitDiagnostics().wasted,0);
    await f.service.logout();assert.deepEqual(cleared,['psim:8']);assert.ok(records.has('psim:7'));
  }finally{await f.service.dispose();}
});

test('HTTP rate limiting holds the maximum while protocol failures remain failed and context cancellation never raises wait',async t=>{
  for(const code of ['RATE_LIMITED','OUTBOUND_ECHO_MISMATCH','REQUEST_ABORTED'])await t.test(code,async st=>{
    const f=await companion(st);
    try{
      f.tick(800);await settle();f.requests[0].reject(new Error(code));await settle();const diagnostics=f.service.getOutboundWaitDiagnostics();
      assert.equal(diagnostics.failed,1);assert.equal(diagnostics.wasted,0);assert.equal(diagnostics.waitMs,800);
      assert.equal(diagnostics.effectiveWaitMs,code==='RATE_LIMITED'?1000:800);
    }finally{await f.service.dispose();}
  });
});


test('a manually selected target waits for the old request to settle then runs immediately even with automatic translation disabled',async t=>{
  const f=await companion(t);
  try{
    const old=f.service.translate('en');await settle();assert.equal(f.requests.length,1);
    await f.service.setTranslationOptions({autoTranslate:false});const next=f.service.translate('ja');await old;await settle();
    assert.equal(f.requests.length,2);assert.equal(f.requests[1].body.target_lang,'ja');assert.equal(f.requests[0].signal.aborted,true);reply(f.requests[1],'Japanese');await next;
  }finally{await f.service.dispose();}
});

test('a late response from an aborted old account cannot update the new controller or preview',async t=>{
  const f=await companion(t);const gate=deferred<any>();
  try{
    f.session.translate=((body:any,identity:any,signal:any,revision:any)=>{f.requests.push({body,identity,signal,revision,resolve:gate.resolve,reject:gate.reject});return gate.promise;}) as any;
    f.tick(800);await settle();const original=f.fixture.waitController;f.switchAccount();await settle();const successor=f.fixture.waitController;
    assert.notEqual(original,successor);reply(f.requests[0],'Old account');await settle();
    assert.equal(f.service.getOutboundWaitDiagnostics().sent,0);assert.equal(f.service.getOutboundWaitDiagnostics().useful,0);assert.equal(f.fixture.state.preview,null);
  }finally{await f.service.dispose();}
});

test('a delayed persistence load is fenced after logout',async t=>{
  const gate=deferred<any>(),cleared:string[]=[];
  const store={load:async(scope:string)=>scope==='psim:8'?gate.promise:null,save:async()=>{},clear:async(scope:string)=>{cleared.push(scope);}};
  const f=await companion(t,store);
  try{
    f.switchAccount();await settle();assert.equal(f.fixture.waitLoading,true);
    await f.service.logout();const loggedOut=f.fixture.waitController;
    gate.resolve({v:1,waitMs:950,updatedAt:performance.now(),sent:8,wasted:2,useful:0});await settle();
    assert.equal(f.fixture.waitController,loggedOut);assert.equal(f.service.getOutboundWaitDiagnostics().waitMs,800);assert.equal(f.service.getOutboundWaitDiagnostics().sent,0);assert.deepEqual(cleared,['psim:8']);
  }finally{await f.service.dispose();}
});


test('logout after transient identity revocation clears the last verified account record',async t=>{
  const cleared:string[]=[],store={load:async()=>null,save:async()=>{},clear:async(scope:string)=>{cleared.push(scope);}};
  const f=await companion(t,store);
  try{
    // A failed profile refresh publishes null before the user can explicitly log out.
    f.fixture.state.auth='connecting';f.fixture.switchWaitScope(null);
    await f.service.logout();assert.deepEqual(cleared,['psim:7']);
  }finally{await f.service.dispose();}
});


test('review Enter after supersession starts the current draft immediately when the old HTTP request settles',async t=>{
  const f=await companion(t);
  try{
    const editor=writableEditor(f.fixture);
    f.tick(800);await settle();assert.equal(f.requests.length,1);const old=f.requests[0];
    f.edit('你好，请问');f.tick(100);await f.fixture.sendShortcut(f.fixture.captured.snapshot);await settle();
    assert.equal(f.requests.length,1);assert.equal(old.signal.aborted,false,'Enter waits for the actual old HTTP request');
    f.tick(1);reply(old,'Obsolete');await settle();
    assert.equal(performance.now(),901);assert.equal(f.requests.length,2,'Enter bypasses the pending typing deadline as soon as the old request settles');
    assert.equal(f.requests[1].body.text,'你好，请问');assert.deepEqual(editor.sent,[]);
    reply(f.requests[1],'Current');await settle();assert.deepEqual(editor.sent,['Current']);
    f.tick(1000);await settle();assert.equal(f.requests.length,2,'the previous typing timer cannot send a duplicate');
  }finally{await f.service.dispose();}
});

test('the immediate Enter reservation cannot survive a draft revision or a revoked send generation',async t=>{
  for(const change of ['edit','send-mode'])await t.test(change,async st=>{
    const f=await companion(st);
    try{
      const editor=writableEditor(f.fixture);f.tick(800);await settle();
      f.edit('你好，请问');f.tick(100);await f.fixture.sendShortcut(f.fixture.captured.snapshot);await settle();
      if(change==='edit')f.edit('你好，请问订单');else await f.service.setTranslationOptions({outboundMode:'replace'});
      f.tick(1);reply(f.requests[0],'Obsolete');await settle();
      assert.equal(f.requests.length,1,'a revoked Enter does not bypass the ordinary edit wait');assert.deepEqual(editor.sent,[]);
      f.tick(800);await settle();assert.equal(f.requests.length,2);reply(f.requests[1],'Latest');await settle();assert.deepEqual(editor.sent,[],'the old Enter cannot send this result');
    }finally{await f.service.dispose();}
  });
});
