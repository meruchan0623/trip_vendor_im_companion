// Manual live smoke only; do not run in a computer-use-only acceptance session.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,join} from 'node:path';
import assert from 'node:assert/strict';
const directory=dirname(fileURLToPath(import.meta.url));
const helper=spawn(resolve(directory,'bin/publish/TravelMerchant.WindowHelper.exe'),[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
const requests=new Map();let sequence=0;
createInterface({input:helper.stdout}).on('line',line=>{const message=JSON.parse(line);const pending=requests.get(message.requestId);if(pending){clearTimeout(pending.timer);requests.delete(message.requestId);pending.resolve(message);}});
helper.stderr.on('data',()=>process.stderr.write('helper_diagnostic\n'));
function request(type,payload={}){const requestId=String(++sequence);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('helper_timeout')),10000);requests.set(requestId,{resolve,timer});helper.stdin.write(JSON.stringify({protocolVersion:'1.0',requestId,type,payload})+'\n');});}
const key={launchId:randomUUID()};
async function cleanup(){const deadline=Date.now()+14000;for(;;){const result=await request('cleanupBrowserLaunch',key);assert.equal(result.type,'browserLaunchCleaned');if(result.payload.complete)return;if(Date.now()>=deadline)throw new Error('cleanup_unconfirmed');await new Promise(resolve=>setTimeout(resolve,150));}}
try{
  const launched=await request('launchBrowser',{...key,profilePath:resolve(directory,`bin/browser-smoke-${Date.now()}`,'system-browser-profile'),appURL:'https://csagent.tsim.tech/embed/operator?source=travel-merchant-companion'});
  assert.equal(launched.type,'browserLaunched');const proof=launched.payload;assert.equal(proof.launchId,key.launchId);
  let adopted;const deadline=Date.now()+12000;
  do{adopted=await request('adoptBrowser',proof);if(adopted.type==='browserAdopted')break;assert.equal(adopted.payload.code,'browser_window_pending');await new Promise(resolve=>setTimeout(resolve,150));}while(Date.now()<deadline);
  assert.equal(adopted.type,'browserAdopted');assert.equal(adopted.payload.profileMatched,true);assert.equal(adopted.payload.borderless,true);process.stdout.write('exact native-spawn lease HWND adopted\n');
  const bounds={x:-32000,y:-32000,width:640,height:480};const placed=await request('placeBrowser',{bounds,visible:false});assert.equal(placed.type,'browserPlaced');assert.deepEqual(placed.payload.bounds,bounds);
  await cleanup();process.stdout.write('owned launch identities exited; no original browser/profile touched\n');
}finally{await cleanup().catch(()=>{});await request('stop').catch(()=>{});helper.stdin.end();const timer=setTimeout(()=>helper.kill(),20000);timer.unref();helper.once('exit',()=>clearTimeout(timer));}
