import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {connectOwnedLoopback} from '../runtime/transport';
import {VERIFIED_RUNTIME_BUILD} from '../runtime/build-manifest';

class FakeSocket extends EventTarget {
  static created:FakeSocket[]=[];
  readyState=0;
  constructor(readonly url:string){super();FakeSocket.created.push(this);queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
  send(){}
  close(){this.readyState=3;}
}
type Handler=(request:IncomingMessage,response:ServerResponse)=>void;
async function fixture(t:TestContext,handler:Handler){
  FakeSocket.created=[];
  const originalSocket=Object.getOwnPropertyDescriptor(globalThis,'WebSocket');
  Object.defineProperty(globalThis,'WebSocket',{configurable:true,writable:true,value:FakeSocket});
  t.after(()=>{if(originalSocket)Object.defineProperty(globalThis,'WebSocket',originalSocket);else Reflect.deleteProperty(globalThis,'WebSocket');});
  const sockets=new Set<import('node:net').Socket>();
  let active=handler,requests=0;
  const server=createServer((request,response)=>{requests++;assert.equal(request.url,'/json/version');active(request,response);});
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address==='object');const port=address.port;
  t.after(async()=>{for(const socket of sockets)socket.destroy();server.close();await once(server,'close');});
  const normal:Handler=(_request,response)=>response.end(JSON.stringify({Browser:`Chrome/${VERIFIED_RUNTIME_BUILD.chromiumMajor}.0.0.0`,webSocketDebuggerUrl:`ws://127.0.0.1:${port}/devtools/browser/test-123`}));
  return{port,sockets,normal,requests:()=>requests,serve:(handler:Handler)=>{active=handler;}};
}
async function bounded<T>(promise:Promise<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('TEST_PENDING_PAST_DEADLINE')),6500);})]);}
  finally{clearTimeout(timer);}
}

for(const mode of ['partial disconnect','body stall','headers stall','slow drip','non-200','oversized','invalid JSON'] as const){
  test(`discovery settles once and permits reconnect after ${mode}`,async t=>{
    let chunks=0;
    const f=await fixture(t,(_request,response)=>{
      if(mode==='headers stall')return;
      if(mode==='non-200'){response.writeHead(503);response.flushHeaders();return;}
      if(mode==='oversized'){response.write('x'.repeat(16001));return;}
      if(mode==='invalid JSON'){response.end('{');return;}
      response.writeHead(200,{'content-length':'200'});response.write('{');
      if(mode==='partial disconnect'){const timer=setTimeout(()=>response.destroy(),20);response.on('close',()=>clearTimeout(timer));}
      if(mode==='slow drip'){const timer=setInterval(()=>{chunks++;response.write(' ');},150);response.on('close',()=>clearInterval(timer));}
    });
    let checks=0,settles=0;
    const started=Date.now();
    const pending=connectOwnedLoopback(f.port,async()=>{checks++;});
    void pending.then(()=>{settles++;},()=>{settles++;});
    const timeout=['body stall','headers stall','slow drip'].includes(mode);
    await assert.rejects(bounded(pending),{message:timeout?'DEBUG_ENDPOINT_TIMEOUT':mode==='oversized'||mode==='invalid JSON'?'DEBUG_ENDPOINT_INVALID':'DEBUG_ENDPOINT_UNAVAILABLE'});
    const elapsed=Date.now()-started;
    assert.ok(elapsed<(timeout?6000:1500),`failure took ${elapsed}ms`);
    if(timeout)assert.ok(elapsed>=3800,`deadline fired early: ${elapsed}ms`);
    if(mode==='slow drip')assert.ok(chunks>=10,'response must remain active throughout the deadline');
    assert.equal(checks,1);assert.equal(FakeSocket.created.length,0);
    await new Promise(resolve=>setTimeout(resolve,30));assert.equal(settles,1);assert.equal(f.sockets.size,0,'failed discovery must close its socket');
    f.serve(f.normal);checks=0;
    const transport=await bounded(connectOwnedLoopback(f.port,async()=>{checks++;}));
    assert.equal(checks,3);assert.equal(FakeSocket.created.length,1);
    assert.equal(FakeSocket.created[0].url,`ws://127.0.0.1:${f.port}/devtools/browser/test-123`);
    await transport.disconnect();assert.equal(FakeSocket.created[0].readyState,3);
  });
}

test('discovery preserves owner checks and rejects arbitrary socket URLs and incompatible Chrome',async t=>{
  const f=await fixture(t,()=>{});
  for(const url of ['ws://example.com:1234/devtools/browser/test','ws://localhost:1234/devtools/browser/test','wss://127.0.0.1:1234/devtools/browser/test',`ws://127.0.0.1:${f.port}/devtools/browser/test?secret=1`,`ws://user@127.0.0.1:${f.port}/devtools/browser/test`,`ws://127.0.0.1:${f.port}/devtools/page/test`]){
    f.serve((_request,response)=>response.end(JSON.stringify({Browser:`Chrome/${VERIFIED_RUNTIME_BUILD.chromiumMajor}.0`,webSocketDebuggerUrl:url})));
    await assert.rejects(connectOwnedLoopback(f.port,async()=>{}),{message:'UNVERIFIED_DEBUG_ENDPOINT'});
  }
  f.serve((_request,response)=>response.end(JSON.stringify({Browser:'Chrome/1.0',webSocketDebuggerUrl:`ws://127.0.0.1:${f.port}/devtools/browser/test`})));
  await assert.rejects(connectOwnedLoopback(f.port,async()=>{}),{message:'UNVERIFIED_DEBUG_ENDPOINT'});
  assert.equal(FakeSocket.created.length,0);
  const before=f.requests();
  await assert.rejects(connectOwnedLoopback(f.port,async()=>{throw Error('OWNER_CHANGED');}),{message:'OWNER_CHANGED'});
  assert.equal(f.requests(),before);
  f.serve(f.normal);
  for(const failAt of [2,3]){
    let checks=0;
    await assert.rejects(connectOwnedLoopback(f.port,async()=>{if(++checks===failAt)throw Error('OWNER_CHANGED');}),{message:'OWNER_CHANGED'});
    assert.equal(checks,failAt);
  }
  assert.equal(FakeSocket.created.length,1);assert.equal(FakeSocket.created[0].readyState,3);
  for(const port of [0,80,65536,NaN])await assert.rejects(connectOwnedLoopback(port,async()=>{assert.fail('invalid ports must not inspect owner');}),{message:'INVALID_DEBUG_PORT'});
});
