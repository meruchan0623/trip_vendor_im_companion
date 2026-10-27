import test from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {BrowserProfileSessionService} from '../electron/browser-profile-session';
import {PersistentSessionService} from '../electron/owned-session';
import {OwnedPsimService} from '../host/owned-service';
import {createTelemetry,runWithTelemetry,currentTelemetry,setTelemetry,finishTelemetry,TELEMETRY_RUN_ID,startHttpTelemetry} from '../electron/translation-telemetry';
import {sanitizeTelemetry,formatTelemetry} from '../src/shared/runtime-telemetry';
import {projectTranslationDiagnostics,translationDiagnosticsFromResponse} from '../src/shared/translation-response-diagnostics';
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

test('owned and fallback browser HTTP payloads identify this plugin without retrying 422',async()=>{
  for(const mode of ['owned','browser'] as const){
    const requests:Record<string,unknown>[]=[];
    const fetcher=async(input:string,init:RequestInit)=>{
      if(new URL(input).pathname==='/agent/profile')return profile();
      requests.push(JSON.parse(String(init.body)));
      return json({detail:[]},{status:422});
    };
    const service=mode==='owned'?await owned(fetcher):await browser(fetcher as typeof fetch);
    try{await assert.rejects(service.translate(body,service.identity()!,new AbortController().signal));assert.deepEqual(requests,[{...body,client_source:'travel_merchant_companion'}]);}
    finally{service.dispose();}
  }
});

test('serialized MAIN-world bridge labels HTTP payload and does not retry an older backend',async()=>{
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
    assert.deepEqual(requests,[{...body,client_source:'travel_merchant_companion'}]);
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
  try{const trace=createTelemetry('translate',{sourceChars:body.text.length,token:'secret',text:body.text});await runWithTelemetry(trace,async()=>{assert.equal(currentTelemetry(),trace);const response=await service.translate(body,service.identity()!,new AbortController().signal);assert.equal(response.data.translated_text,'Private translated text');assert.equal((response.data as any).provider,undefined);setTelemetry({outcome:'shown',model:'secret'});});assert.equal(logs.length,0);finishTelemetry(trace,'shown');finishTelemetry(trace,'failed');assert.equal(logs.length,1);const log=logs[0];assert.equal(log.runId,TELEMETRY_RUN_ID);assert.equal(log.translationSent,true);assert.equal(log.providerReported,'google_nmt');assert.equal(log.translationProfile,'agent_draft');assert.equal(log.translationProtocol,'agent-translation-items-v1');assert.equal(log.providerMs,null);assert.equal(log.serverMs,null);assert.equal(log.cacheSource,'unknown');assert.equal(log.httpStatus,200);assert.ok(log.headersMs>=2);assert.ok(log.bodyMs>=5);assert.ok(log.httpMs>=log.headersMs+log.bodyMs);assert.ok(log.parseMs>=0);assert.equal(log.responseBytes,log.contentLength);assert.equal(log.requestBytes,Buffer.byteLength(JSON.stringify({...body,client_source:'travel_merchant_companion'})));assert.equal(requests,1);assert.equal(JSON.stringify(log).includes(body.text),false);assert.equal(JSON.stringify(log).includes('Private translated text'),false);assert.equal('model' in log,false);}finally{service.dispose();}
}));

test('malicious service metadata never enters trace and strict echo validation remains enabled',async()=>capture(async logs=>{
  const service=await owned(async()=>json(result('valid',{provider:'API_KEY_SECRET',translation_profile:'private account',translation_protocol:'customer secret',translation_policy_version:'token',request_id:'customer-id',model:'model-secret',provider_ms:8,server_ms:9})));
  try{const trace=createTelemetry('translate');await runWithTelemetry(trace,()=>service.translate(body,service.identity()!,new AbortController().signal));finishTelemetry(trace,'shown');assert.equal(logs[0].providerReported,undefined);assert.equal(logs[0].translationProfile,undefined);assert.equal(logs[0].serverRequestId,undefined);assert.equal(logs[0].providerMs,null);assert.equal(logs[0].serverMs,null);const wrong={...body,composer_content_version:'mismatch'};await assert.rejects(service.translate(wrong,service.identity()!,new AbortController().signal),/OUTBOUND_ECHO_MISMATCH/);}finally{service.dispose();}
}));

test('concurrent traces remain isolated even with interleaved HTTP and finish',async()=>capture(async logs=>{
  let requests=0;const service=await owned(async(_input,init)=>{requests++;const value=JSON.parse(String(init.body));await delay(value.target_lang==='ja'?8:1);return json(result('Private translated text',{...metadata,provider:value.target_lang==='ja'?'deepl':'google_nmt'}));});
  try{const traces=[createTelemetry('translate',{targetLanguage:'ja'}),createTelemetry('translate',{targetLanguage:'en'})];await Promise.all(traces.map(trace=>runWithTelemetry(trace,async()=>{await service.translate({...body,target_lang:trace.fields.targetLanguage as 'ja'|'en'},service.identity()!,new AbortController().signal);finishTelemetry(trace,'shown');})));assert.equal(logs.length,2);assert.equal(new Set(logs.map(log=>log.traceId)).size,2);assert.equal(logs.find(log=>log.targetLanguage==='ja')?.providerReported,'deepl');assert.equal(logs.find(log=>log.targetLanguage==='en')?.providerReported,'google_nmt');assert.equal(requests,2);}finally{service.dispose();}
}));

test('HTTP errors preserve status, safe retry delay and phase without consuming error bodies',async()=>capture(async logs=>{
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
