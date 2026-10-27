/** Host-owned recovery: restarting the native process never changes the vendor client. */
export class NativeRecovery {
  private stopped=false;
  private attempts=0;
  private retry?:ReturnType<typeof setTimeout>;
  private stable?:ReturnType<typeof setTimeout>;
  constructor(private start:()=>void,private exhausted:()=>void){}
  status(status:string){
    if(this.stopped||!['helper_stopped','helper_unavailable'].includes(status))return;
    clearTimeout(this.stable);this.stable=undefined;
    if(this.retry)return;
    const delays=[1000,3000,10000];
    if(this.attempts>=delays.length){this.exhausted();return;}
    this.retry=setTimeout(()=>{this.retry=undefined;if(this.stopped)return;this.attempts++;try{this.start();}catch{this.status('helper_unavailable');}},delays[this.attempts]);
    this.retry.unref?.();
  }
  ready(){
    if(this.stopped||this.stable)return;
    // A capability alone does not reset a repeated crash loop.
    this.stable=setTimeout(()=>{this.stable=undefined;this.attempts=0;},60000);this.stable.unref?.();
  }
  dispose(){this.stopped=true;clearTimeout(this.retry);clearTimeout(this.stable);this.retry=this.stable=undefined;}
}
