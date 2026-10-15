import{OwnedPsimService}from'./owned-service';
import{startOwnedLoginServer}from'./auth-server';
import type{OutboundBody,PsimIdentity}from'../src/shared/workbench';
export async function runOwnedAuthWorker(){
  if(!process.send||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw new Error('OWNED_AUTH_CHANNEL_REQUIRED');
  const emit=(value:unknown)=>{if(process.connected)process.send!(value);};
  const service=new OwnedPsimService(fetch,identity=>emit({type:'auth',identity}));const server=await startOwnedLoginServer(service);const pending=new Map<string,AbortController>();let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;for(const controller of pending.values())controller.abort();pending.clear();await server.close();if(process.connected)process.disconnect();};
  process.on('disconnect',()=>{void stop();});
  process.on('message',message=>{void(async()=>{const data=message as Record<string,unknown>;if(!data||typeof data.id!=='string'||!/^[a-z0-9-]{1,100}$/i.test(data.id)||typeof data.type!=='string')return;const id=data.id;
    if(data.type==='stop'){await stop();return;}if(stopping)return;
    if(data.type==='cancel'){pending.get(id)?.abort();return;}
    if(pending.has(id)){emit({type:'response',id,ok:false,error:'DUPLICATE_REQUEST'});return;}
    const controller=new AbortController();pending.set(id,controller);
    try{let value:unknown;if(data.type==='identity')value=service.identity();else if(data.type==='refresh')value=await service.refresh();else if(data.type==='logout'){await service.logout();value=null;}else if(data.type==='translate')value=await service.translate(data.body as OutboundBody,data.identity as PsimIdentity,controller.signal);else if(data.type==='query')value=await service.queryOriginalIdentifier(data.identifier as string,data.identity as PsimIdentity,controller.signal);else throw new Error('FORBIDDEN_OWNED_COMMAND');if(!controller.signal.aborted)emit({type:'response',id,ok:true,value});}
    catch(error){const text=error instanceof Error?error.message:'';emit({type:'response',id,ok:false,error:/^[A-Z][A-Z0-9_]{1,80}$/.test(text)?text:'SERVICE_UNAVAILABLE'});}finally{pending.delete(id);}
  })().catch(()=>{});});
  emit({type:'ready',loginURL:server.loginURL});
}

