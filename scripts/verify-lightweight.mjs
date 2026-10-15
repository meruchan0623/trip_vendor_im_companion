import {readFile,readdir,stat} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(process.argv[2]??'release/TravelMerchantCompanion-0.4.0-lightweight-win-x64');
const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
if(manifest.electron!==false||manifest.kind!=='node-native-resident')throw new Error('PACKAGE_KIND_INVALID');
const actual=[];async function scan(dir){for(const name of await readdir(dir)){const path=join(dir,name);if((await stat(path)).isDirectory())await scan(path);else actual.push(relative(root,path).replaceAll('\\','/'));}}await scan(root);
if(actual.some(path=>!manifest.files.some(f=>f.path===path)&&path!=='manifest.json'))throw new Error('UNMANIFESTED_PACKAGE_FILE');
for(const file of manifest.files){if(!/^[\w./-]+$/.test(file.path)||file.path.split('/').includes('..'))throw new Error('INVALID_MANIFEST_PATH');const bytes=await readFile(join(root,file.path));if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('PACKAGE_HASH_MISMATCH');}
const sourceHash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
for(const [pkg,source] of [['host/main.cjs','dist-lightweight/host/main.cjs'],['TravelMerchant.Resident.exe','native/resident/bin/publish/TravelMerchant.Resident.exe']])if(manifest.files.find(f=>f.path===pkg)?.sha256!==await sourceHash(source))throw new Error('PACKAGE_BUILD_MISMATCH');
const meta=JSON.parse(await readFile('dist-lightweight/node-metafile.json','utf8'));
if(Object.keys(meta.inputs).some(path=>path.includes('node_modules/electron/')||/electron\/(main|preload|security)\.ts$/.test(path))||Object.values(meta.outputs).some(o=>o.imports.some(i=>!i.path.startsWith('node:'))))throw new Error('UNEXPECTED_RUNTIME_DEPENDENCY');
console.log(JSON.stringify({passed:true,root,version:manifest.version,nodeVersion:manifest.nodeVersion,files:actual.length,electron:false,buildHashesMatch:true}));
