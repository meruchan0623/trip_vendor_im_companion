import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';

const FAILURE = 'WINDOWS_POWERSHELL_EXECUTION_FAILED';
const MAX_OUTPUT = 256_000;
const TIMEOUT_MS = 15_000;
const IDLE_MS = 5_000;

// EncodedCommand avoids command-line quoting. Each input line is one complete
// UTF-8 script, so multiline scripts never consume the next request's input.
const BOOTSTRAP = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$requestId=0
while ($null -ne ($line=[Console]::In.ReadLine())) {
  $requestId++
  try {
    $script=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
    $output=& { $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; & ([ScriptBlock]::Create($script)) } | Out-String -Width 32768
    $frame=ConvertTo-Json -InputObject @{id=$requestId;ok=$true;output=[string]$output} -Compress
  } catch {
    $frame=ConvertTo-Json -InputObject @{id=$requestId;ok=$false;error='${FAILURE}'} -Compress
  }
  [Console]::Out.WriteLine($frame)
  [Console]::Out.Flush()
}
`;

interface Request {
  script:string;
  resolve:(value:unknown)=>void;
  reject:(error:Error)=>void;
}
interface Session {
  child:ChildProcessWithoutNullStreams;
  id:number;
  buffer:string;
  bytes:number;
  active?:Request;
  timeout?:ReturnType<typeof setTimeout>;
  idle?:ReturnType<typeof setTimeout>;
}

/** Internal executor for the runtime's fixed read-only inspection scripts. */
export class WindowsPowerShell {
  private session?:Session;
  private queue:Request[]=[];
  private disposed=false;

  execute(script:string):Promise<unknown> {
    if(this.disposed)return Promise.reject(new Error(FAILURE));
    return new Promise((resolve,reject)=>{
      this.queue.push({script,resolve,reject});
      this.pump();
    });
  }

  dispose():void {
    this.disposed=true;
    this.fail(this.session);
  }

  private pump():void {
    if(this.session?.active||!this.queue.length)return;
    let session=this.session;
    if(!session){
      try {
        const env={...process.env};
        for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
        const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(BOOTSTRAP,'utf16le').toString('base64')],{env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
        session={child,id:0,buffer:'',bytes:0};
        this.session=session;
        const current=session;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data',(chunk:string)=>this.receive(current,chunk));
        child.stderr.on('data',(chunk:Buffer|string)=>{if(chunk.length)this.fail(current);});
        child.on('error',()=>this.fail(current));
        child.on('close',()=>this.fail(current));
        child.stdin.on('error',()=>this.fail(current));
        child.stdout.on('error',()=>this.fail(current));
        child.stderr.on('error',()=>this.fail(current));
      } catch {
        this.fail();
        return;
      }
    }
    if(session.idle)clearTimeout(session.idle);
    session.idle=undefined;
    this.reference(session,true);
    session.active=this.queue.shift()!;
    session.id++;
    session.bytes=0;
    session.timeout=setTimeout(()=>this.fail(session),TIMEOUT_MS);
    try {
      session.child.stdin.write(Buffer.from(session.active.script,'utf8').toString('base64')+'\n',(error)=>{if(error)this.fail(session);});
    } catch {
      this.fail(session);
    }
  }

  private receive(session:Session,chunk:string):void {
    if(this.session!==session)return;
    session.bytes+=Buffer.byteLength(chunk,'utf8');
    if(!session.active||session.bytes>MAX_OUTPUT){this.fail(session);return;}
    session.buffer+=chunk;
    const newline=session.buffer.indexOf('\n');
    if(newline<0)return;
    // Exactly one frame per request, with no trailing banners or extra lines.
    if(newline!==session.buffer.length-1){this.fail(session);return;}
    let result:unknown;
    try {
      const frame=JSON.parse(session.buffer.slice(0,newline));
      if(!frame||typeof frame!=='object'||Array.isArray(frame)||frame.id!==session.id||frame.ok!==true||typeof frame.output!=='string'||Object.keys(frame).sort().join(',')!=='id,ok,output')throw new Error(FAILURE);
      result=JSON.parse(frame.output.trim());
    } catch {
      this.fail(session);
      return;
    }
    clearTimeout(session.timeout);
    session.timeout=undefined;
    session.buffer='';
    const request=session.active;
    session.active=undefined;
    request.resolve(result);
    if(this.queue.length)this.pump();
    else {
      this.reference(session,false);
      session.idle=setTimeout(()=>{if(this.session===session&&!session.active)this.fail(session);},IDLE_MS);
      session.idle.unref();
    }
  }

  private reference(session:Session,ref:boolean):void {
    session.child[ref?'ref':'unref']();
    for(const stream of [session.child.stdin,session.child.stdout,session.child.stderr]){
      // Pipe sockets have ref/unref in Node; ordinary streams used in tests may not.
      const socket=stream as typeof stream & {ref?:()=>void;unref?:()=>void};
      socket[ref?'ref':'unref']?.();
    }
  }

  private fail(session?:Session):void {
    if(session&&this.session!==session)return;
    const current=session??this.session;
    this.session=undefined;
    if(current){
      clearTimeout(current.timeout);
      clearTimeout(current.idle);
      current.active?.reject(new Error(FAILURE));
      try{current.child.kill();}catch{/* Never expose native errors or paths. */}
    }
    for(const request of this.queue.splice(0))request.reject(new Error(FAILURE));
  }
}

export const windowsPowerShell=new WindowsPowerShell();
