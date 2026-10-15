import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

// Development acceptance: observe the existing target, never write a draft or send a message.
const native=await build({entryPoints:['runtime/native-composer.ts'],bundle:true,platform:'browser',target:'chrome118',format:'iife',write:false,minify:true});
const source=native.outputFiles[0].text;
const directory=resolve('work/standalone-acceptance');await mkdir(directory,{recursive:true});
const outfile=resolve(directory,'ports.cjs');
await build({stdin:{contents:"export {NativeAdapter} from './electron/native-adapter'; export {connectExternalComposer} from './electron/external-composer';",resolveDir:process.cwd()},outfile,bundle:true,platform:'node',format:'cjs',target:'node24',define:{__NATIVE_ARTIFACT_SOURCE__:JSON.stringify(source),__NATIVE_ARTIFACT_SHA256__:JSON.stringify(createHash('sha256').update(source).digest('hex'))}});
const {NativeAdapter,connectExternalComposer}=createRequire(import.meta.url)(outfile);
const helper=new NativeAdapter(resolve('native/windows/bin/publish/TravelMerchant.WindowHelper.exe'),()=>{},status=>console.log(JSON.stringify({event:'native_status',status})));
let composer;
try{
  helper.start();const windows=await helper.list();console.log(JSON.stringify({event:'candidate_windows',count:windows.length}));
  if(windows.length!==1)throw new Error('SELECT_SINGLE_TARGET_FOR_ACCEPTANCE');
  await helper.bind(windows[0].targetInstanceId);
  composer=await connectExternalComposer(windows[0].targetInstanceId);
  const poll=await composer.read(0);
  console.log(JSON.stringify({event:'external_editor_observed',snapshotAvailable:!!poll.snapshot,writeVerified:poll.writeVerified,composing:poll.snapshot?.composing??null,plainText:poll.snapshot?.isPlainText??null,draftCharacters:poll.snapshot?.text.length??0,visibleOrderEntries:poll.orderEntries?.length??0,viewport:poll.orderViewport??null,pageUiMountedByCheck:false,draftWritten:false,customerMessageSent:false}));
  if(!poll.snapshot)throw new Error(poll.reason??'COMPOSER_UNAVAILABLE');
}catch(error){console.error(JSON.stringify({event:'acceptance_incomplete',code:error instanceof Error&&/^[A-Z][A-Z0-9_]{1,100}$/.test(error.message)?error.message:'ACCEPTANCE_FAILED'}));process.exitCode=1;}
finally{await composer?.close().catch(()=>{});helper.stop();}
