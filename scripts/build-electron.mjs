import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
// Selects the vendor build manifest compiled into every bundle; cross-build with TMC_RUNTIME_PLATFORM=win32|darwin.
const runtimePlatform=process.env.TMC_RUNTIME_PLATFORM||process.platform;
if(!['win32','darwin'].includes(runtimePlatform))throw new Error(`UNSUPPORTED_RUNTIME_PLATFORM ${runtimePlatform}`);
const platformDefine={__TMC_RUNTIME_PLATFORM__:JSON.stringify(runtimePlatform)};
if(runtimePlatform==='win32'&&process.env.TMC_WINDOWS_DYNAMIC==='1')platformDefine.__TMC_WINDOWS_DYNAMIC__='true';
if(process.env.TMC_WINDOWS_MANIFEST){
  throw new Error('WINDOWS_MANIFEST_MUST_BE_CREATED_AT_INSTALL_TIME');
}
if(process.env.TMC_MACOS_MANIFEST){
  if(runtimePlatform!=='darwin')throw new Error('PATCHED_MANIFEST_REQUIRES_MACOS');
  const manifest=JSON.parse(await readFile(process.env.TMC_MACOS_MANIFEST,'utf8'));
  const keys=['executableSha256','asarSha256'];
  if(Object.keys(manifest).some(key=>!keys.includes(key))||keys.some(key=>!/^[a-f0-9]{64}$/.test(manifest[key])))throw new Error('INVALID_PATCHED_MANIFEST');
  platformDefine.__TMC_MACOS_PATCHED_BUILD__=JSON.stringify(Object.fromEntries(keys.map(key=>[key,manifest[key]])));
}
const native=await build({entryPoints:['runtime/native-composer.ts'],bundle:true,platform:'browser',target:'chrome118',format:'iife',minify:true,write:false,define:platformDefine});
const nativeSource=native.outputFiles[0].text;
const runtime=await build({entryPoints:['runtime/runtime-ui.tsx'],bundle:true,platform:'browser',target:'chrome118',format:'iife',minify:true,write:false,define:{'process.env.NODE_ENV':'"production"',...platformDefine}});
const runtimeSource=runtime.outputFiles[0].text;
const hash=source=>createHash('sha256').update(source).digest('hex');
await mkdir('dist-runtime',{recursive:true});
await writeFile('dist-runtime/runtime-ui.js',runtimeSource);
await writeFile('dist-runtime/native-composer.js',nativeSource);
await writeFile('dist-runtime/artifact.json',JSON.stringify({kind:'embedded-companion',customerSend:'user-enter',runtimeSha256:hash(runtimeSource),nativeSha256:hash(nativeSource)},null,2));
await build({entryPoints:['electron/main.ts','electron/preload.ts'],bundle:true,platform:'node',target:'node24',format:'cjs',outdir:'dist-electron',outExtension:{'.js':'.cjs'},external:['electron'],define:{...platformDefine,__NATIVE_ARTIFACT_SOURCE__:JSON.stringify(nativeSource),__NATIVE_ARTIFACT_SHA256__:JSON.stringify(hash(nativeSource)),__RUNTIME_ARTIFACT_SOURCE__:JSON.stringify(runtimeSource),__RUNTIME_ARTIFACT_SHA256__:JSON.stringify(hash(runtimeSource))}});
console.log(JSON.stringify({event:'embedded_build_complete',runtimePlatform,customerSend:'user-enter',runtimeSha256:hash(runtimeSource),nativeSha256:hash(nativeSource)}));
