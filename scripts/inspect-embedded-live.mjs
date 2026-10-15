import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const pid=Number(process.argv[2]),port=Number(process.argv[3]);
if(!Number.isSafeInteger(pid)||!Number.isSafeInteger(port))throw new Error('PID_PORT_REQUIRED');
await mkdir('work/embedded-acceptance',{recursive:true});
const outfile=resolve('work/embedded-acceptance/inspect-ports.cjs');
await build({stdin:{contents:"export {WindowsLaunchPlatform} from './runtime/windows-platform'; export {reattachExplicitDevInstance} from './runtime/launcher'; export {connectOwnedLoopback} from './runtime/transport'; export {approvedDocumentURL} from './runtime/identity';",resolveDir:process.cwd()},outfile,bundle:true,platform:'node',format:'cjs'});
const {WindowsLaunchPlatform,reattachExplicitDevInstance,connectOwnedLoopback,approvedDocumentURL}=createRequire(import.meta.url)(outfile);
const platform=new WindowsLaunchPlatform(),verify=()=>reattachExplicitDevInstance(platform,pid,port);await verify();
const transport=await connectOwnedLoopback(port,verify);let session;
try{
 const targets=await transport.send('Target.getTargets',{}),matches=targets.targetInfos.filter(t=>t.type==='page'&&approvedDocumentURL(t.url));if(matches.length!==1)throw new Error('SINGLE_TARGET_REQUIRED');
 session=(await transport.send('Target.attachToTarget',{targetId:matches[0].targetId,flatten:true})).sessionId;
 const frame=(await transport.send('Page.getFrameTree',{},session)).frameTree.frame;
 const world=await transport.send('Page.createIsolatedWorld',{frameId:frame.id,worldName:'tsim-readonly-acceptance'},session);
 const result=await transport.send('Runtime.evaluate',{contextId:world.executionContextId,returnByValue:true,expression:`(()=>{const p=document.getElementById('tsim-outbound-panel'),s=p?.shadowRoot,e=document.querySelector('.chat-editor');return {documentPath:location.pathname,visible:document.visibilityState,focused:document.hasFocus(),lease:document.documentElement.hasAttribute('data-tsim-runtime-lease'),panelCount:document.querySelectorAll('#tsim-outbound-panel').length,panelConnected:!!p?.isConnected,shadow:!!s,areaCount:document.querySelectorAll('.im_detail.inform-con > .chat_area').length,inputCount:document.querySelectorAll('.chat_area-input').length,editorCount:document.querySelectorAll('.chat-editor').length,draftCharacters:e?.textContent?.length??0,panelText:s?.textContent?.replace(/<style[\\s\\S]*?<\\/style>/g,'').slice(-1600)??null,rect:p?{x:p.getBoundingClientRect().x,y:p.getBoundingClientRect().y,width:p.getBoundingClientRect().width,height:p.getBoundingClientRect().height}:null}})()`},session);
 if(result.exceptionDetails)throw new Error('INSPECTION_FAILED');console.log(JSON.stringify(result.result.value,null,2));
}finally{if(session)await transport.send('Target.detachFromTarget',{sessionId:session}).catch(()=>{});await transport.disconnect();}
