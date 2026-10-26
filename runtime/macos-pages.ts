import {readFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {posix} from 'node:path';
import {pathToFileURL} from 'node:url';
import {MACOS_BUNDLED_DIST,MACOS_MANIFEST_PATH,MACOS_PAGE_BUILDS,compareMacAres,macRendererName,assertMacRendererContract,validateMacPage,validateMacRuntimeManifest,type MacPageManifest} from './macos-page-compatibility.mjs';
import {macRuntimePageBuild,macRuntimeBuild} from './build-manifest';
import {VerifiedFiles} from './verified-files';

export interface MacPageFiles {
  isDirectory(path:string):Promise<boolean>;
  version(path:string):Promise<unknown>;
  hash(path:string,maxBytes:number):Promise<string>;
  assertUnchanged?():Promise<void>;
}
export interface MacDynamicPageFiles extends MacPageFiles {read(path:string,maxBytes:number):Promise<Buffer>}
const ancestors=(path:string)=>{const result:string[]=[];for(let at=path;at!=='/';at=posix.dirname(at))result.push(at);return result.reverse();};
async function noRedirect(path:string){for(const item of ancestors(path))if((await lstat(item)).isSymbolicLink())throw new Error('MACOS_RESOURCE_REDIRECTION');}
function nativeFiles():MacDynamicPageFiles{
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
    read,
    assertUnchanged:()=>files.assertUnchanged(),
  };
}
function userDistOf(home:string){
  if(!posix.isAbsolute(home)||home==='/'||posix.normalize(home)!==home||home.includes('\\')||home.includes('\0'))throw new Error('MACOS_HOME_UNAVAILABLE');
  return posix.join(home,'Library/Application Support/vbk-electron/dist');
}
/** Current-user update wins only after complete verification. No update directory means bundled pages. */
export async function inspectMacPages(home=homedir(),files:MacPageFiles=nativeFiles()){
  const userDist=userDistOf(home);
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
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
/** Reads only the two fixed HTML documents and their single relative module entrypoints. */
async function probeMacPages(folder:string,packageVersion:string,files:MacDynamicPageFiles):Promise<MacPageManifest>{
  const version=await files.version(posix.join(folder,'packageVersion.json')) as {pkgVersion?:unknown;aresVersion?:unknown}|null;
  if(!version||version.pkgVersion!==packageVersion||typeof version.aresVersion!=='string')throw new Error('MACOS_PACKAGE_VERSION_MISMATCH');
  const [html,navHtml]=await Promise.all([files.read(posix.join(folder,'src/pages/imPlus/index.html'),20000),files.read(posix.join(folder,'src/pages/main/index.html'),20000)]);
  const rendererName=macRendererName(html.toString('utf8'),'imWindow'),navigationRendererName=macRendererName(navHtml.toString('utf8'),'mainWindow');
  const [renderer,navRenderer]=await Promise.all([files.read(posix.join(folder,'js',rendererName),8_000_000),files.read(posix.join(folder,'js',navigationRendererName),200_000)]);
  assertMacRendererContract(renderer.toString('utf8'),navRenderer.toString('utf8'));
  return validateMacPage({packageVersion,aresVersion:version.aresVersion,rendererName,navigationRendererName,htmlSha256:digest(html),rendererSha256:digest(renderer),navigationHtmlSha256:digest(navHtml),navigationRendererSha256:digest(navRenderer)});
}
/** Installer-recorded client: mirrors the vendor isUserPath (a newer current-user aresVersion wins) and
 * probes unknown compatible page names instead of trusting a reviewed hash list. */
export async function inspectMacDynamicPages(home=homedir(),files:MacDynamicPageFiles=nativeFiles()){
  const userDist=userDistOf(home);
  let manifest;
  try{manifest=validateMacRuntimeManifest(JSON.parse((await files.read(MACOS_MANIFEST_PATH,64000)).toString('utf8')));}
  catch(error){if(error instanceof Error&&/^(INVALID_|MACOS_)/.test(error.message))throw error;throw new Error('INVALID_MACOS_RUNTIME_MANIFEST');}
  const bundled=await probeMacPages(MACOS_BUNDLED_DIST,manifest.bundledPage.packageVersion,files);
  if(Object.entries(manifest.bundledPage).some(([key,value])=>(bundled as unknown as Record<string,unknown>)[key]!==value))throw new Error('UNSUPPORTED_MACOS_BUNDLED_BUILD');
  let page=bundled,dist=MACOS_BUNDLED_DIST,user:{aresVersion?:unknown}|null|undefined;
  try{user=await files.version(posix.join(userDist,'packageVersion.json')) as {aresVersion?:unknown}|null;}catch(error){if((error as NodeJS.ErrnoException)?.code!=='ENOENT')throw error;}
  if(user!==undefined){
    if(!user||typeof user.aresVersion!=='string')throw new Error('UNSUPPORTED_MACOS_PAGE_VERSION');
    if(compareMacAres(bundled.aresVersion,user.aresVersion)<0){page=await probeMacPages(userDist,bundled.packageVersion,files);dist=userDist;}
  }
  await files.assertUnchanged?.();
  return{dist,manifest,build:macRuntimeBuild(manifest,page,pathToFileURL(dist+'/').href),assertUnchanged:()=>files.assertUnchanged?.()??Promise.resolve()};
}
