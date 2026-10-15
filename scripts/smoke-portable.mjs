import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const {version}=JSON.parse(await readFile('package.json','utf8'));
const executable=resolve(process.argv[2]??`release/TravelMerchantCompanion-${version}-win-x64.exe`);
console.log(JSON.stringify({event:'portable_smoke_command',executable,args:['--smoke-test','--idle-sample']}));
const child=spawn(executable,['--smoke-test','--idle-sample'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let output='';
for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{const text=chunk.toString();output+=text;process.stdout.write(text);});
const timeout=setTimeout(()=>{console.error('PORTABLE_SMOKE_TIMEOUT');child.kill();},60000);
try{
  const code=await new Promise((done,fail)=>{child.once('error',fail);child.once('exit',done);});
  await writeFile(`work/portable-${version}-smoke.log`,output,'utf8');
  const result={executable,exitCode:code,applicationSmokeVerified:output.includes('"event":"smoke_complete"')&&output.includes('"localWindows":0')&&output.includes('"embeddedBusinessUI":true')};
  console.log(JSON.stringify(result));
  await writeFile(`work/portable-${version}-launch-check.json`,JSON.stringify(result,null,2),'utf8');
  if(code!==0)throw new Error('PORTABLE_LAUNCH_FAILED');
  console.log(result.applicationSmokeVerified?'APPLICATION_SMOKE_PASSED':'LAUNCHER_EXITED_OK_WITHOUT_APP_CONSOLE; verify extracted application separately');
}finally{clearTimeout(timeout);}
