/** Serializes native mutations; a newer user intent invalidates pending discovery/launch. */
export class ResidentConnection {
  private epoch=0;
  private stopped=false;
  private started=false;
  private paused=false;
  private bound=false;
  private stateRevision=0;
  private pending:number|null=null;
  private discovering=false;
  private tail:Promise<unknown>=Promise.resolve();
  private timer:ReturnType<typeof setTimeout>|undefined;
  constructor(private adapter:{list():Promise<{targetInstanceId:string}[]>;bind(id:string):Promise<void>;unbind():Promise<void>},private beforeBind:()=>Promise<void>,private intervalMs=30000,private onAutoBound:()=>void=()=>{}){}
  setBound(bound:boolean):void{
    const lost=this.bound&&!bound;this.bound=bound;++this.stateRevision;
    if(bound&&this.timer){clearTimeout(this.timer);this.timer=undefined;}
    if(lost&&this.started)this.schedule(0);
  }
  notifyTargetAvailable():void{
    if(!this.started||this.stopped||this.bound||this.paused)return;
    this.schedule(150);
  }
  private schedule(delay=this.intervalMs):void{
    if(this.stopped||this.bound||this.paused)return;
    if(this.timer)clearTimeout(this.timer);
    this.timer=setTimeout(()=>{this.timer=undefined;void this.poll();},delay);this.timer.unref?.();
  }
  start():void{if(this.started||this.stopped)return;this.started=true;void this.poll();}
  private async poll():Promise<void>{
    await this.discover();
    this.schedule();
  }
  private valid(epoch:number):boolean{return !this.stopped&&epoch===this.epoch;}
  private check(epoch:number):void{if(!this.valid(epoch))throw new Error('CONNECTION_SUPERSEDED');}
  private enqueue(epoch:number,operation:()=>Promise<void>):Promise<void>{
    const result=this.tail.then(async()=>{this.check(epoch);await operation();this.check(epoch);});
    this.tail=result.catch(()=>{});return result;
  }
  private async bind(epoch:number,target:string,automatic=false):Promise<void>{
    await this.beforeBind();this.check(epoch);
    const revision=this.stateRevision;
    await this.adapter.bind(target);
    if(!this.valid(epoch))return;
    // A native loss notification may arrive before the bind acknowledgement.
    if(revision===this.stateRevision)this.bound=true;
    if(automatic&&this.bound)this.onAutoBound();
  }
  async discover():Promise<void>{
    if(this.stopped||this.paused||this.bound||this.pending!==null||this.discovering)return;
    this.discovering=true;const epoch=this.epoch;
    try{
      const windows=await this.adapter.list();
      if(!this.valid(epoch)||this.paused||this.bound||this.pending!==null)return;
      // Native discovery orders eligible clients by foreground/visibility. Keep
      // the current binding stable until loss; never ask the user to pick one.
      for(const window of windows){
        if(!this.valid(epoch)||this.paused||this.bound||this.pending!==null)return;
        try{await this.enqueue(epoch,()=>this.bind(epoch,window.targetInstanceId,true));}
        catch{if(!this.valid(epoch))return;}
      }
    }catch{/* No target/helper yet: retry quietly without reopening settings. */}
    finally{this.discovering=false;}
  }
  async connect(resolveTarget:(current:()=>boolean)=>Promise<string>):Promise<void>{
    const epoch=++this.epoch;this.pending=epoch;this.paused=false;
    try{
      this.check(epoch);
      const target=await resolveTarget(()=>this.valid(epoch));this.check(epoch);
      await this.enqueue(epoch,()=>this.bind(epoch,target));
    }finally{if(this.pending===epoch)this.pending=null;}
  }
  async disconnect():Promise<void>{
    const epoch=++this.epoch;this.paused=true;this.pending=epoch;
    try{await this.enqueue(epoch,async()=>{await this.beforeBind();this.check(epoch);await this.adapter.unbind();this.bound=false;});}
    finally{if(this.pending===epoch)this.pending=null;}
  }
  dispose():void{this.stopped=true;++this.epoch;if(this.timer)clearTimeout(this.timer);this.timer=undefined;}
}
