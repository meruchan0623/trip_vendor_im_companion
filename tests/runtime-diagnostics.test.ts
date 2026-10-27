import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntimeDiagnostics} from '../electron/runtime-diagnostics';
// @ts-ignore Test-only dependency.
import {JSDOM} from 'jsdom';
import {createOutboundPanel} from '../runtime/page/outbound-panel';
import {embeddedPanelState,invokeEmbeddedAction} from '../electron/embedded-host';
import {validWorkbenchAction} from '../runtime/workbench-action';

const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('memory and both disk generations together retain at most 1000 records',()=>{
  const dir=mkdtempSync(join(tmpdir(),'tsim-logs-')),file=join(dir,'runtime.log');
  try{
    for(const path of [file,file+'.1'])writeFileSync(path,Array.from({length:2000},()=>'{"old":true}').join('\n')+'\n');
    const logger=createRuntimeDiagnostics(file);
    assert.equal([file,file+'.1'].flatMap(path=>readFileSync(path,'utf8').trim().split('\n')).length,1000);
    for(let i=0;i<1503;i++)logger.lifecycle('ready',i);
    const snapshot=logger.snapshot();assert.equal(snapshot.length,1000);assert.equal(snapshot[0].pid,503);assert.equal(snapshot.at(-1)!.pid,1502);
    const disk=[file,file+'.1'].flatMap(path=>readFileSync(path,'utf8').trim().split('\n'));assert.ok(disk.length<=1000);
    snapshot[0].pid=-1;assert.equal(logger.snapshot()[0].pid,503);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('unavailable disk cannot disable in-memory diagnostics; only allowlisted data is forwarded',()=>{
  const dir=mkdtempSync(join(tmpdir(),'tsim-logs-')),forwarded:unknown[]=[];
  try{
    writeFileSync(join(dir,'block'),'not a directory');const logger=createRuntimeDiagnostics(join(dir,'block','runtime.log'),undefined,entry=>forwarded.push(entry));
    logger.consoleLog([JSON.stringify({event:'companion-service-failed',code:'PRIVATE_CUSTOMER_SECRET',errorType:'CustomerSecret',locations:['secret.ts:1:2'],message:'customer message',token:'secret-token'})]);
    logger.consoleLog([JSON.stringify({event:'composer-startup',stage:'secret-stage'})]);
    logger.consoleError(['PRIVATE_CUSTOMER_SECRET','secret-token']);
    logger.state({auth:'ready',nativeStatus:'secret',phase:'secret',accountScope:'secret-account',hasError:true});
    logger.consoleLog([JSON.stringify({event:'companion-service-failed',code:'WINDOWS_MANIFEST_NOT_PROTECTED'})]);
    const text=JSON.stringify(logger.snapshot());assert.doesNotMatch(text,/secret|PRIVATE|customer message|CustomerSecret/);assert.match(text,/WINDOWS_MANIFEST_NOT_PROTECTED/);assert.equal(forwarded.length,4);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('more and log entry remain usable when translation is off, connecting or failed',async()=>{
  for(const variant of [{autoTranslate:false,auth:'ready'},{auth:'connecting'},{auth:'failed'}]){
    const dom=new JSDOM('<div class="im_detail inform-con"><div class="chat_area"><div class="chat_area-input"></div></div></div>',{pretendToBeVisual:true});
    const state=embeddedPanelState({attached:true,composerSource:'verified-editor',phase:'idle',language:'en',orderEntries:[],messageSurface:{active:true},...variant} as any);
    const panel=createOutboundPanel(dom.window.document,{invoke:async action=>{assert.equal(action,'getRuntimeLogs');return Array.from({length:1100},(_,pid)=>({at:'2026-10-26T00:00:00.000Z',event:'host-ready',pid}));}},state);
    try{
      const root=panel.host.shadowRoot!,more=root.querySelector<HTMLButtonElement>('.more')!;assert.equal(more.hidden,false);assert.equal(more.disabled,false);more.click();root.querySelector<HTMLButtonElement>('.runtime-logs')!.click();await flush();
      const dialog=dom.window.document.querySelector('#tsim-runtime-logs')!.shadowRoot!;const value=dialog.querySelector('textarea')!.value;assert.equal(value.split('\n').length,1000);assert.equal(JSON.parse(value.split('\n')[0]).pid,100);
      dialog.querySelector<HTMLButtonElement>('.close')!.click();assert.equal(dom.window.document.querySelector('#tsim-runtime-logs'),null);
    }finally{panel.dispose();dom.window.close();}
  }
});
test('Windows panel uses the persistent bootstrap log viewer without requiring a live host call',()=>{
  const dom=new JSDOM('<div class="im_detail inform-con"><div class="chat_area"><div class="chat_area-input"></div></div></div>',{pretendToBeVisual:true});let opens=0;
  dom.window.document.addEventListener('tsim-companion-open-logs',(event:Event)=>{event.preventDefault();opens++;});
  const state=embeddedPanelState({auth:'failed',attached:true,composerSource:'unavailable',phase:'failed',language:'en',orderEntries:[]} as any);
  const panel=createOutboundPanel(dom.window.document,{invoke:async()=>assert.fail('should not require host')},state);
  try{panel.host.shadowRoot!.querySelector<HTMLButtonElement>('.runtime-logs')!.click();assert.equal(opens,1);assert.equal(dom.window.document.querySelector('#tsim-runtime-logs'),null);}finally{panel.dispose();dom.window.close();}
});
test('log action accepts zero arguments and returns only the host diagnostic snapshot',async()=>{
  const service={getRuntimeLogs:()=>[{at:'2026-10-26T00:00:00.000Z',event:'host-ready'}]} as any;
  assert.equal(validWorkbenchAction('getRuntimeLogs',[]),true);assert.equal(validWorkbenchAction('getRuntimeLogs',['path']),false);
  assert.deepEqual(await invokeEmbeddedAction(service,'getRuntimeLogs',[]),service.getRuntimeLogs());await assert.rejects(invokeEmbeddedAction(service,'getRuntimeLogs',['path']),/INVALID_ACTION/);
});
