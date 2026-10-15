import { EventEmitter } from 'node:events';
import { PassThrough, Writable, type Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import type { NativeTransport } from '../electron/native-adapter';
import type { StandaloneState } from '../src/shared/companion-api';
import { isPanelTarget } from '../src/shared/workbench';
import { stateErrorCode } from './diagnostics';

export const MAX_LINE_BYTES=262144;
const actions=['status','refreshSession','openLogin','logout','connect','disconnect','pause','resume','startClient','quit','updateSettings','followCustomerLanguage'] as const;
export interface HostAction {protocolVersion:'1.0';type:'hostAction';requestId:string;payload:{action:typeof actions[number];options?:{language?:StandaloneState['language'];autoTranslate?:boolean;shortcutEnabled?:boolean}}}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function parseHostAction(v:unknown):HostAction|null {
  if(!record(v)||v.protocolVersion!=='1.0'||v.type!=='hostAction'||typeof v.requestId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(v.requestId)||!record(v.payload)||!actions.includes(v.payload.action as any))return null;
  if(Object.keys(v).some(k=>!['protocolVersion','type','requestId','payload'].includes(k))||Object.keys(v.payload).some(k=>!['action','options'].includes(k)))return null;
  const o=v.payload.options;
  if(v.payload.action==='updateSettings'){
    if(!record(o)||Object.keys(o).some(k=>!['language','autoTranslate','shortcutEnabled'].includes(k))||o.language!==undefined&&!isPanelTarget(o.language)||o.autoTranslate!==undefined&&typeof o.autoTranslate!=='boolean'||o.shortcutEnabled!==undefined&&typeof o.shortcutEnabled!=='boolean')return null;
  }else if(o!==undefined)return null;
  return v as unknown as HostAction;
}
/** Explicit projection: native tray never receives draft, preview, identity or credentials. */
export function stateProjection(s:StandaloneState,orderStatus:string){return {attached:s.attached,auth:s.auth,phase:s.phase,composerSource:s.composerSource,nativeStatus:/^[a-z_]{1,80}$/.test(s.nativeStatus)?s.nativeStatus:'unknown',translationPaused:!!s.translationPaused,hasPreview:!!s.preview,language:s.language,autoTranslate:!!s.autoTranslate,shortcutEnabled:!!s.shortcutEnabled,followCustomerLanguage:s.followCustomerLanguage!==false,errorCode:stateErrorCode(s.error),orderStatus:['idle','loading','ready','failed','empty'].includes(orderStatus)?orderStatus:'unknown'};}

/** Bound allocation before newline; readline alone does not impose a memory limit. */
export class BoundedJsonLines {
  private parts:Buffer[]=[];private size=0;private failed=false;
  constructor(private message:(value:unknown)=>void,private failure:()=>void){}
  push(chunk:Buffer){
    if(this.failed)return;
    let start=0;
    for(let i=0;i<=chunk.length;i++)if(i===chunk.length||chunk[i]===10){
      const part=chunk.subarray(start,i);this.size+=part.length;
      if(this.size>MAX_LINE_BYTES){this.fail();return;}
      if(part.length)this.parts.push(part);
      if(i<chunk.length){
        const line=Buffer.concat(this.parts,this.size);this.parts=[];this.size=0;
        try{const text=new TextDecoder('utf-8',{fatal:true}).decode(line);if(text.trim())this.message(JSON.parse(text));}catch{this.fail();return;}
      }
      start=i+1;
    }
  }
  end(){if(this.size)this.fail();}
  private fail(){this.failed=true;this.parts=[];this.size=0;this.failure();}
}

/** Private parent pipe masquerades only as transport, never as a spawned child. */
export class ParentNativeTransport extends EventEmitter implements NativeTransport {
  stdout=new PassThrough();stderr=new PassThrough();stdin:Writable;private closed=false;
  constructor(write:(value:unknown)=>void){super();this.stdin=new Writable({write:(chunk,_encoding,callback)=>{try{write(JSON.parse(chunk.toString()));callback();}catch{callback(new Error('PARENT_PIPE_FAILED'));}},final:callback=>{this.kill();callback();}});}
  receive(value:unknown){if(!this.closed)this.stdout.write(JSON.stringify(value)+'\n');}
  kill(){if(this.closed)return;this.closed=true;this.stdout.end();this.stderr.end();this.emit('exit');}
}

export function attachProtocol(input:Readable,onMessage:(value:unknown)=>void,onClose:()=>void){
  let closed=false;const close=()=>{if(closed)return;closed=true;onClose();};
  const parser=new BoundedJsonLines(onMessage,close);
  const data=(chunk:Buffer|string)=>{if(!closed)parser.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));};
  const end=()=>{parser.end();close();};
  input.on('data',data);input.once('end',end);input.once('error',close);
  return ()=>{closed=true;input.off('data',data);input.off('end',end);input.off('error',close);};
}
