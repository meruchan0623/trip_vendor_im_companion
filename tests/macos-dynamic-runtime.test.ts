import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {posix,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {inspectMacDynamicPages,type MacDynamicPageFiles} from '../runtime/macos-pages';
import {MACOS_BUNDLED_DIST,MACOS_EXECUTABLE,MACOS_MANIFEST_PATH,MACOS_PAGE_BUILDS,validateMacRuntimeManifest,type MacRuntimeManifest} from '../runtime/macos-page-compatibility.mjs';
import {IM_CONTRACT,NAVIGATION_CONTRACT} from '../runtime/windows-compatibility.mjs';
import {MACOS_DYNAMIC_RUNTIME,activateMacPageBuild,validateMacRuntimeBuild,VERIFIED_RUNTIME_BUILD} from '../runtime/build-manifest';
import {mountRuntimeUi} from '../runtime/runtime-ui';

const sha=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex');
const html=(script:string)=>`<!doctype html><html><head><script type="module" crossorigin src="../../../js/${script}"></script></head><body><div id="root"></div></body></html>`;
interface PageFixture {pkg:string;ares:string;renderer:string;navigation:string;im:string;nav:string}
const page=(ares:string,extra:Partial<PageFixture>={}):PageFixture=>({pkg:'1.2.11',ares,renderer:`imWindow-A${ares.replaceAll('.','')}.js`,navigation:`mainWindow-B${ares.replaceAll('.','')}.js`,im:'/*im*/'+IM_CONTRACT.join(';'),nav:'/*nav*/'+NAVIGATION_CONTRACT.join(';'),...extra});
async function writeDist(dist:string,value:PageFixture){
  const files:[string,string][]=[['packageVersion.json',JSON.stringify({pkgVersion:value.pkg,aresVersion:value.ares})],['src/pages/imPlus/index.html',html(value.renderer)],['src/pages/main/index.html',html(value.navigation)],['js/'+value.renderer,value.im],['js/'+value.navigation,value.nav]];
  for(const [relative,text] of files){await mkdir(posix.dirname(posix.join(dist,relative)),{recursive:true});await writeFile(posix.join(dist,relative),text);}
  return{packageVersion:value.pkg,aresVersion:value.ares,rendererName:value.renderer,navigationRendererName:value.navigation,htmlSha256:sha(html(value.renderer)),rendererSha256:sha(value.im),navigationHtmlSha256:sha(html(value.navigation)),navigationRendererSha256:sha(value.nav)};
}
/** Maps the fixed installed paths into a temporary fixture; everything else reads the real path. */
function mapped(bundled:string,manifest:string):MacDynamicPageFiles{
  const map=(path:string)=>path===MACOS_MANIFEST_PATH?manifest:path.startsWith(MACOS_BUNDLED_DIST+'/')?posix.join(bundled,path.slice(MACOS_BUNDLED_DIST.length+1)):path;
  const read=async(path:string,maxBytes:number)=>{const bytes=await readFile(map(path));if(bytes.length>maxBytes)throw new Error('MACOS_RESOURCE_SIZE_REJECTED');return bytes;};
  return{isDirectory:async()=>true,version:async path=>JSON.parse((await read(path,16000)).toString('utf8')),hash:async(path,maxBytes)=>sha(await read(path,maxBytes)),read,assertUnchanged:async()=>{}};
}
async function fixture(run:(root:string,home:string)=>Promise<void>){
  const temporary=await mkdtemp(join(tmpdir(),'macos-dynamic-')),root=await realpath(temporary);
  try{await run(root,posix.join(root,'home'));}finally{await rm(temporary,{recursive:true,force:true});}
}
const manifestFor=(bundledPage:MacRuntimeManifest['bundledPage'],version='1.2.11'):MacRuntimeManifest=>({schemaVersion:1,executable:MACOS_EXECUTABLE,executableVersion:version,executableSha256:'a'.repeat(64),asarSha256:'b'.repeat(64),chromiumMajor:118,bundledPage});

test('dynamic build flag is compiled into this suite',()=>{assert.equal(MACOS_DYNAMIC_RUNTIME,true);});

test('installer manifest accepts 1.2.11+ and binds the fixed executable and package version',()=>{
  const bundledPage={packageVersion:'1.2.11',aresVersion:'1.2.14',rendererName:'imWindow-x.js',navigationRendererName:'mainWindow-y.js',htmlSha256:'1'.repeat(64),rendererSha256:'2'.repeat(64),navigationHtmlSha256:'3'.repeat(64),navigationRendererSha256:'4'.repeat(64)};
  for(const version of ['1.2.11','1.2.12','1.3.0','2.0.0'])assert.ok(validateMacRuntimeManifest(manifestFor({...bundledPage,packageVersion:version},version)));
  assert.ok(validateMacRuntimeManifest(manifestFor(bundledPage,'1.2.11.2679')));
  assert.throws(()=>validateMacRuntimeManifest(manifestFor({...bundledPage,packageVersion:'1.2.10'},'1.2.10')),/INVALID_MACOS_PAGE_MANIFEST|INVALID_MACOS_RUNTIME_MANIFEST/);
  assert.throws(()=>validateMacRuntimeManifest(manifestFor(bundledPage,'1.2.12')),/MACOS_PACKAGE_VERSION_MISMATCH/);
  assert.throws(()=>validateMacRuntimeManifest({...manifestFor(bundledPage),executable:'/Applications/Other.app/Contents/MacOS/旅游商家桌面版'}),/INVALID_MACOS_RUNTIME_MANIFEST/);
  assert.throws(()=>validateMacRuntimeManifest({...manifestFor(bundledPage),chromiumMajor:108}),/INVALID_MACOS_RUNTIME_MANIFEST/);
  assert.throws(()=>validateMacRuntimeManifest({...manifestFor(bundledPage),extra:true}),/INVALID_MACOS_RUNTIME_MANIFEST/);
});

test('unknown bundled page names are probed and newer current-user pages win like the vendor',()=>fixture(async(root,home)=>{
  const bundledPage=await writeDist(posix.join(root,'bundled'),page('1.2.14')),manifest=posix.join(root,'manifest.json');
  await writeFile(manifest,JSON.stringify(manifestFor(bundledPage)));
  const files=mapped(posix.join(root,'bundled'),manifest),userDist=posix.join(home,'Library/Application Support/vbk-electron/dist');
  const fresh=await inspectMacDynamicPages(home,files);
  assert.equal(fresh.dist,MACOS_BUNDLED_DIST);assert.equal(fresh.build.rendererName,bundledPage.rendererName);assert.equal(fresh.build.executableVersion,'1.2.11');
  assert.deepEqual(validateMacRuntimeBuild(fresh.build),fresh.build);activateMacPageBuild(fresh.build);assert.equal(VERIFIED_RUNTIME_BUILD.documentURL,fresh.build.documentURL);
  await writeDist(userDist,page('1.2.13'));
  assert.equal((await inspectMacDynamicPages(home,files)).dist,MACOS_BUNDLED_DIST,'older user pages are ignored');
  await rm(userDist,{recursive:true});const newer=await writeDist(userDist,page('1.2.16'));
  const selected=await inspectMacDynamicPages(home,files);
  assert.equal(selected.dist,userDist);assert.equal(selected.build.htmlSha256,newer.htmlSha256);
  assert.ok(decodeURIComponent(new URL(selected.build.documentURL).pathname).startsWith(home+'/Library/'));
  assert.deepEqual(validateMacRuntimeBuild(selected.build),selected.build);
}));

test('bundled drift, broken contracts and foreign packages fail closed',()=>fixture(async(root,home)=>{
  const bundled=posix.join(root,'bundled'),manifest=posix.join(root,'manifest.json'),files=mapped(bundled,manifest);
  const bundledPage=await writeDist(bundled,page('1.2.14'));
  await writeFile(manifest,JSON.stringify(manifestFor({...bundledPage,rendererSha256:'0'.repeat(64)})));
  await assert.rejects(inspectMacDynamicPages(home,files),/UNSUPPORTED_MACOS_BUNDLED_BUILD/);
  await writeFile(manifest,JSON.stringify(manifestFor(bundledPage)));
  await writeDist(bundled,page('1.2.14',{im:'chat-editor only'}));
  await assert.rejects(inspectMacDynamicPages(home,files),/UNSUPPORTED_MACOS_RENDERER_CONTRACT/);
  await writeDist(bundled,page('1.2.14'));
  await writeDist(posix.join(home,'Library/Application Support/vbk-electron/dist'),page('1.2.16',{pkg:'1.2.12'}));
  await assert.rejects(inspectMacDynamicPages(home,files),/MACOS_PACKAGE_VERSION_MISMATCH/);
  await writeFile(manifest,'{"schemaVersion":1}');
  await assert.rejects(inspectMacDynamicPages(home,files),/INVALID_MACOS_RUNTIME_MANIFEST/);
  await rm(manifest);await assert.rejects(inspectMacDynamicPages(home,files),/INVALID_MACOS_RUNTIME_MANIFEST/);
}));

test('renderer accepts only an exact dynamic reconstruction',()=>fixture(async(root,home)=>{
  const bundledPage=await writeDist(posix.join(root,'bundled'),page('1.2.14')),manifest=posix.join(root,'manifest.json');
  await writeFile(manifest,JSON.stringify(manifestFor(bundledPage)));
  const {build}=await inspectMacDynamicPages(home,mapped(posix.join(root,'bundled'),manifest));
  for(const key of ['executable','executableVersion','aresVersion','htmlSha256','rendererSha256','documentURL','rendererURL','navigationURL','navigationRendererURL'] as const)assert.throws(()=>validateMacRuntimeBuild({...build,[key]:'tampered'}));
  assert.throws(()=>validateMacRuntimeBuild({...build,documentURL:pathToFileURL('/tmp/unapproved/dist/src/pages/imPlus/index.html').href}));
  const document={defaultView:{location:new URL(build.documentURL)},visibilityState:'visible',scripts:[]} as unknown as Document;
  const metadata={leaseId:'a'.repeat(32),aresVersion:build.aresVersion,htmlSha256:build.htmlSha256,rendererSha256:build.rendererSha256,keyboardBoundary:'isolated-world-shadow' as const,macBuild:build};
  assert.throws(()=>mountRuntimeUi(metadata,document),/UNAPPROVED_RENDERER/);
  assert.throws(()=>mountRuntimeUi({...metadata,macBuild:{...build,executableSha256:'0'.repeat(63)}},document),/UNAPPROVED_METADATA/);
}));

// TMC_OFFICIAL_APP may also be an installer dry-run stage: its recorded manifest is then used as is.
test('real client pages probe to the reviewed 1.2.12 hashes or the installer-recorded identity',{skip:!process.env.TMC_OFFICIAL_APP},()=>fixture(async(root,home)=>{
  const app=process.env.TMC_OFFICIAL_APP!,recorded=posix.join(app,'Contents/Resources/companion/vendor-runtime-manifest.json'),reviewed=MACOS_PAGE_BUILDS[0],dist=posix.join(app,'Contents/Resources/app.asar.unpacked/dist');
  let manifest=recorded;
  try{await readFile(recorded);}catch{manifest=posix.join(root,'manifest.json');await writeFile(manifest,JSON.stringify(manifestFor({...reviewed},reviewed.packageVersion)));}
  const {build}=await inspectMacDynamicPages(home,mapped(dist,manifest));
  assert.deepEqual(validateMacRuntimeBuild(build),build);
  if(build.packageVersion===reviewed.packageVersion&&build.aresVersion===reviewed.aresVersion){assert.equal(build.rendererName,reviewed.rendererName);assert.equal(build.navigationRendererSha256,reviewed.navigationRendererSha256);}
}));
