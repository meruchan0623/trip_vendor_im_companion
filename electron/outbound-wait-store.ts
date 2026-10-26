import {mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {OutboundWaitPersisted} from '../runtime/outbound-wait-controller';
export interface OutboundWaitStore {
  load(accountScope:string):Promise<OutboundWaitPersisted|null>;
  save(accountScope:string,state:OutboundWaitPersisted):Promise<void>;
  clear(accountScope:string):Promise<void>;
}
const scopeValid=(scope:string)=>/^psim:[A-Za-z0-9_-]{1,128}$/.test(scope);
const stateValid=(value:unknown):value is OutboundWaitPersisted=>{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const s=value as OutboundWaitPersisted;
  return Object.keys(s).sort().join(',')==='sent,updatedAt,useful,v,waitMs,wasted'&&s.v===1&&Number.isFinite(s.waitMs)&&s.waitMs>=100&&s.waitMs<=3000&&Number.isFinite(s.updatedAt)&&[s.sent,s.wasted,s.useful].every(v=>Number.isSafeInteger(v)&&v>=0);
};
/** Only numeric feedback is stored. updatedAt is converted at this wall/monotonic boundary. */
export class FileOutboundWaitStore implements OutboundWaitStore {
  private queue:Promise<void>=Promise.resolve();
  constructor(private path:string,private monotonic=()=>performance.now(),private wall=()=>Date.now()){}
  private async read():Promise<Record<string,OutboundWaitPersisted>> {
    let text:string;try{text=await readFile(this.path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{};throw new Error('OUTBOUND_WAIT_READ_FAILED');}
    try{if(text.length>131072)throw new Error();const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>256||!Object.entries(value).every(([scope,state])=>scopeValid(scope)&&stateValid(state)))throw new Error();return value;}catch{throw new Error('OUTBOUND_WAIT_INVALID');}
  }
  async load(scope:string):Promise<OutboundWaitPersisted|null>{
    if(!scopeValid(scope))return null;await this.queue;const state=(await this.read())[scope];
    return state?{...state,updatedAt:this.monotonic()-(this.wall()-state.updatedAt)}:null;
  }
  private mutate(scope:string,state:OutboundWaitPersisted|null):Promise<void>{
    if(!scopeValid(scope)||state&&!stateValid(state))return Promise.reject(new Error('OUTBOUND_WAIT_INVALID'));
    const saved=state?{...state,updatedAt:this.wall()-(this.monotonic()-state.updatedAt)}:null;
    const task=this.queue.then(async()=>{
      const records=await this.read();if(saved)records[scope]=saved;else delete records[scope];
      const text=JSON.stringify(records)+'\n';if(Object.keys(records).length>256||text.length>131072)throw new Error('OUTBOUND_WAIT_INVALID');
      const temporary=this.path+'.'+randomUUID()+'.tmp';
      try{await mkdir(dirname(this.path),{recursive:true});await writeFile(temporary,text,{encoding:'utf8',mode:0o600,flag:'wx'});await rename(temporary,this.path);}catch{throw new Error('OUTBOUND_WAIT_SAVE_FAILED');}finally{await unlink(temporary).catch(()=>{});}
    });this.queue=task.catch(()=>{});return task;
  }
  save(scope:string,state:OutboundWaitPersisted){return this.mutate(scope,state);}
  clear(scope:string){return this.mutate(scope,null);}
}
