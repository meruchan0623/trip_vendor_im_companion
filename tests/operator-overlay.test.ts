import test from 'node:test';
import assert from 'node:assert/strict';
import {createOperatorOverlay,REUSE_REVEAL_TIMEOUT_MS,OPERATOR_VIEWPORT_ID,OPERATOR_WARM_ID,CLOSED_FRAME_RETENTION_MS} from '../runtime/page/operator-overlay';
import type {OperatorSessionGrant} from '../src/shared/workbench';

// Minimal platform-neutral DOM: just what the overlay touches, with manually advanced timers.
const ORIGIN='https://csagent.tsim.tech';
class Events {private listeners=new Map<string,Set<(event:any)=>void>>();addEventListener(type:string,listener:(event:any)=>void){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type)!.add(listener);}removeEventListener(type:string,listener:(event:any)=>void){this.listeners.get(type)?.delete(listener);}dispatch(type:string,event:any={}){for(const listener of [...this.listeners.get(type)??[]])listener(event);}}
class FakeElement extends Events {
  id='';title='';type='';referrerPolicy='';textContent='';style:Record<string,string>={};parent:FakeElement|null=null;children:FakeElement[]=[];private attributes=new Map<string,string>();
  constructor(readonly tagName:string,readonly owner:FakeDocument){super();}
  setAttribute(name:string,value:string){this.attributes.set(name,value);}
  append(...nodes:FakeElement[]){for(const node of nodes){node.remove();node.parent=this;this.children.push(node);}}
  remove(){if(!this.parent)return;this.parent.children=this.parent.children.filter(node=>node!==this);this.parent=null;}
  get isConnected(){let node:FakeElement|null=this;while(node){if(node===this.owner.body)return true;node=node.parent;}return false;}
  blur(){if(this.owner.activeElement===this)this.owner.activeElement=null;}
}
class FakeFrame extends FakeElement {
  outbox:{value:Record<string,unknown>;target:string}[]=[];private url='';
  readonly contentWindow={postMessage:(value:Record<string,unknown>,target:string)=>{this.outbox.push({value,target});}};
  get src(){return this.url;}set src(value:string){this.url=new URL(value).href;}
}
class FakeView extends Events {
  innerWidth=1200;innerHeight=800;now=0;private timers=new Map<number,{at:number;run:()=>void}>();private next=0;
  setTimeout(run:()=>void,ms=0){const id=++this.next;this.timers.set(id,{at:this.now+ms,run});return id;}
  clearTimeout(id?:number){if(id!==undefined)this.timers.delete(id);}
  advance(ms:number){this.now+=ms;for(const [id,timer] of [...this.timers].sort((a,b)=>a[1].at-b[1].at))if(timer.at<=this.now&&this.timers.delete(id))timer.run();}
}
class FakeDocument extends Events {
  readonly defaultView=new FakeView();readonly body:FakeElement=new FakeElement('body',this);activeElement:FakeElement|null=null;visibilityState='visible';
  createElement(tag:string){return tag==='iframe'?new FakeFrame(tag,this):new FakeElement(tag,this);}
  getElementById(id:string){const walk=(node:FakeElement):FakeElement|null=>{if(node.id===id)return node;for(const child of node.children){const found=walk(child);if(found)return found;}return null;};return walk(this.body);}
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const TOKEN_A='token-A-xxxxxxxxxxxx',TOKEN_B='token-B-yyyyyyyyyyyy';

function setup(grant:()=>Promise<OperatorSessionGrant|undefined>=()=>Promise.resolve({accessToken:TOKEN_A,sessionRef:null})){
  const document=new FakeDocument(),view=document.defaultView;let n=0;const sessions:unknown[]=[];
  const overlay=createOperatorOverlay(document as unknown as Document,{origin:ORIGIN,randomUUID:()=>`6f1c2f9e-3b1a-4c8d-9e2f-${String(++n).padStart(12,'0')}`,now:()=>view.now,requestSession:request=>{sessions.push(request);return grant() as Promise<OperatorSessionGrant>;}});
  const frame=()=>overlay.frame as unknown as FakeFrame|null;
  const child=(target:FakeFrame,data:Record<string,unknown>)=>view.dispatch('message',{data,origin:ORIGIN,source:target.contentWindow});
  return{document,view,overlay,sessions,frame,child};
}
/** Opens on a cold frame and completes the session handoff the way the TSim page does. */
async function coldOpen(env:ReturnType<typeof setup>,identifier:string){
  env.overlay.open({identifier});const frame=env.frame()!,request=env.overlay.active!;
  env.child(frame,{type:'TSIM_OPERATOR_NEEDS_SESSION',version:2,identifier,requestId:request.requestId});await settle();
  env.child(frame,{type:'TSIM_OPERATOR_BOUNDS',version:1,identifier,rect:{x:10,y:10,width:300,height:200}});
  return{frame,request};
}

test('a cold frame always receives an answer to its session request',async()=>{
  const ok=setup(),first=await coldOpen(ok,'ORDER1');
  assert.deepEqual(first.frame.outbox.map(m=>[m.value.type,m.value.accessToken,m.target]),[['TSIM_OPERATOR_SESSION',TOKEN_A,ORIGIN]]);
  for(const grant of [()=>Promise.resolve(undefined),()=>Promise.reject(new Error('ACTION_FAILED'))]){
    const env=setup(grant);env.overlay.open({identifier:'ORDER1'});const frame=env.frame()!,request=env.overlay.active!;
    env.child(frame,{type:'TSIM_OPERATOR_NEEDS_SESSION',version:2,identifier:'ORDER1',requestId:request.requestId});await settle();
    assert.deepEqual(frame.outbox.map(m=>m.value.type),['TSIM_OPERATOR_SESSION_UNAVAILABLE'],'an empty or refused grant must not leave TSim waiting');
  }
});

test('the next query reuses the warm frame after the same session is confirmed',async()=>{
  const env=setup(),first=await coldOpen(env,'ORDER1');env.overlay.close();
  assert.equal(env.frame(),first.frame,'closing keeps the page loaded');assert.equal(first.frame.style.visibility,'hidden');
  assert.equal(env.document.getElementById(OPERATOR_VIEWPORT_ID)?.style.visibility,'hidden');
  env.overlay.open({identifier:'ORDER2',identifierType:'order_number'});
  assert.equal(env.frame(),first.frame);assert.equal(first.frame.style.visibility,'hidden','the previous order stays hidden');
  await settle();
  const request=env.overlay.active!;
  assert.equal(env.sessions.length,2,'authorization runs for every query');
  assert.deepEqual(first.frame.outbox.slice(1).map(m=>m.value),[
    {type:'TSIM_OPERATOR_SET_IDENTIFIER',version:2,identifier:'ORDER2',identifierType:'order_number',requestId:request.requestId},
    {type:'TSIM_OPERATOR_REQUEST_BOUNDS',version:1,identifier:'ORDER2'},
  ]);
  env.child(first.frame,{type:'TSIM_OPERATOR_BOUNDS',version:1,identifier:'ORDER1',rect:{x:0,y:0,width:100,height:100}});
  assert.equal(first.frame.style.visibility,'hidden','late bounds of the previous order do not reveal it');
  env.child(first.frame,{type:'TSIM_OPERATOR_BOUNDS',version:1,identifier:'ORDER2',rect:{x:20,y:20,width:300,height:200}});
  assert.equal(first.frame.style.visibility,'visible');assert.equal(env.overlay.frameURL,first.frame.src);
});

test('a warm frame is rebuilt whenever reuse is not proven safe',async()=>{
  let token=TOKEN_A;
  const changed=setup(()=>Promise.resolve({accessToken:token,sessionRef:null}));let first=await coldOpen(changed,'ORDER1');changed.overlay.close();token=TOKEN_B;
  changed.overlay.open({identifier:'ORDER2'});await settle();
  assert.notEqual(changed.frame(),first.frame,'another companion session');assert.equal(first.frame.isConnected,false);
  assert.match(changed.frame()!.src,/identifier=ORDER2/);assert.match(changed.frame()!.src,/session=handoff/);

  const login=setup();first=await coldOpen(login,'ORDER1');login.overlay.close();
  login.child(first.frame,{type:'TSIM_OPERATOR_NEEDS_LOGIN'});login.overlay.open({identifier:'ORDER2'});
  assert.notEqual(login.frame(),first.frame,'the hidden page fell back to its own login');

  const reload=setup();first=await coldOpen(reload,'ORDER1');first.frame.dispatch('load');first.frame.dispatch('load');reload.overlay.close();
  reload.overlay.open({identifier:'ORDER2'});
  assert.notEqual(reload.frame(),first.frame,'the page reloaded itself');

  const silent=setup();first=await coldOpen(silent,'ORDER1');silent.overlay.close();
  silent.overlay.open({identifier:'ORDER2'});await settle();assert.equal(silent.frame(),first.frame);
  silent.view.advance(REUSE_REVEAL_TIMEOUT_MS);
  assert.notEqual(silent.frame(),first.frame,'the page never answered the new identifier');
});

test('reset drops the warm frame entirely',async()=>{
  const env=setup(),first=await coldOpen(env,'ORDER1');env.overlay.reset();
  assert.equal(env.overlay.frame,null);assert.equal(env.overlay.frameURL,null);assert.equal(first.frame.isConnected,false);
  assert.equal(env.document.getElementById(OPERATOR_VIEWPORT_ID),null);
});

function deferred(){let resolve!:(value:OperatorSessionGrant|undefined)=>void;const promise=new Promise<OperatorSessionGrant|undefined>(r=>{resolve=r;});return{promise,resolve};}
const tokens=(frame:FakeFrame)=>frame.outbox.filter(m=>'accessToken' in m.value);

test('the cold path starts the grant at click time and answers the session request with it',async()=>{
  const env=setup();env.overlay.open({identifier:'ORDER1'});
  assert.equal(env.sessions.length,1,'authorization starts with the click');
  const frame=env.frame()!,request=env.overlay.active!;await settle();
  assert.equal(frame.outbox.length,0,'no bearer before the page asks for it');
  env.child(frame,{type:'TSIM_OPERATOR_NEEDS_SESSION',version:2,identifier:'ORDER1',requestId:request.requestId});await settle();
  assert.equal(env.sessions.length,1,'the in-flight grant is reused');
  assert.deepEqual(frame.outbox.map(m=>[m.value.type,m.value.accessToken,m.value.requestId,m.target]),[['TSIM_OPERATOR_SESSION',TOKEN_A,request.requestId,ORIGIN]]);
});

test('the warm path sends the next order only after the adopted session is confirmed',async()=>{
  let pending=deferred();
  const env=setup(()=>pending.promise),cold=env.overlay;
  cold.open({identifier:'ORDER1'});const first=env.frame()!,r1=cold.active!;pending.resolve({accessToken:TOKEN_A,sessionRef:null});
  env.child(first,{type:'TSIM_OPERATOR_NEEDS_SESSION',version:2,identifier:'ORDER1',requestId:r1.requestId});await settle();
  env.child(first,{type:'TSIM_OPERATOR_BOUNDS',version:1,identifier:'ORDER1',rect:{x:10,y:10,width:300,height:200}});cold.close();
  pending=deferred();env.overlay.open({identifier:'ORDER2'});const r2=env.overlay.active!;
  assert.equal(first.outbox.length,1,'no new identifier or bounds request before the grant resolves');
  assert.equal(first.style.visibility,'hidden');
  pending.resolve({accessToken:TOKEN_A,sessionRef:null});await settle();
  assert.deepEqual(first.outbox.slice(1).map(m=>m.value.type),['TSIM_OPERATOR_SET_IDENTIFIER','TSIM_OPERATOR_REQUEST_BOUNDS']);
  assert.equal(first.outbox[1].value.requestId,r2.requestId);
  assert.equal(first.style.visibility,'hidden','the authorized query still waits for its answer');
  env.child(first,{type:'TSIM_OPERATOR_BOUNDS',version:1,identifier:'ORDER2',rect:{x:20,y:20,width:300,height:200}});
  assert.equal(env.frame(),first);assert.equal(first.style.visibility,'visible');assert.equal(env.overlay.bounds?.x,20);
  assert.equal(tokens(first).length,1,'the warm frame never receives another bearer');

  env.overlay.close();pending=deferred();const sent=first.outbox.length;env.overlay.open({identifier:'ORDER3'});const r3=env.overlay.active!,sessions=env.sessions.length;
  assert.equal(first.outbox.length,sent,'the old session receives no new order while authorization is pending');
  pending.resolve({accessToken:TOKEN_B,sessionRef:null});await settle();
  const rebuilt=env.frame()!;
  assert.notEqual(rebuilt,first,'another bearer rebuilds the page');assert.equal(first.isConnected,false);assert.match(rebuilt.src,/identifier=ORDER3/);
  assert.equal(first.outbox.length,sent,'another bearer never sends the new order to the old session');
  env.child(rebuilt,{type:'TSIM_OPERATOR_NEEDS_SESSION',version:2,identifier:'ORDER3',requestId:r3.requestId});await settle();
  assert.equal(env.sessions.length,sessions,'the rebuilt frame is answered with the same grant');
  assert.deepEqual(tokens(rebuilt).map(m=>m.value.accessToken),[TOKEN_B]);assert.equal(tokens(first).length,1);
});

test('a refused warm grant rebuilds without sending the order to the old session',async()=>{
  for(const refused of [()=>Promise.resolve(undefined),()=>Promise.reject(new Error('ACTION_FAILED'))]){
    let grant:()=>Promise<OperatorSessionGrant|undefined>=()=>Promise.resolve({accessToken:TOKEN_A,sessionRef:null});
    const env=setup(()=>grant()),first=await coldOpen(env,'ORDER1');env.overlay.close();
    grant=refused;const sent=first.frame.outbox.length;
    env.overlay.open({identifier:'ORDER2'});assert.equal(first.frame.outbox.length,sent);
    await settle();
    assert.notEqual(env.frame(),first.frame);assert.equal(first.frame.isConnected,false);
    assert.match(env.frame()!.src,/identifier=ORDER2/);
    assert.equal(first.frame.outbox.length,sent,'a denied order must never reach the old bearer');
  }
});

test('a late warm grant cannot send an expired order after close, reset, timeout or a newer open',async()=>{
  for(const action of ['close','reset','timeout','newer']){
    let pending=deferred();pending.resolve({accessToken:TOKEN_A,sessionRef:null});
    const env=setup(()=>pending.promise),first=await coldOpen(env,'ORDER1');env.overlay.close();
    pending=deferred();const expired=pending,sent=first.frame.outbox.length;
    env.overlay.open({identifier:'ORDER2'});
    assert.equal(first.frame.outbox.length,sent,action);
    if(action==='close')env.overlay.close();
    else if(action==='reset')env.overlay.reset();
    else if(action==='timeout')env.view.advance(REUSE_REVEAL_TIMEOUT_MS);
    else{pending=deferred();env.overlay.open({identifier:'ORDER3'});}
    const current=env.frame();expired.resolve({accessToken:TOKEN_A,sessionRef:null});await settle();
    assert.equal(env.frame(),current,`${action}: expired grant does not replace the current frame`);
    assert.equal(first.frame.outbox.length,sent,`${action}: expired order never reaches the old session`);
    if(action==='newer'){
      pending.resolve({accessToken:TOKEN_A,sessionRef:null});await settle();
      assert.deepEqual(first.frame.outbox.slice(sent).map(m=>[m.value.type,m.value.identifier]),[
        ['TSIM_OPERATOR_SET_IDENTIFIER','ORDER3'],['TSIM_OPERATOR_REQUEST_BOUNDS','ORDER3'],
      ],'only the current authorized order is sent');
    }
  }
});

test('a frame that fell back to TSim login is never warm-reused, even after a manual login',async()=>{
  for(const hidden of [false,true]){
    const env=setup(),first=await coldOpen(env,'ORDER1'),label=hidden?'hidden':'visible';
    if(hidden){env.overlay.close();env.child(first.frame,{type:'TSIM_OPERATOR_NEEDS_LOGIN'});}
    else env.child(first.frame,{type:'TSIM_OPERATOR_NEEDS_LOGIN',version:2,identifier:'ORDER1',requestId:first.request.requestId});
    // The user signs in by hand inside the frame, possibly as another TSim account, and the page renders again.
    if(hidden)env.overlay.open({identifier:'ORDER1'});
    const request=env.overlay.active!;
    env.child(first.frame,{type:'TSIM_OPERATOR_LOADED',version:2,identifier:'ORDER1',requestId:request.requestId});
    env.child(first.frame,{type:'TSIM_OPERATOR_BOUNDS',version:1,identifier:'ORDER1',rect:{x:10,y:10,width:300,height:200}});
    env.overlay.close();const before=env.frame()!;env.overlay.open({identifier:'ORDER2'});await settle();
    assert.notEqual(env.frame(),first.frame,`${label}: the same companion grant does not reuse a manually logged-in page`);
    assert.notEqual(env.frame(),before,label);assert.equal(first.frame.isConnected,false);assert.match(env.frame()!.src,/identifier=ORDER2/);
    assert.equal(first.frame.outbox.filter(m=>m.value.type==='TSIM_OPERATOR_SET_IDENTIFIER').length,0,label);
  }
  // A refused grant (SESSION_UNAVAILABLE) likewise leaves no reusable grant.
  let ok=false;const refused=setup(()=>Promise.resolve(ok?{accessToken:TOKEN_A,sessionRef:null}:undefined));
  const first=await coldOpen(refused,'ORDER1');assert.deepEqual(first.frame.outbox.map(m=>m.value.type),['TSIM_OPERATOR_SESSION_UNAVAILABLE']);
  refused.overlay.close();ok=true;refused.overlay.open({identifier:'ORDER2'});await settle();
  assert.notEqual(refused.frame(),first.frame);
});

test('creation and legacy warm hooks never load a page or request authorization',()=>{
  const env=setup();
  for(let i=0;i<3;i++){
    env.overlay.prewarm();env.overlay.warmConnection();env.view.advance(CLOSED_FRAME_RETENTION_MS);
    assert.equal(env.overlay.frame,null);assert.equal(env.overlay.frameURL,null);
    assert.equal(env.document.getElementById(OPERATOR_WARM_ID),null);
    assert.equal(env.document.body.children.length,0);assert.equal(env.sessions.length,0);
  }
  env.overlay.open({identifier:'ORDER1'});
  assert.ok(env.overlay.frame,'only opening creates the page');assert.equal(env.sessions.length,1);
});

test('closing retains a page for at most 60 seconds and repeated close cannot extend it',async()=>{
  const env=setup(),first=await coldOpen(env,'ORDER1');env.overlay.close();
  env.view.advance(CLOSED_FRAME_RETENTION_MS-1);assert.equal(env.frame(),first.frame);
  env.overlay.close();env.view.advance(1);
  assert.equal(env.frame(),null);assert.equal(env.overlay.frameURL,null);assert.equal(first.frame.isConnected,false);
  assert.equal(env.document.getElementById(OPERATOR_VIEWPORT_ID),null);
  env.overlay.open({identifier:'ORDER2'});assert.notEqual(env.frame(),first.frame);
});

test('reopening cancels the closed-page deadline and the next close receives its own deadline',async()=>{
  const env=setup(),first=await coldOpen(env,'ORDER1');env.overlay.close();
  env.view.advance(CLOSED_FRAME_RETENTION_MS-1);env.overlay.open({identifier:'ORDER2'});await settle();
  const request=env.overlay.active!;
  env.child(first.frame,{type:'TSIM_OPERATOR_LOADED',version:2,identifier:'ORDER2',requestId:request.requestId});
  env.view.advance(CLOSED_FRAME_RETENTION_MS);assert.equal(env.frame(),first.frame);assert.equal(env.overlay.visible,true);
  env.overlay.close();env.view.advance(CLOSED_FRAME_RETENTION_MS);assert.equal(env.frame(),null);
});

test('reset, disposal and page unload immediately remove frames and ignore pending grants',async()=>{
  for(const action of ['reset','dispose','pagehide']){
    const pending=deferred(),env=setup(()=>pending.promise);env.overlay.open({identifier:'ORDER1'});
    const first=env.frame()!,request=env.overlay.active!;
    env.child(first,{type:'TSIM_OPERATOR_NEEDS_SESSION',version:2,identifier:'ORDER1',requestId:request.requestId});
    if(action==='pagehide')env.view.dispatch('pagehide');else env.overlay[action as 'reset'|'dispose']();
    pending.resolve({accessToken:TOKEN_A,sessionRef:null});await settle();
    assert.equal(first.isConnected,false,action);assert.equal(env.frame(),null,action);assert.equal(first.outbox.length,0,action);
    assert.equal(env.document.body.children.length,0,action);
    env.view.advance(CLOSED_FRAME_RETENTION_MS);env.overlay.open({identifier:'ORDER2'});
    assert.equal(Boolean(env.frame()),action!=='dispose',action);
  }
});

test('a delayed refusal for an earlier query cannot corrupt the current retained grant',async()=>{
  const pending=deferred();let calls=0;
  const env=setup(()=>++calls===1?Promise.resolve({accessToken:TOKEN_A,sessionRef:null}):pending.promise);
  const first=await coldOpen(env,'ORDER1');env.overlay.close();env.overlay.open({identifier:'ORDER2'});
  const expired=env.overlay.active!;
  // No result from the retained old document may answer a query before its grant is accepted.
  env.child(first.frame,{type:'TSIM_OPERATOR_LOADED',version:2,identifier:'ORDER2',requestId:expired.requestId});
  assert.equal(first.frame.style.visibility,'hidden');
  env.overlay.reset();env.overlay.open({identifier:'ORDER3'});const current=env.frame()!;
  pending.resolve(undefined);await settle();
  assert.equal(env.frame(),current);assert.equal(first.frame.isConnected,false);assert.equal(first.frame.outbox.length,1);
});

test('reopening an identical identifier uses a fresh source to reject legacy stale messages',async()=>{
  const env=setup(),first=await coldOpen(env,'ORDER1');env.overlay.close();env.overlay.open({identifier:'ORDER1'});
  const current=env.frame()!;assert.notEqual(current,first.frame);
  env.child(first.frame,{type:'TSIM_OPERATOR_BOUNDS',version:1,identifier:'ORDER1',rect:{x:0,y:0,width:100,height:100}});
  assert.equal(env.overlay.bounds?.x,60,'stale legacy result cannot replace the current loading bounds');
});

test('synchronous grant failures are answered and repeated handshakes share the click grant',async()=>{
  const env=setup(()=>{throw new Error('SESSION_UNAVAILABLE');});env.overlay.open({identifier:'ORDER1'});
  const first=env.frame()!,request=env.overlay.active!;
  for(let i=0;i<2;i++)env.child(first,{type:'TSIM_OPERATOR_NEEDS_SESSION',version:2,identifier:'ORDER1',requestId:request.requestId});
  await settle();assert.equal(env.sessions.length,1);assert.deepEqual(first.outbox.map(m=>m.value.type),['TSIM_OPERATOR_SESSION_UNAVAILABLE','TSIM_OPERATOR_SESSION_UNAVAILABLE']);
});

test('returning to an older identifier also rejects its legacy messages with a fresh frame',async()=>{
  const env=setup(),first=await coldOpen(env,'ORDER1');env.overlay.close();env.overlay.open({identifier:'ORDER2'});await settle();
  const request=env.overlay.active!;env.child(first.frame,{type:'TSIM_OPERATOR_LOADED',version:2,identifier:'ORDER2',requestId:request.requestId});
  env.overlay.close();env.overlay.open({identifier:'ORDER1'});assert.notEqual(env.frame(),first.frame);
  env.child(first.frame,{type:'TSIM_OPERATOR_BOUNDS',version:1,identifier:'ORDER1',rect:{x:0,y:0,width:100,height:100}});
  assert.equal(env.overlay.bounds?.x,60);
});

test('a suspended release timer cannot extend reuse beyond its wall-clock deadline',async()=>{
  const env=setup(),first=await coldOpen(env,'ORDER1');env.overlay.close();
  env.view.now+=CLOSED_FRAME_RETENTION_MS; // Renderer suspended: the timer callback has not run yet.
  env.overlay.open({identifier:'ORDER2'});assert.notEqual(env.frame(),first.frame);assert.equal(first.frame.isConnected,false);
});
