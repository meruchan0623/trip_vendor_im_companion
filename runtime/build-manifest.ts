/** Static compatibility manifests, one per vendor build; safe to bundle into an isolated renderer world. */
declare const __TMC_RUNTIME_PLATFORM__:string|undefined;
declare const __TMC_MACOS_PATCHED_BUILD__:{executableSha256:string;asarSha256:string}|undefined;
declare const __TMC_MACOS_PAGE_BUILD__: {
  aresVersion:string;htmlSha256:string;rendererSha256:string;rendererName:string;
  navigationHtmlSha256:string;navigationRendererSha256:string;
  documentURL:string;rendererURL:string;navigationURL:string;navigationRendererURL:string;
}|undefined;
export const MACOS_PATCHED_BUILD=typeof __TMC_MACOS_PATCHED_BUILD__!=='undefined';
export const WINDOWS_RUNTIME_BUILD = Object.freeze({
  executable: 'C:\\Program Files\\vbk-electron\\旅游商家桌面版.exe',
  executableVersion: '1.2.11.2664320', packageVersion: '1.2.11', aresVersion: '1.2.14',
  executableSha256: '16abcc1d60648323aa661a64a490d8673737160408040d95e3f96bc0c3965159',
  asarSha256: '31a70162330e448574480960930b2e5b05d78d07ccd1a66e1c8517525f46aef6',
  htmlSha256: '928bfd1bed4fe3ead20b866450aa4e03dbc0c43154be23feff2ee55ee4c94f93',
  rendererSha256: '4e3ba5aa01063a0ed9ebe11ef545040f797dbe33f71aff68cd45e98de3041f87',
  documentURL: 'file:///C:/Program%20Files/vbk-electron/resources/app.asar.unpacked/dist/src/pages/imPlus/index.html',
  rendererURL: 'file:///C:/Program%20Files/vbk-electron/resources/app.asar.unpacked/dist/js/imWindow-DfcqWwN2.js',
  rendererName: 'imWindow-DfcqWwN2.js', chromiumMajor: 118,
  navigationURL: 'file:///C:/Program%20Files/vbk-electron/resources/app.asar.unpacked/dist/src/pages/main/index.html',
  navigationRendererURL: 'file:///C:/Program%20Files/vbk-electron/resources/app.asar.unpacked/dist/js/mainWindow-BMmNuWTW.js',
  navigationHtmlSha256: '94feb90c608b9a5cb6710c6b608349f2742ac6c9304de622a76fcc9bc97e5c47',
  navigationRendererSha256: '3dc548ead7bc30a230d48d14f231c3a6d86b457e6d5c233f280a635051480582',
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
export const VERIFIED_RUNTIME_BUILD=RUNTIME_PLATFORM==='darwin'?MACOS_RUNTIME_BUILD:WINDOWS_RUNTIME_BUILD;
