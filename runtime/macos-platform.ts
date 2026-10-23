import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {posix} from 'node:path';
import {fingerprintFile as hash} from './file-fingerprint';
import {createFingerprintCache,createFileFingerprintStore,type FingerprintStore} from './fingerprint-cache';
import {fingerprintMacExecutable} from './macho-fingerprint';
import {MACOS_PATCHED_BUILD,MACOS_RUNTIME_BUILD,activateMacPageBuild} from './build-manifest';
import {inspectMacPages} from './macos-pages';
import {VERIFIED_RUNTIME_BUILD,RUNTIME_PLATFORM,assertBuildFingerprint,sameExecutablePath,type ProcessIdentity,type ListenerIdentity} from './identity';
import type {LaunchPlatform,VerifiedIdleSnapshot} from './launcher';
const execute=promisify(execFile);
const exe=VERIFIED_RUNTIME_BUILD.executable;
const bundle=posix.dirname(posix.dirname(posix.dirname(exe))),contents=posix.join(bundle,'Contents');
const nfc=(path:string)=>posix.normalize(path).normalize('NFC'),bundlePrefix=nfc(bundle)+'/',clientName=posix.basename(nfc(exe));
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
interface ProcessRow {pid:number;startedAt:string;executable:string;args?:string}
function macos(){if(process.platform!=='darwin'||RUNTIME_PLATFORM!=='darwin')throw new Error('MACOS_REQUIRED');}
// Fixed English/UTC output: ps lstart is locale and timezone dependent; lsof escapes non-ASCII paths outside UTF-8 locales.
async function run(file:string,args:string[],maxBuffer:number):Promise<string>{
  const {stdout}=await execute(file,args,{shell:false,timeout:15000,maxBuffer,encoding:'utf8',env:{...process.env,LC_ALL:'en_US.UTF-8',TZ:'UTC'}});return stdout;
}
/** ps lstart, e.g. 'Fri Oct 16 00:24:21 2026' (UTC), to a stable second-resolution ISO string. */
function startedAt(value:string):string{
  const m=/^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value),month=m?MONTHS.indexOf(m[2]):-1;
  if(!m||month<0)throw new Error('PROCESS_START_TIME_INVALID');
  const [day,hour,minute,second]=[m[3],m[4],m[5],m[6]].map(Number),date=new Date(Date.UTC(Number(m[7]),month,day,hour,minute,second));
  if(date.getUTCDate()!==day||date.getUTCHours()!==hour||date.getUTCMinutes()!==minute||date.getUTCSeconds()!==second||DAYS[date.getUTCDay()]!==m[1])throw new Error('PROCESS_START_TIME_INVALID');
  return date.toISOString();
}
/** 'pid= ppid= lstart= comm=': comm must stay last so spaced UTF-8 paths are printed whole. */
function parseTable(stdout:string):ProcessRow[]{
  const rows:ProcessRow[]=[],seen=new Set<number>();
  for(const line of stdout.split('\n')){
    if(!line.trim())continue;
    const m=/^\s*(\d+)\s+\d+\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})(?:\s+(.*))?$/.exec(line),pid=m?Number(m[1]):NaN;
    if(!m||!Number.isSafeInteger(pid)||seen.has(pid))throw new Error('PROCESS_INSPECTION_INVALID_STATE');
    seen.add(pid);rows.push({pid,startedAt:startedAt(m[2]),executable:m[3]??''});
  }
  return rows;
}
function parseArgs(stdout:string):Map<number,string>{
  const args=new Map<number,string>();
  for(const line of stdout.split('\n')){
    if(!line.trim())continue;
    const m=/^\s*(\d+)(?: (.*))?$/.exec(line),pid=m?Number(m[1]):NaN;
    if(!m||!Number.isSafeInteger(pid)||args.has(pid))throw new Error('PROCESS_INSPECTION_INVALID_STATE');
    args.set(pid,m[2]??'');
  }
  return args;
}
const debugFlags=(args:string)=>[...args.matchAll(/(?:^|\s)(--?remote-debugging-port=\S*)/g)].map(match=>match[1]);
const isMainImage=(row:ProcessRow)=>sameExecutablePath(row.executable,exe);
const isMain=(row:ProcessRow)=>isMainImage(row)&&row.args!==undefined&&!row.args.includes('--type=');
const isInstaller=(row:ProcessRow)=>{const path=nfc(row.executable);return path.includes('vbk-electron-updater')||path.startsWith(bundlePrefix)&&posix.basename(path)==='ShipIt';};
/** Starts an independent read-only check now; awaiting the getter later reports its failure in the caller's original order. */
function early<T>(promise:Promise<T>):()=>Promise<T>{promise.catch(()=>{});return()=>promise;}
async function scan():Promise<ProcessRow[]>{
  let table:string,commands:string;
  try{[table,commands]=await Promise.all([run('/bin/ps',['-axww','-o','pid=,ppid=,lstart=,comm='],4_000_000),run('/bin/ps',['-axww','-o','pid=,args='],16_000_000)]);}catch{throw new Error('PROCESS_INSPECTION_FAILED');}
  const args=parseArgs(commands);return parseTable(table).map(row=>args.has(row.pid)?{...row,args:args.get(row.pid)}:row);
}
async function listeners(port:number):Promise<{pid:number;address:string;port:number}[]>{
  let stdout:string;
  try{stdout=await run('/usr/sbin/lsof',['-w','-nP',`-iTCP:${port}`,'-sTCP:LISTEN','-Fpn'],1_000_000);}
  catch(error){const failure=error as {code?:unknown;stdout?:unknown;stderr?:unknown};if(failure&&failure.code===1&&failure.stdout===''&&failure.stderr==='')return[];throw new Error('LISTENER_CHECK_UNAVAILABLE');}
  const found=new Map<string,{pid:number;address:string;port:number}>();let pid=0;
  for(const line of stdout.split('\n')){
    if(!line)continue;const value=line.slice(1);
    if(line[0]==='p'){if(!/^[1-9]\d{0,9}$/.test(value))throw new Error('LISTENER_CHECK_UNAVAILABLE');pid=Number(value);}
    else if(line[0]==='f'){if(!pid)throw new Error('LISTENER_CHECK_UNAVAILABLE');}
    else if(line[0]==='n'){const m=/^(?:\[([0-9A-Fa-f:.%]+)\]|([^\s\[\]>]+)):(\d+)$/.exec(value);if(!pid||!m||Number(m[3])!==port)throw new Error('LISTENER_CHECK_UNAVAILABLE');const address=m[1]??m[2];found.set(`${pid} ${address}`,{pid,address,port});}
    else throw new Error('LISTENER_CHECK_UNAVAILABLE');
  }
  return[...found.values()];
}
let fingerprintStore:FingerprintStore|undefined;
/** The helper's private data directory; repeated launches then skip re-reading the ~300 MB vendor archive while it starts. */
export function configureFingerprintPersistence(file:string){fingerprintStore=createFileFingerprintStore(file);}
// Shared by every platform instance: each connection attempt creates one, and the vendor is still loading meanwhile.
const sharedHash=createFingerprintCache(hash,()=>fingerprintStore,'sha256');
const sharedExecutableHash=createFingerprintCache(MACOS_PATCHED_BUILD?fingerprintMacExecutable:hash,()=>fingerprintStore,MACOS_PATCHED_BUILD?'macho-unsigned-sha256':'sha256');
/** Read-only process/file inspection; the client is only ever started through LaunchServices so TCC stays attributed to it. */
export class MacLaunchPlatform implements LaunchPlatform {
  private hash=sharedHash;
  private executableHash=sharedExecutableHash;
  async inspectReadOnly():Promise<VerifiedIdleSnapshot>{
    macos();
    const clients:number[]=[],main:number[]=[],installers:number[]=[];
    // Process listing, bundle version and file digests are independent reads; overlap them.
    const rows=early(scan()),versionText=early(run('/usr/bin/plutil',['-extract','CFBundleVersion','raw','-o','-',posix.join(contents,'Info.plist')],64_000));
    const verified=early(Promise.all([inspectMacPages(),this.executableHash(exe),this.hash(posix.join(contents,'Resources','app.asar'))]));
    for(const row of await rows()){
      const path=nfc(row.executable);
      if(isInstaller(row)){installers.push(row.pid);continue;}
      if(path.startsWith(bundlePrefix)){if(isMainImage(row)&&row.args===undefined)throw new Error('CLIENT_IDENTITY_UNAVAILABLE');clients.push(row.pid);if(isMain(row))main.push(row.pid);continue;}
      if(posix.basename(path).startsWith(clientName))throw new Error('UNKNOWN_CLIENT_IMAGE');
    }
    let version:string;
    try{version=(await versionText()).replace(/\n$/,'');}catch{throw new Error('CLIENT_VERSION_UNAVAILABLE');}
    if(!/^[0-9A-Za-z.-]{1,64}$/.test(version))throw new Error('CLIENT_VERSION_UNAVAILABLE');
    const [pages,executableSha256,asarSha256]=await verified();
    if(version!==MACOS_RUNTIME_BUILD.executableVersion||executableSha256!==MACOS_RUNTIME_BUILD.executableSha256||asarSha256!==MACOS_RUNTIME_BUILD.asarSha256)throw new Error('UNVERIFIED_BUILD');
    await pages.assertUnchanged();activateMacPageBuild(pages.build);
    const fingerprint={executable:exe,executableVersion:version,packageVersion:pages.build.packageVersion,aresVersion:pages.build.aresVersion,executableSha256,asarSha256,htmlSha256:pages.build.htmlSha256,rendererSha256:pages.build.rendererSha256};assertBuildFingerprint(fingerprint);
    return{verified:true,fingerprint,clientProcessIds:clients,clientMainProcessIds:main,installerProcessIds:installers};
  }
  async reserveLoopbackPort(){
    const server=createServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();if(!address||typeof address==='string'){server.close();throw new Error('PORT_RESERVATION_FAILED');}
    let released=false;return{address:'127.0.0.1' as const,port:address.port,release:async()=>{if(released)return;released=true;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
  }
  async spawnOriginal(executable:string,args:readonly string[],options:{shell:false;modifyEnvironment:false}):Promise<ProcessIdentity>{
    macos();
    if(executable!==exe||options.shell!==false||options.modifyEnvironment!==false||args.length!==1||!/^--remote-debugging-port=\d+$/.test(args[0]))throw new Error('UNAPPROVED_LAUNCH');
    if(process.env.ELECTRON_RUN_AS_NODE!==undefined)throw new Error('UNSAFE_LAUNCH_ENVIRONMENT');
    const flag=args[0];
    // No -n: with no client running, LaunchServices starts the one bundle instance with exactly this argument.
    try{await execute('/usr/bin/open',['-a',bundle,'--args',flag],{shell:false,timeout:15000,maxBuffer:64_000});}catch{throw new Error('LAUNCH_FAILED');}
    const deadline=Date.now()+8000;
    for(;;){
      const started=(await scan()).filter(row=>{if(!isMain(row))return false;const flags=debugFlags(row.args!);return flags.length===1&&flags[0]===flag;});
      if(started.length>1)throw new Error('AMBIGUOUS_CLIENT_PROCESS');
      if(started.length===1){const identity=await this.identity(started[0].pid);if(identity.startedAt!==started[0].startedAt)throw new Error('PROCESS_CHANGED');return identity;}
      if(Date.now()>=deadline)throw new Error('CLIENT_PROCESS_NOT_FOUND');
      await pause(200);
    }
  }
  async processIdentity(pid:number):Promise<ProcessIdentity>{return this.identity(pid);}
  /** argv[0] (ps comm) is caller-controlled, so the mapped text image reported by lsof must agree with it. */
  private async identity(pid:number):Promise<ProcessIdentity>{
    macos();if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('INVALID_PID');
    let table:string,text:string;
    try{[table,text]=await Promise.all([run('/bin/ps',['-ww','-o','pid=,ppid=,lstart=,comm=','-p',String(pid)],64_000),run('/usr/sbin/lsof',['-w','-nP','-a','-p',String(pid),'-d','txt','-Fn'],1_000_000)]);}catch{throw new Error('PROCESS_IDENTITY_UNAVAILABLE');}
    const rows=parseTable(table),lines=text.split('\n'),image=lines.find(line=>line.startsWith('n'))?.slice(1);
    if(rows.length!==1||rows[0].pid!==pid||lines[0]!==`p${pid}`||!image||!sameExecutablePath(rows[0].executable,image))throw new Error('PROCESS_IDENTITY_UNAVAILABLE');
    return{pid,executable:image,startedAt:rows[0].startedAt};
  }
  async waitForListener(owner:ProcessIdentity,port:number,timeoutMs:number):Promise<ListenerIdentity>{
    macos();if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('INVALID_DEBUG_PORT');
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
      const listening=early(listeners(port));
      const identity=await this.identity(owner.pid);if(identity.startedAt!==owner.startedAt||!sameExecutablePath(identity.executable,owner.executable)||!sameExecutablePath(identity.executable,exe))throw new Error('PROCESS_CHANGED');
      const found=await listening();
      if(found.length){if(found.length!==1)throw new Error('AMBIGUOUS_LISTENER');return{...found[0],processStartedAt:identity.startedAt};}
      await pause(200);
    }
    throw new Error('DEBUG_LISTENER_NOT_AVAILABLE');
  }
  /** The debugger port of an already running client main process, from its own command line only. */
  async debugPortOf(pid:number):Promise<number>{
    macos();const required=()=>new Error('EXISTING_CLIENT_DEBUG_PORT_REQUIRED');
    if(!Number.isSafeInteger(pid)||pid<=0)throw required();
    let rows:ProcessRow[],args:Map<number,string>;
    try{const [table,commands]=await Promise.all([run('/bin/ps',['-ww','-o','pid=,ppid=,lstart=,comm=','-p',String(pid)],64_000),run('/bin/ps',['-ww','-o','pid=,args=','-p',String(pid)],256_000)]);rows=parseTable(table);args=parseArgs(commands);}catch{throw required();}
    const row=rows.length===1&&rows[0].pid===pid&&args.has(pid)?{...rows[0],args:args.get(pid)}:undefined;
    if(!row||!isMain(row))throw required();
    const flags=debugFlags(row.args!),m=flags.length===1?/^--remote-debugging-port=(\d{4,5})$/.exec(flags[0]):null,port=m?Number(m[1]):NaN;
    if(!Number.isSafeInteger(port)||port<1024||port>=65535)throw required();
    return port;
  }
}
