import{lstat}from'node:fs/promises';
import{createRequire}from'node:module';
/** Raw archive metadata is required under Electron, whose normal fs treats .asar as a directory. */
async function fileIdentity(path:string):Promise<string>{
  const fs:Pick<typeof import('node:fs/promises'),'lstat'>=process.versions.electron?createRequire(process.execPath)('original-fs').promises:{lstat};
  const value=await fs.lstat(path,{bigint:true});
  if(value.isSymbolicLink()||!value.isFile()&&!value.isDirectory())throw new Error('VERIFIED_FILE_UNAVAILABLE');
  return`${value.isFile()?'f':'d'}:${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}:${value.mode}`;
}
/** A connection-local record of metadata captured around successful full byte/ACL verification. */
export class VerifiedFiles {
  private identities=new Map<string,string>();
  constructor(private identify:(path:string)=>Promise<string>=fileIdentity){}
  get paths():readonly string[]{return[...this.identities.keys()];}
  async verify<T>(path:string,operation:()=>Promise<T>):Promise<T>{return this.verifyMany([path],operation);}
  async verifyMany<T>(paths:readonly string[],operation:()=>Promise<T>):Promise<T>{
    const before=await Promise.all(paths.map(path=>this.identify(path)));
    paths.forEach((path,index)=>{const previous=this.identities.get(path);if(previous!==undefined&&previous!==before[index])throw new Error('VERIFIED_FILE_CHANGED');});
    const result=await operation(),after=await Promise.all(paths.map(path=>this.identify(path)));
    if(before.some((identity,index)=>identity!==after[index]))throw new Error('VERIFIED_FILE_CHANGED');
    paths.forEach((path,index)=>this.identities.set(path,before[index]));return result;
  }
  async assertUnchanged():Promise<void>{
    if(!this.identities.size)throw new Error('VERIFIED_FILES_REQUIRED');
    await Promise.all([...this.identities].map(async([path,expected])=>{if(await this.identify(path)!==expected)throw new Error('VERIFIED_FILE_CHANGED');}));
  }
}
