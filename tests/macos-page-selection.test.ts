import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {posix,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {inspectMacPages,type MacPageFiles} from '../runtime/macos-pages';
import {MACOS_BUNDLED_DIST,MACOS_PAGE_BUILDS,macPageBuild,validateMacPageBuild} from '../runtime/macos-page-compatibility.mjs';
import {macRuntimePageBuild,activateMacPageBuild,validateMacRuntimeBuild,VERIFIED_RUNTIME_BUILD} from '../runtime/build-manifest';
import {mountRuntimeUi} from '../runtime/runtime-ui';

function fixture(home:string,version='1.2.16',userExists=true,drift?:number){
  const user=posix.join(home,'Library/Application Support/vbk-electron/dist'),selected=userExists?user:MACOS_BUNDLED_DIST;
  const page=MACOS_PAGE_BUILDS.find(page=>page.aresVersion===version)??MACOS_PAGE_BUILDS[0];
  const expected=new Map([['src/pages/imPlus/index.html',page.htmlSha256],['js/'+page.rendererName,page.rendererSha256],['src/pages/main/index.html',page.navigationHtmlSha256],['js/'+page.navigationRendererName,page.navigationRendererSha256]].map(([relative,hash])=>[posix.join(selected,relative),hash]));
  const hashed:string[]=[];let checks=0;
  const files:MacPageFiles={
    isDirectory:async path=>{assert.ok(path===user||path===MACOS_BUNDLED_DIST);return path===user?userExists:true;},
    version:async path=>{assert.equal(path,posix.join(selected,'packageVersion.json'));return{pkgVersion:'1.2.12',aresVersion:version};},
    hash:async path=>{assert.ok(expected.has(path));hashed.push(path);return hashed.length-1===drift?'0'.repeat(64):expected.get(path)!;},
    assertUnchanged:async()=>{checks++;},
  };
  return{files,selected,hashed,checks:()=>checks};
}

test('clean user data selects the fixed bundled 1.2.15 and verifies all four resources',async()=>{
  const sample=fixture('/Users/fresh','1.2.15',false),selected=await inspectMacPages('/Users/fresh',sample.files);
  assert.equal(selected.dist,MACOS_BUNDLED_DIST);assert.equal(selected.build.aresVersion,'1.2.15');assert.equal(sample.hashed.length,4);assert.equal(sample.checks(),1);
  activateMacPageBuild(selected.build);assert.equal(VERIFIED_RUNTIME_BUILD.documentURL,selected.build.documentURL);
});

test('retained user 1.2.16 and user 1.2.15 keep the verified current-user root',async()=>{
  for(const version of ['1.2.15','1.2.16'])for(const home of ['/Users/alice','/Users/bob','/Users/用户 空间']){
    const sample=fixture(home,version),selected=await inspectMacPages(home,sample.files);
    assert.equal(selected.dist,sample.selected);assert.equal(selected.build.aresVersion,version);assert.equal(sample.hashed.length,4);
    assert.ok(decodeURIComponent(new URL(selected.build.documentURL).pathname).startsWith(home+'/Library/'));
    assert.deepEqual(validateMacRuntimeBuild(selected.build),selected.build);
    activateMacPageBuild(selected.build);assert.equal(VERIFIED_RUNTIME_BUILD.documentURL,selected.build.documentURL);
  }
});

test('unknown versions and drift in any of the four files fail without bundled fallback',async()=>{
  const unknown=fixture('/Users/test','1.2.99');await assert.rejects(inspectMacPages('/Users/test',unknown.files),/UNSUPPORTED_MACOS_PAGE_VERSION/);assert.equal(unknown.hashed.length,0);
  for(let drift=0;drift<4;drift++)await assert.rejects(inspectMacPages('/Users/test',fixture('/Users/test','1.2.16',true,drift).files),/UNSUPPORTED_MACOS_PAGE_HASH/);
});

test('renderer rebuild validates exact approved URL, manifest fields and macBuild metadata',()=>{
  const root=pathToFileURL('/Users/current/Library/Application Support/vbk-electron/dist/').href,build=macRuntimePageBuild('1.2.16',root);
  const page=macPageBuild('1.2.16',root);assert.deepEqual(validateMacPageBuild(page),page);
  for(const key of ['executable','aresVersion','htmlSha256','rendererSha256','navigationHtmlSha256','navigationRendererSha256','documentURL','rendererURL','navigationURL','navigationRendererURL'])assert.throws(()=>validateMacRuntimeBuild({...build,[key]:'tampered'}));
  assert.throws(()=>macRuntimePageBuild('1.2.16','file:///tmp/unapproved/dist/'));
  assert.throws(()=>macRuntimePageBuild('1.2.16',root+'?unapproved'));
  const document={defaultView:{location:new URL(build.documentURL)},visibilityState:'visible',scripts:[]} as unknown as Document;
  const metadata={leaseId:'a'.repeat(32),aresVersion:build.aresVersion,htmlSha256:build.htmlSha256,rendererSha256:build.rendererSha256,keyboardBoundary:'isolated-world-shadow' as const,macBuild:build};
  // No browser is used: reaching the script check demonstrates accepted metadata/document identity.
  assert.throws(()=>mountRuntimeUi(metadata,document),/UNAPPROVED_RENDERER/);
  assert.throws(()=>mountRuntimeUi({...metadata,macBuild:{...build,htmlSha256:'0'.repeat(64)}},document),/UNAPPROVED_METADATA/);
  assert.throws(()=>mountRuntimeUi({...metadata,macBuild:undefined},document),/UNAPPROVED_METADATA/);
});

test('native reader rejects real fixture byte drift and missing user metadata',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'macos-page-bytes-')),home=await realpath(temporary),dist=posix.join(home,'Library/Application Support/vbk-electron/dist');
  try{
    await mkdir(dist,{recursive:true});await assert.rejects(inspectMacPages(home),{code:'ENOENT'});
    await writeFile(posix.join(dist,'packageVersion.json'),JSON.stringify({pkgVersion:'1.2.12',aresVersion:'1.2.15'}));
    const page=MACOS_PAGE_BUILDS[0];
    for(const relative of ['src/pages/imPlus/index.html','src/pages/main/index.html','js/'+page.rendererName,'js/'+page.navigationRendererName]){const file=posix.join(dist,relative);await mkdir(posix.dirname(file),{recursive:true});await writeFile(file,'fixture bytes deliberately differ from reviewed vendor bytes');}
    await assert.rejects(inspectMacPages(home),/UNSUPPORTED_MACOS_PAGE_HASH/);
  }finally{await rm(temporary,{recursive:true,force:true});}
});
