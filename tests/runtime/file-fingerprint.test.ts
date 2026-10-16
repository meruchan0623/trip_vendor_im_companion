import {describe,it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fingerprintFile} from '../../runtime/file-fingerprint';
describe('bounded real file fingerprints',()=>{
  it('hashes an archive across chunk boundaries and handles empty files',async()=>{
    const root=await mkdtemp(join(tmpdir(),'tsim-hash-'));
    try{const data=Buffer.alloc(2*1024*1024+193123,47),path=join(root,'app.asar');await writeFile(path,data);expect(await fingerprintFile(path)).toBe(createHash('sha256').update(data).digest('hex'));await writeFile(path,'');expect(await fingerprintFile(path)).toBe(createHash('sha256').digest('hex'));}finally{await rm(root,{recursive:true,force:true});}
  });
  it('rejects directories and missing files',async()=>{await expect(fingerprintFile(tmpdir())).rejects.toThrow();await expect(fingerprintFile(join(tmpdir(),'missing-tsim-fingerprint-file'))).rejects.toThrow();});
});
