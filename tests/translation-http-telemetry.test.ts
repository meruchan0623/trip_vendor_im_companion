import test from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {BrowserProfileSessionService} from '../electron/browser-profile-session';
import {BrowserSessionService} from '../electron/browser-session';
import {PersistentSessionService} from '../electron/owned-session';
import {OwnedPsimService} from '../host/owned-service';
import {createTelemetry,runWithTelemetry,currentTelemetry,setTelemetry,finishTelemetry,TELEMETRY_RUN_ID,startHttpTelemetry} from '../electron/translation-telemetry';
import {sanitizeTelemetry,formatTelemetry} from '../src/shared/runtime-telemetry';
import {projectTranslationDiagnostics,translationDiagnosticsFromResponse} from '../src/shared/translation-response-diagnostics';
import {translationHttpError,TranslationHttpError,serviceErrorMessage} from '../src/shared/translation-http-error';
import type {OutboundBody} from '../src/shared/workbench';
const body:OutboundBody={text:'正文不能进入日志',source_lang:'zh',target_lang:'en',purpose:'outbound',draft_request_id:'fixture-translation',composer_content_version:'fixture-version'};
const result=(translated_text='Private translated text',extra:Record<string,unknown>={})=>({success:true,data:{translated_text,draft_request_id:body.draft_request_id,composer_content_version:body.composer_content_version,...extra}});
const json=(value:unknown,init?:ResponseInit)=>new Response(JSON.stringify(value),{...init,headers:{'content-type':'application/json',...init?.headers}});
const profile=()=>json({success:true,data:{id:7,is_active:true,permissions:['complaint_records']}});
const metadata={provider:'google_nmt',translation_profile:'agent_draft',translation_policy_version:'2026-10-23.2',translation_protocol:'agent-translation-items-v1'};
const diagnostics={version:1,attribution:'request_owned_calls',server_ms:42.5,upstream_ms:30,provider_queue_ms:2.5,upstream_calls:1,upstream_calls_completed:1,input_tokens:314,output_tokens:23,cached_input_tokens:128,cache_write_tokens:null,reasoning_tokens:0,usage_complete:true,result_source:'upstream'};
function stream(value:unknown){const encoded=new TextEncoder().encode(JSON.stringify(value));let part=0;return new Response(new ReadableStream({async pull(controller){await delay(3);if(part===0)controller.enqueue(encoded.slice(0,10));else if(part===1)controller.enqueue(encoded.slice(10));else controller.close();part++;}}),{headers:{'content-type':'application/json','content-length':String(encoded.length)}});}
async function capture(fn:(logs:Record<string,any>[])=>Promise<void>){const original=console.log,logs:Record<string,any>[]=[];console.log=(line:unknown)=>{if(typeof line==='string')try{logs.push(JSON.parse(line));}catch{}};try{await fn(logs);}finally{console.log=original;}}
async function owned(fetcher:(input:string,init:RequestInit)=>Promise<Response>){const service=new OwnedPsimService(async(input,init)=>new URL(input).pathname==='/agent/profile'?profile():fetcher(input,init),()=>{},{load:async()=>({accessToken:'fixture-token',sessionRef:'fixture-ref'}),save:async()=>{},clear:async()=>{}});await service.ensureSession();return service;}
async function browser(fetcher:typeof fetch){const service=new BrowserProfileSessionService(()=>{},{backgroundPolling:false,fetcher,requestTimeoutMs:20,discoverProfiles:async()=>[{browserPath:'fixture-browser',userDataDir:'fixture-data',profileDirectory:'Default'}],readToken:async()=> 'fixture-token'});await service.sync();return service;}
function bridge(fetcher:(input:string,init:RequestInit)=>Promise<Response>){
  const source=readFileSync('browser-extension/background.js','utf8'),entry=source.slice(source.indexOf('async function pageRequest('),source.indexOf('async function inject('));
  return runInNewContext(`(${entry})`,{location:{origin:'https://csagent.tsim.tech'},localStorage:{getItem:()=> 'fixture-token'},crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,AbortController,setTimeout,clearTimeout,fetch:fetcher});
}

test('all translation exits are accepted initially by old extra-forbid and new optional-source models',async()=>{
  for(const schema of ['old-extra-forbid','new-optional-source'])for(const mode of ['owned','browser','extension']){
    let requests=0;
    const fetcher=async(input:string,init:RequestInit)=>{
      if(new URL(input).pathname==='/agent/profile')return profile();
      requests++;const sent=JSON.parse(String(init.body));
      // Contract-equivalent fixture: the old model forbids every extra field; the new model optionally accepts client_source.
      const fields=[...Object.keys(body),...(schema==='new-optional-source'?['client_source']:[])];
      const extra=Object.keys(sent).filter(key=>!fields.includes(key));
      if(extra.length)return json({detail:extra.map(key=>({loc:['body',key],type:'extra_forbidden',input:sent[key]}))},{status:422});
      assert.deepEqual(sent,body);return json(result());
    };
    if(mode==='extension'){
      const response=await bridge(fetcher)('translate',{body,expectedAccount:'psim:7',expectedPermissions:['complaint_records']},null,'fixture');
      assert.equal(response.ok,true,`${schema}/${mode}`);assert.equal(response.value.data.translated_text,'Private translated text');
    }else{
      const session=mode==='owned'?await owned(fetcher):await browser(fetcher as typeof fetch);
      try{assert.equal((await session.translate(body,session.identity()!,new AbortController().signal)).data.translated_text,'Private translated text');}finally{session.dispose();}
    }
    assert.equal(requests,1,`${schema}/${mode} must make exactly one business request`);
  }
});

test('422 projection keeps only bounded validation fields and trusted UUID diagnostics',async()=>{
  const requestId='12345678-1234-4234-8234-123456789abc';
  const error=await translationHttpError(json({detail:[{loc:['body','client_source'],type:'extra_forbidden',msg:'RAW_SECRET',input:{token:'TOKEN_SECRET',body:'CHAT_SECRET'}},{loc:['body','CHAT_SECRET'],type:'missing'},{loc:['body','text'],type:'TOKEN_SECRET'}],request_id:'CHAT_SECRET'},{status:422,headers:{'x-request-id':requestId}}));
  assert.equal(error.message,'PSIM_HTTP_422_VALIDATION');assert.deepEqual(error.validation,[{field:'client_source',type:'extra_forbidden'}]);assert.equal(error.requestId,requestId);
  assert.match(serviceErrorMessage(error)!,/兼容校验失败/);assert.match(serviceErrorMessage(error)!,new RegExp(requestId));
  assert.doesNotMatch(JSON.stringify(error)+serviceErrorMessage(error),/RAW_SECRET|TOKEN_SECRET|CHAT_SECRET|input|body/);
  assert.equal((await translationHttpError(json({detail:[]},{status:422,headers:{'x-request-id':'TOKEN_SECRET'}}))).requestId,undefined);
});

test('missing, oversized, malformed and unsupported 422 bodies fall back to accurate status without retry',async()=>{
  let cancelled=0;
  const oversized=()=>new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(20_000));},cancel(){cancelled++;}}),{status:422});
  for(const response of [new Response(null,{status:422}),new Response('not-json RAW_SECRET',{status:422}),json({detail:'RAW_SECRET'},{status:422}),oversized(),json({detail:[]},{status:422,headers:{'content-length':'20000'}})]){
    const error=await translationHttpError(response);assert.equal(error.message,'PSIM_HTTP_422');assert.match(serviceErrorMessage(error)!,/未接受此请求/);assert.doesNotMatch(serviceErrorMessage(error)!,/网络|权限|RAW_SECRET/);
  }
  assert.equal(cancelled,1);
});

test('unknown and validation 422 at every HTTP exit stay single-request and cannot become permission errors',async()=>{
  for(const detail of [[],[{loc:['body','client_source'],type:'extra_forbidden',input:'CHAT_SECRET',msg:'RAW_SECRET'}]])for(const mode of ['owned','browser','extension']){
    let requests=0;const fetcher=async(input:string)=>{if(new URL(input).pathname==='/agent/profile')return profile();requests++;return json({detail,body:'CHAT_SECRET',token:'TOKEN_SECRET'},{status:422});};
    const expected=detail.length?'PSIM_HTTP_422_VALIDATION':'PSIM_HTTP_422';
    if(mode==='extension'){
      const response=await bridge(fetcher)('translate',{body,expectedAccount:'psim:7',expectedPermissions:['complaint_records']},null,'fixture');assert.equal(response.error,expected);
    }else{
      const session=mode==='owned'?await owned(fetcher):await browser(fetcher as typeof fetch),identity=session.identity();
      try{await assert.rejects(session.translate(body,identity!,new AbortController().signal),(error:Error)=>{assert.equal(error.message,expected);assert.doesNotMatch(JSON.stringify(error),/CHAT_SECRET|TOKEN_SECRET|RAW_SECRET/);return true;});assert.deepEqual(session.identity(),identity);}finally{session.dispose();}
    }
    assert.equal(requests,1);
  }
});

test('HTTP status display distinguishes authentication, permission, refusal, throttling and service failure',()=>{
  for(const [status,phrase] of [[401,'登录已失效'],[403,'没有此操作权限'],[423,'账号已锁定'],[429,'过于频繁'],[500,'服务暂时不可用'],[502,'服务暂时不可用']] as const){
    const message=serviceErrorMessage(new TranslationHttpError(status))!;assert.match(message,new RegExp(phrase));assert.match(message,new RegExp(`HTTP ${status}`));assert.doesNotMatch(message,/网络/);
  }
});

test('explicit cancellation stops a stalled error-body read and never causes a second request',async()=>{
  for(const mode of ['owned','browser','extension']){
    let sent!:()=>void,cancelled=0,requests=0;const started=new Promise<void>(resolve=>sent=resolve);
    const fetcher=async(input:string)=>{if(new URL(input).pathname==='/agent/profile')return profile();requests++;sent();return new Response(new ReadableStream({pull(){},cancel(){cancelled++;}}),{status:422});};
    if(mode==='extension'){
      const pageRequest=bridge(fetcher),pending=pageRequest('translate',{body,expectedAccount:'psim:7',expectedPermissions:['complaint_records']},null,'cancel-fixture');
      await started;await pageRequest('cancel',null,null,'cancel-fixture');assert.equal((await pending).error,'REQUEST_ABORTED');
    }else{
      const session=mode==='owned'?await owned(fetcher):await browser(fetcher as typeof fetch),controller=new AbortController();
      try{const pending=session.translate(body,session.identity()!,controller.signal);await started;controller.abort();await assert.rejects(pending,/REQUEST_ABORTED/);}finally{session.dispose();}
    }
    assert.equal(requests,1);assert.equal(cancelled,1);
  }
});

test('stalled 422 error-body reads preserve deadline and external revocation priority in browser and owned sessions',async()=>{
  const originalTimeout=AbortSignal.timeout;
  // Owned requests retain their production 30 s deadline; shorten only this isolated synthetic test.
  AbortSignal.timeout=()=>originalTimeout(20);
  const keepAlive=setTimeout(()=>{},2000);
  try{
    for(const mode of ['owned','browser'])for(const stop of ['timeout','logout','dispose']){
      let started!:()=>void,requests=0,cancelled=0;const sent=new Promise<void>(resolve=>started=resolve);
      const fetcher=async(input:string)=>{if(new URL(input).pathname==='/agent/profile')return profile();if(new URL(input).pathname==='/agent/logout')return json({success:true});requests++;return new Response(new ReadableStream({pull(){started();},cancel(){cancelled++;}},{highWaterMark:0}),{status:422});};
      const service=mode==='owned'?await owned(fetcher):await browser(fetcher as typeof fetch);
      try{
        const pending=service.translate(body,service.identity()!,new AbortController().signal);
        const rejected=assert.rejects(pending,stop==='timeout'?(mode==='owned'?/^Error: SERVICE_TIMEOUT$/:/^Error: BROWSER_SESSION_TIMEOUT$/):/^Error: AUTH_CHANGED$/);
        await sent;if(stop==='logout')await service.logout();else if(stop==='dispose')service.dispose();
        await rejected;assert.equal(requests,1);assert.equal(cancelled,1);
        assert.equal(service.identity()===null,stop!=='timeout');
      }finally{service.dispose();}
    }
  }finally{AbortSignal.timeout=originalTimeout;clearTimeout(keepAlive);}
});

test('401 and 423 self-revocation retain refusal status and explicit cancellation still wins',async()=>{
  for(const mode of ['owned','browser'])for(const status of [401,423])for(const abort of [false,true]){
    const controller=new AbortController();let requests=0;
    const fetcher=async(input:string)=>{if(new URL(input).pathname==='/agent/profile')return profile();requests++;if(abort)controller.abort();return json({detail:'PRIVATE_SECRET'},{status});};
    const session=mode==='owned'?await owned(fetcher):await browser(fetcher as typeof fetch);
    try{await assert.rejects(session.translate(body,session.identity()!,controller.signal),abort?/REQUEST_ABORTED/:new RegExp(`PSIM_HTTP_${status}`));assert.equal(requests,1);if(!abort)assert.equal(session.identity(),null);}finally{session.dispose();}
  }
});

test('serialized extension auth refusals invalidate the native bridge identity and all pending translations',async()=>{
  for(const status of [401,423,422,403,429,503,'legacy-login'] as const){
    const key='a'.repeat(64)+':7',identity={accountScope:'psim:7',authGeneration:1,permissions:['complaint_records']};
    const session=Object.create(BrowserSessionService.prototype) as BrowserSessionService,fixture=session as any;
    const changed:unknown[]=[],writes:any[]=[];
    Object.assign(fixture,{current:identity,sessionKey:key,generation:1,pending:new Map(),ready:Promise.resolve(),disposed:false,suspended:false,options:{requestTimeoutMs:1000},waitBounds:{enabled:true,min_ms:100,max_ms:1000},orderWindows:new Set(),changed:(value:unknown)=>changed.push(value),socket:{write(line:string){writes.push(JSON.parse(line));return true;}}});
    let requests=0;
    const pageRequest=bridge(async(input:string)=>{if(new URL(input).pathname==='/agent/profile')return profile();requests++;return json({detail:[]},{status:typeof status==='number'?status:401});});
    const first=session.translate(body,identity,new AbortController().signal),second=session.translate({...body,draft_request_id:'second-fixture'},identity,new AbortController().signal);
    const revoked=status===401||status===423||status==='legacy-login';
    const firstRejected=assert.rejects(first,revoked?/AUTH_CHANGED/:new RegExp(`PSIM_HTTP_${status}`));
    const secondRejected=assert.rejects(second,/AUTH_CHANGED/);
    await new Promise<void>(resolve=>setImmediate(resolve));
    const outgoing=writes.filter(value=>value.type==='request');assert.equal(outgoing.length,2);
    assert.deepEqual(outgoing[0].payload.body,body);
    const reply=status==='legacy-login'?{ok:false,error:'PSIM_LOGIN_REQUIRED'}:await pageRequest('translate',{body:outgoing[0].payload.body,expectedAccount:identity.accountScope,expectedPermissions:identity.permissions},null,'native-fixture');
    fixture.receive({type:'response',id:outgoing[0].id,ok:reply.ok,error:reply.error});
    await firstRejected;
    if(revoked){
      assert.equal(session.identity(),null);assert.equal(session.outboundWaitBounds(),null);assert.equal(fixture.pending.size,0);assert.deepEqual(changed,[null]);
      fixture.receive({type:'response',id:outgoing[1].id,ok:true,value:result()});assert.equal(session.identity(),null);
    }else{
      assert.deepEqual(session.identity(),identity);assert.equal(fixture.pending.size,1);assert.equal(changed.length,0);await session.logout();
    }
    await secondRejected;assert.equal(requests,status==='legacy-login'?0:1);
    await assert.rejects(session.translate(body,identity,new AbortController().signal),/AUTH_CHANGED/);
  }
});

test('owned and fallback browser send the six compatible fields once for unknown 422',async()=>{
  for(const mode of ['owned','browser'] as const){
    const requests:Record<string,unknown>[]=[];
    const fetcher=async(input:string,init:RequestInit)=>{
      if(new URL(input).pathname==='/agent/profile')return profile();
      requests.push(JSON.parse(String(init.body)));
      return json({detail:[]},{status:422});
    };
    const service=mode==='owned'?await owned(fetcher):await browser(fetcher as typeof fetch);
    try{await assert.rejects(service.translate(body,service.identity()!,new AbortController().signal));assert.deepEqual(requests,[body]);}
    finally{service.dispose();}
  }
});

test('serialized MAIN-world bridge sends the compatible payload once for success and unknown 422',async()=>{
  const source=readFileSync('browser-extension/background.js','utf8');
  const entry=source.slice(source.indexOf('async function pageRequest('),source.indexOf('async function inject('));
  for(const status of [200,422]){
    const requests:Record<string,unknown>[]=[];
    const pageRequest=runInNewContext(`(${entry})`,{location:{origin:'https://csagent.tsim.tech'},localStorage:{getItem:()=> 'fixture-token'},crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,AbortController,setTimeout,clearTimeout,fetch:async(input:string,init:RequestInit)=>{
      if(new URL(input).pathname==='/agent/profile')return profile();
      requests.push(JSON.parse(String(init.body)));
      return status===200?json(result()):json({detail:[]},{status});
    }});
    const response=await pageRequest('translate',{body,expectedAccount:'psim:7',expectedPermissions:['complaint_records']},null,'fixture');
    assert.equal(response.ok,status===200);
    assert.deepEqual(requests,[body]);
  }
});

test('strict projection drops secrets, arbitrary uppercase codes, getters and invalid fields',()=>{
  let getters=0;const unsafe={event:'translation-summary',text:body.text,translated_text:'secret',model:'secret',headers:{Authorization:'Bearer secret'},token:'SECRET_TOKEN',code:'PRIVATE_CREDENTIAL',providerMs:99,serverMs:0,cacheSource:'memory',httpMs:Infinity,bodyMs:-1,sourceLanguage:'../../secret',providerReported:'secret-provider',translationProfile:'secret-profile',translationProtocol:'secret-protocol',policyVersion:'secret-version',serverRequestId:'customer-id',runId:'not-run-id',traceId:'customer-id',get customerIdentifier(){getters++;throw new Error('getter');}};
  const safe=sanitizeTelemetry(unsafe)!;assert.deepEqual(safe,{event:'translation-summary',code:'UNCLASSIFIED',providerMs:99,serverMs:0});assert.equal(getters,0);
  const knownGetter=Object.defineProperty({event:'runtime-health'},'rssBytes',{get(){getters++;throw new Error('getter');},enumerable:true});assert.deepEqual(sanitizeTelemetry(knownGetter),{event:'runtime-health'});assert.equal(getters,0);
  assert.equal(sanitizeTelemetry({event:'arbitrary',httpMs:1}),undefined);assert.deepEqual(sanitizeTelemetry(JSON.parse('{"event":"translation-summary","__proto__":"secret","constructor":"secret","toString":"secret"}')),{event:'translation-summary'});
  const linked={event:'translation-action',parentTraceId:'12345678-1234-4234-8234-123456789abc',replaceMs:2,sendMs:3,httpSampleCount:256,userSampleCount:0};assert.deepEqual(sanitizeTelemetry(linked),linked);assert.deepEqual(sanitizeTelemetry({event:'translation-statistics',parentTraceId:'private-id',replaceMs:-1,sendMs:Infinity,httpSampleCount:1.5,userSampleCount:-1}),{event:'translation-statistics'});assert.match(formatTelemetry(linked),/替换耗时：2 ms/);assert.match(formatTelemetry(linked),/发送耗时：3 ms/);assert.match(formatTelemetry(linked),/请求耗时样本数：256/);assert.match(formatTelemetry(linked),/用户等待样本数：0/);
  assert.match(formatTelemetry({event:'translation-summary',providerMs:null,serverMs:null,cacheSource:'unknown',httpMs:2}),/翻译请求：2 ms/);assert.match(formatTelemetry({event:'translation-summary',cacheSource:'unknown'}),/结果来源：未知/);
});

test('owned successful HTTP attaches timings and metadata to exactly one redacted summary without new requests',async()=>capture(async logs=>{
  let requests=0;const service=await owned(async()=>{requests++;await delay(3);return stream(result(undefined,metadata));});
  try{const trace=createTelemetry('translate',{sourceChars:body.text.length,token:'secret',text:body.text});await runWithTelemetry(trace,async()=>{assert.equal(currentTelemetry(),trace);const response=await service.translate(body,service.identity()!,new AbortController().signal);assert.equal(response.data.translated_text,'Private translated text');assert.equal((response.data as any).provider,undefined);setTelemetry({outcome:'shown',model:'secret'});});assert.equal(logs.length,0);finishTelemetry(trace,'shown');finishTelemetry(trace,'failed');assert.equal(logs.length,1);const log=logs[0];assert.equal(log.runId,TELEMETRY_RUN_ID);assert.equal(log.translationSent,true);assert.equal(log.providerReported,'google_nmt');assert.equal(log.translationProfile,'agent_draft');assert.equal(log.translationProtocol,'agent-translation-items-v1');assert.equal(log.providerMs,null);assert.equal(log.serverMs,null);assert.equal(log.cacheSource,'unknown');assert.equal(log.httpStatus,200);assert.ok(log.headersMs>=2);assert.ok(log.bodyMs>=5);assert.ok(log.httpMs>=log.headersMs+log.bodyMs);assert.ok(log.parseMs>=0);assert.equal(log.responseBytes,log.contentLength);assert.equal(log.requestBytes,Buffer.byteLength(JSON.stringify(body)));assert.equal(requests,1);assert.equal(JSON.stringify(log).includes(body.text),false);assert.equal(JSON.stringify(log).includes('Private translated text'),false);assert.equal('model' in log,false);}finally{service.dispose();}
}));

test('malicious service metadata never enters trace and strict echo validation remains enabled',async()=>capture(async logs=>{
  const service=await owned(async()=>json(result('valid',{provider:'API_KEY_SECRET',translation_profile:'private account',translation_protocol:'customer secret',translation_policy_version:'token',request_id:'customer-id',model:'model-secret',provider_ms:8,server_ms:9})));
  try{const trace=createTelemetry('translate');await runWithTelemetry(trace,()=>service.translate(body,service.identity()!,new AbortController().signal));finishTelemetry(trace,'shown');assert.equal(logs[0].providerReported,undefined);assert.equal(logs[0].translationProfile,undefined);assert.equal(logs[0].serverRequestId,undefined);assert.equal(logs[0].providerMs,null);assert.equal(logs[0].serverMs,null);const wrong={...body,composer_content_version:'mismatch'};await assert.rejects(service.translate(wrong,service.identity()!,new AbortController().signal),/OUTBOUND_ECHO_MISMATCH/);}finally{service.dispose();}
}));

test('concurrent traces remain isolated even with interleaved HTTP and finish',async()=>capture(async logs=>{
  let requests=0;const service=await owned(async(_input,init)=>{requests++;const value=JSON.parse(String(init.body));await delay(value.target_lang==='ja'?8:1);return json(result('Private translated text',{...metadata,provider:value.target_lang==='ja'?'deepl':'google_nmt'}));});
  try{const traces=[createTelemetry('translate',{targetLanguage:'ja'}),createTelemetry('translate',{targetLanguage:'en'})];await Promise.all(traces.map(trace=>runWithTelemetry(trace,async()=>{await service.translate({...body,target_lang:trace.fields.targetLanguage as 'ja'|'en'},service.identity()!,new AbortController().signal);finishTelemetry(trace,'shown');})));assert.equal(logs.length,2);assert.equal(new Set(logs.map(log=>log.traceId)).size,2);assert.equal(logs.find(log=>log.targetLanguage==='ja')?.providerReported,'deepl');assert.equal(logs.find(log=>log.targetLanguage==='en')?.providerReported,'google_nmt');assert.equal(requests,2);}finally{service.dispose();}
}));

test('HTTP errors preserve status, safe retry delay and phase with bounded error projection',async()=>capture(async logs=>{
  let bodyReads=0;const service=await owned(async()=>{const response=json({token:'private error'},{status:429,headers:{'retry-after':'2','x-request-id':'customer-id'}});Object.defineProperty(response,'text',{value:async()=>{bodyReads++;throw Error('must not read');}});return response;});
  try{const trace=createTelemetry('translate');await runWithTelemetry(trace,async()=>{await assert.rejects(service.translate(body,service.identity()!,new AbortController().signal),/PSIM_HTTP_429/);});finishTelemetry(trace,'rate-limited');assert.equal(logs[0].httpStatus,429);assert.equal(logs[0].httpFailurePhase,'validation');assert.equal(logs[0].headerRetryAfterMs,2000);assert.ok(logs[0].failedElapsedMs>=0);assert.equal(logs[0].responseBytes,undefined);assert.equal(bodyReads,0);}finally{service.dispose();}
}));

test('invalid JSON body retains parse phase and elapsed time',async()=>capture(async logs=>{
  const service=await owned(async()=>new Response('invalid private payload'));try{const trace=createTelemetry('translate');await runWithTelemetry(trace,async()=>{await assert.rejects(service.translate(body,service.identity()!,new AbortController().signal),/INVALID_SERVICE_RESPONSE/);});finishTelemetry(trace,'failed');assert.equal(logs[0].httpFailurePhase,'parse');assert.ok(logs[0].parseMs>=0);assert.equal(logs[0].responseBytes,23);assert.equal(JSON.stringify(logs[0]).includes('invalid private payload'),false);}finally{service.dispose();}
}));

test('browser timeout and explicit abort preserve existing error semantics and phases',async()=>capture(async logs=>{
  let requests=0;const service=await browser(async(input,init)=>{if(new URL(String(input)).pathname==='/agent/profile')return profile();requests++;return new Promise<Response>((_resolve,reject)=>{const signal=init!.signal!;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});});
  const keepAlive=setTimeout(()=>{},1000);try{for(const abort of [false,true]){const trace=createTelemetry('translate'),controller=new AbortController();const operation=runWithTelemetry(trace,()=>service.translate(body,service.identity()!,controller.signal));if(abort)setTimeout(()=>controller.abort(),2);await assert.rejects(operation,abort?/REQUEST_ABORTED/:/BROWSER_SESSION_TIMEOUT/);finishTelemetry(trace,abort?'cancelled':'failed');const log=logs.at(-1)!;assert.equal(log.httpFailurePhase,'request');assert.ok(log.httpMs>=0);assert.ok(log.failedElapsedMs>=0);assert.equal(log.timeoutMs,20);}assert.equal(requests,2);}finally{clearTimeout(keepAlive);service.dispose();}
}));

test('browser stream failure retains response status, partial byte count and body phase',async()=>capture(async logs=>{
  const service=await browser(async input=>new URL(String(input)).pathname==='/agent/profile'?profile():new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1,2,3]));setTimeout(()=>controller.error(new Error('private stream error')),3);}})));
  try{const trace=createTelemetry('translate');await runWithTelemetry(trace,async()=>assert.rejects(service.translate(body,service.identity()!,new AbortController().signal),/SERVICE_UNAVAILABLE/));finishTelemetry(trace,'failed');assert.equal(logs[0].httpStatus,200);assert.equal(logs[0].httpFailurePhase,'body');assert.equal(logs[0].responseBytes,3);assert.ok(logs[0].bodyMs>=0);}finally{service.dispose();}
}));

test('owned sync joins existing check, accounts for auth and does not emit background profile flood',async()=>capture(async logs=>{
  let requests=0;const session=new PersistentSessionService(()=>{},{backgroundPolling:false,fetcher:async()=>{requests++;await delay(3);return profile();}},{load:async()=>({accessToken:'fixture-token',sessionRef:'fixture-ref'}),save:async()=>{},clear:async()=>{}});
  try{await session.sync();await session.sync();assert.equal(logs.length,0);const a=createTelemetry('translate'),b=createTelemetry('translate');await Promise.all([runWithTelemetry(a,()=>session.sync()),runWithTelemetry(b,()=>session.sync())]);finishTelemetry(a,'success');finishTelemetry(b,'success');assert.equal(requests,3);assert.equal(logs[0].authCheckMode,'owned');assert.equal(logs[1].authCheckMode,'joined');assert.equal(logs[0].sessionMode,'owned');assert.equal(logs[0].authHttpCount,1);assert.ok(logs[0].authHttpMs>=0);assert.ok(logs[1].authMs>=0);assert.equal(logs[1].authHttpCount,undefined);}finally{await session.dispose();}
}));

test('browser reuses verified check with no extra HTTP or token reads',async()=>capture(async logs=>{
  let requests=0;const service=await browser(async input=>{requests++;return new URL(String(input)).pathname==='/agent/profile'?profile():json(result());});
  try{const before=requests,trace=createTelemetry('translate');await runWithTelemetry(trace,async()=>{await service.sync({reuseRecent:true});await service.translate(body,service.identity()!,new AbortController().signal);});finishTelemetry(trace,'shown');assert.equal(requests,before+1);assert.equal(logs[0].authCheckMode,'reused');assert.equal(logs[0].authChecks,2);assert.equal(logs[0].authTokenReads,1);assert.ok(logs[0].postReadTokenMs>=0);assert.equal(logs[0].authHttpCount,undefined);}finally{service.dispose();}
}));

test('retry headers accept only integer seconds or HTTP dates and never retain raw header values',async()=>capture(async logs=>{
  for(const [retry,length,valid] of [['not-a-date','-1',false],['1.5','NaN',false],[new Date(Date.now()+60_000).toUTCString(),'27',true]] as const){
    const service=await owned(async()=>json({private:'error payload'},{status:429,headers:{'retry-after':retry,'content-length':length}}));
    try{const trace=createTelemetry('translate');await runWithTelemetry(trace,async()=>assert.rejects(service.translate(body,service.identity()!,new AbortController().signal),/PSIM_HTTP_429/));finishTelemetry(trace,'rate-limited');const log=logs.at(-1)!;assert.equal(Object.hasOwn(log,'headerRetryAfterMs'),valid);if(valid){assert.ok(log.headerRetryAfterMs>0&&log.headerRetryAfterMs<=60_000);assert.equal(log.contentLength,27);}else assert.equal(log.contentLength,undefined);assert.equal('headers' in log,false);}finally{service.dispose();}
  }
}));

test('post-HTTP echo validation failure is identified without bypassing the original rejection',async()=>capture(async logs=>{
  const service=await owned(async()=>json(result()));
  try{const trace=createTelemetry('translate');await runWithTelemetry(trace,async()=>assert.rejects(service.translate({...body,composer_content_version:'wrong'},service.identity()!,new AbortController().signal),/OUTBOUND_ECHO_MISMATCH/));finishTelemetry(trace,'failed');assert.equal(logs[0].httpFailurePhase,'validation');assert.equal(logs[0].httpStatus,200);}finally{service.dispose();}
}));

test('versioned response diagnostics project scalar measurements from single, batch and already-read error envelopes',()=>{
  const expected={diagnosticsVersion:1,usageAttribution:'request_owned_calls',serverMs:42.5,providerMs:30,providerQueueMs:2.5,upstreamCalls:1,upstreamCallsCompleted:1,inputTokens:314,outputTokens:23,cachedInputTokens:128,cacheWriteTokens:null,reasoningTokens:0,usageComplete:true,cacheSource:'upstream'};
  for(const envelope of [{success:true,data:{translated_text:'SECRET'},diagnostics},{success:true,data:[{translated_text:'SECRET'},{translated_text:'SECRET'}],diagnostics},{detail:{code:'translation_provider_timeout',diagnostics}}])assert.deepEqual(translationDiagnosticsFromResponse(envelope),expected);
  assert.equal(translationDiagnosticsFromResponse({success:true,data:{diagnostics}}),undefined);
  for(const source of ['upstream','memory_cache','shared_cache','singleflight','mixed','none'])assert.equal(projectTranslationDiagnostics({...diagnostics,result_source:source})?.cacheSource,source);
  assert.deepEqual(projectTranslationDiagnostics({...diagnostics,server_ms:0,upstream_ms:null,provider_queue_ms:null,upstream_calls:0,upstream_calls_completed:0,input_tokens:null,output_tokens:null,cached_input_tokens:null,cache_write_tokens:null,reasoning_tokens:null,usage_complete:false,result_source:'memory_cache'}),{...expected,serverMs:0,providerMs:null,providerQueueMs:null,upstreamCalls:0,upstreamCallsCompleted:0,inputTokens:null,outputTokens:null,cachedInputTokens:null,cacheWriteTokens:null,reasoningTokens:null,usageComplete:false,cacheSource:'memory_cache'});
});

test('diagnostic projection ignores unknown versions, unsafe numbers, secrets, inherited fields and accessors',()=>{
  for(const value of [null,[],{}, {...diagnostics,version:2},{...diagnostics,attribution:'customer-secret'},Object.create(diagnostics),new Proxy({},{getOwnPropertyDescriptor(){throw Error('proxy');}})])assert.equal(projectTranslationDiagnostics(value),undefined);
  const {proxy,revoke}=Proxy.revocable({},{});revoke();assert.equal(projectTranslationDiagnostics(proxy),undefined);
  let proxyReads=0;assert.equal(projectTranslationDiagnostics(new Proxy(diagnostics,{get(){proxyReads++;throw Error('must not read');}}))?.inputTokens,314);assert.equal(proxyReads,0);
  let getters=0;const readAccessor={version:1,attribution:'request_owned_calls',get server_ms(){getters++;throw Error('must not run');},get input_tokens(){getters++;throw Error('must not run');},token:'SECRET',text:'SECRET',model:'SECRET',headers:{Authorization:'SECRET'}};
  assert.deepEqual(projectTranslationDiagnostics(readAccessor),{diagnosticsVersion:1,usageAttribution:'request_owned_calls'});assert.equal(getters,0);
  assert.equal(translationDiagnosticsFromResponse({get diagnostics(){getters++;throw Error('must not run');}}),undefined);assert.equal(getters,0);
  const unsafe=projectTranslationDiagnostics({...diagnostics,server_ms:Infinity,upstream_ms:-1,provider_queue_ms:'42',upstream_calls:1.5,upstream_calls_completed:Number.MAX_SAFE_INTEGER+1,input_tokens:-1,output_tokens:NaN,cached_input_tokens:true,cache_write_tokens:1.5,reasoning_tokens:'0',usage_complete:'true',result_source:'private'})!;
  assert.deepEqual(unsafe,{diagnosticsVersion:1,usageAttribution:'request_owned_calls'});
  const safe=projectTranslationDiagnostics({...diagnostics,token:'SECRET',text:'SECRET',model:'SECRET',account:'SECRET',nested:{password:'SECRET'}})!;
  assert.doesNotMatch(JSON.stringify(safe),/SECRET|token"|password|nested|model|account/);
});

test('owned HTTP preserves backend diagnostics before business projection without additional requests',async()=>capture(async logs=>{
  let requests=0;const service=await owned(async()=>{requests++;return json({...result(undefined,metadata),diagnostics});});
  try{const trace=createTelemetry('translate');await runWithTelemetry(trace,()=>service.translate(body,service.identity()!,new AbortController().signal));finishTelemetry(trace,'shown');assert.equal(requests,1);
    assert.equal(logs[0].providerMs,30);assert.equal(logs[0].serverMs,42.5);assert.equal(logs[0].inputTokens,314);assert.equal(logs[0].outputTokens,23);assert.equal(logs[0].cacheWriteTokens,null);assert.equal(logs[0].reasoningTokens,0);assert.equal(logs[0].upstreamCalls,1);assert.equal(logs[0].usageAttribution,'request_owned_calls');assert.equal(logs[0].cacheSource,'upstream');
    const readable=formatTelemetry(logs[0]);assert.match(readable,/上游传输耗时合计：30 ms/);assert.match(readable,/TSim处理耗时：42.5 ms/);assert.match(readable,/上游输入Token合计：314/);assert.match(readable,/上游缓存写入Token：未提供/);assert.match(readable,/用量归属：仅本请求新建调用/);assert.match(readable,/结果来源：新建上游调用/);
  }finally{service.dispose();}
}));

test('batch observer reads diagnostics once from envelope, ignores item measurements and isolates concurrent operations',async()=>capture(async logs=>{
  const traces=[createTelemetry('translate'),createTelemetry('translate')];
  await Promise.all(traces.map((trace,index)=>runWithTelemetry(trace,async()=>{
    const observer=startHttpTelemetry('/agent/translate/batch',20000)!;await delay(index?1:4);
    observer.parsed({success:true,data:[{diagnostics:{...diagnostics,input_tokens:9999}},{diagnostics}],diagnostics:{...diagnostics,input_tokens:index?0:128}},performance.now());observer.done();finishTelemetry(trace,'shown');
  })));
  assert.equal(logs.length,2);assert.equal(logs.find(log=>log.traceId===traces[0].fields.traceId)?.inputTokens,128);assert.equal(logs.find(log=>log.traceId===traces[1].fields.traceId)?.inputTokens,0);assert.ok(logs.every(log=>log.upstreamCalls===1&&log.httpRoute==='/agent/translate/batch'));
  const trace=createTelemetry('translate');await runWithTelemetry(trace,async()=>{const observer=startHttpTelemetry('/agent/profile',20000)!;observer.parsed({diagnostics},performance.now());observer.done();});finishTelemetry(trace,'success');assert.equal(logs.at(-1)?.inputTokens,undefined);
}));

test('Windows browser profile HTTP attaches backend measurements while retaining response token checks',async()=>capture(async logs=>{
  let requests=0;const service=await browser(async input=>{if(new URL(String(input)).pathname==='/agent/profile')return profile();requests++;return json({...result(),diagnostics:{...diagnostics,input_tokens:0,output_tokens:0,cached_input_tokens:0}});});
  try{const trace=createTelemetry('translate');await runWithTelemetry(trace,()=>service.translate(body,service.identity()!,new AbortController().signal));finishTelemetry(trace,'shown');assert.equal(requests,1);assert.equal(logs[0].inputTokens,0);assert.equal(logs[0].outputTokens,0);assert.equal(logs[0].cachedInputTokens,0);assert.equal(logs[0].providerMs,30);assert.equal(logs[0].serverMs,42.5);assert.equal(logs[0].authTokenReads,1);assert.ok(logs[0].postReadTokenMs>=0);
  }finally{service.dispose();}
}));
