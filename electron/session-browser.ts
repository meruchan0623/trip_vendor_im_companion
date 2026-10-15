import type { Bounds } from './layout';
import type { OperatorSelection } from './system-browser';

export interface BrowserSessionOrderPort {
  openOrder(selection:OperatorSelection,bounds:Bounds):Promise<{windowId:number;marker:string}>;
  closeOrder(windowId:number):Promise<void>;
}
interface SharedNativePort {
  adoptSharedBrowser(marker:string):Promise<void>;
  releaseSharedBrowser():Promise<void>;
  placeBrowser(options:{bounds:Bounds;visible:boolean}):Promise<void>;
}
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
/** Orders run in the extension's existing browser profile. No browser credentials are copied. */
export class SessionBrowser {
  private generation=0;
  private queue:Promise<unknown>=Promise.resolve();
  private windowId:number|null=null;
  private adopted=false;
  private pending:{bounds:Bounds;visible:boolean}|null=null;
  private applied='';
  private placing=false;
  constructor(private native:SharedNativePort,private session:BrowserSessionOrderPort,private failed:(code:'BROWSER_PLACEMENT_FAILED')=>void=()=>{}){}
  private async retire(){
    this.adopted=false;this.applied='';
    const id=this.windowId;if(id===null)return;
    await this.native.releaseSharedBrowser().catch(()=>{});
    await this.session.closeOrder(id);
    this.windowId=null;
  }
  async open(selection:OperatorSelection,bounds:Bounds):Promise<void>{
    const generation=++this.generation;this.adopted=false;
    const operation=this.queue.then(async()=>{
      await this.retire();if(generation!==this.generation)return;
      const popup=await this.session.openOrder(selection,bounds);this.windowId=popup.windowId;
      try{
        const deadline=Date.now()+8000;
        for(;;){
          if(generation!==this.generation){await this.retire();return;}
          try{await this.native.adoptSharedBrowser(popup.marker);break;}
          catch(error){if(!(error instanceof Error)||error.message!=='browser_window_pending'||Date.now()>=deadline)throw error;await delay(150);}
        }
        if(generation!==this.generation){await this.retire();return;}
        this.adopted=true;this.pending={bounds:{...bounds},visible:false};
        await this.native.placeBrowser(this.pending);this.applied=JSON.stringify(this.pending);
      }catch(error){await this.retire();throw error;}
    });
    this.queue=operation.catch(()=>{});await operation;
  }
  place(bounds:Bounds,visible:boolean):void{
    this.pending={bounds:{...bounds},visible};if(this.placing||!this.adopted)return;
    this.placing=true;const generation=this.generation;
    void(async()=>{
      while(this.adopted&&generation===this.generation&&this.pending){
        const current=this.pending,key=JSON.stringify(current);if(key===this.applied)return;
        let success=false;
        for(let attempt=0;attempt<3;attempt++){
          if(generation!==this.generation||!this.adopted)return;
          if(this.pending!==current)break;
          try{await this.native.placeBrowser(current);success=true;break;}
          catch{if(attempt<2)await delay(150*(attempt+1));}
        }
        if(generation!==this.generation)return;
        if(success)this.applied=key;
        else if(this.pending===current)throw new Error('BROWSER_PLACEMENT_FAILED');
      }
    })().catch(async()=>{
      if(generation!==this.generation)return;
      this.adopted=false;
      const operation=this.queue.then(()=>this.retire());this.queue=operation.catch(()=>{});
      await operation.catch(()=>{});if(generation===this.generation)this.failed('BROWSER_PLACEMENT_FAILED');
    }).finally(()=>{this.placing=false;if(this.adopted&&this.pending&&JSON.stringify(this.pending)!==this.applied)this.place(this.pending.bounds,this.pending.visible);});
  }
  async close():Promise<void>{
    ++this.generation;this.adopted=false;this.pending=null;
    const operation=this.queue.then(()=>this.retire());this.queue=operation.catch(()=>{});await operation;
  }
  handleLost():void{void this.close().catch(()=>{});}
}
