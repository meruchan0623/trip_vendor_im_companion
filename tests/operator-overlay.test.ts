import test from 'node:test';
import assert from 'node:assert/strict';
import {createOperatorOverlay,REUSE_REVEAL_TIMEOUT_MS,OPERATOR_VIEWPORT_ID} from '../runtime/page/operator-overlay';
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
  const overlay=createOperatorOverlay(document as unknown as Document,{origin:ORIGIN,randomUUID:()=>`6f1c2f9e-3b1a-4c8d-9e2f-${String(++n).padStart(12,'0')}`,requestSession:request=>{sessions.push(request);return grant() as Promise<OperatorSessionGrant>;}});
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
