import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
const options={bundle:true,platform:'browser',target:'chrome118',format:'iife',minify:true,write:false};
const native=(await build({...options,entryPoints:['runtime/native-composer.ts']})).outputFiles[0].text;
const runtime=(await build({...options,entryPoints:['runtime/runtime-ui.tsx'],define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
const hash=s=>createHash('sha256').update(s).digest('hex');
const output=await build({entryPoints:['host-node/main.ts'],bundle:true,platform:'node',target:'node24',format:'cjs',outfile:'dist-lightweight/host/main.cjs',metafile:true,define:{__NATIVE_ARTIFACT_SOURCE__:JSON.stringify(native),__NATIVE_ARTIFACT_SHA256__:JSON.stringify(hash(native)),__RUNTIME_ARTIFACT_SOURCE__:JSON.stringify(runtime),__RUNTIME_ARTIFACT_SHA256__:JSON.stringify(hash(runtime))}});
if(Object.keys(output.metafile.inputs).some(x=>x.includes('node_modules/electron/'))||Object.values(output.metafile.outputs).some(x=>x.imports.some(i=>i.path==='electron')))throw new Error('ELECTRON_DEPENDENCY_FORBIDDEN');
await mkdir('dist-lightweight',{recursive:true});
await writeFile('dist-lightweight/node-metafile.json',JSON.stringify(output.metafile,null,2));
await writeFile('dist-lightweight/artifact.json',JSON.stringify({kind:'node-native-resident',customerSend:false,electron:false,runtimeSha256:hash(runtime),nativeSha256:hash(native)},null,2));
console.log(JSON.stringify({event:'lightweight_node_built',electron:false,customerSend:false}));

