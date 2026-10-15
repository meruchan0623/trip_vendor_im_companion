// Exercises the built helper's JSON dispatch only; no bind, browser launch or UI Automation.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const executable=resolve(process.argv[2]??'work/acceptance-fix-native/TravelMerchant.WindowHelper.exe');
const child=spawn(executable,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
const pending=new Map();let sequence=0;
createInterface({input:child.stdout}).on('line',line=>{
  const message=JSON.parse(line),item=pending.get(message.requestId);
  if(item){clearTimeout(item.timer);pending.delete(message.requestId);item.resolve(message);}
});
child.stderr.on('data',()=>process.stderr.write('helper_diagnostic\n'));
function request(payload){
  const requestId=String(++sequence);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('helper_timeout'));},6000);
    pending.set(requestId,{resolve,timer});
    child.stdin.write(JSON.stringify({protocolVersion:'1.0',requestId,type:'placeBrowser',payload})+'\n');
  });
}
try{
  for(const restack of [true,false]){
    const result=await request({bounds:{x:0,y:0,width:800,height:600},visible:true,restack});
    assert.equal(result.type,'error');assert.equal(result.payload.code,'browser_not_adopted');
  }
  for(const payload of [{restack:'true'},{restack:true,unknown:true}])assert.equal((await request(payload)).payload.code,'invalid_command');
  process.stdout.write('native placement protocol: boolean restack passes field gate; invalid values and unknown fields rejected; no browser/UI operations\n');
}finally{
  child.stdin.end();setTimeout(()=>child.kill(),1500).unref();
}
