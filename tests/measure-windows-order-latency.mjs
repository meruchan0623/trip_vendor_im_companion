// Controlled CDP latency model, not installed-client or network acceptance.
import {build} from 'esbuild';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {tmpdir} from 'node:os';

const root=process.cwd(),temporaryRoot=resolve(tmpdir());
const directory=await mkdtemp(join(temporaryRoot,'tsim-order-latency-'));
const source=String.raw`
import {LiveRuntimeDriver} from './runtime/driver';
import {RuntimeCDPPolicy} from './runtime/cdp-policy';
import {WINDOWS_RUNTIME_BUILD} from './runtime/build-manifest';
import {createHash} from 'node:crypto';
const delay=()=>new Promise(resolve=>setTimeout(resolve,8));
async function sample(oopif,earlyHint=false){
  let commands=0;
  const round=async()=>{commands++;await delay();};
  const source='https://vbooking.ctrip.com/tour/im/ex-area/b?groupid=fixture&sessionid=fixture&serviceType=t&status=1';
  const actual='https://vbooking.ctrip.com/tour/im/ex-area/b/imExtraInfo?groupid=fixture&sessionid=fixture&servicetype=t&status=1';
  const child={id:'child',parentId:'main',url:actual,loaderId:'fixture-loader'};
  const orderPolicy=Object.create(RuntimeCDPPolicy.prototype);
  Object.assign(orderPolicy,{isolatedContextId:1,sessionId:'parent-session',generation:0,target:{frameId:'main',contextNonce:'fixture'},transport:{send:async(method,params,session)=>{
    await round();
    if(method==='Target.getTargets')return{targetInfos:[{targetId:'child',type:'iframe',url:actual}]};
    if(method==='Target.attachToTarget')return{sessionId:'child-session'};
    if(method==='Target.detachFromTarget'||method==='Runtime.releaseObject')return{};
    if(method==='Page.getFrameTree')return session==='child-session'?{frameTree:{frame:child}}:{frameTree:{frame:{id:'main'},childFrames:oopif?[]:[{frame:child}]}};
    if(method==='Runtime.evaluate'&&params.returnByValue===false)return{result:{objectId:'frame-object'}};
    if(method==='DOM.describeNode')return{node:{frameId:'child',attributes:['src',source]}};
    if(method==='Page.createIsolatedWorld')return{executionContextId:2};
    if(method==='Runtime.evaluate')return{result:{value:{width:400,height:600,entries:[{identifier:'FIXTURE123',identifierType:'order_number',rect:{x:10,y:20,width:100,height:15}}]}}};
    throw Error('Unexpected command '+method);
  }}});
  const geometry={rect:{x:500,y:100,width:400,height:600},clientWidth:400,clientHeight:600,clientLeft:0,clientTop:0};
  const driver=Object.create(LiveRuntimeDriver.prototype);
  Object.assign(driver,{epoch:0,invalid:false,verifyActiveTarget:async()=>{await round();return true;},policy:{
    installNative:async()=>{},
    verifyExactDocument:async()=>{await round();await round();},renewNative:round,
    readMessageNavigation:async()=>{await round();await round();return{active:true,dpr:1,width:1000,height:800};},
    pollNative:async()=>{await round();return{snapshot:{conversationId:'fixture'},messageSurface:{active:true},orderFrame:geometry,...(earlyHint?{currentOrderHint:{identifier:'FIXTURE123',conversationId:'fixture'}}:{})};},
    readRightOrderEntries:geometry=>orderPolicy.readRightOrderEntries(geometry),
  }});
  const port=await driver.externalComposer('',''),start=performance.now();
  const result=await port.read(0);
  if(result.orderEntries?.length!==1&&result.currentOrderHint?.identifier!=='FIXTURE123')throw Error('ORDER_NOT_VERIFIED');
  return{elapsedMs:performance.now()-start,commands};
}
async function sampleTargets(count){
  let commands=0;const html='fixture-html',ids=Array.from({length:count},(_,i)=>'target-'+i);
  const driver=Object.create(LiveRuntimeDriver.prototype);
  Object.assign(driver,{epoch:0,invalid:false,target:{targetId:ids[0],frameId:ids[0]+'-frame',contextNonce:'fixture',fingerprint:{htmlSha256:createHash('sha256').update(html).digest('hex')}},transport:{send:async(method,params,session)=>{
    commands++;await delay();
    if(method==='Target.getTargets')return{targetInfos:ids.map(targetId=>({targetId,type:'page',url:WINDOWS_RUNTIME_BUILD.documentURL}))};
    if(method==='Target.attachToTarget')return{sessionId:params.targetId};
    if(method==='Page.enable'||method==='Target.detachFromTarget')return{};
    if(method==='Page.getFrameTree')return{frameTree:{frame:{id:session+'-frame',url:WINDOWS_RUNTIME_BUILD.documentURL,loaderId:'fixture'}}};
    if(method==='Page.getResourceContent')return{content:html,base64Encoded:false};
    if(method==='Page.createIsolatedWorld')return{executionContextId:2};
    if(method==='Runtime.evaluate')return{result:{value:{visible:session===ids[0],focused:session===ids[0]}}};
    throw Error('Unexpected '+method);
  }}});
  const start=performance.now();if(!await driver.verifyActiveTarget())throw Error('TARGET_NOT_VERIFIED');
  return{elapsedMs:performance.now()-start,commands};
}
(async()=>{for(const [oopif,earlyHint] of [[false,false],[true,false],[true,true]]){
  const samples=[];for(let i=0;i<5;i++)samples.push(await sample(oopif,earlyHint));
  const sorted=samples.map(s=>s.elapsedMs).sort((a,b)=>a-b);
  console.log(JSON.stringify({mode:oopif?'OOPIF':'same-process',earlyHint,simulatedRoundTripMs:8,samples:5,medianMs:Math.round(sorted[2]*10)/10,commands:samples[0].commands}));
}
for(const count of [4,8]){
  const samples=[];for(let i=0;i<3;i++)samples.push(await sampleTargets(count));
  const sorted=samples.map(s=>s.elapsedMs).sort((a,b)=>a-b);
  console.log(JSON.stringify({mode:'active-account-verification',candidateAccounts:count,simulatedRoundTripMs:8,samples:3,medianMs:Math.round(sorted[1]*10)/10,commands:samples[0].commands}));
}})().catch(error=>{console.error(error);process.exitCode=1;});
`;
try{
  for(const version of ['baseline','optimized']){
    const outfile=join(directory,version+'.cjs');
    await build({stdin:{contents:source,resolveDir:root,loader:'ts'},outfile,bundle:true,platform:'node',format:'cjs',define:{__TMC_RUNTIME_PLATFORM__:'"win32"'},logLevel:'warning',plugins:version==='baseline'?[{name:'head-baseline',setup(builder){builder.onLoad({filter:/runtime[\\/](?:driver|cdp-policy)\.ts$/},args=>({contents:execFileSync('git',['show','HEAD:'+relative(root,args.path).replaceAll('\\','/')],{cwd:root,encoding:'utf8'}),loader:'ts'}));}}]:[]});
    console.log(JSON.stringify({version,baseline:version==='baseline'?'git HEAD':'working tree',note:'Simulated protocol delay; does not measure the installed client or TSim service.'}));
    const result=spawnSync(process.execPath,[outfile],{stdio:'inherit'});
    if(result.status!==0)throw Error('LATENCY_MEASUREMENT_FAILED');
  }
}finally{
  const target=resolve(directory);
  if(target.startsWith(temporaryRoot+'\\')||target.startsWith(temporaryRoot+'/'))await rm(target,{recursive:true,force:true});
}
