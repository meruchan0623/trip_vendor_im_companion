import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CompanionService} from '../electron/companion-service';
import {setTelemetry} from '../electron/translation-telemetry';
import {createRuntimeDiagnostics} from '../electron/runtime-diagnostics';
import {TranslationHttpError} from '../src/shared/translation-http-error';
const settle=async()=>{for(let i=0;i<5;i++)await new Promise<void>(resolve=>setImmediate(resolve));};
function deferred<T=void>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((ok,no)=>{resolve=ok;reject=no;});return{promise,resolve,reject};}
const snapshot=(text='客户正文_SECRET')=>({text,conversationId:'CUSTOMER_SECRET',revision:text.length,composing:false,scopeGeneration:1,authGeneration:1,editorIdentity:'editor',docFingerprint:'private',isPlainText:true,platformAccountScope:'ACCOUNT_SECRET',composerId:'composer',documentGeneration:1});
const capture=(draft:any)=>({source:'verified-editor',snapshot:draft,orderEntries:[],orderViewport:null,messageSurface:{active:true,composerRect:null,toolbarRect:null},currentOrderHint:null});
async function fixture(options:{publish?:(state:any)=>Promise<boolean|void>;postCapture?:Promise<void>}={}){
  const logs:any[]=[],original=console.log;console.log=(...args:any[])=>{try{logs.push(JSON.parse(args[0]));}catch{}};
  let identity={accountScope:'psim:private',authGeneration:1,permissions:[]},changed!:(value:any)=>void,draft=snapshot(),captures=0,requests=0;
  const response=deferred<any>(),sent:string[]=[];
  const session={identity:()=>identity,sync:async()=>{},setBackgroundPolling(){},getBrowserProfile:()=>null,operatorGrant:()=>null,
    translate:async(body:any)=>{requests++;setTelemetry({httpMs:40,headersMs:30,bodyMs:8,parseMs:2,translationSent:true,httpStatus:200});const result=await response.promise;return{success:true,data:{translated_text:result,draft_request_id:body.draft_request_id,composer_content_version:body.composer_content_version}};},
    queryOriginalIdentifier:async()=>{throw Error('unused');},openLogin:async()=>{},logout:async()=>{},dispose(){}};
  const service=new CompanionService({} as any,async()=>{},()=>{},{enabled:false},true,(callback:any)=>{changed=callback;return session as any;}),f=service as any;
  await f.sessionStarting;await f.translationOptionsStarting;changed(identity);await f.waitStarting;
  Object.assign(f.state,{auth:'ready',attached:true,targetInstanceId:'1:2:3',autoTranslate:false,translationPaused:false,messageSurface:{active:true},sessionMode:'owned'});f.foreground=true;
  f.external={targetInstanceId:'1:2:3',close:async()=>{},renew:async()=>{},updateWorkbench:options.publish??(async()=>true),
    replace:async(_snapshot:any,text:string,authorize:any)=>{(await authorize())();draft=snapshot(text);},
    send:async(current:any,authorize:any)=>{(await authorize())();sent.push(current.text);}};
  f.capture=async()=>{if(++captures===2&&options.postCapture)await options.postCapture;return capture(draft);};f.adopt(capture(draft));f.state.followCustomerLanguage=false;f.state.language='en';await settle();
  return{service,f,logs,response,sent,requests:()=>requests,edit(text:string){draft=snapshot(text);f.adopt(capture(draft));},async close(){await service.dispose();await settle();console.log=original;}};
}
test('translation returns before pending DOM publication; emits one private-safe summary only after explicit acknowledgement',async()=>{
  const gate=deferred(),f=await fixture({publish:async state=>{if(state.preview)await gate.promise;return true;}});
  try{
    const pending=f.service.translate('en');await settle();f.response.resolve('译文_SECRET');await pending;
    assert.equal(f.requests(),1);assert.equal(f.logs.filter(row=>row.event==='translation-summary').length,0);
    gate.resolve();await settle();const rows=f.logs.filter(row=>row.event==='translation-summary');assert.equal(rows.length,1);
    const row=rows[0];assert.equal(row.outcome,'shown');assert.equal(row.previewShown,true);assert.equal(row.providerMs,null);assert.equal(row.serverMs,null);assert.equal(row.cacheSource,'unknown');assert.equal(row.httpMs,40);assert.ok(row.captureBeforeMs>=0);assert.ok(row.captureAfterMs>=0);assert.ok(row.responseToPreviewMs>=0);assert.ok(row.userWaitMs>=0);assert.doesNotMatch(JSON.stringify(f.logs),/客户正文|译文_SECRET|CUSTOMER_SECRET|ACCOUNT_SECRET|psim:private/);
  }finally{gate.resolve();await f.close();}
});
test('missing/false renderer confirmation cannot claim a visible preview',async()=>{
  for(const result of [undefined,false]){
    const f=await fixture({publish:async()=>result});try{const pending=f.service.translate('en');await settle();f.response.resolve('Hi');await pending;await settle();const row=f.logs.find(value=>value.event==='translation-summary');assert.equal(row.previewShown,false);assert.equal(row.outcome,'success');assert.equal(row.userWaitMs,undefined);}finally{await f.close();}
  }
});
test('pause during post-response read is cancellation, while a newer draft is supersession',async()=>{
  for(const pause of [true,false]){
    const gate=deferred(),f=await fixture({postCapture:gate.promise});try{
      const pending=f.service.translate('en');await settle();f.response.resolve('Hi');await settle();
      if(pause)await f.service.cancelTranslation();else f.edit('新的草稿_SECRET');gate.resolve();await pending;await settle();
      const row=f.logs.find(value=>value.event==='translation-summary');assert.equal(row.outcome,pause?'cancelled':'superseded');assert.equal(row.reason,pause?'paused':'draft-changed');assert.equal(row.previewShown,false);
    }finally{gate.resolve();await f.close();}
  }
});
test('replacement and Enter are separately linked and never claim confirmed message delivery',async()=>{
  const f=await fixture();try{
    const pending=f.service.translate('en');await settle();f.response.resolve('Hi');await pending;await settle();const translation=f.logs.find(row=>row.event==='translation-summary');
    await f.service.replaceDraft(undefined,'send');await settle();const row=f.logs.find(value=>value.event==='translation-action');assert.equal(row.parentTraceId,translation.traceId);assert.equal(row.outcome,'send-unconfirmed');assert.equal(row.reason,undefined);assert.equal(row.sendTriggered,true);assert.equal(row.sendConfirmed,false);assert.equal(row.readbackMatched,true);assert.ok(row.replaceMs>=0);assert.ok(row.sendMs>=0);assert.deepEqual(f.sent,['Hi']);
  }finally{await f.close();}
});
test('authentication refusal before HTTP remains a failed operation with no fabricated network timings',async()=>{
  const f=await fixture();try{f.f.psim.sync=async()=>{throw Error('PSIM_LOGIN_REQUIRED');};await f.service.translate('en');await settle();const row=f.logs.find(value=>value.event==='translation-summary');assert.equal(row.outcome,'failed');assert.equal(row.reason,'login-required');assert.equal(row.translationSent,undefined);assert.equal(row.httpMs,undefined);assert.equal(f.requests(),0);}finally{await f.close();}
});
test('actual failed translations show TSIM status-specific errors and keep 422 out of permission and network classifications',async()=>{
  const cases:[Error,RegExp,string][]=[
    [new TranslationHttpError(422),/未接受此请求.*HTTP 422/,'request-failed'],
    [new TranslationHttpError(422,[{field:'client_source',type:'extra_forbidden'}]),/格式或客户端兼容校验失败.*HTTP 422/,'request-failed'],
    [new TranslationHttpError(401),/登录已失效.*HTTP 401/,'login-required'],
    [new TranslationHttpError(403),/没有此操作权限.*HTTP 403/,'permission-required'],
    [new TranslationHttpError(423),/账号已锁定.*HTTP 423/,'login-required'],
    [new TranslationHttpError(429),/过于频繁.*HTTP 429/,'rate-limited'],
    [new TranslationHttpError(503),/服务暂时不可用.*HTTP 503/,'request-failed'],
    [new Error('SERVICE_UNAVAILABLE'),/无法连接 TSIM 服务.*网络/,'network'],
    [new Error('SERVICE_TIMEOUT'),/请求超时/,'timeout'],
  ];
  for(const [error,expected,reason] of cases){
    const f=await fixture();let calls=0;
    try{
      f.f.psim.translate=async()=>{calls++;throw error;};
      await f.service.translate('en');await settle();
      assert.equal(calls,1);assert.match(f.service.getState().error!,expected);assert.doesNotMatch(f.service.getState().error!,/PSIM|TSim/);
      if(error.message.startsWith('PSIM_HTTP_422'))assert.doesNotMatch(f.service.getState().error!,/权限|网络/);
      const row=f.logs.find(value=>value.event==='translation-summary');assert.equal(row.reason,reason);
    }finally{await f.close();}
  }
});
test('order summary 422 stays unavailable while explicit 403 remains permission denied',async()=>{
  const f=await fixture();
  try{
    f.f.psim.identity().permissions.push('complaint_records');
    for(const [error,reason] of [[new TranslationHttpError(422),'unavailable'],[new TranslationHttpError(422,[{field:'text',type:'missing'}]),'unavailable'],[new TranslationHttpError(403),'permission']] as const){
      f.f.psim.queryOrderSummary=async()=>{throw error;};
      const result=await f.service.orderSummary({identifier:'ORDER1',conversationKey:f.f.context(),refresh:true});
      assert.deepEqual(result,{status:'failed',identifier:'ORDER1',reason});
    }
  }finally{await f.close();}
});
test('statistics use only observed numeric samples and do not invent server or provider measurements',()=>{
  const dir=mkdtempSync(join(tmpdir(),'tsim-summary-'));try{
    const logger=createRuntimeDiagnostics(join(dir,'runtime.log'));
    for(let i=1;i<=300;i++)logger.telemetry({event:'translation-summary',operation:'translate',translationSent:true,outcome:i===300?'cancelled':'shown',httpMs:i,userWaitMs:i*2,providerMs:null,serverMs:null,cacheSource:'unknown',text:'DO_NOT_LOG'});
    logger.statistics(true);const row=logger.snapshot().find(value=>value.event==='translation-statistics')!;
    assert.equal(row.requests,300);assert.equal(row.successCount,299);assert.equal(row.cancelledCount,1);assert.equal(row.httpSampleCount,256);assert.equal(row.userSampleCount,256);assert.equal(row.httpMaxMs,300);assert.equal(row.httpP50Ms,172);assert.equal(row.httpP95Ms,288);assert.doesNotMatch(JSON.stringify(logger.snapshot()),/DO_NOT_LOG/);
    for(let i=0;i<1050;i++)logger.lifecycle('ready',i);logger.health({rssBytes:100});const health=logger.snapshot().at(-1)!;assert.equal(health.event,'runtime-health');assert.equal(health.logRetained,1000);assert.ok(Number(health.logEvicted)>0);assert.equal(logger.snapshot().length,1000);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
