// Reviewed macOS page bytes. This allowlist is shared by the host and isolated renderer.
export const MACOS_BUNDLED_DIST='/Applications/旅游商家桌面版.app/Contents/Resources/app.asar.unpacked/dist';
export const MACOS_PAGE_BUILDS=Object.freeze([
  Object.freeze({packageVersion:'1.2.12',aresVersion:'1.2.15',rendererName:'imWindow-BnMVlw3I.js',navigationRendererName:'mainWindow-2v9P5wjR.js',htmlSha256:'a91c9fcd232a132a0441c7ed4d785fa39b4cc52d2205afc7db571489336d7b0f',rendererSha256:'80f0a342ddc9cced51b20138bb41554e583490714085d0eaeb027aa882877aa7',navigationHtmlSha256:'e32baaf2caeddf331de3a20eed37cfd259cdc20aeb2b6ab38aed96291494a4fd',navigationRendererSha256:'c4114938c13e12bc057a8ef0931676f8b0f68cc34db46d7d3c504badd77c81a6'}),
  Object.freeze({packageVersion:'1.2.12',aresVersion:'1.2.16',rendererName:'imWindow-Dd2iXeK_.js',navigationRendererName:'mainWindow-BJrZBQ0Z.js',htmlSha256:'50b80642865961b0f20867c8059a6712eea763ad263e9a8cd82ff6bf56c6de0d',rendererSha256:'af2a9fc0fb69daaf1848d42755587fe1374831e20ea87b3f7c4f53fc0814e405',navigationHtmlSha256:'a668d0fed75b4fecc715fe2d3c3d1c1a8e47afeae70745ccd7ded4f953e82fd0',navigationRendererSha256:'457f1f2a1037fdcf13c17aa346a1189f761e11fcff680d5362821d5a218f7a7b'}),
]);
export function macPageBuild(aresVersion,distURL){
  const page=MACOS_PAGE_BUILDS.find(page=>page.aresVersion===aresVersion),root=new URL(distURL),path=decodeURIComponent(root.pathname);
  const bundled=path===MACOS_BUNDLED_DIST+'/',user=path.endsWith('/Library/Application Support/vbk-electron/dist/')&&path.length>'/Library/Application Support/vbk-electron/dist/'.length;
  if(!page||root.protocol!=='file:'||root.host||root.search||root.hash||!path.startsWith('/')||!path.endsWith('/')||path.includes('\\')||path.includes('\0')||path.includes('//')||path.split('/').some(segment=>segment==='.'||segment==='..')||/%(?:2f|5c)/i.test(root.pathname)||!bundled&&!user)throw new Error('UNSUPPORTED_MACOS_PAGE_BUILD');
  const {navigationRendererName,...fields}=page;
  return Object.freeze({...fields,documentURL:new URL('src/pages/imPlus/index.html',root).href,rendererURL:new URL('js/'+page.rendererName,root).href,navigationURL:new URL('src/pages/main/index.html',root).href,navigationRendererURL:new URL('js/'+navigationRendererName,root).href});
}
export function validateMacPageBuild(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.documentURL!=='string')throw new Error('INVALID_MACOS_PAGE_BUILD');
  const document=new URL(value.documentURL),suffix='/src/pages/imPlus/index.html';
  if(!document.pathname.endsWith(suffix)||document.search||document.hash)throw new Error('INVALID_MACOS_PAGE_BUILD');
  const checked=macPageBuild(value.aresVersion,new URL('../../../',document).href);
  if(Object.keys(value).length!==Object.keys(checked).length||Object.entries(checked).some(([key,entry])=>value[key]!==entry))throw new Error('INVALID_MACOS_PAGE_BUILD');
  return checked;
}
