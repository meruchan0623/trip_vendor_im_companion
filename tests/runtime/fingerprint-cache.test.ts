import {describe,it,expect,vi} from 'vitest';
import {mkdtemp,writeFile,rm,symlink,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fingerprintFile} from '../../runtime/file-fingerprint';
import {createFingerprintCache} from '../../runtime/fingerprint-cache';
describe('connection-scoped fingerprint cache',()=>{
  it('reuses unchanged files, rehashes replacements and rejects symlinks',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'tmc-cache-')),path=join(dir,'app.asar');
    try{
      await writeFile(path,'one');const hash=vi.fn(fingerprintFile),cached=createFingerprintCache(hash);
      const first=await cached(path);expect(await cached(path)).toBe(first);expect(hash).toHaveBeenCalledTimes(1);
      await writeFile(join(dir,'new'),'two');await rename(join(dir,'new'),path);
      expect(await cached(path)).not.toBe(first);expect(hash).toHaveBeenCalledTimes(2);
      await rename(path,join(dir,'real'));await symlink(join(dir,'real'),path);
      await expect(cached(path)).rejects.toThrow('FINGERPRINT_FILE_UNVERIFIED');
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it('does not cache a file changed during hashing or a failed read',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'tmc-cache-')),path=join(dir,'file');
    try{
      await writeFile(path,'before');const hash=vi.fn(async()=>{await writeFile(path,'after');return 'hash'}),cached=createFingerprintCache(hash);
      await expect(cached(path)).rejects.toThrow('FINGERPRINT_FILE_CHANGED');
      hash.mockRejectedValueOnce(new Error('read failed'));await expect(cached(path)).rejects.toThrow('read failed');
      hash.mockResolvedValue('stable');expect(await cached(path)).toBe('stable');expect(hash).toHaveBeenCalledTimes(3);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
});
