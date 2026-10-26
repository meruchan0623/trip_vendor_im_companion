// Reviewed macOS page bytes. This allowlist is shared by the host and isolated renderer.
import {IM_CONTRACT,NAVIGATION_CONTRACT} from './windows-compatibility.mjs';
export const MACOS_EXECUTABLE='/Applications/旅游商家桌面版.app/Contents/MacOS/旅游商家桌面版';
export const MACOS_MANIFEST_PATH='/Applications/旅游商家桌面版.app/Contents/Resources/companion/vendor-runtime-manifest.json';
export const MACOS_BUNDLED_DIST='/Applications/旅游商家桌面版.app/Contents/Resources/app.asar.unpacked/dist';
export const MACOS_PAGE_BUILDS=Object.freeze([
  Object.freeze({packageVersion:'1.2.12',aresVersion:'1.2.15',rendererName:'imWindow-BnMVlw3I.js',navigationRendererName:'mainWindow-2v9P5wjR.js',htmlSha256:'a91c9fcd232a132a0441c7ed4d785fa39b4cc52d2205afc7db571489336d7b0f',rendererSha256:'80f0a342ddc9cced51b20138bb41554e583490714085d0eaeb027aa882877aa7',navigationHtmlSha256:'e32baaf2caeddf331de3a20eed37cfd259cdc20aeb2b6ab38aed96291494a4fd',navigationRendererSha256:'c4114938c13e12bc057a8ef0931676f8b0f68cc34db46d7d3c504badd77c81a6'}),
  Object.freeze({packageVersion:'1.2.12',aresVersion:'1.2.16',rendererName:'imWindow-Dd2iXeK_.js',navigationRendererName:'mainWindow-BJrZBQ0Z.js',htmlSha256:'50b80642865961b0f20867c8059a6712eea763ad263e9a8cd82ff6bf56c6de0d',rendererSha256:'af2a9fc0fb69daaf1848d42755587fe1374831e20ea87b3f7c4f53fc0814e405',navigationHtmlSha256:'a668d0fed75b4fecc715fe2d3c3d1c1a8e47afeae70745ccd7ded4f953e82fd0',navigationRendererSha256:'457f1f2a1037fdcf13c17aa346a1189f761e11fcff680d5362821d5a218f7a7b'}),
]);
/** Only the bundled dist or a current user's vendor update directory may hold pages. */
function distRoot(distURL){
  const root=new URL(distURL),path=decodeURIComponent(root.pathname);
  const bundled=path===MACOS_BUNDLED_DIST+'/',user=path.endsWith('/Library/Application Support/vbk-electron/dist/')&&path.length>'/Library/Application Support/vbk-electron/dist/'.length;
  if(root.protocol!=='file:'||root.host||root.search||root.hash||!path.startsWith('/')||!path.endsWith('/')||path.includes('\\')||path.includes('\0')||path.includes('//')||path.split('/').some(segment=>segment==='.'||segment==='..')||/%(?:2f|5c)/i.test(root.pathname)||!bundled&&!user)throw new Error('UNSUPPORTED_MACOS_PAGE_BUILD');
  return root;
}
function pageURLs(page,root){
  const {navigationRendererName,...fields}=page;
  return Object.freeze({...fields,documentURL:new URL('src/pages/imPlus/index.html',root).href,rendererURL:new URL('js/'+page.rendererName,root).href,navigationURL:new URL('src/pages/main/index.html',root).href,navigationRendererURL:new URL('js/'+navigationRendererName,root).href});
}
export function macPageBuild(aresVersion,distURL){
  const page=MACOS_PAGE_BUILDS.find(page=>page.aresVersion===aresVersion);
  if(!page)throw new Error('UNSUPPORTED_MACOS_PAGE_BUILD');
  return pageURLs(page,distRoot(distURL));
}
export function validateMacPageBuild(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.documentURL!=='string')throw new Error('INVALID_MACOS_PAGE_BUILD');
  const document=new URL(value.documentURL),suffix='/src/pages/imPlus/index.html';
  if(!document.pathname.endsWith(suffix)||document.search||document.hash)throw new Error('INVALID_MACOS_PAGE_BUILD');
  const checked=macPageBuild(value.aresVersion,new URL('../../../',document).href);
  if(Object.keys(value).length!==Object.keys(checked).length||Object.entries(checked).some(([key,entry])=>value[key]!==entry))throw new Error('INVALID_MACOS_PAGE_BUILD');
  return checked;
}

// Installer-recorded compatibility for any 1.2.11+ client. Local hashes bind this
// installation; they are not vendor signatures, so pages must also satisfy the contract.
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const release=value=>typeof value==='string'&&/^\d{1,4}\.\d{1,4}\.\d{1,9}$/.test(value);
const object=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export function supportedMacVersion(value){
  if(typeof value!=='string'||!/^\d{1,4}\.\d{1,4}\.\d{1,9}(?:\.\d{1,10})?$/.test(value))return false;
  const [major,minor,patch]=value.split('.').map(Number);return major>1||major===1&&(minor>2||minor===2&&patch>=11);
}
export function compareMacAres(left,right){
  if(!release(left)||!release(right))throw new Error('UNSUPPORTED_MACOS_PAGE_VERSION');
  const a=left.split('.').map(Number),b=right.split('.').map(Number);for(let index=0;index<3;index++)if(a[index]!==b[index])return a[index]<b[index]?-1:1;return 0;
}
export function validateMacPage(value){
  const keys=['packageVersion','aresVersion','rendererName','navigationRendererName','htmlSha256','rendererSha256','navigationHtmlSha256','navigationRendererSha256'];
  if(!object(value,keys)||!release(value.packageVersion)||!supportedMacVersion(value.packageVersion)||!release(value.aresVersion)||typeof value.rendererName!=='string'||typeof value.navigationRendererName!=='string'||!/^imWindow-[A-Za-z0-9_-]{1,80}\.js$/.test(value.rendererName)||!/^mainWindow-[A-Za-z0-9_-]{1,80}\.js$/.test(value.navigationRendererName)||keys.filter(key=>key.endsWith('Sha256')).some(key=>!hash(value[key])))throw new Error('INVALID_MACOS_PAGE_MANIFEST');
  return value;
}
export function validateMacRuntimeManifest(value){
  const keys=['schemaVersion','executable','executableVersion','executableSha256','asarSha256','chromiumMajor','bundledPage'];
  if(!object(value,keys)||value.schemaVersion!==1||value.executable!==MACOS_EXECUTABLE||!supportedMacVersion(value.executableVersion)||!hash(value.executableSha256)||!hash(value.asarSha256)||!Number.isInteger(value.chromiumMajor)||value.chromiumMajor<118||value.chromiumMajor>999)throw new Error('INVALID_MACOS_RUNTIME_MANIFEST');
  validateMacPage(value.bundledPage);
  if(value.executableVersion.split('.').slice(0,3).join('.')!==value.bundledPage.packageVersion)throw new Error('MACOS_PACKAGE_VERSION_MISMATCH');
  return value;
}
/** A page whose bytes the host has hashed and whose structure and contract it has probed. */
export function macDynamicPageBuild(page,distURL){return pageURLs(validateMacPage(page),distRoot(distURL));}
export function macRendererName(html,kind){
  if(!['imWindow','mainWindow'].includes(kind)||typeof html!=='string'||html.length>20000||[...html.matchAll(/\bid\s*=\s*["']root["']/g)].length!==1)throw new Error('UNSUPPORTED_MACOS_PAGE_STRUCTURE');
  const modules=[...html.matchAll(/<script\b([^>]*)>/gi)].filter(([,attrs])=>/\btype\s*=\s*["']module["']/i.test(attrs));
  if(modules.length!==1)throw new Error('UNSUPPORTED_MACOS_PAGE_STRUCTURE');
  const sources=[...modules[0][1].matchAll(/\bsrc\s*=\s*(["'])([^"']+)\1/gi)];
  if(sources.length!==1)throw new Error('UNSUPPORTED_MACOS_PAGE_STRUCTURE');
  const match=new RegExp('^\\.\\./\\.\\./\\.\\./js/('+kind+'-[A-Za-z0-9_-]{1,80}\\.js)$').exec(sources[0][2]);
  if(!match)throw new Error('UNSUPPORTED_MACOS_PAGE_STRUCTURE');return match[1];
}
export function assertMacRendererContract(im,nav){
  if(typeof im!=='string'||im.length>8_000_000||typeof nav!=='string'||nav.length>200_000||IM_CONTRACT.some(token=>!im.includes(token))||NAVIGATION_CONTRACT.some(token=>!nav.includes(token)))throw new Error('UNSUPPORTED_MACOS_RENDERER_CONTRACT');
}
