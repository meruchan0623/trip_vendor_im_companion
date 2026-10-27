import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {collectOrderSummary,displayText,esimCode,formatMb,latestCdrs,parseAmountMb,projectStatus,quotaFromPlanName,type OrderSummaryTransport} from '../electron/order-summary-query';
import {isOrderSummaryIntent,parseOrderSummaryResult,type OrderSummary,type OrderSummaryIntent,type OrderSummaryPlan} from '../src/shared/order-summary';
import {validWorkbenchAction} from '../runtime/workbench-action';
import {invokeEmbeddedAction} from '../electron/embedded-host';
import {CompanionService} from '../electron/companion-service';
import {OwnedPsimService} from '../host/owned-service';
import {BrowserProfileSessionService} from '../electron/browser-profile-session';
import {createOrderSummaryCard,esimTone,ORDER_SUMMARY_FAILURE_TEXT} from '../runtime/page/order-summary-card';
import type {PsimIdentity} from '../src/shared/workbench';

const ORDER='ORD-1';
const SECRETS={iccid:'89860012345678901234',imsi:'460011234567890',msisdn:'8613800001111',pin:'PIN-7788',lpa:'LPA:1$rsp.example$SECRET'};
const UPDATED=Date.parse('2026-10-26T09:30:00+08:00')/1000;
const DETAIL_101={code:1,result:{supplier_name:'Supplier A',apn:'ctnet',channel_dataplan_name:'日本 每日1GB 5天',dataplan_name:'JP Daily 1GB',package_status:'using',is_daily:1,data_usage:'1536 MB',today_usage:'512',spec_name:'每日1GB',esim_status:'已启用(Enabled)',esim_eid:'89049032000000000000000000000001',device_model:'iPhone 15',topup_id:'TOPUP-NOT-SHOWN',eiccid:'202610250931813371519835',iccid:SECRETS.iccid,imsi:SECRETS.imsi,msisdn:SECRETS.msisdn,pin_puk:SECRETS.pin,lpa:SECRETS.lpa,operate:{allow_cdr:1,allow_activation_callback:1},cdr_list:[{update_datetime:'2026-10-01 00:00:00',country:'Ignored',total_usage_kb:1}]}};
const LIVE_101={code:1,result:{today_usage:'850 MB',can_check_daily_usage:1,original_data:{data_usage:'2 GB'},esim_status:'Enabled',package_status:'using',device_model:'iPhone 15 Pro',iccid:SECRETS.iccid}};
const MORE_101={code:1,result:{list:[
  {update_datetime:'2026-10-25 08:10:00',country:'Japan',operator:'NTT Docomo',total_usage_kb:2048,mcc:'440',mnc:'10',iccid:SECRETS.iccid,imsi:SECRETS.imsi,msisdn:SECRETS.msisdn},
  {update_time:UPDATED,region:'Tokyo',operator:'SoftBank',total_usage:'300 MB',mcc:'440',mnc:'20'},
  'junk',
  {date:'2026-10-24',country:'Korea',total_usage_kb:'512'},
  {update_datetime:'2026-10-20 10:00',country:'Old Row',total_usage_kb:1},
]}};
const DETAIL_102={code:1,result:{supplier_name:'-',channel_dataplan_name:'Global 3GB 30天',dataplan_name:'Global 3GB',status:'inactive',operate:{allow_cdr:0,allow_activation_callback:0},data_usage:'0',cdr_list:[{update_datetime:'2026-10-01 00:00:00',country:'France',total_usage_kb:0}]}};
const EXPECTED:OrderSummary={identifier:ORDER,total:2,plans:[
  {serialNumber:'202610250931813371519835',iccid:SECRETS.iccid,supplier:'Supplier A',apn:'ctnet',channelPlanName:'日本 每日1GB 5天',sourcePlanName:'JP Daily 1GB',status:{code:'using',label:'使用中',tone:'ok'},totalUsage:'2 GB',todayUsage:'850 MB',remaining:{text:'174 MB',quota:'1 GB',scope:'daily',percent:17,tone:'warn'},unlimited:false,esimStatus:'Enabled',eid:'89049032000000000000000000000001',deviceModel:'iPhone 15 Pro',cdrs:[
    {time:'10-26 09:30',region:'Tokyo',operator:'SoftBank',usage:'300 MB',plmn:'440-20'},
    {time:'10-25 08:10',region:'Japan',operator:'NTT Docomo',usage:'2 MB',plmn:'440-10'},
    {time:'2026-10-24',region:'Korea',operator:null,usage:'0.5 MB',plmn:null},
  ]},
  {serialNumber:null,iccid:null,supplier:null,apn:null,channelPlanName:'Global 3GB 30天',sourcePlanName:'Global 3GB',status:{code:'inactive',label:'不支持自动同步',tone:'muted'},totalUsage:'0 MB',todayUsage:null,remaining:{text:'3 GB',quota:'3 GB',scope:'total',percent:100,tone:'ok'},unlimited:false,esimStatus:null,eid:null,deviceModel:null,cdrs:[
    {time:'10-01 00:00',region:'France',operator:null,usage:'0 MB',plmn:null},
  ]},
]};
/** Fixture TSim package-query routes keyed by path and query; an Error value fails that request. */
function api(overrides:Record<string,unknown>={}){
  const routes:Record<string,unknown>={
    '/agent/package-query/perform':{code:1,result:{query_id:'q-1'}},
    '/agent/package-query/dataplan-list?query_id=q-1':{code:1,result:[{card_dataplan_id:101},{card_dataplan_id:'102'}]},
    '/agent/package-query/detail?card_dataplan_id=101':DETAIL_101,
    '/agent/package-query/live-detail?card_dataplan_id=101':LIVE_101,
    '/agent/package-query/cdr-more?card_dataplan_id=101':MORE_101,
    '/agent/package-query/detail?card_dataplan_id=102':DETAIL_102,
    '/agent/package-query/live-detail?card_dataplan_id=102':new Error('SERVICE_UNAVAILABLE'),
    '/agent/package-query/cdr-more?card_dataplan_id=102':{code:1,result:{list:[]}},
    ...overrides,
  };
  const calls:string[]=[];
  const answer=(path:string)=>{calls.push(path);if(!(path in routes))throw new Error(`UNEXPECTED ${path}`);const value=routes[path];if(value instanceof Error)throw value;return structuredClone(value);};
  const transport:OrderSummaryTransport={get:async path=>answer(path),post:async(path,body)=>{assert.deepEqual(body,{order_nums:ORDER});return answer(path);}};
  /** The same routes over HTTP; failures answer 503. */
  const fetcher=async(input:string|URL|Request,init?:RequestInit)=>{
    const url=new URL(String(input)),key=url.pathname+url.search;
    if(url.pathname==='/agent/profile')return json({success:true,data:{id:7,is_active:true,permissions:['complaint_records']}});
    if(init?.method==='POST')assert.deepEqual(JSON.parse(String(init.body)),{order_nums:ORDER});
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer fixture-token');
    try{return json(answer(key));}catch{return json({},{status:503});}
  };
  return{transport,calls,fetcher};
}
const json=(value:unknown,init?:ResponseInit)=>new Response(JSON.stringify(value),{...init,headers:{'content-type':'application/json'}});
const EXPECTED_CALLS=['/agent/package-query/perform','/agent/package-query/dataplan-list?query_id=q-1',
  '/agent/package-query/detail?card_dataplan_id=101','/agent/package-query/live-detail?card_dataplan_id=101','/agent/package-query/cdr-more?card_dataplan_id=101',
  '/agent/package-query/detail?card_dataplan_id=102','/agent/package-query/live-detail?card_dataplan_id=102','/agent/package-query/cdr-more?card_dataplan_id=102'];
function noSecrets(value:unknown,allowPlanIccid=false){
  const copy=structuredClone(value);
  // Only the exact projected plan field may contain ICCID; it remains forbidden in CDRs or other fields.
  if(allowPlanIccid)for(const plan of (copy as OrderSummary).plans)plan.iccid=null;
  const text=JSON.stringify(copy);for(const secret of Object.values(SECRETS))assert.equal(text.includes(secret),false,`leaked ${secret}`);assert.equal(/token|bearer/i.test(text),false);
}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};}
const settle=(ms=40)=>new Promise(resolve=>setTimeout(resolve,ms));
const PLAN:OrderSummaryPlan=EXPECTED.plans[0];
const single=(plan:OrderSummaryPlan=PLAN,total=1):OrderSummary=>({identifier:ORDER,plans:[plan],total});

test('display text is one bounded line without control, bidi or placeholder values',()=>{
  const bidi=String.fromCharCode(0x202e),nul=String.fromCharCode(0),zero=String.fromCharCode(0x200b);
  assert.equal(displayText(`  a${bidi}b${nul}c${zero}d  `,20),'a b c d');
  for(const placeholder of ['-','—','/','null','N/A','undefined',' '])assert.equal(displayText(placeholder,10),null);
  assert.equal(displayText(12.5,10),'12.5');assert.equal(displayText(Number.NaN,10),null);assert.equal(displayText({},10),null);
  assert.equal(displayText('abcdef',4),'abcd');
  assert.equal(displayText(`abc${String.fromCodePoint(0x1f600)}d`,4),'abc');
});

test('amounts, quotas, statuses and eSIM codes follow the operator panel rules',()=>{
  assert.equal(parseAmountMb('18452.48 MB'),18452.48);assert.equal(parseAmountMb('3 GB'),3072);assert.equal(parseAmountMb('20.00(KB)'),20/1024);assert.equal(parseAmountMb(5),5);
  for(const invalid of [-1,'abc','1 PB',null,Number.POSITIVE_INFINITY])assert.equal(parseAmountMb(invalid),null);
  assert.equal(formatMb(1536),'1.5 GB');assert.equal(formatMb(0.5),'0.5 MB');assert.equal(formatMb(1024),'1 GB');
  assert.equal(quotaFromPlanName('日本 3GB 7天',false),3072);assert.equal(quotaFromPlanName('每日1GB',false),null);assert.equal(quotaFromPlanName('每日1GB',true),1024);
  assert.equal(quotaFromPlanName('1GB/天',true),1024);assert.equal(quotaFromPlanName('无限流量 3GB',false),null);assert.equal(quotaFromPlanName('3GB+5GB',false),null);assert.equal(quotaFromPlanName('Japan 500MB',true),null);
  assert.deepEqual(projectStatus('using',null),{code:'using',label:'使用中',tone:'ok'});
  assert.deepEqual(projectStatus('Inactive',{allow_cdr:0,allow_activation_callback:0}),{code:'Inactive',label:'不支持自动同步',tone:'muted'});
  assert.deepEqual(projectStatus('inactive',{allow_cdr:1,allow_activation_callback:0}),{code:'inactive',label:'未激活',tone:'warn'});
  assert.deepEqual(projectStatus('weird_state',null),{code:'weird_state',label:'weird_state',tone:'muted'});assert.equal(projectStatus('-',null),null);
  assert.equal(esimCode('已启用(Enabled)'),'Enabled');assert.equal(esimCode('Disabled'),'Disabled');assert.equal(esimCode('Not Installed'),'Not Installed');assert.equal(esimCode('未知'),null);
  assert.equal(esimTone('Enabled'),'ok');assert.equal(esimTone('disabled'),'warn');assert.equal(esimTone('Not_Installed'),'warn');assert.equal(esimTone('Deleted'),'bad');assert.equal(esimTone('Unknown'),'muted');
});

test('CDRs are newest first, at most three, and keep only time, place, operator, usage and PLMN',()=>{
  const rows=latestCdrs(MORE_101.result.list);
  assert.deepEqual(rows,EXPECTED.plans[0].cdrs);noSecrets(rows);
  for(const row of rows)assert.deepEqual(Object.keys(row).sort(),['operator','plmn','region','time','usage']);
  assert.deepEqual(latestCdrs([{update_time:'not-a-time',country:'A'},{update_time:1e20,country:'B'}]).map(row=>row.time),[null,null]);
});

test('collection reads perform, list and each plan in order and projects allowlisted fields only',async()=>{
  const {transport,calls}=api();
  const summary=await collectOrderSummary(ORDER,transport);
  assert.deepEqual(summary,EXPECTED);assert.deepEqual(calls,EXPECTED_CALLS);noSecrets(summary,true);
  assert.deepEqual(parseOrderSummaryResult({status:'ready',summary,fetchedAt:1}),{status:'ready',summary,fetchedAt:1});
  // A pending perform still lists plans; a non-success live envelope only hides the live fields.
  const pending=api({'/agent/package-query/perform':{code:2,result:{query_id:'q-1'}},'/agent/package-query/live-detail?card_dataplan_id=101':{code:0,result:LIVE_101.result}});
  const partial=await collectOrderSummary(ORDER,pending.transport);
  assert.equal(partial.plans[0].deviceModel,'iPhone 15');assert.equal(partial.plans[0].todayUsage,'512 MB');assert.equal(partial.plans[0].esimStatus,'Enabled');
});

test('collection stops at five plans and fails closed on required, fatal or malformed responses',async()=>{
  const many:Record<string,unknown>={'/agent/package-query/dataplan-list?query_id=q-1':{code:1,result:[1,2,3,4,5,6,7].map(id=>({card_dataplan_id:id}))}};
  for(let id=1;id<=7;id++)many[`/agent/package-query/detail?card_dataplan_id=${id}`]={code:1,result:{supplier_name:`S${id}`}};
  const limited=api(many),summary=await collectOrderSummary(ORDER,limited.transport);
  assert.equal(summary.total,7);assert.deepEqual(summary.plans.map(plan=>plan.supplier),['S1','S2','S3','S4','S5']);
  assert.equal(limited.calls.some(path=>path.endsWith('=6')),false);
  for(const [routes,error] of [
    [{'/agent/package-query/live-detail?card_dataplan_id=101':new Error('AUTH_CHANGED')},/AUTH_CHANGED/],
    [{'/agent/package-query/cdr-more?card_dataplan_id=101':new Error('PSIM_LOGIN_REQUIRED')},/PSIM_LOGIN_REQUIRED/],
    [{'/agent/package-query/detail?card_dataplan_id=102':new Error('SERVICE_UNAVAILABLE')},/SERVICE_UNAVAILABLE/],
    [{'/agent/package-query/detail?card_dataplan_id=102':{code:0,result:null}},/ORDER_RESPONSE_INVALID/],
    [{'/agent/package-query/perform':{code:0,result:{query_id:'q-1'}}},/ORDER_QUERY_FAILED/],
    [{'/agent/package-query/perform':{code:1,result:{query_id:'../q'}}},/ORDER_RESPONSE_INVALID/],
    [{'/agent/package-query/dataplan-list?query_id=q-1':{code:1,result:[{card_dataplan_id:'a b'}]}},/ORDER_RESPONSE_INVALID/],
    [{'/agent/package-query/dataplan-list?query_id=q-1':{code:1,result:Array.from({length:101},(_,id)=>({card_dataplan_id:id}))}},/ORDER_RESPONSE_INVALID/],
  ] as [Record<string,unknown>,RegExp][])await assert.rejects(collectOrderSummary(ORDER,api(routes).transport),error);
});

test('intents and results are validated on both sides of the bridge',()=>{
  const intent:OrderSummaryIntent={identifier:ORDER,conversationKey:'["1:2:3","customer",1,"vendor:1"]',refresh:false};
  assert.equal(isOrderSummaryIntent(intent),true);assert.equal(validWorkbenchAction('orderSummary',[intent]),true);
  for(const invalid of [{...intent,extra:1},{...intent,refresh:'no'},{...intent,identifier:'a b'},{...intent,identifier:'x'.repeat(101)},{...intent,conversationKey:''},null,[intent]])assert.equal(isOrderSummaryIntent(invalid),false);
  assert.equal(validWorkbenchAction('orderSummary',[]),false);assert.equal(validWorkbenchAction('orderSummary',[intent,intent]),false);
  const ready={status:'ready',summary:single(),fetchedAt:5};
  assert.deepEqual(parseOrderSummaryResult(ready),ready);
  assert.deepEqual(parseOrderSummaryResult({status:'empty',identifier:ORDER}),{status:'empty',identifier:ORDER});
  assert.deepEqual(parseOrderSummaryResult({status:'failed',identifier:ORDER,reason:'permission'}),{status:'failed',identifier:ORDER,reason:'permission'});
  const control=String.fromCharCode(10);
  for(const invalid of [
    {status:'failed',identifier:ORDER,reason:'other'},{status:'empty',identifier:'a b'},{status:'ready',summary:single(),fetchedAt:Number.NaN},
    {status:'ready',summary:{...single(),plans:[]},fetchedAt:1},{status:'ready',summary:{...single(),total:0},fetchedAt:1},
    {status:'ready',summary:single({...PLAN,iccid:'not-an-iccid'}),fetchedAt:1},
    {status:'ready',summary:single({...PLAN,imsi:SECRETS.imsi} as OrderSummaryPlan),fetchedAt:1},
    {status:'ready',summary:single({...PLAN,serialNumber:'x'.repeat(65)}),fetchedAt:1},
    {status:'ready',summary:single({...PLAN,cdrs:[...PLAN.cdrs,...PLAN.cdrs,...PLAN.cdrs,...PLAN.cdrs]}),fetchedAt:1},
    {status:'ready',summary:single({...PLAN,supplier:`a${control}b`}),fetchedAt:1},
    {status:'ready',summary:single({...PLAN,status:{code:'x',label:'x'.repeat(21),tone:'ok'}}),fetchedAt:1},
    {status:'ready',summary:single({...PLAN,remaining:{...PLAN.remaining!,percent:101}}),fetchedAt:1},
    {status:'ready',summary:{...single(),plans:Array(6).fill(PLAN),total:6},fetchedAt:1},
  ])assert.equal(parseOrderSummaryResult(invalid),null);
});

function companion(query:(identifier:string,signal:AbortSignal)=>Promise<OrderSummary>){
  let current:PsimIdentity|null={accountScope:'psim:7',authGeneration:1,permissions:['complaint_records']},queries=0;
  const session={identity:()=>current,sync:async()=>{},setBackgroundPolling(){},getBrowserProfile:()=>null,translate:async()=>{throw new Error('unused');},queryOriginalIdentifier:async()=>{throw new Error('unused');},queryOrderSummary:async(identifier:string,signal:AbortSignal)=>{queries++;return query(identifier,signal);},openLogin:async()=>{},logout:async()=>{},dispose(){}};
  const service=new CompanionService({} as never,async()=>{},()=>{},{enabled:false},true,()=>session as never);
  const fixture=service as any;
  fixture.state={...service.getState(),sessionMode:'owned',auth:'ready',attached:true,targetInstanceId:'1:2:3',messageSurface:{active:true,composerRect:null,toolbarRect:null}};
  fixture.foreground=true;fixture.external={close:async()=>{}};
  fixture.captured={source:'verified-editor',snapshot:{conversationId:'customer',scopeGeneration:1,platformAccountScope:'vendor:1'}};
  return{service,fixture,session,queries:()=>queries,identity:(value:PsimIdentity|null)=>{current=value;},intent:(refresh=false,identifier=ORDER):OrderSummaryIntent=>({identifier,conversationKey:fixture.context(),refresh}),age:(ms:number)=>{for(const entry of fixture.orderSummaries.values())entry.at-=ms;},
    started:async(before:number)=>{for(let i=0;i<50&&queries===before;i++)await settle(2);assert.equal(queries,before+1,'the read started');}};
}

test('host answers only the visible conversation with a verified, permitted session',{timeout:10000},async()=>{
  const world=companion(async()=>single());
  const failed=(reason:string)=>({status:'failed',identifier:ORDER,reason});
  try{
    assert.deepEqual(await world.service.orderSummary({...world.intent(),conversationKey:'other'}),failed('context'));
    world.fixture.state.messageSurface={active:false,composerRect:null,toolbarRect:null};
    assert.deepEqual(await world.service.orderSummary(world.intent()),failed('context'));
    world.fixture.state.messageSurface={active:true,composerRect:null,toolbarRect:null};
    world.identity(null);assert.deepEqual(await world.service.orderSummary(world.intent()),failed('login'));
    world.identity({accountScope:'psim:7',authGeneration:1,permissions:['complaint_records']});world.fixture.state.auth='needs_login';
    assert.deepEqual(await world.service.orderSummary(world.intent()),failed('login'));
    world.fixture.state.auth='ready';world.identity({accountScope:'psim:7',authGeneration:1,permissions:[]});
    assert.deepEqual(await world.service.orderSummary(world.intent()),failed('permission'));
    assert.equal(world.queries(),0);
    world.identity({accountScope:'psim:7',authGeneration:1,permissions:['complaint_records']});
    await assert.rejects(world.service.orderSummary({...world.intent(),extra:1} as never),/INVALID_ACTION/);
    await assert.rejects(invokeEmbeddedAction(world.service,'orderSummary',[{...world.intent(),refresh:'yes'}]),/INVALID_ACTION/);
    const result:any=await invokeEmbeddedAction(world.service,'orderSummary',[world.intent()]);
    assert.equal(result.status,'ready');assert.deepEqual(result.summary,single());assert.equal(world.queries(),1);
    world.session.queryOrderSummary=undefined as never;world.age(120_000);
    assert.deepEqual(await world.service.orderSummary(world.intent()),failed('unavailable'));
  }finally{await world.service.dispose();}
});

test('host joins reads, caches settled snapshots, floors refresh and never caches failures',{timeout:10000},async()=>{
  let next=deferred<OrderSummary>();
  const world=companion(()=>next.promise);
  try{
    const first=world.service.orderSummary(world.intent()),second=world.service.orderSummary(world.intent(true));
    next.resolve(single());const [a,b]=await Promise.all([first,second]);
    assert.equal(a,b);assert.equal(a.status,'ready');assert.equal(world.queries(),1);
    assert.equal(await world.service.orderSummary(world.intent()),a);
    assert.equal(await world.service.orderSummary(world.intent(true)),a,'refresh inside the floor reuses the snapshot');
    assert.equal(world.queries(),1);
    next=deferred();next.resolve(single({...PLAN,supplier:'Refreshed'}));world.age(4000);
    const refreshed=await world.service.orderSummary(world.intent(true));
    assert.equal(world.queries(),2);assert.equal(refreshed.status==='ready'&&refreshed.summary.plans[0].supplier,'Refreshed');
    assert.equal(await world.service.orderSummary(world.intent()),refreshed);world.age(61_000);
    next=deferred();next.resolve(single());await world.service.orderSummary(world.intent());assert.equal(world.queries(),3);
    world.identity({accountScope:'psim:7',authGeneration:2,permissions:['complaint_records']});
    next=deferred();next.resolve(single());await world.service.orderSummary(world.intent());assert.equal(world.queries(),4,'a new authorization never reuses an older snapshot');
    for(const [code,reason] of [['RATE_LIMITED','rate_limited'],['ORDER_PERMISSION_REQUIRED','permission'],['PSIM_LOGIN_REQUIRED','login'],['ORDER_RESPONSE_INVALID','unavailable'],['ECONNRESET','unavailable']]){
      next=deferred();next.reject(new Error(code));const before=world.queries();
      assert.deepEqual(await world.service.orderSummary(world.intent(false,'FAIL-1')),{status:'failed',identifier:'FAIL-1',reason});
      assert.equal(world.queries(),before+1,'failures are never cached');
    }
    next=deferred();next.resolve({identifier:'EMPTY-1',plans:[],total:0});
    assert.deepEqual(await world.service.orderSummary(world.intent(false,'EMPTY-1')),{status:'empty',identifier:'EMPTY-1'});
    next=deferred();next.resolve(single({...PLAN,iccid:'not-an-iccid'}));
    assert.deepEqual(await world.service.orderSummary(world.intent(false,'BAD-1')),{status:'failed',identifier:'BAD-1',reason:'unavailable'});
    // An account change while the read is in flight voids its result.
    next=deferred();let before=world.queries();const switched=world.service.orderSummary(world.intent(false,'SWITCH-1'));
    await world.started(before);world.identity({accountScope:'psim:8',authGeneration:3,permissions:['complaint_records']});next.resolve(single());
    assert.equal((await switched).status,'failed');
    next=deferred();before=world.queries();const dropped=world.service.orderSummary(world.intent(false,'DROP-1'));
    await world.started(before);world.identity(null);next.reject(new Error('AUTH_CHANGED'));
    assert.deepEqual(await dropped,{status:'failed',identifier:'DROP-1',reason:'login'});
  }finally{await world.service.dispose();}
});

test('owned and browser sessions read the allowlisted routes with their bound token',{timeout:10000},async()=>{
  const owned=api();
  const service=new OwnedPsimService(owned.fetcher as typeof fetch,()=>{},{load:async()=>({accessToken:'fixture-token',sessionRef:'fixture-ref'}),save:async()=>{},clear:async()=>{}});
  await service.ensureSession();
  try{
    const summary=await service.queryOrderSummary(ORDER,service.identity()!,new AbortController().signal);
    assert.deepEqual(summary,EXPECTED);assert.deepEqual(owned.calls,EXPECTED_CALLS);noSecrets(summary,true);
    const aborted=new AbortController();aborted.abort();
    await assert.rejects(service.queryOrderSummary(ORDER,service.identity()!,aborted.signal),/REQUEST_ABORTED|AbortError|aborted/i);
    await assert.rejects(service.queryOrderSummary(ORDER,{...service.identity()!,authGeneration:99},new AbortController().signal),/AUTH_CHANGED/);
    await assert.rejects(service.queryOrderSummary('a b',service.identity()!,new AbortController().signal),/INVALID_ORDER_IDENTIFIER/);
  }finally{service.dispose();}
  const browser=api();
  const session=new BrowserProfileSessionService(()=>{},{backgroundPolling:false,fetcher:browser.fetcher as typeof fetch,requestTimeoutMs:2000,discoverProfiles:async()=>[{browserPath:'fixture-browser',userDataDir:'fixture-data',profileDirectory:'Default'}],readToken:async()=>'fixture-token'});
  await session.sync();
  try{
    const summary=await session.queryOrderSummary(ORDER,new AbortController().signal);
    assert.deepEqual(summary,EXPECTED);assert.deepEqual(browser.calls,EXPECTED_CALLS);noSecrets(summary,true);
    await assert.rejects(session.queryOrderSummary('a b',new AbortController().signal),/INVALID_ORDER_IDENTIFIER/);
  }finally{session.dispose();}
});

/** Vendor layout: the order-detail frame under the customer panel. */
function page(markup='<div class="customer_info"><iframe class="customer_order-detail"></iframe></div>'){
  const dom=new JSDOM(`<!doctype html><html><body>${markup}</body></html>`,{pretendToBeVisual:true});
  const {window}=dom,document=window.document;
  for(const frame of document.querySelectorAll('iframe'))frame.getBoundingClientRect=()=>rect(600,100,400,660);
  return{dom,window,document,frame:document.querySelector('iframe')!};
}
const rect=(left:number,top:number,width:number,height:number)=>({left,top,width,height,right:left+width,bottom:top+height,x:left,y:top,toJSON(){return this;}}) as DOMRect;
function harness(markup?:string){
  const env=page(markup);const loads:{intent:OrderSummaryIntent;reply:ReturnType<typeof deferred<unknown>>}[]=[];let logins=0,outside=0;
  env.document.addEventListener('click',()=>{outside++;});env.document.addEventListener('keydown',()=>{outside++;});
  const card=createOrderSummaryCard(env.document as unknown as Document,{load:intent=>{const reply=deferred<unknown>();loads.push({intent,reply});return reply.promise;},openLogin:()=>{logins++;}});
  const root=card.host.shadowRoot!;
  const texts=(selector:string)=>[...root.querySelectorAll(selector)].map(node=>node.textContent);
  const field=(label:string)=>[...root.querySelectorAll('dt')].find(node=>node.textContent===label)?.nextElementSibling?.textContent;
  return{...env,card,root,loads,texts,field,logins:()=>logins,outside:()=>outside,ready:(summary:OrderSummary=EXPECTED)=>({status:'ready',summary,fetchedAt:Date.now()})};
}
const at=(document:Document,selector:string)=>document.querySelector<HTMLElement>(selector)!;

test('card renders the projected plan as text in the requested order',{timeout:10000},async()=>{
  const h=harness();
  try{
    h.card.update({identifier:ORDER,conversationKey:'conv',auth:'ready'});
    assert.deepEqual(h.loads.map(load=>load.intent),[{identifier:ORDER,conversationKey:'conv',refresh:false}]);
    assert.ok(h.root.querySelector('.skeleton'));assert.equal(h.root.querySelector('.order')!.textContent,ORDER);
    h.loads[0].reply.resolve(h.ready());await settle();
    assert.deepEqual(h.texts('dt'),['业务流水号','ICCID','供应商','APN','渠道套餐','源套餐','eSIM 状态','EID','设备型号']);
    assert.deepEqual(h.texts('dd'),['202610250931813371519835',SECRETS.iccid,'Supplier A','ctnet','日本 每日1GB 5天','JP Daily 1GB','Enabled','89049032000000000000000000000001','iPhone 15 Pro']);
    const sections=[...h.root.querySelectorAll('section')].map(node=>node.textContent??'');
    assert.equal(sections.length,6);
    ['业务流水号','供应商','渠道套餐','套餐状态','eSIM 状态','最近 3 条 CDR'].forEach((label,index)=>assert.ok(sections[index].includes(label),label));
    assert.equal(h.root.querySelector('.pill')!.textContent,'使用中 using');
    assert.deepEqual(h.texts('.tile small'),['总用量','当日用量','今日剩余']);assert.deepEqual(h.texts('.tile b'),['2 GB','850 MB','174 MB']);
    assert.equal(at(h.root as never,'.tile.remain').dataset.tone,'warn');
    const meter=at(h.root as never,'.meter');assert.equal(meter.getAttribute('aria-valuenow'),'17');assert.equal((meter.firstElementChild as HTMLElement).style.width,'17%');
    assert.deepEqual(h.texts('.caption span'),['剩余 17%','每日流量 1 GB']);
    assert.equal(at(h.root as never,'.code').dataset.tone,'ok');
    assert.deepEqual(h.texts('.cdr time'),['10-26 09:30','10-25 08:10','2026-10-24']);
    assert.deepEqual(h.texts('.cdr .where span'),['Tokyo · SoftBank','Japan · NTT Docomo','Korea']);
    assert.equal(h.root.textContent!.includes('…'),false);
    assert.deepEqual(h.texts('.cdr .where small'),['PLMN 440-20','PLMN 440-10']);assert.deepEqual(h.texts('.cdr b'),['300 MB','2 MB','0.5 MB']);
    assert.match(h.root.querySelector('.foot')!.textContent!,/^更新于 \d{2}:\d{2}:\d{2} · TSim$/);
    // Second plan: missing fields read as an em dash and optional rows disappear.
    const tabs=[...h.root.querySelectorAll<HTMLButtonElement>('.tab')];
    assert.deepEqual(tabs.map(tab=>tab.textContent),['套餐 1','套餐 2']);assert.equal(tabs[0].getAttribute('aria-selected'),'true');
    tabs[1].click();
    assert.deepEqual(h.texts('dt'),['业务流水号','ICCID','供应商','APN','渠道套餐','源套餐','eSIM 状态']);
    assert.deepEqual(h.texts('dd'),['—','—','—','—','Global 3GB 30天','Global 3GB','—']);
    assert.equal(h.root.querySelector('.pill')!.textContent,'不支持自动同步 inactive');
    assert.deepEqual(h.texts('.tile small'),['总用量','套餐剩余']);assert.deepEqual(h.texts('.cdr .where span'),['France']);
    assert.equal(h.outside(),0,'clicks inside the card never reach the vendor page');
  }finally{h.card.dispose();h.window.close();}
});

test('card treats server text as text and notes plans beyond the shown ones',{timeout:10000},async()=>{
  const h=harness();
  try{
    let copied='';Object.defineProperty(h.window.navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{copied=text;}}});
    h.card.update({identifier:ORDER,conversationKey:'conv',auth:'ready'});
    const hostile='<img src=x onerror=alert(1)>';
    h.loads[0].reply.resolve(h.ready(single({...PLAN,supplier:hostile,deviceModel:'<script>alert(1)</script>',unlimited:false,remaining:null,todayUsage:null}, 9)));await settle();
    assert.equal(h.root.querySelector('img,script'),null);assert.equal(h.field('供应商'),hostile);
    assert.equal(h.root.querySelector('.note')!.textContent,'该订单共 9 个套餐，这里显示前 1 个');assert.equal(h.root.querySelector('.tabs'),null);
    assert.deepEqual(h.texts('.tile b'),['2 GB','—']);assert.equal(h.root.querySelector('.meter'),null);
    h.root.querySelector<HTMLButtonElement>('[aria-label="复制 EID"]')!.click();await settle();
    assert.equal(copied,PLAN.eid);assert.equal(h.root.querySelector('.flash')!.textContent,'已复制 EID');
    const unlimited=harness();
    try{
      unlimited.card.update({identifier:ORDER,conversationKey:'conv',auth:'ready'});
      unlimited.loads[0].reply.resolve(unlimited.ready(single({...PLAN,remaining:null,unlimited:true})));await settle();
      assert.deepEqual(unlimited.texts('.tile b'),['2 GB','850 MB','不限量']);
    }finally{unlimited.card.dispose();unlimited.window.close();}
  }finally{h.card.dispose();h.window.close();}
});

test('card shows login, failure and retry states and ignores stale or mismatched replies',{timeout:10000},async()=>{
  const h=harness();
  try{
    h.card.update({identifier:ORDER,conversationKey:'conv',auth:'needs_login'});
    assert.equal(h.loads.length,0);assert.equal(h.root.querySelector('.callout p')!.textContent,'登录 TSim 后自动查询本订单的套餐信息');
    h.root.querySelector<HTMLButtonElement>('.solid')!.click();assert.equal(h.logins(),1);
    h.card.update({identifier:ORDER,conversationKey:'conv',auth:'failed'});assert.match(h.root.querySelector('.callout p')!.textContent!,/连接失败/);
    h.card.update({identifier:ORDER,conversationKey:'conv',auth:'connecting'});assert.ok(h.root.querySelector('.skeleton'));assert.equal(h.loads.length,0);
    h.card.update({identifier:ORDER,conversationKey:'conv',auth:'ready'});assert.equal(h.loads.length,1);
    // A reply for a conversation that is no longer shown is dropped.
    h.card.update({identifier:'ORD-2',conversationKey:'conv-2',auth:'ready'});assert.equal(h.loads.length,2);
    h.loads[0].reply.resolve(h.ready());await settle();assert.ok(h.root.querySelector('.skeleton'));
    h.loads[1].reply.resolve(h.ready());await settle();
    assert.equal(h.root.querySelector('.callout p')!.textContent,ORDER_SUMMARY_FAILURE_TEXT.unavailable,'a reply for another order is never shown');
    h.root.querySelector<HTMLButtonElement>('.outline')!.click();assert.equal(h.loads.length,3);assert.equal(h.loads[2].intent.refresh,false);
    const replies:[unknown,string,string|null][]=[
      [{status:'failed',identifier:'ORD-2',reason:'login'},ORDER_SUMMARY_FAILURE_TEXT.login,'登录 TSim'],
      [{status:'failed',identifier:'ORD-2',reason:'permission'},ORDER_SUMMARY_FAILURE_TEXT.permission,null],
      [{status:'failed',identifier:'ORD-2',reason:'rate_limited'},ORDER_SUMMARY_FAILURE_TEXT.rate_limited,'重试'],
      [{status:'empty',identifier:'ORD-2'},'未查询到该订单的套餐',null],
      [{status:'ready',summary:{identifier:'ORD-2',plans:[],total:0},fetchedAt:1},ORDER_SUMMARY_FAILURE_TEXT.unavailable,'重试'],
    ];
    for(const [index,[reply,text,action]] of replies.entries()){
      const last=h.loads[h.loads.length-1];last.reply.resolve(reply);await settle();
      assert.equal(h.root.querySelector('.callout p')!.textContent,text);
      assert.equal(h.root.querySelector('.callout button')?.textContent??null,action);
      // A new conversation each round: settled empty results are otherwise reused.
      const before=h.loads.length;h.card.update({identifier:'ORD-2',conversationKey:`conv-r${index}`,auth:'ready'});assert.equal(h.loads.length,before+1);
    }
    h.loads[h.loads.length-1].reply.reject(new Error('bridge timeout'));await settle();
    assert.equal(h.root.querySelector('.callout p')!.textContent,ORDER_SUMMARY_FAILURE_TEXT.unavailable);
  }finally{h.card.dispose();h.window.close();}
});

test('card reuses a settled snapshot briefly, refreshes in place and forgets it on sign-out',{timeout:10000},async()=>{
  const h=harness();
  try{
    h.card.update({identifier:ORDER,conversationKey:'conv',auth:'ready'});h.loads[0].reply.resolve(h.ready());await settle();
    h.card.update({identifier:undefined,conversationKey:'conv',auth:'ready'});assert.equal(h.root.querySelector('.body')!.childElementCount,0);
    h.card.update({identifier:ORDER,conversationKey:'conv',auth:'ready'});
    assert.equal(h.loads.length,1,'a vendor re-render of the same order does not read again');assert.equal(h.field('供应商'),'Supplier A');
    h.card.update({identifier:ORDER,conversationKey:'conv-other',auth:'ready'});assert.equal(h.loads.length,2,'another conversation reads again');
    h.loads[1].reply.resolve(h.ready());await settle();
    const refresh=h.root.querySelector<HTMLButtonElement>('.refresh')!;refresh.click();
    assert.equal(h.loads.length,3);assert.equal(h.loads[2].intent.refresh,true);
    assert.equal(h.field('供应商'),'Supplier A','refresh keeps the current snapshot visible');assert.equal(refresh.disabled,true);
    assert.ok(h.root.querySelector('.card')!.classList.contains('busy'));assert.equal(h.root.querySelector('.foot span')!.textContent,'正在刷新');
    h.loads[2].reply.resolve(h.ready(single({...PLAN,supplier:'Refreshed'})));await settle();
    assert.equal(h.field('供应商'),'Refreshed');assert.equal(refresh.disabled,false);
    const toggle=h.root.querySelector<HTMLButtonElement>('.toggle')!;toggle.click();
    assert.ok(h.root.querySelector('.card')!.classList.contains('collapsed'));assert.equal(toggle.getAttribute('aria-expanded'),'false');toggle.click();
    h.card.update({identifier:ORDER,conversationKey:'conv-other',auth:'needs_login'});assert.equal(h.root.querySelector('dd'),null);
    h.card.update({identifier:ORDER,conversationKey:'conv-other',auth:'ready'});assert.equal(h.loads.length,4,'nothing read under an earlier sign-in is shown again');
    assert.ok(h.root.querySelector('.skeleton'));
    const key=new h.window.KeyboardEvent('keydown',{bubbles:true,composed:true,key:'Enter'});refresh.dispatchEvent(key);assert.equal(h.outside(),0);
  }finally{h.card.dispose();h.window.close();}
});

test('card sits under 用户信息 in a readable frame and docks to the panel bottom otherwise',{timeout:10000},async()=>{
  const h=harness();
  try{
    await settle();assert.equal(h.card.host.style.display,'none','no order, no card');
    h.card.update({identifier:ORDER,conversationKey:'conv',auth:'ready'});
    // Readable frame: below the last 用户信息 list and any later vendor section.
    const child=h.frame.contentDocument!;
    child.body.innerHTML='<div class="wrap"><div class="im_info_basic_list">用户信息</div></div><section class="later">更多</section>';
    const list=child.querySelector<HTMLElement>('.im_info_basic_list')!,later=child.querySelector<HTMLElement>('.later')!;
    list.getClientRects=(()=>[rect(0,0,400,200)]) as never;list.getBoundingClientRect=()=>rect(0,120,400,80);later.getBoundingClientRect=()=>rect(0,220,400,40);
    h.card.reposition();await settle();
    const style=h.card.host.style;
    assert.equal(style.display,'block');assert.equal(style.top,'368px');assert.equal(style.bottom,'');assert.equal(style.maxHeight,'384px');
    assert.equal(style.left,'608px');assert.equal(style.width,'384px');assert.equal(style.zIndex,'900');
    // Not enough room below the vendor content: docked at most 60% of the panel high.
    later.getBoundingClientRect=()=>rect(0,560,400,40);h.card.reposition();await settle();
    assert.equal(style.top,'');assert.equal(style.bottom,'16px');assert.equal(style.maxHeight,'386.4px');
    // Out-of-process frame: no readable content, docked.
    Object.defineProperty(h.frame,'contentDocument',{configurable:true,get:()=>null});
    h.card.reposition();await settle();assert.equal(style.bottom,'16px');assert.equal(style.display,'block');
    h.frame.getBoundingClientRect=()=>rect(600,100,400,150);h.card.reposition();await settle();assert.equal(style.display,'none','a short panel has no room');
    h.frame.getBoundingClientRect=()=>rect(600,100,400,660);h.card.reposition();await settle();assert.equal(style.display,'block');
    h.document.querySelector('.customer_info')!.classList.add('close');h.card.reposition();await settle();assert.equal(style.display,'none','a closed customer panel hides the card');
    h.document.querySelector('.customer_info')!.classList.remove('close');h.card.reposition();await settle();assert.equal(style.display,'block');
    h.card.host.remove();h.card.reposition();await settle();assert.equal(h.card.host.isConnected,true,'a vendor re-render that drops the card puts it back');
    h.card.update({identifier:undefined,conversationKey:null,auth:'ready'});await settle();assert.equal(style.display,'none');
    h.card.dispose();assert.equal(h.document.getElementById('tsim-order-summary'),null);
    h.card.update({identifier:ORDER,conversationKey:'conv',auth:'ready'});assert.equal(h.loads.length,1,'a disposed card never reads');
  }finally{h.card.dispose();h.window.close();}
  const ambiguous=harness('<div class="customer_info"><iframe class="customer_order-detail"></iframe><iframe class="customer_order-detail"></iframe></div>');
  try{ambiguous.card.update({identifier:ORDER,conversationKey:'conv',auth:'ready'});await settle();assert.equal(ambiguous.card.host.style.display,'none','two order frames are ambiguous');}
  finally{ambiguous.card.dispose();ambiguous.window.close();}
  const hidden=harness('<div class="customer_info" hidden><iframe class="customer_order-detail"></iframe></div>');
  try{hidden.card.update({identifier:ORDER,conversationKey:'conv',auth:'ready'});await settle();assert.equal(hidden.card.host.style.display,'none');}
  finally{hidden.card.dispose();hidden.window.close();}
});

test('Windows type is legible, near-black and dense; the scrollbar is a hairline on the right edge',{timeout:10000},()=>{
  const h=harness();
  try{
    h.card.update({identifier:ORDER,conversationKey:'conv',auth:'ready'});
    const css=h.root.querySelector('style')!.textContent!;
    // Every font size goes through the scale, so the Windows layer reaches all of them.
    assert.equal(/font(?:-size)?:[^;{}]*d+(?:.d+)?px/.test(css.replace(/--fs-[a-z]+:[d.]+px/g,'')),false);
    const windows=css.slice(css.lastIndexOf(':host{'));
    assert.match(windows,/'Microsoft YaHei UI'/);assert.match(windows,/'Cascadia Mono',Consolas/);
    for(const [,size] of windows.matchAll(/--fs-[a-z]+:([d.]+)px/g))assert.ok(Number(size)>=12&&Number(size)<=15,size);
    for(const [,hex] of windows.matchAll(/--ink(?:-[23])?:#([0-9a-f]{6})/g)){
      const [r,g,b]=[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16));assert.ok(Math.max(r,g,b)<=0x60,hex);
    }
    // No text is ever elided: values wrap instead.
    assert.equal(/ellipsis/.test(css),false);
    // The order number stays whole on one line.
    assert.match(css,/.order{[^}]*white-space:nowrap;flex:none/);
    assert.match(css,/.body::-webkit-scrollbar{width:3px/);assert.equal(/scrollbar-(?:width|color)[^;]*;?[^}]*}/.test(css.match(/.body{[^}]*}/g)!.join('')),false);
  }finally{h.card.dispose();h.window.close();}
});
