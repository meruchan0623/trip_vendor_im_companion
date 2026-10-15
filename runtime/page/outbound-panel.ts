import type {OperatorIdentifierType} from './identifiers';
import {PANEL_TARGETS,type PanelState} from '../../src/shared/workbench';
/** Inline outbound translation panel above the vendor composer. Text and button intents only; Node owns translate/replace. */
export const PANEL_HOST_ID='tsim-outbound-panel';
export const CHAT_AREA_SELECTOR='.im_detail.inform-con > .chat_area';
export const INPUT_SELECTOR='.chat_area-input';
export const EDITOR_SELECTOR='.tiptap.ProseMirror.chat-editor[contenteditable="true"]';
export const REATTACH_DEBOUNCE_MS=100;
export const TARGET_LABELS:Record<typeof PANEL_TARGETS[number],string>={en:'English',ja:'日本語',ko:'한국어',th:'ไทย',vi:'Tiếng Việt',id:'Bahasa Indonesia',ms:'Bahasa Melayu',es:'Español',fr:'Français',de:'Deutsch',ru:'Русский',ar:'العربية','zh-TW':'繁體中文',pt:'Português',it:'Italiano'};
const LANGUAGE_NAMES:Record<string,string>={zh:'中文',en:'英语',ja:'日语',ko:'韩语',th:'泰语',ar:'阿拉伯语',ru:'俄语',el:'希腊语',vi:'越南语',es:'西班牙语',fr:'法语',de:'德语',pt:'葡萄牙语',it:'意大利语',id:'印尼语',ms:'马来语'};
const STATUS_TEXT={unavailable:'编辑器未就绪',idle:'等待输入',translating:'翻译中...',ready:'就绪',stale:'已过期',failed:'失败',needs_login:'需登录'} as const;
export const PANEL_HINT='确认译文后替换草稿，再由您在原客户端发送';
const CONTAINED=['keydown','keyup','keypress','beforeinput','input','paste','copy','cut','compositionstart','compositionupdate','compositionend','click','mousedown','pointerdown'];
const STYLE=`:host{all:initial;display:block;box-sizing:border-box;font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;color:#1f2937}
*{box-sizing:border-box;font:inherit}
.panel{margin:0;border-top:1px solid #e5e7eb;background:#fafbff;padding:6px 10px}
.panel.collapsed{padding:2px 10px;background:#f7f8fa}
.row{display:flex;align-items:center;gap:8px;min-height:24px;flex-wrap:wrap}
.title{font-weight:600;color:#4c1d95}
.toggle{border:1px solid #c4b5fd;border-radius:10px;background:#fff;color:#6d28d9;padding:0 8px;height:20px;cursor:pointer}
.toggle[aria-pressed="true"]{background:#7c3aed;border-color:#7c3aed;color:#fff}
select{height:22px;border:1px solid #d1d5db;border-radius:4px;background:#fff;padding:0 4px}
.follow{color:#6b7280;font-size:12px}
.follow.on{color:#047857}
.badge{border-radius:9px;padding:0 8px;font-size:12px;background:#eef2ff;color:#4338ca;white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis}
.badge[data-status="ready"]{background:#ecfdf5;color:#047857}
.badge[data-status="stale"]{background:#fffbeb;color:#b45309}
.badge[data-status="failed"],.badge[data-status="needs_login"]{background:#fef2f2;color:#b91c1c}
.badge[data-status="translating"]{background:#f5f3ff;color:#6d28d9}
.spacer{flex:1}
.preview{margin-top:6px;max-height:96px;overflow:auto;white-space:pre-wrap;word-break:break-word;border:1px solid #e5e7eb;border-radius:6px;background:#fff;padding:4px 8px;min-height:26px}
.preview.empty{color:#9ca3af}
.preview.stale{color:#9ca3af;text-decoration:line-through}
.actions{margin-top:6px}
button.act{height:24px;border:1px solid #d1d5db;border-radius:4px;background:#fff;color:#374151;padding:0 10px;cursor:pointer}
button.act.primary{background:#7c3aed;border-color:#7c3aed;color:#fff}
button.act:disabled{opacity:.45;cursor:not-allowed}
.hint{color:#9ca3af;font-size:12px}
.order{border:1px dashed #a855f7;border-radius:4px;background:#efe2ff;color:#6815a8;padding:0 8px;height:22px;cursor:pointer;white-space:nowrap}
.order:hover,.order:focus-visible{background:#e2ccff}
.collapsed .preview,.collapsed .actions{display:none}
[hidden]{display:none!important}`;
export interface PanelBridge {invoke(action:string,args?:unknown[]):Promise<void>}
export interface OutboundPanel {render(state:PanelState):void;setOrder(order:string|undefined):void;attach():boolean;readonly host:HTMLElement;readonly editor:HTMLElement|undefined;dispose():void}
/** `openOrder` opens the TSim operator window for the conversation's order number (shown as a chip that stays visible when collapsed). */
export function createOutboundPanel(document:Document,bridge:PanelBridge,initial:PanelState,hooks:{openOrder?(order:string,identifierType?:OperatorIdentifierType):void;orderUnavailableReason?:string}={}):OutboundPanel{
  const unavailableReason=hooks.orderUnavailableReason??(!hooks.openOrder?'订单查询不可用：尚未连接 TSim 内嵌页面':undefined);
  const view=document.defaultView!;let state=initial,disposed=false,composing=false,editor:HTMLElement|undefined,timer:number|undefined,notice='',noticeTimer:number|undefined;
  const host=document.createElement('div');host.id=PANEL_HOST_ID;host.setAttribute('data-tsim-owned','1');host.setAttribute('aria-label','出站翻译');
  const contain=(event:Event)=>event.stopPropagation();CONTAINED.forEach(type=>host.addEventListener(type,contain));
  const shadow=host.attachShadow({mode:'open'});const make=<K extends keyof HTMLElementTagNameMap>(tag:K,className='',text='')=>{const node=document.createElement(tag);if(className)node.className=className;if(text)node.textContent=text;return node;};
  const style=make('style');style.textContent=STYLE;const panel=make('div','panel');
  const header=make('div','row'),title=make('span','title','出站翻译'),toggle=make('button','toggle'),select=make('select'),follow=make('span','follow'),badge=make('span','badge'),spacer=make('span','spacer'),login=make('button','act','打开登录'),order=make('button','order');let orderValue:string|undefined;
  toggle.type='button';login.type='button';order.type='button';order.hidden=true;select.setAttribute('aria-label','目标语言');const automatic=make('option','','自动跟随客户语言');automatic.value='auto';select.append(automatic);for(const target of PANEL_TARGETS){const option=make('option','',`${TARGET_LABELS[target]} (${target})`);option.value=target;select.append(option);}
  const query=make('input'),queryButton=make('button','order','查询标识');query.type='text';query.placeholder='订单 ID / 已选标识';query.setAttribute('aria-label','明确输入或选择要查询的标识');query.maxLength=100;query.disabled=!!unavailableReason;queryButton.disabled=!!unavailableReason;queryButton.title=unavailableReason??'';if(unavailableReason)queryButton.textContent='订单查询不可用';query.style.width='160px';queryButton.type='button';query.hidden=queryButton.hidden=false;
  queryButton.addEventListener('mousedown',()=>{const selection=document.getSelection()?.toString().trim();if(selection&&/^[A-Za-z0-9_-]{1,100}$/.test(selection))query.value=selection;});
  queryButton.addEventListener('click',()=>{const value=query.value.trim();if(!disposed&&/^[A-Za-z0-9_-]{1,100}$/.test(value)){hooks.openOrder?.(value);}else flash('请输入或选中明确的订单标识');});
  header.append(title,toggle,select,follow,badge,spacer,order,query,queryButton,login);
  const preview=make('div','preview');preview.setAttribute('aria-live','polite');
  const actions=make('div','row actions'),retry=make('button','act','重试'),pause=make('button','act','暂停翻译'),copy=make('button','act','复制译文'),replace=make('button','act','替换原文'),hint=make('span','hint',PANEL_HINT);
  for(const button of [retry,pause,copy,replace])button.type='button';actions.append(retry,pause,copy,replace,make('span','spacer'),hint);
  panel.append(header,preview,actions);shadow.append(style,panel);
  const act=(action:string,args:unknown[]=[])=>{if(disposed)return;void bridge.invoke(action,args).catch(()=>{if(!disposed)flash('操作未完成，请检查连接或重新登录');});};
  const ready=()=>!state.translationPaused&&state.enabled&&state.auth==='ready'&&state.status==='ready'&&!!state.preview&&!state.busy&&!state.draft?.composing&&!composing;
  const flash=(text:string)=>{notice=text;view.clearTimeout(noticeTimer);noticeTimer=view.setTimeout(()=>{notice='';render(state);},1500);render(state);};
  async function copyPreview(){const text=state.preview;if(!text||!ready())return;try{await view.navigator.clipboard.writeText(text);flash('已复制');return;}catch{/* fall back below */}const area=make('textarea');area.value=text;area.style.cssText='position:fixed;opacity:0;pointer-events:none';shadow.append(area);area.select();let ok=false;try{ok=document.execCommand('copy');}catch{ok=false;}area.remove();flash(ok?'已复制':'复制失败');}
  toggle.addEventListener('click',()=>act('setEnabled',[!state.enabled]));
  select.addEventListener('change',()=>select.value==='auto'?act('followCustomer'):act('setTarget',[{lang:select.value,source:'manual'}]));
  login.addEventListener('click',()=>act('openLogin'));
  order.addEventListener('click',()=>{if(orderValue&&!disposed){hooks.openOrder?.(orderValue,'order_number');}});
  function setOrder(next:string|undefined){if(next===orderValue)return;orderValue=next;order.hidden=!next;order.textContent=next?`订单 ${next}`:'';order.title=unavailableReason??(next?`在 TSim 中查询订单 ${next}`:'');order.disabled=!!unavailableReason;}
  retry.addEventListener('click',()=>{if(!state.translationPaused)act('retry');});
  pause.addEventListener('click',()=>act(state.translationPaused?'resume':'cancel'));
  copy.addEventListener('click',()=>{void copyPreview();});
  replace.addEventListener('click',()=>{if(ready())act('apply',[{mode:'replace'}]);});
  const onCompositionStart=()=>{composing=true;render(state);};const onCompositionEnd=()=>{composing=false;render(state);};
  function bindEditor(next:HTMLElement|undefined){if(next===editor)return;editor?.removeEventListener('compositionstart',onCompositionStart);editor?.removeEventListener('compositionend',onCompositionEnd);editor=next;composing=false;editor?.addEventListener('compositionstart',onCompositionStart);editor?.addEventListener('compositionend',onCompositionEnd);}
  /** Keep the host directly above .chat_area-input; the vendor may re-render either side at any time. */
  function attach(){
    if(disposed||document.visibilityState==='hidden')return false;const area=document.querySelector(CHAT_AREA_SELECTOR),input=area?.querySelector<HTMLElement>(INPUT_SELECTOR);
    if(!area||!input?.parentNode){if(host.isConnected)host.remove();bindEditor(undefined);return false;}
    if(host.parentNode!==input.parentNode||host.nextSibling!==input)input.parentNode.insertBefore(host,input);
    const editors=input.querySelectorAll<HTMLElement>(EDITOR_SELECTOR);bindEditor(editors.length===1?editors[0]:undefined);return true;
  }
  function render(next:PanelState){
    state=next;if(disposed)return;const on=state.enabled;
    panel.classList.toggle('collapsed',!on);toggle.textContent=on?'开':'关';toggle.setAttribute('aria-pressed',String(on));toggle.title=on?'关闭出站翻译':'开启出站翻译';
    const selection=state.followCustomer.following?'auto':state.target;if(select.value!==selection)select.value=selection;
    const lang=state.followCustomer.lang;follow.hidden=false;follow.classList.toggle('on',state.followCustomer.following);follow.textContent=state.followCustomer.following?`跟随客户 · ${LANGUAGE_NAMES[lang??'']??(lang==='unknown'||!lang?'待识别':lang)}`:`客户 ${LANGUAGE_NAMES[lang??'']??(lang==='unknown'||!lang?'未识别':lang)} · 已手动`;
    badge.setAttribute('data-status',state.status);badge.textContent=notice||(state.translationPaused?'翻译已暂停':state.status==='failed'?`${STATUS_TEXT.failed}: ${state.error??'未知错误'}`:STATUS_TEXT[state.status]);badge.title=badge.textContent;
    login.hidden=state.status!=='needs_login'&&state.auth!=='needs_login'&&state.auth!=='failed';login.disabled=state.auth==='connecting';
    const automaticHint=state.followCustomer.following?(lang==='zh'?'客户使用中文，无需翻译；也可手动选择目标语言':!lang||lang==='unknown'?'客户语言待识别，请等待客户原文或手动选择目标语言':!PANEL_TARGETS.includes(lang as typeof PANEL_TARGETS[number])?'客户语言暂不支持自动翻译，请手动选择目标语言':''):'';
    const text=state.preview??'';preview.textContent=text||automaticHint||(state.translationPaused?'翻译已暂停，点击恢复翻译后继续':state.status==='translating'?'翻译中...':'输入中文后自动生成译文预览');preview.classList.toggle('empty',!text);preview.classList.toggle('stale',!!text&&state.status==='stale');
    const usable=ready();copy.disabled=!usable;replace.disabled=!usable;
    pause.textContent=state.translationPaused?'恢复翻译':'暂停翻译';pause.disabled=!on||state.auth==='connecting';
    retry.disabled=state.followCustomer.following&&(!state.followCustomer.lang||!PANEL_TARGETS.includes(state.followCustomer.lang as typeof PANEL_TARGETS[number]))||!!state.translationPaused||!on||state.busy||state.auth!=='ready'||!state.draft?.text.trim()||state.status==='translating';
  }
  const schedule=()=>{if(disposed||document.visibilityState==='hidden')return;view.clearTimeout(timer);timer=view.setTimeout(attach,REATTACH_DEBOUNCE_MS);};
  const observer=new view.MutationObserver(mutations=>{if(mutations.every(mutation=>{const target=mutation.target.nodeType===1?mutation.target as Element:mutation.target.parentElement;const changed=[...mutation.addedNodes,...mutation.removedNodes];return !!target?.closest('[data-tsim-owned="1"]')||changed.length>0&&changed.every(node=>node===host);}))return;schedule();});
  const onVisibility=()=>{view.clearTimeout(timer);if(document.visibilityState!=='hidden')attach();};document.addEventListener('visibilitychange',onVisibility);
  render(state);attach();if(document.body)observer.observe(document.body,{childList:true,subtree:true});
  return{render,setOrder,attach,host,get editor(){return editor;},dispose(){if(disposed)return;disposed=true;view.clearTimeout(timer);view.clearTimeout(noticeTimer);observer.disconnect();document.removeEventListener('visibilitychange',onVisibility);bindEditor(undefined);CONTAINED.forEach(type=>host.removeEventListener(type,contain));host.remove();}};
}
