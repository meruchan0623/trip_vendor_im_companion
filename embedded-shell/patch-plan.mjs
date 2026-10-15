import { createHash,randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { resolve,relative,dirname,join,isAbsolute,sep } from 'node:path';
export const VERIFIED={packageVersion:'1.2.6',aresVersion:'1.2.10',html:'9f70dcd9eab2f0c990f943eefcf0505a9448b4d349a3ac6bcecaac470249bc9c',renderer:'d527dd4889f4cb6dfe6ad0df9a5611525c5aa2334ab1d4787b34f4f6dd09aec4',version:'a454a1cb6e6f34be4ae60f018f44e483520766aeee74cc481d0a2876157fe941'};
export const HTML='src/pages/imPlus/index.html';
export const ASSET='src/pages/imPlus/tmc/companion.js';
const renderer='js/imWindow-9Tos9blK.js';
const marker='<script src="./tmc/companion.js" defer data-tmc-patch="1.0"></script>';
export const sha256=data=>createHash('sha256').update(data).digest('hex');
export async function hashFile(path){return sha256(await fs.readFile(path));}
async function canonicalDestination(path){
  let cursor=resolve(path);const tail=[];
  for(;;){try{return join(await fs.realpath(cursor),...tail.reverse());}catch(error){if(error.code!=='ENOENT')throw error;const parent=dirname(cursor);if(parent===cursor)throw new Error('No existing output ancestor');tail.push(cursor.slice(parent.length).replace(/^[/\\]+/,''));cursor=parent;}}
}
function containsPath(root,path){const boundary=relative(root,path);return !boundary||(!isAbsolute(boundary)&&boundary!=='..'&&!boundary.startsWith(`..${sep}`));}
export async function confined(root,path){
  root=resolve(root);const destination=resolve(root,path);const rel=relative(root,destination);
  if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith(`..${sep}`))throw new Error('Path escapes transaction root');
  let cursor=dirname(destination);
  for(;;){try{const resolved=await fs.realpath(cursor);const realRoot=await fs.realpath(root);const boundary=relative(realRoot,resolved);if(isAbsolute(boundary)||boundary==='..'||boundary.startsWith(`..${sep}`))throw new Error('Reparse point escapes root');break;}catch(error){if(error.code!=='ENOENT')throw error;cursor=dirname(cursor);}}
  try{if((await fs.lstat(destination)).isSymbolicLink())throw new Error('Symlink target rejected');}catch(error){if(error.code!=='ENOENT')throw error;}
  return destination;
}
export function patchedHTML(original){
  const text=original.toString('utf8');if(text.includes('data-tmc-patch'))throw new Error('Already patched');
  if((text.match(/<\/body>/gi)||[]).length!==1||!text.includes('<div id="root"></div>')||!text.includes('imWindow-9Tos9blK.js'))throw new Error('Unexpected HTML structure');
  return Buffer.from(text.replace('</body>',`    ${marker}\r\n</body>`));
}
async function validateSource(root){
  const version=JSON.parse(await fs.readFile(await confined(root,'packageVersion.json'),'utf8'));
  if(version.pkgVersion!==VERIFIED.packageVersion||version.aresVersion!==VERIFIED.aresVersion)throw new Error('Client version drift');
  for(const[path,hash]of[[HTML,VERIFIED.html],[renderer,VERIFIED.renderer],['packageVersion.json',VERIFIED.version]])if(await hashFile(await confined(root,path))!==hash)throw new Error(`Client hash drift: ${path}`);
}
export async function prepare({clientRoot,bundleRoot,out}){
  clientRoot=resolve(clientRoot);out=resolve(out);await validateSource(clientRoot);
  const canonicalClient=await fs.realpath(clientRoot),canonicalOut=await canonicalDestination(out);
  if(containsPath(canonicalClient,canonicalOut)||containsPath(canonicalOut,canonicalClient))throw new Error('Review output must stay outside the live client source');
  try{await fs.access(out);throw new Error('Output transaction directory already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
  const original=await fs.readFile(await confined(clientRoot,HTML));const changed=patchedHTML(original);
  const script=await fs.readFile(resolve(bundleRoot,'companion.js'));if(script.length<100||script.length>2_000_000)throw new Error('Invalid embedded bundle size');
  await fs.mkdir(join(out,'staged',dirname(HTML)),{recursive:true});await fs.mkdir(join(out,'backup'),{recursive:true});await fs.mkdir(join(out,'staged',dirname(ASSET)),{recursive:true});
  await fs.writeFile(join(out,'backup/index.html'),original,{flag:'wx'});await fs.writeFile(join(out,'staged',HTML),changed,{flag:'wx'});await fs.writeFile(join(out,'staged',ASSET),script,{flag:'wx'});
  const manifest={format:'tmc-client-patch/1',transactionId:randomUUID(),createdAt:new Date().toISOString(),kind:'html-only',clientRoot,clientVersion:VERIFIED,features:{embeddedUI:true,translation:false,query:false,automaticCapture:false,writeDraft:false,customerSend:false},changes:[{path:HTML,originalSha256:sha256(original),patchedSha256:sha256(changed),backup:'backup/index.html'},{path:ASSET,originalSha256:null,patchedSha256:sha256(script)}],guards:[{path:renderer,sha256:VERIFIED.renderer},{path:'packageVersion.json',sha256:VERIFIED.version}]};
  await fs.writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2));return manifest;
}
export async function loadManifest(bundle){
  const m=JSON.parse(await fs.readFile(join(bundle,'manifest.json'),'utf8'));
  if(m.format!=='tmc-client-patch/1'||m.kind!=='html-only'||m.changes?.length!==2||m.changes[0].path!==HTML||m.changes[0].backup!=='backup/index.html'||m.changes[1].path!==ASSET||m.changes[1].originalSha256!==null)throw new Error('Unsupported manifest');
  if(m.guards?.length!==2||m.guards[0].path!==renderer||m.guards[1].path!=='packageVersion.json')throw new Error('Unsupported guards');
  for(const entry of [...m.changes,...m.guards])for(const key of ['sha256','originalSha256','patchedSha256'])if(entry[key]!==undefined&&entry[key]!==null&&!/^[0-9a-f]{64}$/.test(entry[key]))throw new Error('Invalid manifest digest');
  if(m.changes[0].originalSha256!==VERIFIED.html||m.guards[0].sha256!==VERIFIED.renderer||m.guards[1].sha256!==VERIFIED.version)throw new Error('Manifest does not match verified release');
  return m;
}
async function atomicWrite(path,data){const temporary=`${path}.tmc-${randomUUID()}.tmp`;await fs.writeFile(temporary,data,{flag:'wx'});try{await fs.rename(temporary,path);}catch(error){await fs.unlink(temporary).catch(()=>{});throw error;}}
export async function apply({bundle,targetRoot}){
  bundle=resolve(bundle);targetRoot=resolve(targetRoot);const m=await loadManifest(bundle);await validateSource(targetRoot);
  const html=await confined(targetRoot,HTML),asset=await confined(targetRoot,ASSET);
  try{await fs.access(asset);throw new Error('Existing asset collision');}catch(error){if(error.code!=='ENOENT')throw error;}
  const original=await fs.readFile(join(bundle,'backup/index.html'));if(sha256(original)!==m.changes[0].originalSha256)throw new Error('Backup digest mismatch');
  const staged=await fs.readFile(join(bundle,'staged',HTML)),script=await fs.readFile(join(bundle,'staged',ASSET));if(sha256(staged)!==m.changes[0].patchedSha256||sha256(script)!==m.changes[1].patchedSha256)throw new Error('Staged digest mismatch');
  if(!staged.equals(patchedHTML(original)))throw new Error('HTML contains changes beyond the reviewed append-only entry');
  await fs.mkdir(dirname(asset),{recursive:true});await atomicWrite(asset,script);
  try{if(await hashFile(html)!==m.changes[0].originalSha256)throw new Error('HTML changed during transaction');await atomicWrite(html,staged);}catch(error){if(await hashFile(asset)===m.changes[1].patchedSha256)await fs.unlink(asset);throw error;}
  if(await hashFile(html)!==m.changes[0].patchedSha256)throw new Error('Applied hash verification failed');
  await fs.writeFile(join(bundle,'applied.json'),JSON.stringify({transactionId:m.transactionId,targetRoot,appliedAt:new Date().toISOString()},null,2));return m;
}
export async function rollback({bundle,targetRoot}){
  bundle=resolve(bundle);targetRoot=resolve(targetRoot);const m=await loadManifest(bundle);
  const html=await confined(targetRoot,HTML),asset=await confined(targetRoot,ASSET);
  for(const guard of m.guards)if(await hashFile(await confined(targetRoot,guard.path))!==guard.sha256)throw new Error('Hot-update drift: rollback refused');
  const htmlHash=await hashFile(html);let assetHash=null;try{assetHash=await hashFile(asset);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(![m.changes[0].originalSha256,m.changes[0].patchedSha256].includes(htmlHash)||(assetHash!==null&&assetHash!==m.changes[1].patchedSha256))throw new Error('Modified target: rollback refused');
  const backup=await fs.readFile(join(bundle,'backup/index.html'));if(sha256(backup)!==m.changes[0].originalSha256)throw new Error('Backup digest mismatch');
  if(htmlHash===m.changes[0].patchedSha256)await atomicWrite(html,backup);
  if(assetHash===m.changes[1].patchedSha256)await fs.unlink(asset);
  await fs.writeFile(join(bundle,'rolled-back.json'),JSON.stringify({transactionId:m.transactionId,targetRoot,rolledBackAt:new Date().toISOString()},null,2));return m;
}
