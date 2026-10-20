/** Static compatibility manifests, one per vendor build; safe to bundle into an isolated renderer world. */
import{validateWindowsPage,validateWindowsRuntimeManifest,type WindowsPageManifest,type WindowsRuntimeManifest}from'./windows-compatibility.mjs';
declare const __TMC_RUNTIME_PLATFORM__:string|undefined;
declare const __TMC_WINDOWS_DYNAMIC__:boolean|undefined;
declare const __TMC_MACOS_PATCHED_BUILD__:{executableSha256:string;asarSha256:string}|undefined;
declare const __TMC_MACOS_PAGE_BUILD__: {
  aresVersion:string;htmlSha256:string;rendererSha256:string;rendererName:string;
  navigationHtmlSha256:string;navigationRendererSha256:string;
  documentURL:string;rendererURL:string;navigationURL:string;navigationRendererURL:string;
}|undefined;
export const MACOS_PATCHED_BUILD=typeof __TMC_MACOS_PATCHED_BUILD__!=='undefined';
export const WINDOWS_RUNTIME_BUILD = Object.freeze({
  executable: 'C:\\Program Files\\vbk-electron\\旅游商家桌面版.exe',
  executableVersion: '1.2.12.2679625', packageVersion: '1.2.12', aresVersion: '1.2.15',
  executableSha256: '4fad3f96a67067aea50c355fe138f96c33c71deea4da17c19ee81b5a206cc6c4',
  asarSha256: 'e1cd32d35e9526cc29f1878532bcbdae8284e522a4d8c588b6214801a145bc49',
  htmlSha256: 'a40a7882b721c7fe584a0c894c093734b88cc415062ddab7c01b21721652bd4f',
  rendererSha256: '543e9b534d691f75dc07f6f03fb5359e791196594c9d87875456d20670ebb6cc',
  documentURL: 'file:///C:/Program%20Files/vbk-electron/resources/app.asar.unpacked/dist/src/pages/imPlus/index.html',
  rendererURL: 'file:///C:/Program%20Files/vbk-electron/resources/app.asar.unpacked/dist/js/imWindow-DeDFr-7q.js',
  rendererName: 'imWindow-DeDFr-7q.js', chromiumMajor: 118,
  navigationURL: 'file:///C:/Program%20Files/vbk-electron/resources/app.asar.unpacked/dist/src/pages/main/index.html',
  navigationRendererURL: 'file:///C:/Program%20Files/vbk-electron/resources/app.asar.unpacked/dist/js/mainWindow-M_STnhjX.js',
  navigationHtmlSha256: '294cbc2541782e25f92dd3c1efdc4be5c529ce2711ab2f7276c3954ac337b7b9',
  navigationRendererSha256: '641095b3cf2f5328a3254b391ee5acf89a985e103d243e8e7dcd5568057fbbd4',
});
/** Default bundled pages; injection may pin a separately verified hot-update build at compile time. */
export const MACOS_RUNTIME_BUILD = Object.freeze({
  executable: '/Applications/旅游商家桌面版.app/Contents/MacOS/旅游商家桌面版',
  executableVersion: '1.2.12', packageVersion: '1.2.12', aresVersion: '1.2.15',
  executableSha256: '0db3c283d0bb58a1e314b89cd2d4f54089c86cdc1ee0c22ecfe1550ade2ff0c2',
  asarSha256: 'e6e1a4547e3609ac858d8d71f69a982a46d6f04a8a7f4197bf4ba63ed39abb24',
  htmlSha256: 'a91c9fcd232a132a0441c7ed4d785fa39b4cc52d2205afc7db571489336d7b0f',
  rendererSha256: '80f0a342ddc9cced51b20138bb41554e583490714085d0eaeb027aa882877aa7',
  documentURL: 'file:///Applications/%E6%97%85%E6%B8%B8%E5%95%86%E5%AE%B6%E6%A1%8C%E9%9D%A2%E7%89%88.app/Contents/Resources/app.asar.unpacked/dist/src/pages/imPlus/index.html',
  rendererURL: 'file:///Applications/%E6%97%85%E6%B8%B8%E5%95%86%E5%AE%B6%E6%A1%8C%E9%9D%A2%E7%89%88.app/Contents/Resources/app.asar.unpacked/dist/js/imWindow-BnMVlw3I.js',
  rendererName: 'imWindow-BnMVlw3I.js', chromiumMajor: 118,
  navigationURL: 'file:///Applications/%E6%97%85%E6%B8%B8%E5%95%86%E5%AE%B6%E6%A1%8C%E9%9D%A2%E7%89%88.app/Contents/Resources/app.asar.unpacked/dist/src/pages/main/index.html',
  navigationRendererURL: 'file:///Applications/%E6%97%85%E6%B8%B8%E5%95%86%E5%AE%B6%E6%A1%8C%E9%9D%A2%E7%89%88.app/Contents/Resources/app.asar.unpacked/dist/js/mainWindow-2v9P5wjR.js',
  navigationHtmlSha256: 'e32baaf2caeddf331de3a20eed37cfd259cdc20aeb2b6ab38aed96291494a4fd',
  navigationRendererSha256: 'c4114938c13e12bc057a8ef0931676f8b0f68cc34db46d7d3c504badd77c81a6',
  ...(typeof __TMC_MACOS_PATCHED_BUILD__!=='undefined'?__TMC_MACOS_PATCHED_BUILD__:{}),
  ...(typeof __TMC_MACOS_PAGE_BUILD__!=='undefined'?__TMC_MACOS_PAGE_BUILD__:{}),
});
// Build-time define wins; unbundled Node falls back to the host. Anything but darwin keeps the Windows manifest.
export const RUNTIME_PLATFORM:'win32'|'darwin'=(typeof __TMC_RUNTIME_PLATFORM__==='string'?__TMC_RUNTIME_PLATFORM__:typeof process!=='undefined'&&process.platform==='darwin'?'darwin':'win32')==='darwin'?'darwin':'win32';
export type RuntimeBuild={readonly [K in keyof typeof WINDOWS_RUNTIME_BUILD]:typeof WINDOWS_RUNTIME_BUILD[K] extends number?number:string};
export let VERIFIED_RUNTIME_BUILD:RuntimeBuild=RUNTIME_PLATFORM==='darwin'?MACOS_RUNTIME_BUILD:WINDOWS_RUNTIME_BUILD;
export const WINDOWS_DYNAMIC_RUNTIME=typeof __TMC_WINDOWS_DYNAMIC__!=='undefined'&&__TMC_WINDOWS_DYNAMIC__;
/** Historical fixtures for standalone developer tests; installed Windows runtime uses its protected manifest. */
export const WINDOWS_PAGE_BUILDS=Object.freeze([
  Object.freeze({packageVersion:'1.2.12',aresVersion:'1.2.15',rendererName:WINDOWS_RUNTIME_BUILD.rendererName,navigationRendererName:'mainWindow-M_STnhjX.js',htmlSha256:WINDOWS_RUNTIME_BUILD.htmlSha256,rendererSha256:WINDOWS_RUNTIME_BUILD.rendererSha256,navigationHtmlSha256:WINDOWS_RUNTIME_BUILD.navigationHtmlSha256,navigationRendererSha256:WINDOWS_RUNTIME_BUILD.navigationRendererSha256}),
  Object.freeze({packageVersion:'1.2.12',aresVersion:'1.2.16',rendererName:'imWindow-Dd2iXeK_.js',navigationRendererName:'mainWindow-BJrZBQ0Z.js',htmlSha256:'50b80642865961b0f20867c8059a6712eea763ad263e9a8cd82ff6bf56c6de0d',rendererSha256:'af2a9fc0fb69daaf1848d42755587fe1374831e20ea87b3f7c4f53fc0814e405',navigationHtmlSha256:'a668d0fed75b4fecc715fe2d3c3d1c1a8e47afeae70745ccd7ded4f953e82fd0',navigationRendererSha256:'457f1f2a1037fdcf13c17aa346a1189f761e11fcff680d5362821d5a218f7a7b'}),
]);
/** Called only after the Node-side checker has hashed the selected files. */
export function activateWindowsPageBuild(aresVersion:string,distURL:string){
  if(RUNTIME_PLATFORM!=='win32')throw new Error('WINDOWS_REQUIRED');
  VERIFIED_RUNTIME_BUILD=windowsPageBuild(aresVersion,distURL);
}
export function windowsPageBuild(aresVersion:string,distURL:string):RuntimeBuild{
  const page=WINDOWS_PAGE_BUILDS.find(page=>page.aresVersion===aresVersion),root=new URL(distURL);
  if(!page||root.protocol!=='file:'||root.host||root.search||root.hash||!/^\/[A-Za-z]:\//.test(decodeURIComponent(root.pathname))||!root.pathname.endsWith('/'))throw new Error('UNSUPPORTED_WINDOWS_PAGE_BUILD');
  const {navigationRendererName,...fields}=page;
  return Object.freeze({...WINDOWS_RUNTIME_BUILD,...fields,documentURL:new URL('src/pages/imPlus/index.html',root).href,rendererURL:new URL('js/'+page.rendererName,root).href,navigationURL:new URL('src/pages/main/index.html',root).href,navigationRendererURL:new URL('js/'+navigationRendererName,root).href});
}
export function windowsRuntimeBuild(manifest:WindowsRuntimeManifest,page:WindowsPageManifest,distURL:string):RuntimeBuild{
  validateWindowsRuntimeManifest(manifest);validateWindowsPage(page);
  const root=new URL(distURL);
  if(page.packageVersion!==manifest.bundledPage.packageVersion||root.protocol!=='file:'||root.host||root.search||root.hash||!/^\/[A-Za-z]:\//.test(decodeURIComponent(root.pathname))||!root.pathname.endsWith('/'))throw new Error('INVALID_WINDOWS_RUNTIME_PAGE');
  const {navigationRendererName,...fields}=page;
  return Object.freeze({...fields,executable:manifest.executable,executableVersion:manifest.executableVersion,executableSha256:manifest.executableSha256,asarSha256:manifest.asarSha256,chromiumMajor:manifest.chromiumMajor,documentURL:new URL('src/pages/imPlus/index.html',root).href,rendererURL:new URL('js/'+page.rendererName,root).href,navigationURL:new URL('src/pages/main/index.html',root).href,navigationRendererURL:new URL('js/'+navigationRendererName,root).href});
}
export function activateWindowsRuntimeBuild(build:RuntimeBuild){if(RUNTIME_PLATFORM!=='win32')throw new Error('WINDOWS_REQUIRED');VERIFIED_RUNTIME_BUILD=validateWindowsRuntimeBuild(build);}
/** Renderer defense in depth; the Node policy has already checked the protected manifest and loaded bytes. */
export function validateWindowsRuntimeBuild(value:RuntimeBuild):RuntimeBuild{
  const document=new URL(value.documentURL),suffix='/src/pages/imPlus/index.html';
  if(document.protocol!=='file:'||document.host||document.search||document.hash||!decodeURIComponent(document.pathname).endsWith('/dist'+suffix))throw new Error('INVALID_WINDOWS_RUNTIME_PAGE');
  const root=new URL('../../../',document),nav=new URL(value.navigationRendererURL),navigationRendererName=decodeURIComponent(nav.pathname).split('/').at(-1)!;
  const page={packageVersion:value.packageVersion,aresVersion:value.aresVersion,rendererName:value.rendererName,navigationRendererName,htmlSha256:value.htmlSha256,rendererSha256:value.rendererSha256,navigationHtmlSha256:value.navigationHtmlSha256,navigationRendererSha256:value.navigationRendererSha256};
  const checked=windowsRuntimeBuild({schemaVersion:1,executable:value.executable,executableVersion:value.executableVersion,executableSha256:value.executableSha256,asarSha256:value.asarSha256,chromiumMajor:value.chromiumMajor,bundledPage:page},page,root.href);
  if(Object.keys(value).length!==Object.keys(checked).length||Object.entries(checked).some(([key,entry])=>(value as unknown as Record<string,unknown>)[key]!==entry))throw new Error('INVALID_WINDOWS_RUNTIME_PAGE');
  return checked;
}
