/** Owns helper resources only. A late setup result is closed even after cancellation has finished. */
export class SetupScope{
  private cancelled=false;private cleanups:(()=>Promise<void>)[]=[];private closing:Promise<void>|undefined;
  async acquire<T>(pending:Promise<T>,dispose:(resource:T)=>Promise<void>):Promise<T>{
    const resource=await pending;
    if(this.cancelled){try{await dispose(resource);}finally{throw new Error('USER_CANCELLED');}}
    let disposed=false;this.cleanups.push(async()=>{if(disposed)return;disposed=true;await dispose(resource);});return resource;
  }
  close():Promise<void>{
    this.cancelled=true;
    return this.closing??=Promise.resolve().then(async()=>{const callbacks=this.cleanups.splice(0).reverse();let failed=false;for(const cleanup of callbacks){try{await cleanup();}catch{failed=true;}}if(failed)throw new Error('HELPER_CLEANUP_FAILED');});
  }
}
