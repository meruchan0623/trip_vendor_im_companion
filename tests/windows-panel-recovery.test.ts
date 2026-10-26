import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore Local test dependency; production does not ship jsdom.
import {JSDOM} from 'jsdom';
import {mountPageFeatures} from '../runtime/page/index';
import {mountRuntimeUi} from '../runtime/runtime-ui';
import {VERIFIED_RUNTIME_BUILD} from '../runtime/build-manifest';
import {embeddedPanelState} from '../electron/embedded-host';

const editor='<div class="chat_area-input"><div class="tiptap ProseMirror chat-editor" contenteditable="true"></div></div>';
const state=()=>embeddedPanelState({auth:'ready',attached:true,composerSource:'verified-editor',phase:'idle',messageSurface:{active:true},orderEntries:[],language:'en',preview:null,error:null} as any);
function fixture(){
  return new JSDOM(`<div id="root"><div class="im_detail inform-con"><div class="chat_area">${editor}</div></div></div><script src="${VERIFIED_RUNTIME_BUILD.rendererURL}"></script>`,{url:VERIFIED_RUNTIME_BUILD.documentURL,pretendToBeVisual:true});
}
test('official composer subtree replacement reattaches the same single panel synchronously',()=>{
  const dom=fixture(),document=dom.window.document;
  const features=mountPageFeatures(document,{state:state(),bridge:{invoke:async()=>{}},prewarmDelayMs:60000});
  try{
    const host=features.panel!.host;
    assert.ok(host.isConnected);
    document.querySelector('.chat_area')!.innerHTML=editor;
    assert.equal(host.isConnected,false);
    assert.equal(features.boundary(),true);
    assert.equal(host.nextElementSibling,document.querySelector('.chat_area-input'));
    assert.equal(document.querySelectorAll('#'+host.id).length,1);
  }finally{features.dispose();dom.window.close();}
});
test('removing only the owned panel revokes the boundary instead of trusting a foreign replacement',()=>{
  const dom=fixture(),document=dom.window.document;
  const features=mountPageFeatures(document,{state:state(),bridge:{invoke:async()=>{}},prewarmDelayMs:60000});
  try{
    features.panel!.host.remove();
    assert.throws(()=>features.boundary(),/OWNED_FRAME_BOUNDARY_FAILED/);
  }finally{features.dispose();dom.window.close();}
});
test('hidden composer replacement waits and reattaches when the page becomes visible',()=>{
  const dom=fixture(),document=dom.window.document;
  let visible=true;Object.defineProperty(document,'visibilityState',{get:()=>visible?'visible':'hidden'});
  const features=mountPageFeatures(document,{state:state(),bridge:{invoke:async()=>{}},prewarmDelayMs:60000});
  try{
    visible=false;document.dispatchEvent(new dom.window.Event('visibilitychange'));
    document.querySelector('.chat_area')!.innerHTML=editor;
    assert.equal(features.boundary(),true);
    assert.equal(features.panel!.host.isConnected,false);
    visible=true;document.dispatchEvent(new dom.window.Event('visibilitychange'));
    assert.equal(features.boundary(),true);assert.ok(features.panel!.host.isConnected);
  }finally{features.dispose();dom.window.close();}
});
test('expired lease and pagehide release ownership so a fresh verified mount can recover',async()=>{
  for(const reason of ['lease','pagehide']){
    const dom=fixture(),document=dom.window.document,previous=(globalThis as any).window;
    (globalThis as any).window=dom.window;
    const now=Date.now;let clock=now(),watchdog:(()=>void)|undefined;
    Date.now=()=>clock;
    dom.window.setInterval=(callback:()=>void)=>{watchdog=callback;return 1;};
    dom.window.clearInterval=()=>{};
    const metadata={leaseId:'a'.repeat(32),aresVersion:VERIFIED_RUNTIME_BUILD.aresVersion,htmlSha256:VERIFIED_RUNTIME_BUILD.htmlSha256,rendererSha256:VERIFIED_RUNTIME_BUILD.rendererSha256,keyboardBoundary:'isolated-world-shadow' as const};
    let handle:ReturnType<typeof mountRuntimeUi>|undefined;
    try{
      handle=mountRuntimeUi(metadata,document);
      if(reason==='lease'){clock+=6001;watchdog!();}else dom.window.dispatchEvent(new dom.window.Event('pagehide'));
      assert.equal(document.documentElement.hasAttribute('data-tsim-runtime-lease'),false);
      assert.throws(()=>handle!.heartbeat(1),/LEASE_ENDED/);
      handle=mountRuntimeUi({...metadata,leaseId:'b'.repeat(32)},document);
      handle.heartbeat(1);assert.equal(handle.boundary(),true);
    }finally{await handle?.detach();Date.now=now;(globalThis as any).window=previous;dom.window.close();}
  }
});
