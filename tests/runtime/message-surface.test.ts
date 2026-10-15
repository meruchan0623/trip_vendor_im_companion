import {describe,it,expect,vi} from 'vitest';
import {JSDOM} from 'jsdom';
import {createHash} from 'node:crypto';
import {messageSurfaceGeometry} from '../../runtime/native-composer';
import {inspectMessageNavigation,inspectRightOrderDocument,RuntimeCDPPolicy,approvedOrderFrameURL} from '../../runtime/cdp-policy';
import {VERIFIED_RUNTIME_BUILD} from '../../runtime/identity';
const rect=(x:number,y:number,width:number,height:number)=>({x,y,width,height,left:x,top:y,right:x+width,bottom:y+height});
function place(element:Element,box:ReturnType<typeof rect>){Object.defineProperty(element,'getBoundingClientRect',{value:()=>box,configurable:true});Object.defineProperty(element,'getClientRects',{value:()=>[box],configurable:true});}
describe('message-only composer anchors, fake DOM',()=>{
  it('requires explicitly selected 消息 nav, never an editor merely mounted in the background',()=>{
    const dom=new JSDOM('<div class="menu-item-wrapper"><span class="menu-text">消息</span></div><div class="menu-item-wrapper cur"><span class="menu-text">订单</span></div><div class="chat-editor"></div>',{pretendToBeVisual:true}),doc=dom.window.document;
    for(const e of doc.querySelectorAll('.menu-item-wrapper'))place(e,rect(0,40,68,60));
    expect(inspectMessageNavigation(doc).active).toBe(false);doc.querySelector('.cur')!.classList.remove('cur');doc.querySelector('.menu-item-wrapper')!.classList.add('cur');expect(inspectMessageNavigation(doc).active).toBe(true);
    doc.querySelector('.menu-item-wrapper')!.classList.remove('cur');expect(inspectMessageNavigation(doc).active).toBe(false);dom.window.close();
  });
  it('returns only unused toolbar space inside composer and above original editor/send',()=>{
    const dom=new JSDOM('<div class="chat_area-input"><div class="chat-func-list"><button>附件</button></div><div class="tiptap ProseMirror chat-editor" contenteditable="true"></div><div class="chat_area-button"><div class="list-btn_send"><button class="btn_send"></button></div></div></div>',{pretendToBeVisual:true}),doc=dom.window.document;
    place(doc.querySelector('.chat_area-input')!,rect(100,400,700,200));place(doc.querySelector('.chat-func-list')!,rect(100,400,700,40));place(doc.querySelector('.chat-func-list button')!,rect(116,405,190,30));place(doc.querySelector('.chat-editor')!,rect(114,445,670,90));place(doc.querySelector('.btn_send')!,rect(700,550,80,30));
    expect(messageSurfaceGeometry(doc)).toEqual({active:true,composerRect:{x:100,y:400,width:700,height:200},toolbarRect:{x:314,y:400,width:478,height:40}});
    (doc.querySelector('.chat_area-input') as HTMLElement).style.display='none';expect(messageSurfaceGeometry(doc).active).toBe(false);dom.window.close();
  });
  it('never anchors over editor content or over occupied vendor controls',()=>{
    const dom=new JSDOM('<div class="chat_area-input"><div class="chat-func-list"><button></button></div><div class="tiptap ProseMirror chat-editor" contenteditable="true"></div></div>',{pretendToBeVisual:true}),doc=dom.window.document;
    place(doc.querySelector('.chat_area-input')!,rect(100,400,700,200));place(doc.querySelector('.chat-func-list')!,rect(100,400,700,40));place(doc.querySelector('button')!,rect(116,405,600,30));place(doc.querySelector('.chat-editor')!,rect(114,445,670,90));
    expect(messageSurfaceGeometry(doc)).toMatchObject({active:true,toolbarRect:null});place(doc.querySelector('.chat-editor')!,rect(114,420,670,90));expect(messageSurfaceGeometry(doc).active).toBe(false);dom.window.close();
  });
});
describe('right user-info order ID only',()=>{
  it('reads one exact table value, leaves header/chat identifiers and vendor DOM untouched',()=>{
    const dom=new JSDOM('<div class="chat-text">12345678</div><div class="im_info_basic_list"><li><div class="im_info_basic_list_title">订单ID</div><div class="im_info_basic_list_content">0012345678901234</div></li><li><div class="im_info_basic_list_title">订单金额</div><div class="im_info_basic_list_content">1234</div></li></div>',{pretendToBeVisual:true}),doc=dom.window.document;
    Object.defineProperty(dom.window.Range.prototype,'getClientRects',{value:()=>[rect(100,120,160,20)],configurable:true});const before=doc.body.innerHTML;
    expect(inspectRightOrderDocument(doc).entries).toEqual([{identifier:'0012345678901234',identifierType:'order_number',rect:{x:100,y:120,width:160,height:20}}]);expect(doc.body.innerHTML).toBe(before);
    (doc.querySelector('.im_info_basic_list_content') as HTMLElement).style.display='none';expect(inspectRightOrderDocument(doc).entries).toEqual([]);dom.window.close();
  });
  it('accepts only the two pinned HTTPS order-frame routes',()=>{expect(approvedOrderFrameURL('https://vbooking.ctrip.com/tour/im/ex-area/b/imExtraInfo?groupid=g')).toBe(true);for(const url of ['https://vbooking.ctrip.com/other','https://attacker.example/tour/im/ex-area/b','http://vbooking.ctrip.com/tour/im/ex-area/b','https://u:p@vbooking.ctrip.com/tour/im/ex-area/b'])expect(approvedOrderFrameURL(url)).toBe(false);});
  it('binds the child frame to its actual iframe owner and conversation before reading in an isolated world',async()=>{
    const source='https://vbooking.ctrip.com/tour/im/ex-area/b?groupid=g&sessionid=s&serviceType=1&status=1';let actual='https://vbooking.ctrip.com/tour/im/ex-area/b/imExtraInfo?groupid=g&sessionid=s&status=1',context=0;
    const send=vi.fn(async(method:string,params:any)=>{
      if(method==='Target.attachToTarget')return{sessionId:'session'};
      if(method==='Page.createIsolatedWorld')return{executionContextId:++context};
      if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'main',url:VERIFIED_RUNTIME_BUILD.documentURL},childFrames:[{frame:{id:'order',parentId:'main',url:actual}}]}};
      if(method==='DOM.describeNode')return{node:{frameId:'order',attributes:['src',source]}};
      if(method==='Runtime.evaluate')return String(params.expression).startsWith('document.querySelector')?{result:{objectId:'iframe'}}:{result:{value:{entries:[{identifier:'0012345678901234',identifierType:'order_number',rect:{x:20,y:30,width:140,height:20}}],width:300,height:600}}};
      return{};
    });
    const target={targetId:'im',frameId:'main',contextNonce:'test-owned',documentURL:VERIFIED_RUNTIME_BUILD.documentURL,fingerprint:VERIFIED_RUNTIME_BUILD};const policy=new RuntimeCDPPolicy({send,disconnect:async()=>{}},target,createHash('sha256').update('test').digest('hex'));await policy.attachSession();await policy.createOwnedWorld();
    const geometry={rect:{x:700,y:0,width:300,height:600},clientWidth:300,clientHeight:600,clientLeft:0,clientTop:0};expect(await policy.readRightOrderEntries(geometry)).toEqual([{identifier:'0012345678901234',identifierType:'order_number',rect:{x:720,y:30,width:140,height:20}}]);
    actual=actual.replace('sessionid=s','sessionid=other');send.mockClear();expect(await policy.readRightOrderEntries(geometry)).toEqual([]);expect(send.mock.calls.some(([method,params])=>method==='Runtime.evaluate'&&!String(params.expression).startsWith('document.querySelector'))).toBe(false);await policy.close();
  });
});
