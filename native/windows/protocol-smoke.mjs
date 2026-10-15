import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import assert from 'node:assert/strict';
const executable=resolve(dirname(fileURLToPath(import.meta.url)),'bin/publish/TravelMerchant.WindowHelper.exe');
const child=spawn(executable,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
const requests=new Map();let number=0;
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{const message=JSON.parse(line);if(message.requestId){const pending=requests.get(message.requestId);if(pending){clearTimeout(pending.timer);requests.delete(message.requestId);pending.resolve(message);}}});
child.stderr.on('data',()=>process.stderr.write('helper_diagnostic\n'));
function request(type,payload={}){const requestId=String(++number);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('helper_timeout')),6000);requests.set(requestId,{resolve,timer});child.stdin.write(JSON.stringify({protocolVersion:'1.0',requestId,type,payload})+'\n');});}
try{
  const windows=await request('listWindows');assert.equal(windows.type,'windows');assert.ok(Array.isArray(windows.payload.windows));
  process.stdout.write(`listWindows passed, candidate count=${windows.payload.windows.length}\n`);
  const unbound=await request('readDraft');assert.equal(unbound.type,'error');assert.equal(unbound.payload.code,'target_not_bound');
  process.stdout.write('unbound draft refused\n');
  const replace=await request('replaceDraft',{text:'fixture',expected:{}});assert.equal(replace.type,'error');assert.equal(replace.payload.code,'verified_editor_required');process.stdout.write('generic UIA mutation refused\n');
  const invalid=await request('adoptBrowser',{processId:1,profilePath:'relative'});assert.equal(invalid.type,'error');
  process.stdout.write('invalid browser identity refused\n');
  // Read-only live accessibility evidence, no draft write and no browser adoption.
  if(windows.payload.windows.length===1){await request('bindWindow',{targetInstanceId:windows.payload.windows[0].targetInstanceId});const draft=await request('readDraft');process.stdout.write(draft.type==='draft'?`live UIA readable, canReplace=${draft.payload.canReplace}\n`:`live UIA unavailable: ${draft.payload.code}\n`);}
  const stopped=await request('stop');assert.equal(stopped.type,'stopped');process.stdout.write('clean shutdown passed\n');
}finally{child.stdin.end();setTimeout(()=>child.kill(),1000).unref();}
