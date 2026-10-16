import{describe,it,expect,vi,beforeEach,afterEach}from'vitest';
interface Row {pid:number;ppid:number;lstart:string;comm:string;args:string;image?:string}
const mocks=vi.hoisted(()=>{
  const state={rows:[] as Row[],argless:new Set<number>(),table:undefined as string|undefined,listeners:[] as (string|Error)[],version:'1.2.12\n',onOpen:[] as Row[],openFails:false};
  const failure=(stderr='')=>Object.assign(new Error('Command failed'),{code:1,stdout:'',stderr});
  const pad=(value:number)=>String(value).padStart(5);
  const run=vi.fn(async(file:string,args:string[],_options:unknown)=>{
    if(file==='/bin/ps'){
      const at=args.indexOf('-p'),rows=at<0?state.rows:state.rows.filter(row=>row.pid===Number(args[at+1]));if(at>=0&&!rows.length)throw failure();
      if(args[args.indexOf('-o')+1]==='pid=,args=')return{stdout:rows.filter(row=>!state.argless.has(row.pid)).map(row=>`${pad(row.pid)} ${row.args}\n`).join(''),stderr:''};
      return{stdout:state.table??rows.map(row=>`${pad(row.pid)} ${pad(row.ppid)} ${row.lstart}     ${row.comm}\n`).join(''),stderr:''};
    }
    if(file==='/usr/sbin/lsof'&&args.includes('txt')){const pid=Number(args[args.indexOf('-p')+1]),row=state.rows.find(item=>item.pid===pid);if(!row)throw failure();return{stdout:`p${pid}\nftxt\nn${row.image??row.comm}\nftxt\nn/usr/lib/dyld\n`,stderr:''};}
    if(file==='/usr/sbin/lsof'){const next=state.listeners.length>1?state.listeners.shift()!:state.listeners[0]??failure();if(next instanceof Error)throw next;return{stdout:next,stderr:''};}
    if(file==='/usr/bin/plutil')return{stdout:state.version,stderr:''};
    if(file==='/usr/bin/open'){if(state.openFails)throw failure('LSOpenURLsWithRole() failed');state.rows.push(...state.onOpen);return{stdout:'',stderr:''};}
    throw new Error('UNEXPECTED_COMMAND');
  });
  return{state,failure,run,child:{spawn:vi.fn(),execFile:Object.assign(vi.fn(),{[Symbol.for('nodejs.util.promisify.custom')]:run})},hash:vi.fn(),readFile:vi.fn()};
});
vi.mock('node:child_process',()=>mocks.child);
vi.mock('node:fs/promises',async importOriginal=>({...await importOriginal<typeof import('node:fs/promises')>(),readFile:mocks.readFile}));
vi.mock('../../runtime/fingerprint-cache',()=>({createFingerprintCache:(hash=mocks.hash)=>hash}));
vi.mock('../../runtime/file-fingerprint',()=>({fingerprintFile:mocks.hash}));
vi.mock('../../runtime/build-manifest',async importOriginal=>{const actual=await importOriginal<typeof import('../../runtime/build-manifest')>();return{...actual,RUNTIME_PLATFORM:'darwin',VERIFIED_RUNTIME_BUILD:actual.MACOS_RUNTIME_BUILD};});
import{MacLaunchPlatform}from'../../runtime/macos-platform';
import{createLaunchPlatform,existingClientDebugPort}from'../../runtime/platform';
import{MACOS_RUNTIME_BUILD}from'../../runtime/build-manifest';
import{VERIFIED_RUNTIME_BUILD,sameExecutablePath}from'../../runtime/identity';
const{state,failure,run}=mocks;
const BUNDLE='/Applications/旅游商家桌面版.app',EXE=MACOS_RUNTIME_BUILD.executable,DIST=BUNDLE+'/Contents/Resources/app.asar.unpacked/dist';
const helper=(kind:string)=>`${BUNDLE}/Contents/Frameworks/旅游商家桌面版 Helper${kind?` (${kind})`:''}.app/Contents/MacOS/旅游商家桌面版 Helper${kind?` (${kind})`:''}`;
const CRASHPAD=BUNDLE+'/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler',DATA='--user-data-dir=/Users/u/Library/Application Support/vbk-electron';
const LSTART='Fri Oct 16 00:24:21 2026',STARTED='2026-10-16T00:24:21.000Z';
const row=(pid:number,comm:string,args:string,extra:Partial<Row>={}):Row=>({pid,ppid:pid===100?1:100,lstart:LSTART,comm,args,...extra});
const main=(flags='')=>row(100,EXE,EXE+flags);
const vendor=()=>[main(),row(101,helper('GPU'),`${helper('GPU')} --type=gpu-process ${DATA}`),row(102,helper('Renderer'),`${helper('Renderer')} --type=renderer ${DATA} --app-path=${BUNDLE}/Contents/Resources/app.asar`,{lstart:'Mon Oct  5 09:00:00 2026'}),row(103,CRASHPAD,`${CRASHPAD} --annotation=_productName=旅游商家桌面版`,{ppid:1}),row(104,helper(''),`${helper('')} --type=utility --utility-sub-type=network.mojom.NetworkService`)];
const unrelated=()=>[row(1,'/sbin/launchd','/sbin/launchd',{ppid:0}),row(2,'/Applications/GitHub Desktop.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt','/Applications/GitHub Desktop.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt',{ppid:1}),row(3,'-zsh','-zsh',{ppid:1})];
const listening=(...records:string[])=>records.join('\n')+'\n';
const hashes:Record<string,string>={[EXE]:MACOS_RUNTIME_BUILD.executableSha256,[BUNDLE+'/Contents/Resources/app.asar']:MACOS_RUNTIME_BUILD.asarSha256,[DIST+'/src/pages/imPlus/index.html']:MACOS_RUNTIME_BUILD.htmlSha256,[DIST+'/js/imWindow-BnMVlw3I.js']:MACOS_RUNTIME_BUILD.rendererSha256};
const platform=Object.getOwnPropertyDescriptor(process,'platform')!,runAsNode=process.env.ELECTRON_RUN_AS_NODE;
beforeEach(()=>{
  Object.defineProperty(process,'platform',{...platform,value:'darwin'});delete process.env.ELECTRON_RUN_AS_NODE;
  Object.assign(state,{rows:[...unrelated()],argless:new Set(),table:undefined,listeners:[],version:'1.2.12\n',onOpen:[],openFails:false});run.mockClear();
  mocks.hash.mockReset().mockImplementation(async(path:string)=>{if(!(path in hashes))throw new Error('UNEXPECTED_HASH_PATH');return hashes[path];});
  mocks.readFile.mockReset().mockImplementation(async(path:string)=>{if(path!==DIST+'/packageVersion.json')throw new Error('UNEXPECTED_READ');return JSON.stringify({pkgVersion:'1.2.12',aresVersion:'1.2.15',aresName:'vbk-electron-v27'});});
});
afterEach(()=>{Object.defineProperty(process,'platform',platform);if(runAsNode===undefined)delete process.env.ELECTRON_RUN_AS_NODE;else process.env.ELECTRON_RUN_AS_NODE=runAsNode;});
describe('macOS read-only client inspection, fake ps/lsof/plutil only',()=>{
  it('selects the macOS manifest and NFC path comparison under the mocked build',()=>{expect(VERIFIED_RUNTIME_BUILD).toBe(MACOS_RUNTIME_BUILD);expect(sameExecutablePath(EXE.normalize('NFD'),EXE)).toBe(true);expect(sameExecutablePath(EXE.toUpperCase(),EXE)).toBe(false);expect(sameExecutablePath(BUNDLE+'/Contents/MacOS/../MacOS/旅游商家桌面版',EXE)).toBe(true);});
  it('classifies spaced UTF-8 helper paths, the single main process and crashpad, then verifies the fingerprint',async()=>{
    state.rows.push(...vendor());const snapshot=await new MacLaunchPlatform().inspectReadOnly();
    expect(snapshot).toEqual({verified:true,fingerprint:{executable:EXE,executableVersion:'1.2.12',packageVersion:'1.2.12',aresVersion:'1.2.15',executableSha256:MACOS_RUNTIME_BUILD.executableSha256,asarSha256:MACOS_RUNTIME_BUILD.asarSha256,htmlSha256:MACOS_RUNTIME_BUILD.htmlSha256,rendererSha256:MACOS_RUNTIME_BUILD.rendererSha256},clientProcessIds:[100,101,102,103,104],clientMainProcessIds:[100],installerProcessIds:[]});
    const options=expect.objectContaining({shell:false,timeout:expect.any(Number),maxBuffer:expect.any(Number),env:expect.objectContaining({LC_ALL:'en_US.UTF-8',TZ:'UTC'})});
    expect(run).toHaveBeenCalledWith('/bin/ps',['-axww','-o','pid=,ppid=,lstart=,comm='],options);expect(run).toHaveBeenCalledWith('/bin/ps',['-axww','-o','pid=,args='],options);expect(run).toHaveBeenCalledWith('/usr/bin/plutil',['-extract','CFBundleVersion','raw','-o','-',BUNDLE+'/Contents/Info.plist'],options);
    expect(mocks.hash.mock.calls.map(call=>call[0]).sort()).toEqual(Object.keys(hashes).sort());
  });
  it('reports an idle machine and counts the vendor updater as an installer, never as a client',async()=>{
    expect(await new MacLaunchPlatform().inspectReadOnly()).toMatchObject({clientProcessIds:[],clientMainProcessIds:[],installerProcessIds:[]});
    const shipIt=BUNDLE+'/Contents/Frameworks/Squirrel.framework/Resources/ShipIt',pending='/Users/u/Library/Caches/vbk-electron-updater/pending/旅游商家桌面版-1.2.13.app/Contents/MacOS/旅游商家桌面版';
    state.rows.push(row(300,shipIt,shipIt,{ppid:1}),row(301,pending,pending,{ppid:1}));expect(await new MacLaunchPlatform().inspectReadOnly()).toMatchObject({clientProcessIds:[],clientMainProcessIds:[],installerProcessIds:[300,301]});
  });
  it('refuses a client image outside the verified bundle, including a translocated or relative one',async()=>{
    for(const image of ['/Users/u/Downloads/旅游商家桌面版.app/Contents/MacOS/旅游商家桌面版','/private/var/folders/x/AppTranslocation/1/d/旅游商家桌面版.app/Contents/Frameworks/旅游商家桌面版 Helper.app/Contents/MacOS/旅游商家桌面版 Helper','./旅游商家桌面版',BUNDLE+'/../旅游商家桌面版']){state.rows=[...unrelated(),row(400,image,image)];await expect(new MacLaunchPlatform().inspectReadOnly()).rejects.toThrow('UNKNOWN_CLIENT_IMAGE');}
  });
  it('fails closed on drifted builds, malformed process output and missing main command lines',async()=>{
    state.rows.push(...vendor());state.version='1.2.11\n';await expect(new MacLaunchPlatform().inspectReadOnly()).rejects.toThrow('UNVERIFIED_BUILD');state.version='1.2.12 extra\n';await expect(new MacLaunchPlatform().inspectReadOnly()).rejects.toThrow('CLIENT_VERSION_UNAVAILABLE');state.version='1.2.12\n';
    mocks.readFile.mockResolvedValueOnce('{"pkgVersion":1}');await expect(new MacLaunchPlatform().inspectReadOnly()).rejects.toThrow('CLIENT_PACKAGE_VERSION_UNAVAILABLE');
    mocks.hash.mockImplementationOnce(async()=>'0'.repeat(64));await expect(new MacLaunchPlatform().inspectReadOnly()).rejects.toThrow('UNVERIFIED_BUILD');
    state.argless.add(100);await expect(new MacLaunchPlatform().inspectReadOnly()).rejects.toThrow('CLIENT_IDENTITY_UNAVAILABLE');state.argless.clear();
    for(const table of ['  100     1 Fri Oct 16 00:24 2026     /x\n','  100     1 Fri Oct 16 00:24:21 2026     /a\n  100     1 Fri Oct 16 00:24:21 2026     /b\n','  100     1 Thu Oct 16 00:24:21 2026     /x\n','  100     1 Fri Feb 31 00:24:21 2026     /x\n']){state.table=table;await expect(new MacLaunchPlatform().inspectReadOnly()).rejects.toThrow(/^PROCESS_(INSPECTION_INVALID_STATE|START_TIME_INVALID)$/);}
    state.table=undefined;run.mockRejectedValueOnce(failure('ps: error'));await expect(new MacLaunchPlatform().inspectReadOnly()).rejects.toThrow('PROCESS_INSPECTION_FAILED');
  });
  it('requires macOS and the macOS manifest',async()=>{
    Object.defineProperty(process,'platform',{...platform,value:'win32'});const mac=new MacLaunchPlatform();
    for(const call of [()=>mac.inspectReadOnly(),()=>mac.processIdentity(100),()=>mac.debugPortOf(100),()=>mac.waitForListener({pid:100,startedAt:STARTED,executable:EXE},19321,100),()=>mac.spawnOriginal(EXE,['--remote-debugging-port=19321'],{shell:false,modifyEnvironment:false})])await expect(call()).rejects.toThrow('MACOS_REQUIRED');
    expect(run).not.toHaveBeenCalled();expect(()=>createLaunchPlatform()).toThrow('UNSUPPORTED_PLATFORM');Object.defineProperty(process,'platform',{...platform,value:'darwin'});expect(createLaunchPlatform()).toBeInstanceOf(MacLaunchPlatform);
  });
});
describe('macOS process identity and debugger ownership',()=>{
  it('derives a stable UTC start time and refuses an argv[0] that differs from the mapped image',async()=>{
    state.rows.push(...vendor());const mac=new MacLaunchPlatform();const identity={pid:100,executable:EXE,startedAt:STARTED};
    expect(await mac.processIdentity(100)).toEqual(identity);expect(await mac.processIdentity(100)).toEqual(identity);expect((await mac.processIdentity(102)).startedAt).toBe('2026-10-05T09:00:00.000Z');
    expect(run).toHaveBeenCalledWith('/usr/sbin/lsof',['-w','-nP','-a','-p','100','-d','txt','-Fn'],expect.objectContaining({shell:false}));
    state.rows.push(row(500,EXE,EXE+' --remote-debugging-port=19321',{image:'/bin/sleep'}));await expect(mac.processIdentity(500)).rejects.toThrow('PROCESS_IDENTITY_UNAVAILABLE');await expect(mac.processIdentity(999)).rejects.toThrow('PROCESS_IDENTITY_UNAVAILABLE');await expect(mac.processIdentity(0)).rejects.toThrow('INVALID_PID');
  });
  it('reads the debugger port only from a main process with exactly one valid flag',async()=>{
    state.rows.push(...vendor());state.rows[state.rows.findIndex(item=>item.pid===100)]=main(' --remote-debugging-port=19321');const mac=new MacLaunchPlatform();
    expect(await mac.debugPortOf(100)).toBe(19321);expect(await existingClientDebugPort(100)).toBe(19321);
    for(const [pid,args] of [[100,EXE],[100,EXE+' --remote-debugging-port=19321 --remote-debugging-port=19322'],[100,EXE+' --remote-debugging-port=19321 -remote-debugging-port=19322'],[100,EXE+' --remote-debugging-port=80'],[100,EXE+' --remote-debugging-port=65535'],[100,EXE+' --remote-debugging-port=19321x'],[100,EXE+' --type=renderer --remote-debugging-port=19321'],[102,helper('Renderer')+' --type=renderer --remote-debugging-port=19321'],[999,'']]as const){
      const target=state.rows.find(item=>item.pid===pid);if(target)target.args=args;await expect(mac.debugPortOf(pid)).rejects.toThrow('EXISTING_CLIENT_DEBUG_PORT_REQUIRED');await expect(existingClientDebugPort(pid)).rejects.toThrow('EXISTING_CLIENT_DEBUG_PORT_REQUIRED');
    }
  });
  it('parses lsof listener records, dedupes dual entries and refuses ambiguity',async()=>{
    state.rows.push(...vendor());const mac=new MacLaunchPlatform(),owner={pid:100,executable:EXE,startedAt:STARTED};
    state.listeners=[listening('p100','f31','n127.0.0.1:19321','f32','n127.0.0.1:19321')];expect(await mac.waitForListener(owner,19321,1000)).toEqual({pid:100,address:'127.0.0.1',port:19321,processStartedAt:STARTED});
    expect(run).toHaveBeenCalledWith('/usr/sbin/lsof',['-w','-nP','-iTCP:19321','-sTCP:LISTEN','-Fpn'],expect.objectContaining({shell:false,env:expect.objectContaining({LC_ALL:'en_US.UTF-8'})}));
    state.listeners=[listening('p100','f31','n[::1]:19321')];expect(await mac.waitForListener(owner,19321,1000)).toMatchObject({pid:100,address:'::1'});
    state.listeners=[listening('p100','f31','n*:19321','f32','n*:19321')];expect(await mac.waitForListener(owner,19321,1000)).toMatchObject({pid:100,address:'*'});
    state.listeners=[listening('p100','f31','n127.0.0.1:19321','f32','n[::1]:19321')];await expect(mac.waitForListener(owner,19321,1000)).rejects.toThrow('AMBIGUOUS_LISTENER');
    state.listeners=[listening('p100','f31','n127.0.0.1:19321','p8262','f9','n127.0.0.1:19321')];await expect(mac.waitForListener(owner,19321,1000)).rejects.toThrow('AMBIGUOUS_LISTENER');
  });
  it('waits through an empty lsof exit 1 and fails closed on lsof errors, malformed records and a changed owner',async()=>{
    state.rows.push(...vendor());const mac=new MacLaunchPlatform(),owner={pid:100,executable:EXE,startedAt:STARTED};
    state.listeners=[failure(),listening('p100','f31','n127.0.0.1:19321')];expect(await mac.waitForListener(owner,19321,2000)).toMatchObject({pid:100,address:'127.0.0.1'});
    state.listeners=[failure()];await expect(mac.waitForListener(owner,19321,300)).rejects.toThrow('DEBUG_LISTENER_NOT_AVAILABLE');
    for(const next of [failure('lsof: unknown service'),Object.assign(new Error('timeout'),{killed:true,signal:'SIGTERM',code:null,stdout:'',stderr:''}),listening('n127.0.0.1:19321'),listening('p100','f31','n127.0.0.1:19322'),listening('p100','f31','n127.0.0.1:19321->127.0.0.1:50000'),listening('p100','t IPv4','n127.0.0.1:19321')]){state.listeners=[next];await expect(mac.waitForListener(owner,19321,1000)).rejects.toThrow('LISTENER_CHECK_UNAVAILABLE');}
    state.listeners=[listening('p100','f31','n127.0.0.1:19321')];await expect(mac.waitForListener({...owner,startedAt:'2026-10-16T00:24:20.000Z'},19321,1000)).rejects.toThrow('PROCESS_CHANGED');await expect(mac.waitForListener(owner,0,1000)).rejects.toThrow('INVALID_DEBUG_PORT');
  });
});
describe('macOS launch through LaunchServices, fake open only',()=>{
  const options={shell:false as const,modifyEnvironment:false as const};
  it('opens the bundle with exactly one debugger argument and adopts the one new main process carrying it',async()=>{
    state.onOpen=[main(' --remote-debugging-port=19321'),row(101,helper('GPU'),`${helper('GPU')} --type=gpu-process --remote-debugging-port=19321`)];
    expect(await new MacLaunchPlatform().spawnOriginal(EXE,['--remote-debugging-port=19321'],options)).toEqual({pid:100,executable:EXE,startedAt:STARTED});
    const open=run.mock.calls.filter(call=>call[0]==='/usr/bin/open');expect(open).toEqual([['/usr/bin/open',['-a',BUNDLE,'--args','--remote-debugging-port=19321'],expect.objectContaining({shell:false})]]);expect(open[0][1]).not.toContain('-n');expect(open[0][2]).not.toHaveProperty('env');
    expect(mocks.child.spawn).not.toHaveBeenCalled();
  });
  it('refuses unapproved arguments, executables and an ELECTRON_RUN_AS_NODE environment before opening anything',async()=>{
    const mac=new MacLaunchPlatform();
    for(const [executable,args] of [[EXE,[]],[EXE,['--remote-debugging-port=19321','--inspect']],[EXE,['--remote-debugging-port=']],[EXE,['--remote-debugging-address=0.0.0.0']],[EXE,['--remote-debugging-port=19321 --inspect']],[helper('Renderer'),['--remote-debugging-port=19321']],[BUNDLE,['--remote-debugging-port=19321']]]as const)await expect(mac.spawnOriginal(executable,args,options)).rejects.toThrow('UNAPPROVED_LAUNCH');
    await expect(mac.spawnOriginal(EXE,['--remote-debugging-port=19321'],{shell:true,modifyEnvironment:false} as never)).rejects.toThrow('UNAPPROVED_LAUNCH');
    process.env.ELECTRON_RUN_AS_NODE='1';await expect(mac.spawnOriginal(EXE,['--remote-debugging-port=19321'],options)).rejects.toThrow('UNSAFE_LAUNCH_ENVIRONMENT');
    expect(run).not.toHaveBeenCalled();
  });
  it('fails closed when open fails or the started process is ambiguous',async()=>{
    state.openFails=true;await expect(new MacLaunchPlatform().spawnOriginal(EXE,['--remote-debugging-port=19321'],options)).rejects.toThrow('LAUNCH_FAILED');
    state.openFails=false;state.onOpen=[main(' --remote-debugging-port=19321'),row(110,EXE,EXE+' --remote-debugging-port=19321',{ppid:1})];await expect(new MacLaunchPlatform().spawnOriginal(EXE,['--remote-debugging-port=19321'],options)).rejects.toThrow('AMBIGUOUS_CLIENT_PROCESS');
  });
});
