import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { WINDOWS_DYNAMIC_RUNTIME } from '../runtime/build-manifest';
import { windowsInstallationFromHelper } from '../runtime/windows-compatibility.mjs';
import { vendorOwnerPID } from './vendor-owner';
import type { NativeWindow } from '../src/shared/types';
import { isRecord } from '../src/shared/validation';
export interface NativeBounds { x:number; y:number; width:number; height:number }
export interface WindowState { targetInstanceId: string; bounds: NativeBounds; clientBounds?:NativeBounds; visible:boolean; minimized:boolean; foreground:boolean; groupForeground:boolean; dpi:number }
export interface NativeDraftSnapshot { targetInstanceId:string; editorIdentity:string; text:string; revision:string; bounds:NativeBounds; canReplace:boolean }
export interface BrowserLaunchKey {launchId:string}
export interface BrowserLaunchProof extends BrowserLaunchKey {processId:number;startedAtTicks:string}
export interface BrowserComponentMeasurement {launchId:string;closed:boolean;rect:NativeBounds|null}
export interface BrowserWindowMeasurement {launchId:string;bounds:NativeBounds;maximized:boolean}
const launchIdValid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
function validBounds(value:unknown):value is NativeBounds { return isRecord(value) && ['x','y','width','height'].every(key=>typeof value[key]==='number' && Number.isFinite(value[key])) && (value.width as number)>0 && (value.height as number)>0; }
function draftSnapshot(value:unknown, bound:string|null):NativeDraftSnapshot {
  if (!isRecord(value) || value.targetInstanceId!==bound || typeof value.editorIdentity!=='string' || !value.editorIdentity || typeof value.text!=='string' || value.text.length>20000 || typeof value.revision!=='string' || !/^[A-F0-9]{64}$/.test(value.revision) || typeof value.canReplace!=='boolean' || !validBounds(value.bounds)) throw new Error('invalid_native_draft');
  return {targetInstanceId:value.targetInstanceId as string,editorIdentity:value.editorIdentity,text:value.text,revision:value.revision,bounds:value.bounds,canReplace:value.canReplace};
}
export interface NativeTransport { stdin:Writable; stdout:Readable; stderr:Readable; on(event:string, listener:(...args:any[])=>void):unknown; once(event:string, listener:(...args:any[])=>void):unknown; kill():unknown }
export function nativeLaunchArguments(nativePath:string,context={platform:process.platform,installed:WINDOWS_DYNAMIC_RUNTIME,helper:process.execPath,args:process.argv}):string[]{
  if(context.platform!=='win32'||!context.installed)return[];
  const installation=windowsInstallationFromHelper(context.helper),owner=vendorOwnerPID(context.args);
  const expected=win32.join(installation.helperDirectory,'resources','native','windows','TravelMerchant.WindowHelper.exe');
  if(!owner||nativePath.toLowerCase()!==expected.toLowerCase())throw new Error('native_target_binding_rejected');
  return['--vendor-executable',installation.executable,'--vendor-owner',String(owner)];
}
export class NativeAdapter {
  private child: NativeTransport | undefined;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private bound: string | null = null;
  constructor(private path: string, private onState: (state: WindowState | null) => void, private onAvailability: (status:string) => void, private onBrowserLost?:()=>void,private onBrowserGeometry?:(measurement:BrowserComponentMeasurement)=>void,private onBrowserWindowState?:(measurement:BrowserWindowMeasurement)=>void,private onTargetAvailable?:()=>void, private transportFactory?:()=>NativeTransport) {}
  start(): void {
    if (this.child) return;
    if (!this.transportFactory && !existsSync(this.path)) { this.onAvailability('helper_not_built'); return; }
    this.child = this.transportFactory ? this.transportFactory() : spawn(this.path, nativeLaunchArguments(this.path), { stdio: ['pipe','pipe','pipe'], windowsHide: true });
    // Diagnostics contain codes only; draft data travels solely over the private stdout pipe.
    this.child.stderr.on('data', () => this.onAvailability('helper_diagnostic'));
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      if (line.length > 262_144) return;
      let value: unknown; try { value = JSON.parse(line); } catch { return; }
      if (!isRecord(value) || value.protocolVersion !== '1.0' || typeof value.type !== 'string') return;
      if (value.type==='browserLost') this.onBrowserLost?.();
      if(value.type==='targetAvailable')this.onTargetAvailable?.();
      if(value.type==='browserWindowState'&&isRecord(value.payload)&&launchIdValid(value.payload.launchId)&&validBounds(value.payload.bounds)&&typeof value.payload.maximized==='boolean'){
        const b=value.payload.bounds;
        if(Math.abs(b.x)<100000&&Math.abs(b.y)<100000&&b.width<=20000&&b.height<=20000)this.onBrowserWindowState?.({launchId:value.payload.launchId,bounds:{x:b.x,y:b.y,width:b.width,height:b.height},maximized:value.payload.maximized});
      }
      if(value.type==='browserComponentGeometry'&&isRecord(value.payload)&&launchIdValid(value.payload.launchId)&&typeof value.payload.closed==='boolean'&&(value.payload.rect===null||validBounds(value.payload.rect))){
        const rect=value.payload.rect as NativeBounds|null;
        if(!rect||rect.x>=0&&rect.y>=0&&rect.x+rect.width<=20000&&rect.y+rect.height<=20000)this.onBrowserGeometry?.({launchId:value.payload.launchId,closed:value.payload.closed,rect:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null});
      }
      if (typeof value.requestId === 'string') {
        const pending = this.pending.get(value.requestId);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(value.requestId); const code = isRecord(value.payload) && typeof value.payload.code==='string' && /^[a-z_]{1,80}$/.test(value.payload.code) ? value.payload.code : 'native_request_failed'; value.type === 'error' ? pending.reject(new Error(code)) : pending.resolve(value.payload); }
      }
      if (value.type==='targetLost' && value.targetInstanceId===this.bound) { this.bound=null; this.onState(null); this.onAvailability('target_lost'); }
      if (value.type==='windowState' && isRecord(value.payload) && value.payload.bound===false && value.payload.reason==='target_lost' && value.targetInstanceId===this.bound) { this.bound=null; this.onState(null); this.onAvailability('target_lost'); }
      if (value.type === 'windowState' && value.targetInstanceId === this.bound && isRecord(value.payload)) {
        const p = value.payload;
        const bounds=p.bounds;
        if (!validBounds(bounds)) return;
        if (!['visible','minimized','foreground'].every(key => typeof p[key] === 'boolean') || typeof p.dpi !== 'number') return;
        this.onState({ targetInstanceId: this.bound!, bounds, ...(validBounds(p.clientBounds)?{clientBounds:p.clientBounds}:{}), visible:p.visible as boolean, minimized:p.minimized as boolean, foreground:p.foreground as boolean, groupForeground:typeof p.groupForeground==='boolean'?p.groupForeground:p.foreground as boolean, dpi:p.dpi });
      }
    });
    this.child.on('error', () => this.lost('helper_unavailable'));
    this.child.on('exit', () => this.lost('helper_stopped'));
    this.onAvailability('available');
  }
  private lost(status:string): void { this.child = undefined; this.bound = null; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(status)); } this.pending.clear(); this.onState(null); this.onAvailability(status); }
  private request(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error('helper_unavailable'));
    const requestId = randomUUID();
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('helper_timeout')); }, ['launchBrowser','adoptBrowser','cleanupBrowserLaunch'].includes(type)?10000:6000);
      this.pending.set(requestId, { resolve,reject,timer });
      this.child!.stdin.write(`${JSON.stringify({ protocolVersion:'1.0',requestId,type,payload })}\n`, error=>{ if (error) { clearTimeout(timer);this.pending.delete(requestId);reject(new Error('helper_unavailable')); } });
    });
  }
  async list(): Promise<NativeWindow[]> {
    const value = await this.request('listWindows');
    const list = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.windows) ? value.windows : [];
    return list.filter(w=>isRecord(w) && typeof w.targetInstanceId==='string').map(w=>({targetInstanceId:w.targetInstanceId as string,title:typeof w.displayName==='string'?w.displayName:'旅游商家桌面版',processName:typeof w.processName==='string'?w.processName:'旅游商家桌面版'}));
  }
  async bind(id:string): Promise<void> { const previous=this.bound;this.bound = id; try { await this.request('bindWindow', { targetInstanceId:id }); this.onAvailability('available'); } catch (error) { this.bound = previous; throw error; } }
  async unbind(): Promise<void> { this.bound = null; if (this.child) await this.request('unbindWindow'); this.onState(null); }
  async readDraft():Promise<NativeDraftSnapshot> { const bound=this.bound;if (!bound) throw new Error('target_not_bound');const result=await this.request('readDraft');if (this.bound!==bound) throw new Error('draft_expired');return draftSnapshot(result,bound); }
  async replaceDraft(_expected:NativeDraftSnapshot,_text:string):Promise<NativeDraftSnapshot> { throw new Error('verified_editor_required'); }
  async launchBrowser(options:BrowserLaunchKey&{profilePath:string;appURL:string}):Promise<BrowserLaunchProof> {
    if(!launchIdValid(options.launchId)||!options.profilePath||!options.appURL)throw new Error('invalid_browser_identity');
    const value=await this.request('launchBrowser',{...options});
    if(!isRecord(value)||value.launchId!==options.launchId||!Number.isSafeInteger(value.processId)||(value.processId as number)<=0||typeof value.startedAtTicks!=='string'||!/^\d{16,20}$/.test(value.startedAtTicks))throw new Error('invalid_browser_identity');
    return Object.freeze({launchId:options.launchId,processId:value.processId as number,startedAtTicks:value.startedAtTicks});
  }
  async adoptBrowser(options:BrowserLaunchProof):Promise<void> { if (!launchIdValid(options.launchId)||!Number.isSafeInteger(options.processId)||options.processId<=0||!/^\d{16,20}$/.test(options.startedAtTicks)) throw new Error('invalid_browser_identity');await this.request('adoptBrowser',{...options}); }
  async placeBrowser(options:{bounds:NativeBounds;visible:boolean;restack?:boolean;maximized?:boolean}):Promise<void> { if (!validBounds(options.bounds)||options.maximized!==undefined&&typeof options.maximized!=='boolean') throw new Error('invalid_browser_bounds');await this.request('placeBrowser',options); }
  async adoptSharedBrowser(marker:string):Promise<void> {if(!launchIdValid(marker))throw new Error('invalid_browser_identity');await this.request('adoptSharedBrowser',{marker});}
  async releaseSharedBrowser():Promise<void> {await this.request('releaseSharedBrowser');}
  async launchProfileBrowser(options:{launchId:string;browserKind:'edge'|'chrome';profileDirectory:string;bootstrapURL:string}):Promise<void>{
    if(!launchIdValid(options.launchId)||!['edge','chrome'].includes(options.browserKind)||!/^(?:Default|Profile [1-9]\d*)$/.test(options.profileDirectory))throw new Error('invalid_browser_profile');
    await this.request('launchProfileBrowser',{...options});
  }
  async adoptProfileBrowser(launchId:string):Promise<void>{if(!launchIdValid(launchId))throw new Error('invalid_browser_identity');await this.request('adoptProfileBrowser',{launchId});}
  async heartbeatProfileBrowser(launchId:string):Promise<void>{if(!launchIdValid(launchId))throw new Error('invalid_browser_identity');await this.request('heartbeatProfileBrowser',{launchId});}
  async cleanupProfileBrowser(launchId:string):Promise<{complete:boolean}>{
    if(!launchIdValid(launchId))throw new Error('invalid_browser_identity');const value=await this.request('cleanupProfileBrowser',{launchId});
    if(!isRecord(value)||typeof value.complete!=='boolean')throw new Error('invalid_browser_cleanup');return{complete:value.complete};
  }
  async cleanupBrowserLaunch(options:BrowserLaunchKey):Promise<{complete:boolean}> {
    if(!launchIdValid(options.launchId))throw new Error('invalid_browser_identity');
    const value=await this.request('cleanupBrowserLaunch',{launchId:options.launchId});
    if(!isRecord(value)||typeof value.complete!=='boolean')throw new Error('invalid_browser_cleanup');return{complete:value.complete};
  }
  async setCompanionWindows(handles:string[]):Promise<void> { if (handles.length>16 || handles.some(h=>! /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(h))) throw new Error('invalid_window_handle');await this.request('setCompanionWindows',{handles}); }
  stop(): void { const child=this.child;if (child) { child.stdin.end(); const timer=setTimeout(()=>child.kill(),20000);timer.unref();child.once('exit',()=>clearTimeout(timer)); } this.lost('helper_stopped'); }
}
