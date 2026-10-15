import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { IdentifierType } from '../src/shared/types';
import type { Bounds } from './layout';
import type { BrowserLaunchKey, BrowserLaunchProof } from './native-adapter';
export interface BrowserNativePort {
  launchBrowser(options:BrowserLaunchKey&{profilePath:string;appURL:string}):Promise<BrowserLaunchProof>;
  adoptBrowser(options:BrowserLaunchProof):Promise<void>;
  placeBrowser(options:{bounds:Bounds;visible:boolean}):Promise<void>;
  cleanupBrowserLaunch(options:BrowserLaunchKey):Promise<{complete:boolean}>;
}
export interface OperatorSelection {identifier:string;identifierType:IdentifierType;requestId:string}
export function operatorURL(selection:OperatorSelection):string {
  if (!selection.identifier.trim() || selection.identifier.length>128 || /[\r\n\u0000]/.test(selection.identifier)
    || !['order_number','iccid','eiccid'].includes(selection.identifierType) || !/^[\w-]{1,100}$/.test(selection.requestId)) throw new Error('INVALID_ORDER_IDENTIFIER');
  const url=new URL('https://csagent.tsim.tech/embed/operator');
  url.search=new URLSearchParams({identifier:selection.identifier,identifierType:selection.identifierType,requestId:selection.requestId}).toString();
  url.searchParams.set('source','travel-merchant-companion');return url.href;
}
// Diagnostic argument builders only. Production spawn is exclusively inside the native lease.
export function edgeExecutable(env:NodeJS.ProcessEnv=process.env):string {
  for(const root of [env['ProgramFiles(x86)'],env.ProgramFiles,env.LOCALAPPDATA])if(root){const path=join(root,'Microsoft','Edge','Application','msedge.exe');if(existsSync(path))return path;}
  throw new Error('EDGE_NOT_INSTALLED');
}
export function edgeArguments(profilePath:string,url:string,bounds:Bounds):string[] {
  return [`--user-data-dir=${resolve(profilePath)}`,'--no-first-run','--no-default-browser-check','--disable-background-mode',`--app=${url}`,`--window-position=${Math.round(bounds.x)},${Math.round(bounds.y)}`,`--window-size=${Math.round(bounds.width)},${Math.round(bounds.height)}`];
}
const delay=()=>new Promise<void>(resolve=>setTimeout(resolve,150));
/** Native holds the exact spawn identity and cleans every owned app window, including late ones. */
export class SystemBrowser {
  private generation=0;
  private queue:Promise<unknown>=Promise.resolve();
  private adopted=false;
  private lease:BrowserLaunchKey|null=null;
  private blocked=false;
  private placement:{bounds:Bounds;visible:boolean}|null=null;
  private appliedPlacement='';
  private placementWork:{generation:number;promise:Promise<void>}|null=null;
  private placementFailureGeneration=-1;
  private openingGeneration:number|null=null;
  constructor(private native:BrowserNativePort,private profilePath:string,private onPlacementFailure:(code:'BROWSER_PLACEMENT_FAILED')=>void=code=>console.error(code)) {}
  private placementKey(value:{bounds:Bounds;visible:boolean}|null):string {
    return value?JSON.stringify([value.bounds.x,value.bounds.y,value.bounds.width,value.bounds.height,value.visible]):'';
  }
  private async applyPlacement(generation:number):Promise<void> {
    let failedKey='',failures=0;
    while(generation===this.generation&&this.adopted&&this.placement){
      const current=this.placement,key=this.placementKey(current);
      if(key===this.appliedPlacement)return;
      try{await this.native.placeBrowser(current);}
      catch{
        if(generation!==this.generation||!this.adopted)return;
        if(key!==this.placementKey(this.placement)){failedKey='';failures=0;continue;}
        failures=key===failedKey?failures+1:1;failedKey=key;
        if(failures>=3)throw new Error('BROWSER_PLACEMENT_FAILED');
        await new Promise<void>(resolve=>setTimeout(resolve,150*failures));continue;
      }
      if(generation!==this.generation||!this.adopted)return;
      this.appliedPlacement=key;failedKey='';failures=0;
    }
  }
  private async ensurePlacement(generation:number):Promise<void> {
    while(generation===this.generation&&this.adopted&&this.placementKey(this.placement)!==this.appliedPlacement){
      let work=this.placementWork;
      if(!work){
        work={generation,promise:Promise.resolve()};const current=work;
        current.promise=this.applyPlacement(generation).finally(()=>{if(this.placementWork===current)this.placementWork=null;});
        this.placementWork=current;
      }
      try{await work.promise;}catch(error){if(work.generation===generation)throw error;}
    }
  }
  private placementFailed(generation:number):void {
    if(generation!==this.generation||this.placementFailureGeneration===generation)return;
    this.placementFailureGeneration=generation;this.adopted=false;
    // Retire the owned HWND before telling main to clear its browser-open state/cache.
    const retiring=this.queue.then(()=>this.cleanup());this.queue=retiring.catch(()=>{});
    void retiring.catch(()=>{}).then(()=>{if(generation===this.generation)this.onPlacementFailure('BROWSER_PLACEMENT_FAILED');}).catch(()=>console.error('BROWSER_PLACEMENT_FAILED'));
  }
  private async cleanup():Promise<void> {
    this.adopted=false;this.appliedPlacement='';
    if(!this.lease)return;
    const deadline=Date.now()+12000;
    try{
      for(;;){const result=await this.native.cleanupBrowserLaunch(this.lease);if(result.complete){this.lease=null;return;}if(Date.now()>=deadline)throw new Error('cleanup_pending');await delay();}
    }catch{this.blocked=true;throw new Error('BROWSER_CLEANUP_UNCONFIRMED');}
  }
  async open(selection:OperatorSelection,bounds:Bounds):Promise<void> {
    const appURL=operatorURL(selection),generation=++this.generation;
    this.adopted=false;this.openingGeneration=generation;
    const operation=this.queue.then(async()=>{
      if(this.blocked)throw new Error('BROWSER_CLEANUP_UNCONFIRMED');
      await this.cleanup();if(generation!==this.generation)return;
      const key={launchId:randomUUID()};this.lease=key;
      try{
        const proof=await this.native.launchBrowser({...key,profilePath:resolve(this.profilePath),appURL});
        if(proof.launchId!==key.launchId)throw new Error('invalid_browser_identity');
        if(generation!==this.generation){await this.cleanup();return;}
        const deadline=Date.now()+8000;
        for(;;){
          if(generation!==this.generation){await this.cleanup();return;}
          try{await this.native.adoptBrowser(proof);break;}
          catch(error){if(!(error instanceof Error)||error.message!=='browser_window_pending'||Date.now()>=deadline)throw error;await delay();}
        }
        if(generation!==this.generation){await this.cleanup();return;}
        this.adopted=true;this.placement??={bounds:{...bounds},visible:false};await this.ensurePlacement(generation);
      }catch(error){
        // These explicit native rejections precede registration/spawn. Timeout/unknown errors do not.
        if(error instanceof Error&&['browser_profile_busy','browser_profile_denied','browser_url_denied','browser_cleanup_pending','edge_not_installed'].includes(error.message))this.lease=null;
        else await this.cleanup();
        if(generation!==this.generation)return;
        throw new Error(error instanceof Error&&['BROWSER_CLEANUP_UNCONFIRMED','BROWSER_PLACEMENT_FAILED'].includes(error.message)?error.message:'BROWSER_ADOPTION_FAILED');
      }
    });
    this.queue=operation.catch(()=>{});
    try{await operation;}finally{if(this.openingGeneration===generation)this.openingGeneration=null;}
  }
  place(bounds:Bounds,visible:boolean):void {
    this.placement={bounds:{...bounds},visible};if(!this.adopted)return;
    const generation=this.generation;void this.ensurePlacement(generation).catch(()=>{if(this.openingGeneration!==generation)this.placementFailed(generation);});
  }
  async close():Promise<void> {
    ++this.generation;this.adopted=false;this.placement=null;
    const operation=this.queue.then(()=>this.cleanup());this.queue=operation.catch(()=>{});await operation;
  }
  handleLost():void {++this.generation;this.adopted=false;this.placement=null;const operation=this.queue.then(()=>this.cleanup());this.queue=operation.catch(()=>{});}
}
