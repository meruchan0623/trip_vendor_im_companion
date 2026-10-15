import {describe,it,expect,vi} from 'vitest';
import {JSDOM} from 'jsdom';
import {createNativeComposer} from '../runtime/native-composer';
describe('external editor inactive lease',()=>{
  it('renews beyond watchdog without reading business text, then still captures after foreground returns',async()=>{
    vi.useFakeTimers();
    const dom=new JSDOM('<iframe class="customer_order-detail" src="https://vbooking.ctrip.com/tour/im/ex-area/b?groupid=fixture&sessionid=fixture-session&serviceType=1&status=1"></iframe><div class="tiptap ProseMirror chat-editor" contenteditable="true"></div>',{pretendToBeVisual:true});
    const frame=dom.window.document.querySelector('iframe')!;const wrapper=dom.window.document.createElement('div');wrapper.className='customer_info';frame.replaceWith(wrapper);wrapper.append(frame);
    const node=dom.window.document.querySelector('.chat-editor') as HTMLElement;Object.defineProperty(node,'getClientRects',{value:()=>[{width:100,height:30}]});
    const getJSON=vi.fn(()=>({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'fixture draft'}]}]}));
    (node as any).editor={view:{dom:node,composing:false},isDestroyed:false,isEditable:true,getJSON,on:vi.fn(),off:vi.fn(),commands:{setContent:vi.fn()}};
    const composer=dom.window.document.createElement('div');composer.className='chat_area-input';node.replaceWith(composer);const bar=dom.window.document.createElement('div');bar.className='chat-func-list';composer.append(bar,node);
    for(const [element,x,y,width,height] of [[composer,100,400,500,200],[bar,100,400,500,40],[node,114,445,470,90]] as const)Object.defineProperty(element,'getBoundingClientRect',{value:()=>({x,y,width,height,left:x,top:y,right:x+width,bottom:y+height})});
    const adapter=createNativeComposer({leaseId:'fixture-native-background',documentGeneration:1},dom.window.document);
    try{
      expect(adapter.poll(0).snapshot?.text).toBe('fixture draft');getJSON.mockClear();
      composer.style.display='none';
      for(let round=0;round<4;round++){await vi.advanceTimersByTimeAsync(4000);adapter.heartbeat();}
      expect(adapter.poll(0).snapshot).toBeUndefined();expect(getJSON).not.toHaveBeenCalled();composer.style.display='';expect(adapter.poll(0).snapshot?.text).toBe('fixture draft');
      await vi.advanceTimersByTimeAsync(7000);expect(()=>adapter.heartbeat()).toThrow('NATIVE_LEASE_ENDED');
    }finally{adapter.dispose();dom.window.close();vi.useRealTimers();}
  });
});
