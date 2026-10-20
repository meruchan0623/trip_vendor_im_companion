import {readFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {posix} from 'node:path';
import {pathToFileURL} from 'node:url';
import {MACOS_BUNDLED_DIST,MACOS_PAGE_BUILDS} from './macos-page-compatibility.mjs';
import {macRuntimePageBuild} from './build-manifest';
import {VerifiedFiles} from './verified-files';

export interface MacPageFiles {
  isDirectory(path:string):Promise<boolean>;
  version(path:string):Promise<unknown>;
  hash(path:string,maxBytes:number):Promise<string>;
  assertUnchanged?():Promise<void>;
}
const ancestors=(path:string)=>{const result:string[]=[];for(let at=path;at!=='/';at=posix.dirname(at))result.push(at);return result.reverse();};
async function noRedirect(path:string){for(const item of ancestors(path))if((await lstat(item)).isSymbolicLink())throw new Error('MACOS_RESOURCE_REDIRECTION');}
function nativeFiles():MacPageFiles{
  const files=new VerifiedFiles();
  const read=async(path:string,maxBytes:number)=>files.verify(path,async()=>{
    await noRedirect(path);const before=await lstat(path);
    if(!before.isFile()||before.size>maxBytes)throw new Error('MACOS_RESOURCE_SIZE_REJECTED');
    const bytes=await readFile(path),after=await lstat(path);
    if(bytes.length>maxBytes||bytes.length!==before.size||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('MACOS_RESOURCE_CHANGED_DURING_READ');
    await noRedirect(path);return bytes;
  });
  return{
    async isDirectory(path){
      try{const value=await lstat(path);if(!value.isDirectory()||value.isSymbolicLink())throw new Error('MACOS_RESOURCE_REDIRECTION');await files.verifyMany(ancestors(path),()=>noRedirect(path));return true;}
      catch(error){if((error as NodeJS.ErrnoException)?.code==='ENOENT')return false;throw error;}
    },
    async version(path){try{return JSON.parse((await read(path,16000)).toString('utf8'));}catch(error){if(error instanceof SyntaxError)throw new Error('UNSUPPORTED_MACOS_PAGE_VERSION');throw error;}},
    async hash(path,maxBytes){return createHash('sha256').update(await read(path,maxBytes)).digest('hex');},
    assertUnchanged:()=>files.assertUnchanged(),
  };
}
/** Current-user update wins only after complete verification. No update directory means bundled pages. */
export async function inspectMacPages(home=homedir(),files:MacPageFiles=nativeFiles()){
  if(!posix.isAbsolute(home)||home==='/'||posix.normalize(home)!==home||home.includes('\\')||home.includes('\0'))throw new Error('MACOS_HOME_UNAVAILABLE');
  const userDist=posix.join(home,'Library/Application Support/vbk-electron/dist');
  const dist=await files.isDirectory(userDist)?userDist:MACOS_BUNDLED_DIST;
  if(dist===MACOS_BUNDLED_DIST&&!await files.isDirectory(dist))throw new Error('MACOS_BUNDLED_PAGES_UNAVAILABLE');
  const version=await files.version(posix.join(dist,'packageVersion.json')) as {pkgVersion?:unknown;aresVersion?:unknown}|null;
  const page=MACOS_PAGE_BUILDS.find(page=>version?.pkgVersion===page.packageVersion&&version?.aresVersion===page.aresVersion);
  if(!page)throw new Error('UNSUPPORTED_MACOS_PAGE_VERSION');
  const entries=[['src/pages/imPlus/index.html',page.htmlSha256,20000],['js/'+page.rendererName,page.rendererSha256,8_000_000],['src/pages/main/index.html',page.navigationHtmlSha256,20000],['js/'+page.navigationRendererName,page.navigationRendererSha256,200_000]] as const;
  await Promise.all(entries.map(async([relative,expected,maxBytes])=>{if(await files.hash(posix.join(dist,relative),maxBytes)!==expected)throw new Error('UNSUPPORTED_MACOS_PAGE_HASH');}));
  await files.assertUnchanged?.();
  return{dist,build:macRuntimePageBuild(page.aresVersion,pathToFileURL(dist+'/').href),assertUnchanged:()=>files.assertUnchanged?.()??Promise.resolve()};
}
