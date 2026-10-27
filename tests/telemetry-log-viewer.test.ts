import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore development-only dependency
import {JSDOM} from 'jsdom';
import {createRuntimeLogDialog} from '../runtime/page/runtime-logs';
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const traceId='12345678-1234-4234-8234-123456789abc';
const record={at:'2026-10-26T08:00:00.000Z',event:'translation-summary',traceId,parentTraceId:'87654321-1234-4234-8234-123456789abc',httpMs:125,providerMs:null,serverMs:null,cacheSource:'unknown',outcome:'shown'};
function fixture(){
 const dom=new JSDOM('<button id="origin">open</button>'),w=dom.window;
 let rows:unknown[]=[{...record,text:'CUSTOMER_SECRET',token:'TOKEN_SECRET',nested:{password:'PASSWORD_SECRET'}}],serial=0;const timers=new Map<number,()=>void>();
 w.setTimeout=((fn:()=>void)=>{const id=++serial;timers.set(id,fn);return id;}) as any;
 w.clearTimeout=((id:number)=>{timers.delete(id);}) as any;
 const origin=w.document.querySelector<HTMLButtonElement>('#origin')!;origin.focus();
 const dialog=createRuntimeLogDialog(w.document,async()=>rows);dialog.open();
 const root=w.document.querySelector('#tsim-runtime-logs')!.shadowRoot!,area=root.querySelector('textarea')!,raw=root.querySelector<HTMLInputElement>('.raw')!;
 return {dom,w,root,area,raw,timers,origin,dialog,setRows(value:unknown[]){rows=value;},async tick(){const fn=timers.values().next().value;assert.ok(fn);timers.clear();fn();await flush();},close(){dialog.dispose();dom.window.close();}};
}
test('default Chinese summary, trace links, raw toggle, old JSON, and 1000-row bound',async()=>{
 const f=fixture();try{await flush();assert.match(f.area.value,/翻译摘要/);assert.match(f.area.value,/翻译请求：125 ms/);assert.match(f.area.value,/上游传输耗时合计：未提供/);assert.match(f.area.value,/结果来源：未知/);assert.match(f.area.value,/12345678 ← 87654321/);
 f.raw.checked=true;f.raw.dispatchEvent(new f.w.Event('change'));assert.equal(JSON.parse(f.area.value).traceId,traceId);assert.doesNotMatch(f.area.value,/SECRET|token|nested|password/);
 f.setRows(Array.from({length:1100},(_,index)=>({event:'host-ready',pid:index})));await f.tick();assert.equal(f.area.value.split('\n').length,1000);assert.equal(JSON.parse(f.area.value.split('\n')[0]).pid,100);
 }finally{f.close();}
});
test('auto refresh preserves selected text, manual refresh updates, clipboard fallback and cleanup',async()=>{
 const f=fixture();try{await flush();f.area.focus();f.area.select();const original=f.area.value;f.setRows([{event:'host-quit'}]);await f.tick();assert.equal(f.area.value,original);assert.equal(f.area.selectionEnd,original.length);
 f.root.querySelector<HTMLButtonElement>('.refresh')!.click();await flush();assert.match(f.area.value,/host-quit/);
 Object.defineProperty(f.w.navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('denied');}}});f.root.querySelector<HTMLButtonElement>('.copy')!.click();await flush();assert.match(f.root.querySelector('.status')!.textContent!,/Ctrl\+C/);assert.equal(f.area.selectionEnd,f.area.value.length);
 let copied='';Object.defineProperty(f.w.navigator,'clipboard',{configurable:true,value:{writeText:async(value:string)=>{copied=value;}}});f.root.querySelector<HTMLButtonElement>('.copy')!.click();await flush();assert.equal(copied,f.area.value);
 const copy=f.root.querySelector<HTMLButtonElement>('.copy')!,close=f.root.querySelector<HTMLButtonElement>('.close')!;copy.focus();copy.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));assert.equal(f.root.activeElement,close);
 close.focus();close.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));assert.equal(f.root.activeElement,copy);
 assert.ok([...f.root.querySelectorAll('button:not(:disabled),textarea,input:not(:disabled)')].includes(f.raw));
 f.dialog.dispose();assert.equal(f.timers.size,0);assert.equal(f.w.document.querySelector('#tsim-runtime-logs'),null);assert.equal(f.w.document.activeElement,f.origin);
 }finally{f.close();}
});
test('dispose clears a pending load timeout and ignores late completion',async()=>{
 const dom=new JSDOM(''),w=dom.window;let resolve!:(rows:unknown[])=>void,serial=0;const timers=new Set<number>();w.setTimeout=(()=>{const id=++serial;timers.add(id);return id;}) as any;w.clearTimeout=((id:number)=>timers.delete(id)) as any;
 const dialog=createRuntimeLogDialog(w.document,()=>new Promise(done=>{resolve=done;}));dialog.open();assert.equal(timers.size,1);dialog.dispose();assert.equal(timers.size,0);resolve([record]);await flush();assert.equal(timers.size,0);assert.equal(w.document.querySelector('#tsim-runtime-logs'),null);w.close();
});
test('backend measurements are readable and survive raw toggle with unknown tokens kept null',async()=>{
 const f=fixture();try{
  f.setRows([{...record,providerMs:125,serverMs:180,providerQueueMs:12,diagnosticsVersion:1,usageAttribution:'request_owned_calls',inputTokens:314,outputTokens:23,cachedInputTokens:128,cacheWriteTokens:null,reasoningTokens:0,upstreamCalls:1,upstreamCallsCompleted:1,usageComplete:true,cacheSource:'upstream',token:'TOKEN_SECRET'}]);
  await flush();await f.tick();assert.match(f.area.value,/上游传输耗时合计：125 ms/);assert.match(f.area.value,/TSim处理耗时：180 ms/);assert.match(f.area.value,/上游输入Token合计：314/);assert.match(f.area.value,/上游缓存写入Token：未提供/);assert.match(f.area.value,/结果来源：新建上游调用/);
  f.raw.checked=true;f.raw.dispatchEvent(new f.w.Event('change'));const row=JSON.parse(f.area.value);assert.equal(row.inputTokens,314);assert.equal(row.outputTokens,23);assert.equal(row.cacheWriteTokens,null);assert.equal(row.usageAttribution,'request_owned_calls');assert.equal(row.diagnosticsVersion,1);assert.equal(row.token,undefined);
 }finally{f.close();}
});
