import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {join} from 'node:path';
// @ts-ignore jsdom is a development-only dependency.
import {JSDOM} from 'jsdom';
const {installBootstrap,companionLoadingIndicator,loadingView,sanitizeDiagnostic,MAX_PROGRESS_LINE}=createRequire(import.meta.url)(join(process.cwd(),'scripts/lib/windows-vendor-bootstrap.cjs'));
const at='2026-10-26T08:00:00.000Z';
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(options:{holdPaint?:boolean;throwFirstPaint?:boolean}={}){
  const dom=new JSDOM('<div class="im_detail inform-con"><div class="chat_area"><div class="chat_area-input"></div></div></div>',{url:'file:///vendor/index.html',runScripts:'outside-only'});
  const app:any=new EventEmitter();app.commandLine={appendSwitch(){},removeSwitch(){}};app.whenReady=()=>Promise.resolve();
  const children:any[]=[],timers=new Map<number,{callback:()=>void;delay:number}>();let serial=0,accept!:(socket:any)=>void,paints=0;
  const server:any=new EventEmitter();server.listen=()=>{};server.unref=()=>{};server.close=()=>{};
  const runtime=installBootstrap({app,pid:1234,execPath:'C:\\Vendor\\vendor.exe',randomBytes:()=>Buffer.alloc(16),
    createServer:(callback:(socket:any)=>void)=>{accept=callback;return server;},
    spawn:()=>{const child:any=new EventEmitter();child.kill=()=>{};children.push(child);return child;},
    schedule:(callback:()=>void,delay:number)=>{const id=++serial;timers.set(id,{callback,delay});return id;},cancel:(id:number)=>timers.delete(id)});
  let holdPaint=options.holdPaint,releasePending:(()=>void)|undefined;
  const contents:any=new EventEmitter();contents.isDestroyed=()=>false;contents.getURL=()=>dom.window.location.href;contents.executeJavaScriptInIsolatedWorld=(_world:number,scripts:any[])=>{
    paints++;
    if(options.throwFirstPaint&&paints===1)throw Error('synchronous renderer refusal');
    if(holdPaint)return new Promise<void>(resolve=>{releasePending=()=>{dom.window.eval(scripts[0].code);resolve();};});
    return Promise.resolve().then(()=>{dom.window.eval(scripts[0].code);});
  };
  app.emit('web-contents-created',{},contents);contents.emit('dom-ready');
  const connect=()=>{const socket:any=new EventEmitter();socket.destroyed=false;socket.setEncoding=()=>{};socket.destroy=()=>{socket.destroyed=true;socket.emit('close');};accept(socket);return socket;};
  const socket=connect();
  const send=(entry:unknown)=>socket.emit('data',JSON.stringify(entry)+'\n');
  const run=(delay:number)=>{const match=[...timers].find(([,value])=>value.delay===delay);assert.ok(match,'timer '+delay);timers.delete(match[0]);match[1].callback();};
  return{dom,app,runtime,socket,send,run,children,timers,contents,server,releasePaint(){holdPaint=false;assert.ok(releasePending,'suspended paint');releasePending();releasePending=undefined;},get paints(){return paints;},get ui(){return (dom.window as any).__tsimCompanionLoading;},close(){app.emit('before-quit');dom.window.close();}};
}

test('only fixed diagnostic fields, stages, methods and tokens survive the receive whitelist',()=>{
  const unsafe={at,event:'companion-service-failed',code:'SERVICE_UNAVAILABLE',stage:'page-verified',method:'Runtime.evaluate',elapsedMs:20,timeoutMs:100,pid:234,ownerPid:123,errorCode:-32000,errorType:'TypeError',locations:['main.cjs:12:20','/private/key.ts:1:2','a'.repeat(200)+'.ts:1:2','external-composer.ts:1:2','companion-service.ts:1:2','driver.ts:1:2','transport.ts:1:2'],auth:'ready',phase:'failed',hasError:true,text:'CUSTOMER_SECRET',cookie:'COOKIE_SECRET',token:'TOKEN_SECRET',nested:{password:'PASSWORD_SECRET'}};
  const safe=sanitizeDiagnostic(unsafe),serialized=JSON.stringify(safe);
  assert.equal(safe.code,'SERVICE_UNAVAILABLE');assert.equal(safe.method,'Runtime.evaluate');assert.equal(safe.locations.length,4);assert.equal(safe.auth,'ready');assert.equal(safe.errorCode,-32000);
  assert.doesNotMatch(serialized,/SECRET|private|aaaaaaa|nested|password/);
  const unknown=sanitizeDiagnostic({...unsafe,code:'CUSTOMER_SECRET',stage:'CUSTOMER_SECRET',method:'Runtime.CUSTOMER_SECRET',errorType:'CUSTOMER_SECRET',auth:'CUSTOMER_SECRET',phase:'CUSTOMER_SECRET',pid:Infinity,ownerPid:-1,elapsedMs:2**40,timeoutMs:0.5});
  for(const field of ['code','stage','method','errorType','auth','phase','pid','ownerPid','elapsedMs','timeoutMs'])assert.equal(field in unknown,false,field);
  assert.equal(sanitizeDiagnostic({...unsafe,event:'CUSTOMER_SECRET'}),undefined);
  assert.equal(sanitizeDiagnostic({...unsafe,at:'CUSTOMER_SECRET'}),undefined);
});

test('bootstrap ring truncates to 1000 records and coalesces a burst into one bounded renderer paint',async()=>{
  const f=fixture();try{
    await flush();const before=f.paints;
    for(let i=0;i<1250;i++)f.send({diagnostic:{at,event:'cdp-slow-command',method:'Runtime.evaluate',elapsedMs:i,text:'CUSTOMER_SECRET'}});
    f.send({diagnostic:{at,event:'unknown-event',token:'TOKEN_SECRET'}});
    f.send({diagnostic:{at,event:'state'},stage:'failed'});
    assert.equal(f.paints,before);assert.equal([...f.timers.values()].filter(value=>value.delay===500).length,1);
    f.run(500);await flush();assert.equal(f.paints,before+1);assert.equal(f.ui.logs.length,1000);assert.equal(f.ui.logs[0].elapsedMs,250);assert.equal(f.ui.logs.at(-1).elapsedMs,1249);
    f.ui.openLogs();assert.equal(f.ui.text.value.split('\n').length,1000);assert.doesNotMatch(f.ui.text.value,/SECRET|token|text/);assert.ok(f.ui.text.value.length<MAX_PROGRESS_LINE*1000);
    assert.equal(f.ui.dialogRoot.querySelectorAll('textarea').length,1);
  }finally{f.close();}
});

test('pipe enforces the 4096-byte limit for complete, fragmented and multi-byte lines',async t=>{
  for(const mode of ['complete','fragmented','unicode'])await t.test(mode,async()=>{
    const f=fixture();try{
      await flush();
      if(mode==='fragmented'){f.socket.emit('data','x'.repeat(4000));assert.equal(f.socket.destroyed,false);f.socket.emit('data','x'.repeat(97));}
      else f.socket.emit('data',(mode==='unicode'?'字'.repeat(1366):'x'.repeat(4097))+'\n');
      await flush();assert.equal(f.socket.destroyed,true);assert.equal(f.ui.logs.filter((entry:any)=>!['host-start','composer-startup','host-error'].includes(entry.event)).length,0);assert.doesNotMatch(JSON.stringify(f.ui.logs),/xxxxx|字/);
    }finally{f.close();}
  });
});

test('exact-limit invalid lines are dropped and later valid stage messages still work',async()=>{
  const f=fixture();try{
    f.socket.emit('data','x'.repeat(4096)+'\n'+JSON.stringify({stage:'page-verified'})+'\n');
    await flush();assert.equal(f.socket.destroyed,false);assert.equal(f.runtime.stage(),'page-verified');assert.match(f.ui.label.textContent,/挂载翻译面板/);
  }finally{f.close();}
});

test('failed stages preserve the last useful phase, fixed code and recovery advice; menus survive helper exit',async()=>{
  const f=fixture();try{
    await flush();f.send({stage:'target-found'});f.send({diagnostic:{at,event:'companion-service-failed',code:'COMPOSER_UNAVAILABLE'}});f.send({stage:'failed'});await flush();
    assert.match(f.ui.label.textContent,/最近阶段：校验页面完整性/);assert.match(f.ui.label.textContent,/COMPOSER_UNAVAILABLE/);assert.match(f.ui.label.textContent,/选择一个客户会话/);
    const label=f.ui.label.textContent;f.send({stage:'failed'});await flush();assert.equal(f.ui.label.textContent,label);
    for(const expected of ['failed','exited']){
      if(expected==='exited'){
        f.socket.emit('close');
        for(const delay of [1000,3000,10000]){f.run(delay);f.children.at(-1).emit('exit',1);}
        await flush();assert.equal(f.runtime.stage(),'exited');assert.match(f.ui.label.textContent,/完全退出并重新打开客户端/);
      }
      assert.ok(f.ui.host.isConnected);f.ui.more.click();assert.equal(f.ui.menu.hidden,false);f.ui.root.querySelector('.open-logs').click();
      assert.equal(f.ui.overlay.hidden,false);assert.match(f.ui.text.value,/COMPOSER_UNAVAILABLE/);f.ui.dialogRoot.querySelector('.close').click();assert.equal(f.ui.overlay.hidden,true);
    }
  }finally{f.close();}
});

test('normal-panel read-only event opens preserved logs, and panel removal restores the placeholder',async()=>{
  const f=fixture();try{
    await flush();f.send({diagnostic:{at,event:'host-ready',pid:123}});f.run(500);await flush();
    const original=f.ui,panel=f.dom.window.document.createElement('div');panel.id='tsim-outbound-panel';f.dom.window.document.body.appendChild(panel);f.send({stage:'panel-mounted'});await flush();
    assert.equal(f.ui,original);assert.equal(f.ui.host.isConnected,false);assert.equal(f.ui.logs.filter((entry:any)=>entry.event==='host-ready').length,1);
    const event=new f.dom.window.Event('tsim-companion-open-logs',{cancelable:true});assert.equal(f.dom.window.document.dispatchEvent(event),false);assert.equal(event.defaultPrevented,true);assert.equal(f.ui.overlay.hidden,false);
    assert.match(f.ui.text.value,/host-ready/);f.ui.dialogRoot.querySelector('.close').click();
    panel.remove();await new Promise(resolve=>setTimeout(resolve,130));assert.ok(f.ui.host.isConnected);assert.match(f.ui.title.textContent,/正在恢复/);assert.equal(f.ui,original);
    f.send({diagnostic:{at,event:'runtime-invalidated',code:'RUNTIME_TARGET_CHANGED'}});f.run(500);await flush();assert.match(f.ui.label.textContent,/RUNTIME_TARGET_CHANGED/);
    const panelAgain=panel.cloneNode();f.dom.window.document.body.appendChild(panelAgain);f.send({stage:'target-found'});f.send({stage:'panel-mounted'});await flush();assert.equal(f.ui.logs.filter((entry:any)=>entry.event==='runtime-invalidated').length,1);assert.equal(f.ui.host.isConnected,false);
    panelAgain.remove();await new Promise(resolve=>setTimeout(resolve,130));assert.match(f.ui.title.textContent,/正在恢复/);assert.equal(f.ui.logs.filter((entry:any)=>entry.event==='runtime-invalidated').length,1);assert.equal(f.ui.logs.filter((entry:any)=>entry.event==='host-ready').length,1);
  }finally{f.close();}
});

test('copy failure leaves selectable text and refresh/close keep the bounded viewer usable',async()=>{
  const f=fixture();try{
    await flush();f.send({diagnostic:{at,event:'host-start',pid:12}});f.run(500);await flush();f.ui.openLogs();
    Object.defineProperty(f.dom.window.navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(Error('denied'))}});
    f.ui.dialogRoot.querySelector('.copy').click();await flush();assert.match(f.ui.copyStatus.textContent,/Ctrl\+C/);assert.equal(f.ui.text.selectionStart,0);assert.equal(f.ui.text.selectionEnd,f.ui.text.value.length);
    f.send({diagnostic:{at,event:'host-quit',pid:12}});f.run(500);await flush();f.ui.dialogRoot.querySelector('.refresh').click();const visible=f.ui.text.value.split('\n').map((line:string)=>JSON.parse(line));assert.equal(visible.filter((entry:any)=>entry.event==='host-quit').length,1);assert.equal(visible.filter((entry:any)=>entry.event==='host-start'&&entry.pid===12).length,1);
    let copied='';Object.defineProperty(f.dom.window.navigator,'clipboard',{configurable:true,value:{writeText:async(value:string)=>{copied=value;}}});f.ui.dialogRoot.querySelector('.copy').click();await flush();assert.equal(copied,f.ui.text.value);assert.equal(f.ui.copyStatus.textContent,'已复制');
    f.ui.dialogRoot.querySelector('.close').click();assert.equal(f.ui.overlay.hidden,true);
  }finally{f.close();}
});

test('renderer independently bounds retained and visible records even for an oversized view',async()=>{
  const f=fixture();try{
    await flush();const logs=Array.from({length:1100},(_,elapsedMs)=>({at,event:'host-ready',elapsedMs}));
    companionLoadingIndicator({...loadingView('failed'),logs},f.dom.window.document);assert.equal(f.ui.logs.length,1000);assert.equal(f.ui.view.logs.length,1000);f.ui.openLogs();assert.equal(f.ui.text.value.split('\n').length,1000);
  }finally{f.close();}
});


test('a lost progress pipe remains actionable while a retry launches without diagnostic transport',async()=>{
  const f=fixture();try{
    await flush();f.server.emit('error',Error('private transport details'));await flush();assert.equal(f.runtime.stage(),'failed');assert.match(f.ui.label.textContent,/BOOTSTRAP_PROGRESS_UNAVAILABLE/);
    f.socket.emit('close');f.run(1000);await flush();assert.equal(f.children.length,1);assert.equal(f.runtime.stage(),'failed');assert.match(f.ui.label.textContent,/BOOTSTRAP_PROGRESS_UNAVAILABLE/);assert.ok(f.ui.host.isConnected);
  }finally{f.close();}
});


test('a suspended renderer receives one in-flight call and then the latest bounded diagnostic/stage snapshot',async()=>{
  const f=fixture({holdPaint:true});try{
    await flush();assert.equal(f.paints,1);assert.equal(f.ui,undefined);
    for(let batch=0;batch<4;batch++){
      for(let index=0;index<400;index++)f.send({diagnostic:{at,event:'cdp-slow-command',method:'Runtime.evaluate',elapsedMs:batch*400+index}});
      f.run(500);f.send({stage:batch%2?'target-found':'transport-ready'});await flush();assert.equal(f.paints,1);
    }
    f.send({stage:'page-verified'});f.send({diagnostic:{at,event:'companion-service-failed',code:'COMPOSER_UNAVAILABLE'}});f.send({stage:'failed'});f.run(500);await flush();assert.equal(f.paints,1);
    f.releasePaint();await flush();assert.equal(f.paints,2);assert.equal(f.ui.logs.length,1000);assert.equal(f.ui.view.logs.length,1000);assert.equal(f.ui.logs.filter((entry:any)=>entry.event==='companion-service-failed').length,1);
    assert.equal(f.ui.logs.filter((entry:any)=>entry.event==='cdp-slow-command').at(-1).elapsedMs,1599);assert.match(f.ui.label.textContent,/最近阶段：挂载翻译面板/);assert.match(f.ui.label.textContent,/COMPOSER_UNAVAILABLE/);
    f.ui.openLogs();assert.equal(f.ui.text.value.split('\n').length,1000);await flush();assert.equal(f.paints,2);
  }finally{f.close();}
});

test('a synchronous renderer execution failure clears the in-flight slot and later progress can paint',async()=>{
  const f=fixture({throwFirstPaint:true});try{
    await flush();assert.equal(f.paints,1);assert.equal(f.ui,undefined);f.send({stage:'page-verified'});await flush();assert.equal(f.paints,2);assert.ok(f.ui.host.isConnected);assert.match(f.ui.label.textContent,/挂载翻译面板/);assert.ok(f.ui.logs.some((entry:any)=>entry.event==='host-start'));
  }finally{f.close();}
});

test('bootstrap telemetry mirror matches shared schema and strips malicious unknown fields without invoking getters',async()=>{
  const {sanitizeTelemetry:shared}=await import('../src/shared/runtime-telemetry');
  const bootstrap=createRequire(import.meta.url)(join(process.cwd(),'scripts/lib/windows-vendor-bootstrap.cjs')).sanitizeTelemetry;
  const traceId='12345678-1234-4234-8234-123456789abc';
  const samples:any[]=[
    {event:'translation-summary',traceId,parentTraceId:traceId,serverRequestId:traceId,runId:'abcdef0123456789',policyVersion:'2026-10-26.1',appVersion:'1.2.3',electronVersion:'27.2.0',nodeVersion:'18.0.0',osRelease:'10.0.1234',sourceLanguage:'zh-TW',targetLanguage:'en',httpMs:125.4,headersMs:3,bodyMs:4,parseMs:5,authTokenReads:1,httpSampleCount:2,userSampleCount:1,providerMs:null,serverMs:null,cacheSource:'unknown',providerReported:'deepl',outcome:'shown',httpStatus:200,translationSent:true,previewShown:true},
    {event:'session-check',authCheckMode:'joined',authStateBefore:'needs_login',authStateAfter:'ready',sessionMode:'owned',authHttpCount:1,authHttpMs:12,authTokenReadMs:4,authHttpFailurePhase:'headers'},
    {event:'translation-action',operation:'send',outcome:'send-unconfirmed',sendTriggered:true,sendConfirmed:false,code:'SERVICE_UNAVAILABLE'},
    {event:'runtime-health',pid:123,rssBytes:2048,uptimeMs:500,eventLoopDelayMs:1,logRetained:1000,logEvicted:5},
    {event:'translation-statistics',requests:3,successCount:2,failureCount:1,httpP50Ms:4,httpP95Ms:5,httpMaxMs:6},
    {event:'runtime-environment',platform:'win32',arch:'x64',injectorVersion:'1.2.3-beta.1'},
    JSON.parse('{"event":"translation-summary","__proto__":{"token":"TOKEN_SECRET"},"constructor":"TOKEN_SECRET","text":"CUSTOMER_SECRET","token":"TOKEN_SECRET","nested":{"password":"PASSWORD_SECRET"},"code":"CUSTOMER_SECRET","traceId":"TOKEN_SECRET","httpMs":-1,"providerMs":12,"serverMs":12,"cacheSource":"hit","httpSampleCount":0.5}'),
    {event:'translation-summary',traceId:'12345678-1234-0234-7234-123456789abc',parentTraceId:'SECRET',httpMs:Infinity,elapsedMs:NaN,timeoutMs:-1,httpSampleCount:2**53,sourceChars:'12',serverRequestId:traceId,code:'PSIM_HTTP_429'},
    {event:'CUSTOMER_SECRET'},null,[],
  ];
  const dateKeys=['operationStartedAt','requestStartedAt','responseHeadersAt','responseCompletedAt'];
  samples.push({event:'translation-summary',diagnosticsVersion:1,usageAttribution:'request_owned_calls',providerMs:44.5,serverMs:40,providerQueueMs:2,inputTokens:314,outputTokens:23,cachedInputTokens:128,cacheWriteTokens:null,reasoningTokens:0,upstreamCalls:2,upstreamCallsCompleted:2,usageComplete:true,cacheSource:'mixed',httpRoute:'/agent/translate/batch'});
  samples.push({event:'translation-summary',diagnosticsVersion:2,usageAttribution:'SECRET',providerMs:Infinity,serverMs:-1,providerQueueMs:NaN,inputTokens:1.5,outputTokens:Number.MAX_SAFE_INTEGER+1,cachedInputTokens:-1,cacheWriteTokens:'secret',reasoningTokens:true,upstreamCalls:0.5,upstreamCallsCompleted:-1,usageComplete:'true',cacheSource:'SECRET'});
  for(const source of ['memory_cache','shared_cache','singleflight','none'])samples.push({event:'translation-summary',diagnosticsVersion:1,usageAttribution:'request_owned_calls',providerMs:null,providerQueueMs:null,serverMs:0,inputTokens:null,outputTokens:null,upstreamCalls:0,upstreamCallsCompleted:0,usageComplete:false,cacheSource:source});
  samples.push({event:'translation-summary',...Object.fromEntries(dateKeys.map(key=>[key,at]))});
  for(const invalid of ['CUSTOMER_SECRET','2026-10-26T08:00:00Z','2026-10-26T08:00:00.000+00:00','2026-99-99T99:99:99.999Z',123,null])samples.push({event:'translation-summary',...Object.fromEntries(dateKeys.map(key=>[key,invalid]))});
  for(const code of ['REQUEST_SUPERSEDED','SERVICE_RESPONSE_TOO_LARGE','OWNED_SERVICE_CLOSED','SESSION_STORAGE_CORRUPT','PSIM_SESSION_LOAD_FAILED','PSIM_SESSION_SAVE_FAILED','PSIM_SESSION_CLEAR_FAILED','INVALID_STORED_SESSION','LOGIN_RESPONSE_INVALID','REFRESH_RESPONSE_INVALID','SESSION_STORAGE_ENCRYPTION_UNAVAILABLE','BROWSER_SESSION_ACCESS_DENIED','NATIVE_EVENT_COMPOSER_UNAVAILABLE','ACTIVE_TARGET_INVALID_ARGUMENTS','BOOTSTRAP_HELPER_EXITED','PSIM_HTTP_418','UNCLASSIFIED'])samples.push({event:'translation-summary',code});
  const accessor={event:'translation-summary'};Object.defineProperty(accessor,'text',{enumerable:true,get(){throw Error('getter must not run');}});Object.defineProperty(accessor,'httpMs',{enumerable:true,get(){throw Error('getter must not run');}});samples.push(accessor);
  for(const value of samples){const safe=bootstrap(value);assert.deepEqual(safe,shared(value));assert.doesNotMatch(JSON.stringify(safe)??'',/SECRET|__proto__|constructor|nested|password|token/);}
  assert.equal(bootstrap(samples[6]).code,'UNCLASSIFIED');
});

test('new telemetry survives second whitelist, preserves connection state and supports raw/summary selection',async()=>{
  const f=fixture();try{
    await flush();f.send({stage:'page-verified'});
    for(const event of ['translation-summary','translation-action','session-check','runtime-health','translation-statistics','runtime-environment'])f.send({diagnostic:{at,event,traceId:'12345678-1234-4234-8234-123456789abc',parentTraceId:'87654321-1234-4234-8234-123456789abc',operationStartedAt:at,requestStartedAt:at,responseHeadersAt:at,responseCompletedAt:at,httpMs:123,providerMs:null,serverMs:null,cacheSource:'unknown',code:'PSIM_HTTP_429',text:'CUSTOMER_SECRET',token:'TOKEN_SECRET'}});
    f.run(500);await flush();assert.equal(f.runtime.stage(),'page-verified');assert.doesNotMatch(f.ui.label.textContent,/PSIM_HTTP_429/);
    assert.equal(f.ui.logs.filter((entry:any)=>entry.httpMs===123).length,6);assert.doesNotMatch(JSON.stringify(f.ui.logs),/SECRET/);
    f.ui.openLogs();assert.match(f.ui.text.value,/翻译摘要/);assert.match(f.ui.text.value,/httpMs：123 ms/);assert.match(f.ui.text.value,/providerMs：未提供/);assert.match(f.ui.text.value,/结果来源：未知/);assert.match(f.ui.text.value,/12345678 ← 87654321/);
    const raw=f.ui.dialogRoot.querySelector('.raw');raw.checked=true;raw.dispatchEvent(new f.dom.window.Event('change'));assert.equal(f.ui.text.value.split('\n').map((line:string)=>JSON.parse(line)).find((entry:any)=>entry.event==='translation-summary').providerMs,null);const timestampRecord=f.ui.text.value.split('\n').map((line:string)=>JSON.parse(line)).find((entry:any)=>entry.event==='translation-summary');for(const key of ['operationStartedAt','requestStartedAt','responseHeadersAt','responseCompletedAt'])assert.equal(timestampRecord[key],at);
    f.ui.text.focus();f.ui.text.select();const previous=f.ui.text.value;f.send({diagnostic:{at,event:'translation-action',operation:'send'}});f.run(500);await flush();assert.equal(f.ui.text.value,previous);assert.equal(f.ui.text.selectionEnd,previous.length);
    f.ui.dialogRoot.querySelector('.refresh').click();assert.notEqual(f.ui.text.value,previous);
    const close=f.ui.dialogRoot.querySelector('.close');close.focus();close.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));assert.equal(f.ui.dialogRoot.activeElement,raw);
    raw.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));assert.equal(f.ui.dialogRoot.activeElement,close);
  }finally{f.close();}
});

test('telemetry bursts remain bounded while the renderer is suspended',async()=>{
 const f=fixture({holdPaint:true});try{
  await flush();for(let index=0;index<1200;index++)f.send({diagnostic:{at,event:'translation-summary',httpMs:index,providerMs:null,serverMs:null,cacheSource:'unknown'}});
  f.run(500);await flush();assert.equal(f.paints,1);f.releasePaint();await flush();assert.equal(f.paints,2);assert.equal(f.ui.logs.length,1000);assert.equal(f.ui.logs[0].httpMs,200);assert.equal(f.ui.logs.at(-1).httpMs,1199);f.ui.openLogs();assert.equal(f.ui.text.value.split('\n').length,1000);assert.match(f.ui.text.value,/翻译摘要/);
 }finally{f.close();}
});
