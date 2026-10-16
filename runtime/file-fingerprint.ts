import {open,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

/** Stream the real file, including .asar bytes, without retaining an archive-sized Buffer. */
export async function fingerprintFile(path:string):Promise<string>{
  const fs:Pick<typeof import('node:fs/promises'),'open'|'lstat'>=process.versions.electron?createRequire(process.execPath)('original-fs').promises:{open,lstat};
  const identity=(s:Awaited<ReturnType<typeof fs.lstat>>)=>`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  const pathBefore=await fs.lstat(path);if(!pathBefore.isFile()||pathBefore.isSymbolicLink())throw new Error('FINGERPRINT_FILE_UNVERIFIED');
  const file=await fs.open(path,'r');
  try{
    const before=await file.stat();if(identity(before)!==identity(pathBefore))throw new Error('FINGERPRINT_FILE_CHANGED');
    const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let position=0;
    while(position<before.size){const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,before.size-position),position);if(!bytesRead)throw new Error('FINGERPRINT_FILE_CHANGED');hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;}
    if(identity(before)!==identity(await file.stat())||identity(before)!==identity(await fs.lstat(path)))throw new Error('FINGERPRINT_FILE_CHANGED');
    return hash.digest('hex');
  }finally{await file.close();}
}
