// Read-only evidence for order/language adapters; never reads credentials or modifies drafts.
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const pid=Number(process.argv[2]),port=Number(process.argv[3]);
if(!Number.isSafeInteger(pid)||!Number.isSafeInteger(port))throw new Error('PID_PORT_REQUIRED');
await mkdir('work/customer-context',{recursive:true});
const outfile=resolve('work/customer-context/ports.cjs');
await build({stdin:{contents:"export {WindowsLaunchPlatform} from './runtime/windows-platform'; export {reattachExplicitDevInstance} from './runtime/launcher'; export {connectOwnedLoopback} from './runtime/transport'; export {approvedDocumentURL} from './runtime/identity';",resolveDir:process.cwd()},outfile,bundle:true,platform:'node',format:'cjs'});
const {WindowsLaunchPlatform,reattachExplicitDevInstance,connectOwnedLoopback,approvedDocumentURL}=createRequire(import.meta.url)(outfile);
const platform=new WindowsLaunchPlatform(),verify=()=>reattachExplicitDevInstance(platform,pid,port);
const transport=await connectOwnedLoopback(port,verify);let session;
try{
 const targets=await transport.send('Target.getTargets',{}),matches=targets.targetInfos.filter(t=>t.type==='page'&&approvedDocumentURL(t.url));if(matches.length!==1)throw new Error('SINGLE_TARGET_REQUIRED');
 session=(await transport.send('Target.attachToTarget',{targetId:matches[0].targetId,flatten:true})).sessionId;
 const tree=(await transport.send('Page.getFrameTree',{},session)).frameTree;
 const world=await transport.send('Page.createIsolatedWorld',{frameId:tree.frame.id,worldName:'tsim-readonly-customer-context'},session);
 const expression=`(()=>{
 const chain=e=>{const a=[];for(let i=0;e&&i<4;i++,e=e.parentElement)a.push({tag:e.tagName,class:e.className,id:e.id});return a};
 const orders=[...document.querySelectorAll('body *')].filter(e=>e.children.length===0&&/^订单\\s*(ID|号)\\s*[：:]?$/i.test(e.textContent?.trim()||'')).slice(0,12).map(e=>({label:e.textContent,chain:chain(e),parent:e.parentElement?.outerHTML.slice(0,5000)}));
 const headers=[...document.querySelectorAll('.im_detail_hd .group-chat-hover-box-txt')].map(e=>e.outerHTML.slice(0,5000));
 const rows=[...document.querySelectorAll('.chat_list_content li.normal-message-item')].slice(-8).map(e=>({class:e.className,nameMarkup:e.querySelector('.message-name')?.innerHTML.replace(/<span class="nick-name"[^>]*>[\\s\\S]*?<\\/span>/g,'<span class="nick-name">[redacted]</span>'),texts:[...e.querySelectorAll('.chat-text')].map(n=>({class:n.className,parent:n.parentElement.className,characters:n.textContent?.length,translation:!!n.closest('.tran-group')}))}));
 return {path:location.pathname,visible:document.visibilityState,orders,headers,rows,iframes:[...document.querySelectorAll('iframe')].map(e=>({id:e.id,class:e.className,location:(()=>{try{const u=new URL(e.src);return {origin:u.origin,path:u.pathname,params:[...u.searchParams].map(([k,v])=>[k,/order/i.test(k)?v:'[redacted]'])}}catch{return null}})()}))};})()`;
 const result=await transport.send('Runtime.evaluate',{contextId:world.executionContextId,returnByValue:true,expression},session);
 if(result.exceptionDetails)throw new Error('INSPECTION_FAILED');
 await writeFile('work/customer-context/live-dom.json',JSON.stringify(result.result.value,null,2),'utf8');
 console.log(JSON.stringify(result.result.value,null,2));
 console.log(JSON.stringify({frames:tree.childFrames?.map(f=>({id:f.frame.id,urlOrigin:new URL(f.frame.url).origin,path:new URL(f.frame.url).pathname})),targets:targets.targetInfos.filter(t=>t.type==='iframe').map(t=>({targetId:t.targetId,type:t.type,origin:new URL(t.url).origin,path:new URL(t.url).pathname}))},null,2));
 const children=tree.childFrames?.filter(f=>{const u=new URL(f.frame.url);return u.origin==='https://vbooking.ctrip.com'&&u.pathname==='/tour/im/ex-area/b/imExtraInfo'})??[];
 if(children.length===1){
   const childWorld=await transport.send('Page.createIsolatedWorld',{frameId:children[0].frame.id,worldName:'tsim-readonly-order-context'},session);
   const child=await transport.send('Runtime.evaluate',{contextId:childWorld.executionContextId,returnByValue:true,expression:`(()=>{const nodes=[...document.querySelectorAll('body *')].filter(e=>e.children.length===0&&/^订单\\s*(ID|号)\\s*[：:]?$/i.test(e.textContent?.trim()||''));return nodes.map(e=>({label:e.textContent,parent:e.parentElement.outerHTML.slice(0,6000),grandparentClass:e.parentElement.parentElement.className}));})()`},session);
   const frameURL=new URL(children[0].frame.url);
   console.log(JSON.stringify({orderFrame:child.result?.value,exception:!!child.exceptionDetails,childParameterNames:[...frameURL.searchParams.keys()]},null,2));
   await writeFile('work/customer-context/order-frame.json',JSON.stringify(child.result?.value,null,2),'utf8');
 }
 const accessible=await transport.send('Runtime.evaluate',{contextId:world.executionContextId,returnByValue:true,expression:`(()=>{try{const f=document.querySelector('iframe.customer_order-detail'),d=f?.contentDocument,a=new URL(f.src),b=new URL(d.URL);return {accessible:!!d,path:d?.location.pathname,scopeMatches:['groupid','sessionid','serviceType','status'].map(k=>({key:k,matches:(a.searchParams.get(k)??'')===(b.searchParams.get(k==='serviceType'?'servicetype':k)??'')}))}}catch{return {accessible:false}}})()`},session);
 console.log(JSON.stringify({parentAccess:accessible.result?.value}));
}finally{if(session)await transport.send('Target.detachFromTarget',{sessionId:session}).catch(()=>{});await transport.disconnect();}
