import {describe,it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {hotUpdatePageBuild,validatePageBuild,inspectMacPageBuild} from '../scripts/lib/macos-page-build.mjs';

describe('macOS hot-update compatibility',()=>{
  it('pins both IM and navigation resources to one reviewed dist',()=>{
    const page=hotUpdatePageBuild('/Users/Test User/Library/Application Support/vbk-electron/dist');
    expect(validatePageBuild(page)).toBe(page);
    expect(page.aresVersion).toBe('1.2.16');
    expect(page.documentURL).toContain('Test%20User/Library/Application%20Support/');
    for(const mutation of [{aresVersion:'1.2.17'},{rendererSha256:'0'.repeat(64)},{navigationRendererURL:'file:///tmp/main.js'},{extra:true},{documentURL:page.documentURL+'?x'},{documentURL:page.documentURL.replace('/Users/','/tmp/../Users/') }]){
      expect(()=>validatePageBuild({...page,...mutation})).toThrow('INVALID_MACOS_PAGE_BUILD');
    }
  });
  it('uses the hot-update identity in browser and Node bundles without changing Windows',async()=>{
    const page=hotUpdatePageBuild('/Users/Test/Library/Application Support/vbk-electron/dist');
    for(const platform of ['darwin','win32']){
      const result=await build({entryPoints:['runtime/build-manifest.ts'],bundle:true,platform:'browser',format:'esm',write:false,define:{__TMC_RUNTIME_PLATFORM__:JSON.stringify(platform),__TMC_MACOS_PAGE_BUILD__:JSON.stringify(page)}});
      const module=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
      expect(module.VERIFIED_RUNTIME_BUILD.aresVersion).toBe(platform==='darwin'?'1.2.16':'1.2.14');
      if(platform==='darwin')expect(module.VERIFIED_RUNTIME_BUILD.documentURL).toBe(page.documentURL);
    }
  });
  it('rejects unknown versions and modified resources, preserves bundled fallback',async()=>{
    const home=await mkdtemp(join(tmpdir(),'tmc-hot-update-'));
    try{
      expect(await inspectMacPageBuild(home)).toBeUndefined();
      const dist=join(home,'Library/Application Support/vbk-electron/dist');await mkdir(dist,{recursive:true});
      const version=async(aresVersion)=>writeFile(join(dist,'packageVersion.json'),JSON.stringify({pkgVersion:'1.2.12',aresVersion}));
      await version('1.2.15');expect(await inspectMacPageBuild(home)).toBeUndefined();
      await version('1.2.17');await expect(inspectMacPageBuild(home)).rejects.toThrow('UNSUPPORTED_MACOS_HOT_UPDATE');
      await version('1.2.16');await mkdir(join(dist,'src/pages/imPlus'),{recursive:true});await writeFile(join(dist,'src/pages/imPlus/index.html'),'modified');
      await expect(inspectMacPageBuild(home)).rejects.toThrow('UNSUPPORTED_MACOS_HOT_UPDATE_HASH');
    }finally{await rm(home,{recursive:true,force:true});}
  });
});
