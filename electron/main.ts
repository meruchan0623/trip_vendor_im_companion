import { app, clipboard, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell, safeStorage, type IpcMainInvokeEvent } from 'electron';
import {PersistentSessionService} from './owned-session';
import {SecureSessionStore} from './secure-session-store';
import {OwnedLoginWindow} from './owned-login-window';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { NativeAdapter, type WindowState } from './native-adapter';
import { CompanionService } from './companion-service';
import {FileOutboundWaitStore} from './outbound-wait-store';
import {FileTranslationOptionsStore} from './translation-options-store';
import { startExternalClient } from './external-composer';
import { lockContents, lockLocalSession } from './security';
import { isPanelTarget, type PanelTarget } from '../src/shared/workbench';
import { ResidentConnection } from './resident-connection';
import {vendorOwnerPID,watchVendorOwner,vendorOwnerExitCode} from './vendor-owner';
import {createLaunchPlatform,configureExplicitVendorDebugPort} from '../runtime/platform';
import {configureFingerprintPersistence} from '../runtime/macos-platform';
import {windowsPowerShell} from '../runtime/windows-powershell';
import {VERIFIED_RUNTIME_BUILD,WINDOWS_DYNAMIC_RUNTIME} from '../runtime/build-manifest';
import {windowsInstallationFromHelper} from '../runtime/windows-compatibility.mjs';
import {createRuntimeDiagnostics} from './runtime-diagnostics';
import {connectVendorProgress,disconnectVendorProgress,reportVendorProgress} from './vendor-progress';

// Local settings open on demand; daily business UI belongs to the verified merchant BrowserView.
if(process.platform==='win32')app.disableHardwareAcceleration();
const residentPlatform=process.platform==='win32'||process.platform==='darwin';
// Installed Windows assistance belongs entirely to the official client's lifetime and embedded UI.
const silentVendorRuntime=process.platform==='win32'&&WINDOWS_DYNAMIC_RUNTIME;
const smokeMode=process.argv.includes('--smoke-test');
const acceptance=process.argv.includes('--acceptance');
if(smokeMode)app.setPath('userData',join(process.cwd(),'work/smoke-profile'));
const ownsInstance=smokeMode||app.requestSingleInstanceLock();
const diagnostics=ownsInstance?createRuntimeDiagnostics(join(app.getPath('userData'),'logs','runtime.log')):undefined;
const hostLog=console.log.bind(console),hostError=console.error.bind(console);
console.log=(...args:unknown[])=>{diagnostics?.consoleLog(args);hostLog(...args);};
console.error=(...args:unknown[])=>{diagnostics?.consoleError(args);hostError(...args);};
diagnostics?.lifecycle('start',process.pid);
const localFile=join(__dirname,'../dist/index.html');
let panel:BrowserWindow|undefined,tray:Tray|undefined,native:NativeAdapter,service:CompanionService,resident:ResidentConnection|undefined;
let ownedLogin:OwnedLoginWindow|undefined;
let latest:WindowState|null=null,quitting=false,cleaned=false,panelIntent=0;
let panelLoad:{window:BrowserWindow;promise:Promise<void>}|undefined;
let lastPublished='';
let acceptanceInput:ReadlineInterface|undefined;
let stopOwnerWatch:(()=>void)|undefined;
let ownerEpoch=0;
let ownerExitCode=0;
async function adoptVendorOwner(pid:number,args:readonly string[]=process.argv):Promise<void>{
  const epoch=++ownerEpoch,platform=createLaunchPlatform();
  // Owner handoff precedes resource verification/manifest activation at startup.
  const expectedExecutable=silentVendorRuntime?windowsInstallationFromHelper(process.execPath).executable:VERIFIED_RUNTIME_BUILD.executable;
  const stop=await watchVendorOwner(pid,id=>platform.processIdentity(id),expectedExecutable,reason=>{if(epoch===ownerEpoch){ownerExitCode=vendorOwnerExitCode(reason);console.error(reason);app.quit();}});
  if(quitting||epoch!==ownerEpoch){stop();return;}
  if(process.platform==='win32')configureExplicitVendorDebugPort(args);stopOwnerWatch?.();stopOwnerWatch=stop;
  // The installed vendor shows startup progress above its composer until the panel mounts.
  if(silentVendorRuntime){connectVendorProgress(args,pid);reportVendorProgress('host-ready');}
}
function listenForAcceptanceQuit():void {
  if(!acceptance)return;
  let requested=false;
  acceptanceInput=createInterface({input:process.stdin,terminal:false});
  acceptanceInput.on('line',line=>{
    if(line!=='quit'||requested||quitting)return;
    requested=true;console.log(JSON.stringify({event:'acceptance_quit_requested'}));app.quit();
  });
}
function trusted(event:IpcMainInvokeEvent):void {
  if(!panel||panel.isDestroyed()||event.sender!==panel.webContents||event.senderFrame!==panel.webContents.mainFrame)throw new Error('UNAUTHORIZED_RENDERER');
  const url=new URL(event.senderFrame!.url);url.hash='';
  if(url.href!==pathToFileURL(localFile).href)throw new Error('UNAUTHORIZED_RENDERER');
}
function handle(name:string,fn:(value:unknown)=>unknown):void {ipcMain.handle(`standalone:${name}`,(event,value)=>{trusted(event);return fn(value);});}
function publish(state=service.getState()):void {
  diagnostics?.state({attached:state.attached,auth:state.auth,phase:state.phase,composerSource:state.composerSource,nativeStatus:state.nativeStatus,hasPreview:!!state.preview,hasError:!!state.error,orderStatus:service?.getOrderStatus?.()??'idle'});
  const serialized=JSON.stringify([state,service?.getOrderStatus?.()??'idle']);if(serialized===lastPublished)return;lastPublished=serialized;
  if(acceptance)console.log(JSON.stringify({event:'embedded_acceptance_state',attached:state.attached,auth:state.auth,phase:state.phase,composerSource:state.composerSource,error:state.error,hasPreview:!!state.preview,orderStatus:service?.getOrderStatus?.()??'idle'}));
  if(panel&&!panel.isDestroyed())panel.webContents.send('standalone:state-event',state);
}
function nativeHandle(window:BrowserWindow):string {const value=window.getNativeWindowHandle();return value.length>=8?value.readBigUInt64LE().toString():value.readUInt32LE().toString();}
function registerSettings():void {if(process.platform==='win32')void native?.setCompanionWindows((panel&&!panel.isDestroyed()?[panel]:[]).map(nativeHandle)).catch(()=>{});}
function hideSettings():void {++panelIntent;const previous=panel;panel=undefined;if(previous&&!previous.isDestroyed())previous.destroy();registerSettings();}
async function openSettings():Promise<void> {
  if(quitting||silentVendorRuntime)return;
  if(!panel||panel.isDestroyed()){
    const window=new BrowserWindow({show:false,frame:false,thickFrame:false,hasShadow:false,autoHideMenuBar:true,resizable:false,width:360,height:480,minWidth:280,minHeight:320,title:'翻译设置',skipTaskbar:true,webPreferences:{preload:join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:true}});
    panel=window;lockContents(window.webContents,false);lockLocalSession(window.webContents.session);
    window.on('page-title-updated',event=>event.preventDefault());window.on('focus',()=>{void service.refreshSession().catch(()=>{});});
    window.on('closed',()=>{if(panel===window)panel=undefined;registerSettings();});registerSettings();
    const pending={window,promise:window.loadFile(localFile,{hash:'settings'})};panelLoad=pending;
    void pending.promise.finally(()=>{if(panelLoad===pending)panelLoad=undefined;}).catch(()=>{});
  }
  const window=panel,intent=++panelIntent;
  try{
    if(panelLoad?.window===window)await panelLoad.promise;
    if(quitting||window.isDestroyed()||window!==panel||intent!==panelIntent)return;
    if(window.isMinimized())window.restore();
    const work=screen.getDisplayMatching(window.getBounds()).workArea,width=Math.min(360,work.width),height=Math.min(480,work.height),bounds=window.getBounds();
    window.setBounds({x:Math.max(work.x,Math.min(bounds.x,work.x+work.width-width)),y:Math.max(work.y,Math.min(bounds.y,work.y+work.height-height)),width,height});
    // A Dock-less macOS app is not activated by its menu bar item; bring settings forward explicitly.
    if(process.platform==='darwin')app.focus({steal:true});window.show();window.focus();publish();
  }catch{if(window===panel&&!quitting){console.error('SETTINGS_LOAD_FAILED');hideSettings();}}
}
function createResidentTray():void {
  // macOS menu bar: 18pt icon drawn at 2x so Retina displays render it crisply.
  const scale=process.platform==='darwin'?2:1,size=process.platform==='darwin'?36:20,pixels=Buffer.alloc(size*size*4);
  for(let py=0;py<size;py++)for(let px=0;px<size;px++){const x=Math.floor(px*20/size),y=Math.floor(py*20/size),letter=y>=5&&y<=7&&x>=4&&x<=15||y>=7&&y<=15&&x>=8&&x<=11;pixels.set(letter?[255,255,255,255]:[190,100,30,255],(py*size+px)*4);}
  tray=new Tray(nativeImage.createFromBitmap(pixels,{width:size,height:size,scaleFactor:scale}));tray.setToolTip('旅游商家助手');
  tray.setContextMenu(Menu.buildFromTemplate([{label:'打开连接设置',click:()=>{void openSettings();}},{type:'separator'},{label:'退出助手',click:()=>app.quit()}]));tray.on('double-click',()=>{void openSettings();});
}
function stateChanged(state:WindowState|null):void {
  if(quitting||cleaned)return;resident?.setBound(!!state);
  const previous=latest;latest=state;
  // Native state supplies availability and foreground; page layout never depends on desktop geometry.
  const changed=previous?.targetInstanceId!==state?.targetInstanceId;
  if(changed||previous?.visible!==state?.visible||previous?.minimized!==state?.minimized||previous?.foreground!==state?.foreground||previous?.groupForeground!==state?.groupForeground)service?.setWindowState(state);
  if(changed&&state)void service.connectComposer();
}
function setupIPC():void {
  handle('state',()=>service.getState());handle('list-windows',()=>native.list());
  handle('start-client',async()=>{
    // Installed clients select their own debugger port and start the helper from the vendor entry.
    // Reject before resident.connect can invalidate an existing connection or spawn another client.
    if(WINDOWS_DYNAMIC_RUNTIME)throw new Error('INSTALLED_VENDOR_ENTRY_REQUIRED');
    if(!residentPlatform)throw new Error('WINDOWS_REQUIRED');
    await resident!.connect(async current=>{
      const pid=await startExternalClient(),deadline=Date.now()+8000;
      while(current()&&Date.now()<deadline){const windows=await native.list();if(!current())break;const targets=windows.filter(window=>window.targetInstanceId.startsWith(`${pid}:`));if(targets.length===1)return targets[0]!.targetInstanceId;if(targets.length>1)throw new Error('AMBIGUOUS_CLIENT_WINDOW');await new Promise<void>(resolve=>setTimeout(resolve,150));}
      throw new Error(current()?'CLIENT_WINDOW_NOT_FOUND':'CONNECTION_SUPERSEDED');
    });
  });
  handle('bind-window',async value=>{if(typeof value!=='string'||!/^\d+:\d+:\d+$/.test(value))throw new Error('INVALID_TARGET');await resident!.connect(async()=>value);});
  handle('unbind-window',()=>resident!.disconnect());handle('connect-composer',()=>service.connectComposer());handle('read-draft',()=>service.readDraft());
  handle('translation-options',value=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_OPTIONS');const options=value as {fallbackTarget?:unknown;language?:unknown;autoTranslate?:unknown;shortcutEnabled?:unknown};if(Object.keys(options).some(key=>!['fallbackTarget','language','autoTranslate','shortcutEnabled'].includes(key))||options.fallbackTarget!==undefined&&!isPanelTarget(options.fallbackTarget)||options.language!==undefined&&!isPanelTarget(options.language)||options.autoTranslate!==undefined&&typeof options.autoTranslate!=='boolean'||options.shortcutEnabled!==undefined&&typeof options.shortcutEnabled!=='boolean')throw new Error('INVALID_OPTIONS');return service.setTranslationOptions(options as {fallbackTarget?:PanelTarget;language?:PanelTarget;autoTranslate?:boolean;shortcutEnabled?:boolean});});
  handle('cancel-translation',()=>service.cancelTranslation());handle('resume-translation',()=>service.resumeTranslation());
  handle('translate',value=>{if(!isPanelTarget(value))throw new Error('INVALID_TARGET_LANGUAGE');return service.translate(value);});handle('replace-draft',()=>service.replaceDraft());
  handle('open-login',()=>service.openLogin());handle('logout',()=>{ownedLogin?.close();return service.logout();});
  handle('copy-translation',()=>{const state=service.getState();if(state.auth!=='ready'||state.phase!=='ready'||!state.preview)throw new Error('PREVIEW_STALE');clipboard.writeText(state.preview);});
  handle('open-translation',openSettings);handle('open-settings',openSettings);
  handle('open-order',()=>{throw new Error('USE_EMBEDDED_ORDER_PANEL');});handle('close-order',()=>{});
  handle('minimize',()=>panel?.minimize());handle('close',hideSettings);
}
function helperPath():string {
  if(process.platform==='darwin')return app.isPackaged?join(process.resourcesPath,'native/macos/TravelMerchant.WindowHelper'):join(app.getAppPath(),'native/macos/bin/TravelMerchant.WindowHelper');
  return app.isPackaged?join(process.resourcesPath,'native/windows/TravelMerchant.WindowHelper.exe'):join(app.getAppPath(),'native/windows/bin/publish/TravelMerchant.WindowHelper.exe');
}
async function cleanup():Promise<void> {
  stopOwnerWatch?.();stopOwnerWatch=undefined;disconnectVendorProgress();
  if(cleaned)return;cleaned=true;acceptanceInput?.close();acceptanceInput=undefined;resident?.dispose();tray?.destroy();tray=undefined;hideSettings();ownedLogin?.close();
  try{await service?.dispose();}finally{native?.stop();}
}
if(ownsInstance)void app.whenReady().then(async()=>{
  if(process.platform==='darwin'&&!smokeMode)configureFingerprintPersistence(join(app.getPath('userData'),'cache','vendor-fingerprints.json'));
  const ownerPID=vendorOwnerPID(process.argv);
  if(silentVendorRuntime&&ownerPID===undefined){console.error('INSTALLED_VENDOR_OWNER_REQUIRED');app.quit();return;}
  let nativeStatus:string|undefined;
  native=new NativeAdapter(helperPath(),stateChanged,status=>{nativeStatus=status;service?.setNativeStatus(status);},()=>{},()=>{},undefined,()=>resident?.notifyTargetAvailable());
  // The helper validates its own owner binding before it reads any command; overlap that
  // process query with owner adoption instead of running the two checks back to back.
  const adopting=ownerPID!==undefined?adoptVendorOwner(ownerPID):undefined,helperStarted=residentPlatform&&!!adopting;
  if(helperStarted)native.start();
  try{await adopting;}catch(error){native.stop();throw error;}
  if(quitting)return;
  diagnostics?.lifecycle('ready',process.pid,ownerPID);
  // Orders open inside the merchant page on both platforms; no external browser windows are created.
  // macOS owns its TSIM account and encrypted credentials. Windows retains its verified browser profile.
  const ownedAccount=process.platform==='darwin';
  if(ownedAccount)ownedLogin=new OwnedLoginWindow();
  const sessionOptions=smokeMode?{enabled:false}:{};
  const ownedStore=ownedAccount?new SecureSessionStore(join(app.getPath('userData'),'account','session.enc'),safeStorage):undefined;
  service=new CompanionService(native,async url=>{
    if(ownedAccount){await ownedLogin!.open(url);return;}
    if(url!=='https://csagent.tsim.tech/login')throw new Error('BROWSER_LOGIN_URL_INVALID');await shell.openExternal(url);
  },()=>{},sessionOptions,true,ownedStore?(changed,options)=>new PersistentSessionService(changed,{...options,embeddedLogin:false,closeLogin:()=>ownedLogin?.close()},ownedStore):undefined,new FileTranslationOptionsStore(join(app.getPath('userData'),'translation-options.json')),undefined,new FileOutboundWaitStore(join(app.getPath('userData'),'outbound-wait.json')));service.onState(publish);
  if(nativeStatus)service.setNativeStatus(nativeStatus);
  resident=new ResidentConnection(native,async()=>{});setupIPC();
  listenForAcceptanceQuit();
  // Installed Windows runs silently inside the vendor; standalone Windows retains tray settings.
  if(residentPlatform){if(process.platform==='darwin'){app.setActivationPolicy('accessory');app.dock?.hide();}if(!helperStarted)native.start();registerSettings();if(process.platform==='win32'&&!silentVendorRuntime)createResidentTray();if(!smokeMode)resident.start();}else service.setNativeStatus('windows_required');
  if(smokeMode){console.log(JSON.stringify({event:'shell_started',electron:process.versions.electron,localWindows:0,trayAvailable:!!tray,residentMode:residentPlatform,embeddedBusinessUI:true,remoteNavigation:false}));setTimeout(()=>{void cleanup().then(()=>{console.log(JSON.stringify({event:'smoke_complete',remoteNavigation:false,credentialsAccessed:false}));app.exit(0);});},1500);}
}).catch(error=>{console.error('SHELL_START_FAILED',error instanceof Error?error.message:'unknown');app.exit(1);});
else app.quit();
app.on('second-instance',(_event,args)=>{
  try{
    const ownerPID=vendorOwnerPID(args);
    if(ownerPID!==undefined){void adoptVendorOwner(ownerPID,args).catch(()=>{console.error('INVALID_VENDOR_OWNER');app.quit();});return;}
    // Repeated launches are background-only; settings require an explicit tray action.
  }catch{console.error('INVALID_VENDOR_OWNER');}
});
// OS activation (including vendor startup) must never summon the settings panel.
app.on('window-all-closed',()=>{if(!quitting&&!residentPlatform)app.quit();});
app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;diagnostics?.lifecycle('quit',process.pid);void cleanup().finally(()=>{if(ownerExitCode){windowsPowerShell.dispose();app.exit(ownerExitCode);}else app.quit();});});
app.once('will-quit',()=>windowsPowerShell.dispose());
