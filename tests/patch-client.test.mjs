import{describe,it,expect,beforeEach,afterEach}from'vitest';
import{promises as fs}from'node:fs';import{resolve,join,dirname}from'node:path';
import{prepare,apply,rollback,HTML,ASSET,hashFile,VERIFIED,confined}from'../embedded-shell/patch-plan.mjs';
import{assertClientIdle}from'../embedded-shell/live-gate.mjs';
let root,client,bundle,assets;
beforeEach(async()=>{
  await fs.mkdir(resolve('work/patch-tests'),{recursive:true});root=await fs.mkdtemp(resolve('work/patch-tests/run-'));client=join(root,'client');bundle=join(root,'bundle');assets=join(root,'assets');
  await fs.mkdir(client,{recursive:true});await fs.mkdir(assets);await fs.writeFile(join(assets,'companion.js'),'/* only fixture owned UI */\nconsole.log("test bundle");'.repeat(3));
  const source=resolve('work/client-investigation/current-source');
  for(const file of [HTML,'js/imWindow-9Tos9blK.js','packageVersion.json']){await fs.mkdir(dirname(join(client,file)),{recursive:true});await fs.copyFile(join(source,file),join(client,file));}
  await fs.writeFile(join(client,'customer-data-sentinel.txt'),'UNCHANGED');
});
describe('fail-closed live process check',()=>{
  it('accepts only a positively verified zero process count',()=>{expect(()=>assertClientIdle(()=> 'tmc-process-check-v1:0\r\n')).not.toThrow();expect(()=>assertClientIdle(()=> 'tmc-process-check-v1:1')).toThrow('running');});
  it('rejects query errors and malformed output instead of accepting a fallback zero',()=>{for(const output of ['0','','query failed\n0','tmc-process-check-v1:NaN'])expect(()=>assertClientIdle(()=>output)).toThrow('refused');expect(()=>assertClientIdle(()=>{throw new Error('CIM failed');})).toThrow('refused');});
  it('requires terminating errors and rejects missing candidate executable paths',()=>{assertClientIdle((_exe,args)=>{expect(args[2]).toContain("$ErrorActionPreference='Stop'");expect(args[2]).toContain('Get-CimInstance Win32_Process -ErrorAction Stop');expect(args[2]).toContain('IsNullOrWhiteSpace($_.ExecutablePath)');return 'tmc-process-check-v1:0';});});
});
afterEach(async()=>{ /* Keep test copies as evidence; no live client directory is ever mutated. */ });
describe('guarded HTML-only client patch transaction on copies',()=>{
  it('prepares a reviewable copy then applies and restores byte-identical original',async()=>{
    const manifest=await prepare({clientRoot:client,bundleRoot:assets,out:bundle});expect(manifest.features.customerSend).toBe(false);expect(await hashFile(join(client,HTML))).toBe(VERIFIED.html);
    await apply({bundle,targetRoot:client});expect(await fs.readFile(join(client,HTML),'utf8')).toContain('data-tmc-patch="1.0"');expect(await fs.readFile(join(client,'customer-data-sentinel.txt'),'utf8')).toBe('UNCHANGED');
    await rollback({bundle,targetRoot:client});expect(await hashFile(join(client,HTML))).toBe(VERIFIED.html);await expect(fs.access(join(client,ASSET))).rejects.toThrow();expect(await fs.readFile(join(client,'customer-data-sentinel.txt'),'utf8')).toBe('UNCHANGED');
  });
  it('refuses source version/hash drift and output under the source tree',async()=>{
    await expect(prepare({clientRoot:client,bundleRoot:assets,out:join(client,'patch')})).rejects.toThrow('outside');
    await fs.appendFile(join(client,'js/imWindow-9Tos9blK.js'),'\n');await expect(prepare({clientRoot:client,bundleRoot:assets,out:bundle})).rejects.toThrow('hash drift');
  });
  it('refuses hot update between review and apply',async()=>{await prepare({clientRoot:client,bundleRoot:assets,out:bundle});await fs.appendFile(join(client,HTML),'\n');await expect(apply({bundle,targetRoot:client})).rejects.toThrow('hash drift');await expect(fs.access(join(client,ASSET))).rejects.toThrow();});
  it('refuses to overwrite a drifted document during rollback',async()=>{await prepare({clientRoot:client,bundleRoot:assets,out:bundle});await apply({bundle,targetRoot:client});await fs.appendFile(join(client,HTML),'\nnew update');await expect(rollback({bundle,targetRoot:client})).rejects.toThrow('rollback refused');expect(await fs.readFile(join(client,HTML),'utf8')).toContain('new update');});
  it('rejects malformed traversal manifest and colliding owned asset',async()=>{await prepare({clientRoot:client,bundleRoot:assets,out:bundle});const m=JSON.parse(await fs.readFile(join(bundle,'manifest.json'),'utf8'));m.changes[1].path='../credentials';await fs.writeFile(join(bundle,'manifest.json'),JSON.stringify(m));await expect(apply({bundle,targetRoot:client})).rejects.toThrow('Unsupported manifest');await expect(confined(client,'../outside')).rejects.toThrow('escapes');});
  it('refuses tampered staged bundle or backup before mutating HTML',async()=>{await prepare({clientRoot:client,bundleRoot:assets,out:bundle});await fs.appendFile(join(bundle,'staged',ASSET),'tamper');await expect(apply({bundle,targetRoot:client})).rejects.toThrow('Staged digest');expect(await hashFile(join(client,HTML))).toBe(VERIFIED.html);});
  it('rejects a review destination under an external junction pointing into the client',async()=>{
    const alias=join(root,'outside-client-alias');await fs.symlink(client,alias,'junction');
    await expect(prepare({clientRoot:client,bundleRoot:assets,out:join(alias,'review-package')})).rejects.toThrow('outside');
    await expect(fs.access(join(client,'review-package'))).rejects.toThrow();expect(await hashFile(join(client,HTML))).toBe(VERIFIED.html);
  });
  it('recovers a hard interruption after the owned asset write and supports idempotent rollback',async()=>{
    await prepare({clientRoot:client,bundleRoot:assets,out:bundle});await fs.mkdir(dirname(join(client,ASSET)),{recursive:true});await fs.copyFile(join(bundle,'staged',ASSET),join(client,ASSET));
    expect(await hashFile(join(client,HTML))).toBe(VERIFIED.html);await rollback({bundle,targetRoot:client});await expect(fs.access(join(client,ASSET))).rejects.toThrow();expect(await hashFile(join(client,HTML))).toBe(VERIFIED.html);
    await rollback({bundle,targetRoot:client});expect(await fs.readFile(join(client,'customer-data-sentinel.txt'),'utf8')).toBe('UNCHANGED');
  });
  it('recovers patched HTML whose owned asset is missing, and refuses unknown asset content',async()=>{
    await prepare({clientRoot:client,bundleRoot:assets,out:bundle});await apply({bundle,targetRoot:client});await fs.unlink(join(client,ASSET));await rollback({bundle,targetRoot:client});expect(await hashFile(join(client,HTML))).toBe(VERIFIED.html);
    await fs.writeFile(join(client,ASSET),'UNKNOWN USER CONTENT');await expect(rollback({bundle,targetRoot:client})).rejects.toThrow('rollback refused');expect(await fs.readFile(join(client,ASSET),'utf8')).toBe('UNKNOWN USER CONTENT');
  });
});
