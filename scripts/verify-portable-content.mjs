import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { extractFile } from '@electron/asar';

const root=resolve(process.argv[2]??'release/win-unpacked');
const archive=resolve(root,'resources/app.asar');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest=JSON.parse(extractFile(archive,'package.json').toString('utf8'));
const checks=[];
for(const file of ['dist-electron/main.cjs','dist-electron/preload.cjs','dist/index.html']){
  const built=sha256(await readFile(file)),packaged=sha256(extractFile(archive,file));
  checks.push({file,sha256:packaged,matchesBuild:built===packaged});
}
const helper='resources/native/windows/TravelMerchant.WindowHelper.exe';
checks.push({file:helper,sha256:sha256(await readFile(resolve(root,helper))),matchesBuild:sha256(await readFile(resolve(root,helper)))===sha256(await readFile('native/windows/bin/publish/TravelMerchant.WindowHelper.exe'))});
const localManifest=JSON.parse(await readFile('package.json','utf8'));
const result={version:manifest.version,checks,passed:manifest.version===localManifest.version&&checks.every(check=>check.matchesBuild)};
console.log(JSON.stringify(result,null,2));
await writeFile(`work/portable-${manifest.version}-content-check.json`,JSON.stringify(result,null,2),'utf8');
if(!result.passed)process.exitCode=1;
