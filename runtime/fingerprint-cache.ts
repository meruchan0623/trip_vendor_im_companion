import {lstat} from 'node:fs/promises';
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {createRequire} from 'node:module';
import {fingerprintFile} from './file-fingerprint';

/** Survives helper restarts: an entry is only reused while dev/ino/size/mtime/ctime/mode are identical. */
export interface FingerprintStore {get(key:string):string|undefined;set(key:string,value:string):void}
/** Small private JSON file; any read/parse failure simply means a cold cache. */
export function createFileFingerprintStore(file:string,limit=32):FingerprintStore{
  let entries:Record<string,string>|undefined;
  const load=()=>{
    if(entries)return entries;
    try{const value=JSON.parse(readFileSync(file,'utf8'));entries=value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).filter(([,hash])=>typeof hash==='string'&&/^[0-9a-f]{64}$/.test(hash))) as Record<string,string>:{};}
    catch{entries={};}
    return entries;
  };
  return{
    get:key=>load()[key],
    set:(key,value)=>{
      const current=load();current[key]=value;
      const keys=Object.keys(current);for(const stale of keys.slice(0,Math.max(0,keys.length-limit)))delete current[stale];
      try{mkdirSync(dirname(file),{recursive:true,mode:0o700});const temp=`${file}.${process.pid}.tmp`;writeFileSync(temp,JSON.stringify(current),{mode:0o600});renameSync(temp,file);}catch{/* Cache persistence is best effort. */}
    },
  };
}

/** One connection attempt rechecks identity repeatedly; only reuse hashes while file metadata is identical. */
export function createFingerprintCache(hash:(path:string)=>Promise<string>=fingerprintFile,store?:()=>FingerprintStore|undefined,namespace='sha256'){
  const fs:Pick<typeof import('node:fs/promises'),'lstat'>=process.versions.electron?createRequire(process.execPath)('original-fs').promises:{lstat};
  const entries=new Map<string,{identity:string;value:string}>();
  const inflight=new Map<string,Promise<string>>();
  async function identity(path:string){
    const value=await fs.lstat(path,{bigint:true});
    if(!value.isFile()||value.isSymbolicLink())throw new Error('FINGERPRINT_FILE_UNVERIFIED');
    return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}:${value.mode}`;
  }
  async function compute(path:string,before:string){
    const persisted=store?.(),key=`${namespace}\0${path}\0${before}`,saved=persisted?.get(key);
    const value=saved??await hash(path);
    if(before!==await identity(path))throw new Error('FINGERPRINT_FILE_CHANGED');
    if(entries.size>=16)entries.clear();
    entries.set(path,{identity:before,value});
    if(saved===undefined)persisted?.set(key,value);
    return value;
  }
  return async(path:string)=>{
    const before=await identity(path),cached=entries.get(path);
    if(cached?.identity===before)return cached.value;
    entries.delete(path);
    // Concurrent connection attempts share one read of a large archive instead of racing the vendor's own I/O.
    const flight=`${path}\0${before}`,running=inflight.get(flight);
    if(running)return running;
    const pending=compute(path,before).finally(()=>inflight.delete(flight));
    inflight.set(flight,pending);
    return pending;
  };
}
