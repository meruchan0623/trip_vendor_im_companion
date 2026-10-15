import { prepare,apply,rollback } from '../embedded-shell/patch-plan.mjs';
import { resolve } from 'node:path';
import { assertClientIdle } from '../embedded-shell/live-gate.mjs';
import { realpathSync } from 'node:fs';
const [command,...args]=process.argv.slice(2);const options={};for(let i=0;i<args.length;i++){if(!args[i].startsWith('--'))throw new Error('Expected named argument');const key=args[i].slice(2);if(key==='allow-live-write')options[key]=true;else options[key]=args[++i];}
const liveRoot=resolve(process.env.APPDATA||'', 'vbk-electron/dist');
function liveWriteGate(targetRoot){
  if(realpathSync(targetRoot).toLowerCase()!==realpathSync(liveRoot).toLowerCase())return;
  if(options['allow-live-write']!==true)throw new Error('Live application requires explicit --allow-live-write after review and confirmed empty merchant draft');
  assertClientIdle();
}
try{
  let manifest;
  if(command==='prepare')manifest=await prepare({clientRoot:options['client-root']||liveRoot,bundleRoot:options['bundle-root']||resolve('dist-embedded'),out:options.out||resolve('work/embedded-patch-review')});
  else if(command==='apply'||command==='rollback'){const targetRoot=options['target-root']||liveRoot;liveWriteGate(targetRoot);manifest=await(command==='apply'?apply:rollback)({bundle:options.bundle||resolve('work/embedded-patch-review'),targetRoot});}
  else throw new Error('Usage: patch-client.mjs prepare|apply|rollback --client-root/--target-root <path> --out/--bundle <transaction>');
  console.log(JSON.stringify({command,transactionId:manifest.transactionId,kind:manifest.kind,features:manifest.features}));
}catch(error){console.error(`Patch refused: ${error.message}`);process.exitCode=1;}
