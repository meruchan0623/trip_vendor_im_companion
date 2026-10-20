import {ownedLoginURL,isLoginPopoverId,type LoginPopover} from '../../src/shared/owned-login';
import type {OperatorIdentifierType} from './identifiers';
import {PANEL_TARGETS,type PanelState} from '../../src/shared/workbench';
/** Inline outbound translation panel above the vendor composer. Text and button intents only; Node owns translate/replace. */
export const PANEL_HOST_ID='tsim-outbound-panel';
export const CHAT_AREA_SELECTOR='.im_detail.inform-con > .chat_area';
export const INPUT_SELECTOR='.chat_area-input';
export const EDITOR_SELECTOR='.tiptap.ProseMirror.chat-editor[contenteditable="true"]';
export const REATTACH_DEBOUNCE_MS=100;
export const TARGET_LABELS:Record<typeof PANEL_TARGETS[number],string>={en:'English',ja:'日本語',ko:'한국어',th:'ไทย',vi:'Tiếng Việt',id:'Bahasa Indonesia',ms:'Bahasa Melayu',es:'Español',fr:'Français',de:'Deutsch',ru:'Русский',ar:'العربية','zh-TW':'繁體中文',pt:'Português',it:'Italiano',tr:'Türkçe'};
const LANGUAGE_NAMES:Record<string,string>={zh:'中文',en:'英语',ja:'日语',ko:'韩语',th:'泰语',ar:'阿拉伯语',ru:'俄语',el:'希腊语',vi:'越南语',es:'西班牙语',fr:'法语',de:'德语',pt:'葡萄牙语',it:'意大利语',id:'印尼语',ms:'马来语','zh-TW':'繁体中文',tr:'土耳其语'};
type Tone='ok'|'warn'|'bad'|'busy'|'muted';
const STATUS:Record<PanelState['status'],[string,Tone]|null>={unavailable:['编辑器未就绪','warn'],idle:null,translating:['翻译中','busy'],ready:['译文就绪','ok'],stale:['待更新','busy'],failed:['翻译失败','bad'],needs_login:null};
export const PANEL_HINT='替换后仍需您在原客户端手动发送';
export const SEND_HINT='按 Enter 直接发送译文';
const ORDER_RE=/^[A-Za-z0-9_-]{1,100}$/;
const CONTAINED=['keydown','keyup','keypress','beforeinput','input','paste','copy','cut','compositionstart','compositionupdate','compositionend','click','mousedown','pointerdown'];
const ICONS={
  chevron:'<path d="m6 9 6 6 6-6"/>',receipt:'<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',search:'<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  more:'<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  retry:'<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',pause:'<path d="M9 6v12M15 6v12"/>',play:'<path d="m8 5 11 7-11 7z"/>',power:'<path d="M12 3v9"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/>',
  lock:'<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',alert:'<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
} as const;
const STYLE=`:host{all:initial;display:block;min-width:0;width:100%;box-sizing:border-box;
--accent:#3a5bd9;--accent-soft:#eef1fd;--ink:#1d2433;--ink-2:#4b5568;--ink-3:#8a93a6;--line:#e3e7ee;--sunken:#f6f7fa;--hover:#eceff4;--ok:#16855a;--warn:#b26a00;--bad:#c2382f;
font:13px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI','Microsoft YaHei',sans-serif;color:var(--ink)}
*{box-sizing:border-box;font:inherit;min-width:0}
button{color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;white-space:nowrap}
button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
button:disabled{opacity:.4;cursor:not-allowed;box-shadow:none}
svg{width:14px;height:14px;flex:none;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.panel{container-type:inline-size;background:var(--sunken);border-top:1px solid var(--line)}
.bar{display:flex;align-items:center;gap:6px;height:36px;padding:0 10px 0 12px}
.switch{width:28px;height:16px;border-radius:9px;background:#cfd5df;position:relative;flex:none;transition:background .15s}
.switch::after{content:"";position:absolute;left:2px;top:2px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .15s}
.switch[aria-checked="true"]{background:var(--accent)}.switch[aria-checked="true"]::after{transform:translateX(12px)}
.title{font-weight:600;font-size:12.5px;white-space:nowrap;margin-right:2px}.off .title{color:var(--ink-3)}
.chip{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border-radius:7px;color:var(--ink-2);overflow:hidden}
.chip:hover:not(:disabled),.icon:hover:not(:disabled),.chip[aria-expanded="true"],.icon[aria-expanded="true"]{background:var(--hover);color:var(--ink)}
.lang b{color:var(--ink);font-weight:600}.lang .arrow{color:var(--ink-3)}.lang svg{width:12px;height:12px}
.tag{font-size:10.5px;line-height:16px;padding:0 5px;border-radius:4px;background:var(--accent-soft);color:var(--accent);font-weight:600}.tag.manual{background:#f1f2f5;color:var(--ink-2)}
.badge{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--ink-3);white-space:nowrap;overflow:hidden;max-width:260px}
.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.badge span{overflow:hidden;text-overflow:ellipsis}
.badge[data-tone="ok"]{color:var(--ok)}.badge[data-tone="warn"]{color:var(--warn)}.badge[data-tone="bad"]{color:var(--bad)}.badge[data-tone="busy"]::before{animation:pulse 1s infinite}
@keyframes pulse{50%{opacity:.25}}
.spacer{flex:1}
.icon{width:26px;height:26px;display:grid;place-items:center;border-radius:7px;color:var(--ink-2);flex:none}
.find{margin-right:-4px}
.order .num{font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;max-width:140px}
.body{padding:0 10px 10px}.off .body{display:none}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden}.card.ready{border-color:#c9d3f5}
.stalebar{display:flex;align-items:center;gap:6px;padding:6px 12px 0;font-size:11.5px;color:var(--warn)}
.stalebar::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;animation:pulse 1s infinite}
.preview{padding:9px 12px 4px;min-height:38px;max-height:min(120px,20vh);overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13.5px;line-height:1.55}
.preview.empty{color:var(--ink-3);font-size:13px}.preview.stale{color:var(--ink-3)}
.skeleton{padding:12px 12px 6px;display:grid;gap:7px}
.skeleton i{height:9px;border-radius:5px;background:linear-gradient(90deg,#eef0f4 25%,#f7f8fa 50%,#eef0f4 75%);background-size:200% 100%;animation:shimmer 1.1s linear infinite}
.skeleton i+i{width:62%}
@keyframes shimmer{to{background-position:-200% 0}}
.foot{display:flex;align-items:center;gap:8px;padding:4px 6px 6px 12px;min-height:38px}
.meta{flex:1;font-size:11.5px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.buttons{display:flex;align-items:center;gap:2px;flex:none}
.ghost{height:28px;padding:0 8px;border-radius:7px;display:inline-flex;align-items:center;gap:5px;color:var(--ink-2);font-size:12.5px}
.ghost:hover:not(:disabled){background:#f0f2f6;color:var(--ink)}
.primary{height:28px;padding:0 6px 0 11px;margin-left:4px;border-radius:7px;display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:#fff;font-weight:600;font-size:12.5px;box-shadow:0 1px 2px rgba(58,91,217,.35)}
.primary:hover:not(:disabled){filter:brightness(1.07)}
kbd{font:500 11px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:0 5px;border-radius:4px;background:rgba(255,255,255,.18)}
.callout{display:flex;align-items:center;gap:10px;padding:10px 12px;font-size:12.5px;color:var(--ink-2)}
.callout svg{width:16px;height:16px}.callout p{margin:0;flex:1;overflow-wrap:anywhere}
.callout[data-tone="info"] svg{color:var(--accent)}.callout[data-tone="warn"] svg{color:var(--warn)}.callout[data-tone="bad"] svg{color:var(--bad)}
.callout.inline{gap:6px;padding:7px 12px 0;font-size:11.5px;color:var(--warn)}.callout.inline svg{width:13px;height:13px}
.callout.inline .outline{height:auto;padding:0;border:0;background:none;color:var(--accent);font-weight:600}.callout.inline .outline:hover{text-decoration:underline}
.solid{height:28px;padding:0 12px;border-radius:7px;background:var(--accent);color:#fff;font-weight:600}
.outline{height:28px;padding:0 12px;border-radius:7px;border:1px solid var(--line);background:#fff;color:var(--ink)}
.pop{position:fixed;z-index:2147483002;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.16),0 2px 6px rgba(15,23,42,.06);padding:6px;animation:rise .12s ease-out}
@keyframes rise{from{opacity:0;transform:translateY(4px)}}
.pop.login-popover{display:flex;flex-direction:column;width:320px;padding:0;overflow:hidden}.login-top{flex:none;display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border-bottom:1px solid var(--line);color:var(--ink-2);font-size:12px;font-weight:600}.login-frame{display:block;flex:1;min-height:0;width:100%;height:0;border:0;background:#fff}
.pop.languages{width:340px}.pop.query{width:300px;padding:10px}.pop.menu{width:236px}
.fallback-settings{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px;font-size:12px}.fallback-settings small{flex-basis:100%;color:var(--muted)}.fallback-target{margin-left:auto;max-width:180px;font:inherit;border:1px solid #d7dce3;border-radius:5px;padding:4px;background:#fff;color:#263241}
.pop h5{margin:0 2px 8px;font-size:11px;font-weight:600;color:var(--ink-3)}
.option{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border-radius:7px;text-align:left;white-space:normal}
.option:hover:not(:disabled){background:#f1f3f7}
.option[aria-selected="true"],.option[aria-checked="true"]{color:var(--accent);font-weight:600}.option[aria-selected="true"]::after,.option[aria-checked="true"]::after{content:"✓";margin-left:auto}
.option.mode span{display:grid;gap:1px}.menu .label{padding:4px 8px 2px;font-size:11px;color:var(--ink-3)}
.option small{color:var(--ink-3);font-weight:400;font-size:11.5px}
.option.follow{padding:9px 8px}.option.follow span{display:grid;gap:1px}
.separator{height:1px;background:var(--line);margin:4px 2px}
.search{display:flex;align-items:center;gap:6px;margin:2px 2px 6px;padding:0 8px;height:32px;border-radius:8px;background:var(--sunken);color:var(--ink-3)}
.search input{flex:1;border:0;background:none;color:var(--ink);outline:none}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;max-height:220px;overflow:auto}
.field{display:flex;gap:6px}
.field input{flex:1;height:32px;padding:0 10px;border:1px solid var(--line);border-radius:8px;outline:none;color:var(--ink);background:#fff}
.field input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.field button{height:32px;padding:0 12px;border-radius:8px;background:var(--ink);color:#fff;font-weight:600}
.note{font-size:11px;color:var(--ink-3);margin:8px 2px 0}.note.error{color:var(--bad)}
@container (max-width:560px){.title,.badge span,.ghost span{display:none}.order .num{max-width:72px}}
@container (max-width:380px){.order .num,.meta,kbd{display:none}.foot{justify-content:flex-end}.lang{padding:0 6px}}
@media (max-height:650px){.preview{max-height:64px}}
[hidden]{display:none!important}`;
export interface PanelBridge {invoke(action:string,args?:unknown[]):Promise<void>}
export interface OutboundPanel {render(state:PanelState):void;setOrder(order:string|undefined):void;attach():boolean;readonly host:HTMLElement;readonly anchor:HTMLElement|undefined;readonly editor:HTMLElement|undefined;dispose():void}
type Popover='languages'|'query'|'menu';
/** `openOrder` opens the TSim operator window: the detected order chip opens directly, the search button queries any other identifier. */
export function createOutboundPanel(document:Document,bridge:PanelBridge,initial:PanelState,hooks:{openOrder?(order:string,identifierType?:OperatorIdentifierType):void;orderUnavailableReason?:string}={}):OutboundPanel{
  const unavailableReason=hooks.orderUnavailableReason??(!hooks.openOrder?'订单查询不可用：尚未连接 TSim 内嵌页面':undefined);
  const view=document.defaultView!;let state=initial,disposed=false,composing=false,editor:HTMLElement|undefined,anchor:HTMLElement|undefined,timer:number|undefined,notice='',noticeTimer:number|undefined,open:Popover|null=null,orderValue:string|undefined;
  const host=document.createElement('div');host.id=PANEL_HOST_ID;host.setAttribute('data-tsim-owned','1');host.setAttribute('aria-label','出站翻译');
  const contain=(event:Event)=>event.stopPropagation();CONTAINED.forEach(type=>host.addEventListener(type,contain));
  const shadow=host.attachShadow({mode:'open'});
  const make=<K extends keyof HTMLElementTagNameMap>(tag:K,className='',text='')=>{const node=document.createElement(tag);if(className)node.className=className;if(text)node.textContent=text;return node;};
  const button=(className:string,text='',title='')=>{const node=make('button',className,text);node.type='button';if(title)node.title=title;return node;};
  const icon=(name:keyof typeof ICONS)=>{const node=make('span');node.style.display='contents';node.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;return node;};
  const style=make('style');style.textContent=STYLE;const panel=make('div','panel');
  // Bar: switch, language, status, other-order search, detected order, more.
  const bar=make('div','bar'),toggle=button('switch'),title=make('span','title','出站翻译');toggle.setAttribute('role','switch');
  const lang=button('chip lang'),langText=make('span'),langTag=make('span','tag');lang.setAttribute('aria-haspopup','listbox');lang.setAttribute('aria-label','目标语言');lang.append(langText,langTag,icon('chevron'));
  const badge=make('span','badge'),badgeText=make('span');badge.setAttribute('role','status');badge.append(badgeText);
  const find=button('icon find','','查询其他订单');find.setAttribute('aria-label','查询其他订单');find.setAttribute('aria-haspopup','dialog');find.append(icon('search'));
  const order=button('chip order'),orderNumber=make('span','num');order.hidden=true;
  const more=button('icon more','','更多');more.setAttribute('aria-label','更多');more.setAttribute('aria-haspopup','menu');more.append(icon('more'));
  bar.append(toggle,title,lang,badge,make('span','spacer'),find,order,more);
  // Body: one card that shows either the preview, a skeleton or a callout.
  const body=make('div','body'),card=make('div','card'),stalebar=make('div','stalebar','草稿已修改，等待更新译文'),preview=make('div','preview'),skeleton=make('div','skeleton');preview.setAttribute('aria-live','polite');skeleton.append(make('i'),make('i'));
  const callout=make('div','callout'),calloutIcon=make('span'),calloutText=make('p'),login=button('solid login','登录 TSim'),resume=button('outline','恢复翻译'),retryFailed=button('outline','重试'),chooseFallback=button('outline fallback-action','修改兜底语言');calloutIcon.style.display='contents';callout.append(calloutIcon,calloutText,login,resume,retryFailed,chooseFallback);
  const foot=make('div','foot'),meta=make('span','meta'),source=make('span'),hint=make('span','hint',PANEL_HINT),buttons=make('div','buttons');meta.append(source,hint);
  const retry=button('ghost','','重新翻译'),copy=button('ghost','','复制译文'),replace=button('primary');retry.append(icon('retry'),make('span','','重试'));copy.append(icon('copy'),make('span','','复制'));retry.setAttribute('aria-label','重试');copy.setAttribute('aria-label','复制译文');
  const mac=/Mac|iPhone|iPad|iPod/i.test(view.navigator.platform||view.navigator.userAgent);
  const shortcut=mac?'⌘ + ⌥ + Enter':'Ctrl + Alt + Enter';
  replace.append(make('span','','替换草稿'),make('kbd','',mac?'⌘⌥↵':'Ctrl Alt ↵'));replace.title=`替换草稿（不发送） · ${shortcut}`;replace.setAttribute('aria-keyshortcuts',mac?'Meta+Alt+Enter':'Control+Alt+Enter');
  buttons.append(retry,copy,replace);foot.append(meta,buttons);card.append(stalebar,preview,skeleton,callout,foot);body.append(card);
  // Popovers are fixed-positioned outside the size container so a clipping vendor ancestor cannot hide them.
  const languages=make('div','pop languages'),follow=button('option follow'),followText=make('span'),followLabel=make('span','','跟随客户语言'),followLang=make('small');languages.setAttribute('role','listbox');languages.setAttribute('aria-label','目标语言');follow.setAttribute('role','option');followText.append(followLabel,followLang);follow.append(followText);
  const search=make('div','search'),searchInput=make('input'),grid=make('div','grid');searchInput.placeholder='搜索语言';searchInput.setAttribute('aria-label','搜索语言');search.append(icon('search'),searchInput);
  const options=PANEL_TARGETS.map(target=>{const option=button('option');option.setAttribute('role','option');option.dataset.lang=target;option.append(LANGUAGE_NAMES[target]??target,' ',make('small','',TARGET_LABELS[target]));grid.append(option);return option;});
  const fallbackSettings=make('label','fallback-settings'),fallbackSelect=make('select','fallback-target');fallbackSelect.setAttribute('aria-label','兜底语言');
  fallbackSettings.append(make('span','','兜底语言'),fallbackSelect,make('small','','无法确定客户语言时使用，非识别结果'));
  for(const target of PANEL_TARGETS){const option=make('option');option.value=target;option.textContent=LANGUAGE_NAMES[target]??target;fallbackSelect.append(option);}
  languages.append(follow,fallbackSettings,make('div','separator'),search,grid);
  const query=make('div','pop query'),queryForm=make('form','field'),queryInput=make('input'),queryButton=button('','查询'),queryNote=make('div','note');queryButton.type='submit';query.setAttribute('role','dialog');query.setAttribute('aria-label','查询其他订单');
  queryInput.type='text';queryInput.placeholder='输入订单 ID 或其他标识';queryInput.setAttribute('aria-label','明确输入或选择要查询的标识');queryInput.maxLength=100;queryInput.autocomplete='off';queryForm.append(queryInput,queryButton);query.append(make('h5','','查询其他订单'),queryForm,queryNote);
  const menu=make('div','pop menu'),pause=button('option'),pauseIcon=make('span'),pauseText=make('span'),disable=button('option');menu.setAttribute('role','menu');pauseIcon.style.display='contents';pause.append(pauseIcon,pauseText);disable.append(icon('power'),'关闭出站翻译');const modeLabel=make('div','label','Enter 键行为'),modes=([['send','Enter 直接发送','未出译文时等待译文后发送'],['replace','替换模式','Enter 保持原样，译文需手动替换']] as const).map(([mode,label,detail])=>{const option=button('option mode');option.setAttribute('role','menuitemradio');option.dataset.mode=mode;const text=make('span');text.append(make('span','',label),make('small','',detail));option.append(text);return option;});
  const accountLogin=button('option account-login','打开浏览器 TSim_CS'),accountLogout=button('option account-logout','断开助手会话');accountLogin.setAttribute('role','menuitem');accountLogout.setAttribute('role','menuitem');
  menu.append(pause,disable,make('div','separator'),modeLabel,...modes,make('div','separator'),accountLogin,accountLogout);
  const popovers:Record<Popover,[HTMLElement,HTMLButtonElement]>={languages:[languages,lang],query:[query,find],menu:[menu,more]};
  for(const [pop] of Object.values(popovers))pop.hidden=true;
  panel.append(bar,body);shadow.append(style,panel,languages,query,menu);
  let loginPresentation:LoginPopover|undefined,dismissedLoginId:string|undefined,loginCard:HTMLElement|undefined,loginFrame:HTMLIFrameElement|undefined;
  const act=(action:string,args:unknown[]=[])=>{if(disposed)return;void bridge.invoke(action,args).catch(()=>{if(!disposed)flash('操作未完成，请检查连接或重新登录','bad');});};
  function placeLogin(){
    if(!loginCard)return;const trigger=!callout.hidden&&!login.hidden?login:more,rect=trigger.getBoundingClientRect();
    const width=Math.min(320,Math.max(0,view.innerWidth-16)),height=Math.min(420,Math.max(0,view.innerHeight-16));
    const above=rect.top-6>=height,top=above?rect.top-height-6:rect.bottom+6;
    Object.assign(loginCard.style,{width:`${width}px`,left:`${Math.max(8,Math.min(rect.right-width,view.innerWidth-width-8))}px`,top:`${Math.max(8,Math.min(top,view.innerHeight-height-8))}px`,height:`${height}px`,maxHeight:`${height}px`});
  }
  function removeLogin(notify=false){
    const id=loginPresentation?.id;if(id)dismissedLoginId=id;loginFrame?.remove();loginCard?.remove();loginFrame=undefined;loginCard=undefined;loginPresentation=undefined;
    if(notify&&id)act('closeLogin',[id]);
  }
  function renderLogin(value:LoginPopover|undefined){
    if(!value){removeLogin();return;}
    try{if(!isLoginPopoverId(value.id))throw new Error('INVALID_LOGIN_URL');ownedLoginURL(value.url);}catch{removeLogin();return;}
    if(value.id===dismissedLoginId)return;
    if(loginPresentation?.id===value.id){if(loginPresentation.url!==value.url)removeLogin(true);else placeLogin();return;}
    removeLogin();setOpen(null);loginPresentation={...value};
    loginCard=make('div','pop login-popover');loginCard.setAttribute('role','dialog');loginCard.setAttribute('aria-label','TSim 账户登录');
    const top=make('div','login-top','TSim 账户'),close=button('icon login-close','×');close.setAttribute('aria-label','关闭 TSim 登录');close.addEventListener('click',()=>removeLogin(true));top.append(close);
    loginFrame=make('iframe','login-frame');loginFrame.title='TSim 账户登录';loginFrame.setAttribute('sandbox','allow-scripts allow-forms');loginFrame.referrerPolicy='no-referrer';loginFrame.src=value.url;
    loginCard.append(top,loginFrame);shadow.append(loginCard);placeLogin();
  }
  const onLoginMessage=(event:MessageEvent)=>{
    if(!loginFrame?.contentWindow||event.source!==loginFrame.contentWindow||event.origin!=='null'||!event.data||typeof event.data!=='object'||Array.isArray(event.data)||Object.keys(event.data).join(',')!=='type')return;
    if(event.data.type==='TSIM_LOGIN_DONE'||event.data.type==='TSIM_LOGIN_CLOSE')removeLogin(true);
  };
  view.addEventListener('message',onLoginMessage);
  const ready=()=>!state.translationPaused&&state.enabled&&state.auth==='ready'&&state.status==='ready'&&!!state.preview&&!state.busy&&!state.draft?.composing&&!composing;
  let noticeTone:Tone='ok';
  const flash=(text:string,tone:Tone='ok')=>{notice=text;noticeTone=tone;view.clearTimeout(noticeTimer);noticeTimer=view.setTimeout(()=>{notice='';render(state);},1500);render(state);};
  async function copyPreview(){const text=state.preview;if(!text||!ready())return;try{await view.navigator.clipboard.writeText(text);flash('已复制');return;}catch{/* fall back below */}const area=make('textarea');area.value=text;area.style.cssText='position:fixed;opacity:0;pointer-events:none';shadow.append(area);area.select();let ok=false;try{ok=document.execCommand('copy');}catch{ok=false;}area.remove();flash(ok?'已复制':'复制失败',ok?'ok':'bad');}
  function place(pop:HTMLElement,trigger:HTMLElement){
    const rect=trigger.getBoundingClientRect(),bounds=host.getBoundingClientRect(),width=Math.min(pop.offsetWidth||300,view.innerWidth-16);
    const alignRight=rect.left+rect.width/2>bounds.left+bounds.width/2;
    const left=alignRight?Math.min(rect.right,view.innerWidth-8)-width:Math.max(8,rect.left);
    Object.assign(pop.style,{left:`${Math.max(8,left)}px`,bottom:`${Math.max(8,view.innerHeight-rect.top+6)}px`,maxWidth:`${view.innerWidth-16}px`});
  }
  function setOpen(next:Popover|null){
    if(disposed)return;if(next)removeLogin(true);open=next;
    for(const [key,[pop,trigger]] of Object.entries(popovers) as [Popover,[HTMLElement,HTMLButtonElement]][]){const on=key===next;pop.hidden=!on;trigger.setAttribute('aria-expanded',String(on));if(on)place(pop,trigger);}
    if(next==='languages'){searchInput.value='';filterLanguages();searchInput.focus();}
    if(next==='query'){queryNote.classList.remove('error');queryNote.textContent=unavailableReason??(orderValue?'在 TSim 订单窗口中打开，Esc 关闭':'未识别到唯一订单 ID，可手动输入查询');queryInput.focus();}
  }
  const toggleOpen=(key:Popover)=>setOpen(open===key?null:key);
  function filterLanguages(){const term=searchInput.value.trim().toLowerCase();for(const option of options){const target=option.dataset.lang!;option.hidden=!!term&&![target,TARGET_LABELS[target as typeof PANEL_TARGETS[number]].toLowerCase(),LANGUAGE_NAMES[target]??''].some(text=>text.includes(term));}}
  function submitQuery(){const value=queryInput.value.trim();if(!disposed&&!unavailableReason&&ORDER_RE.test(value)){setOpen(null);hooks.openOrder?.(value);return;}queryNote.textContent='请输入或选中明确的订单标识（字母、数字、-、_）';queryNote.classList.add('error');}
  toggle.addEventListener('click',()=>{setOpen(null);act('setEnabled',[!state.enabled]);});
  lang.addEventListener('click',()=>toggleOpen('languages'));
  more.addEventListener('click',()=>toggleOpen('menu'));
  find.addEventListener('mousedown',()=>{const selection=document.getSelection()?.toString().trim();if(selection&&ORDER_RE.test(selection))queryInput.value=selection;});
  find.addEventListener('click',()=>toggleOpen('query'));
  follow.addEventListener('click',()=>{setOpen(null);act('followCustomer');});
  chooseFallback.addEventListener('click',()=>setOpen('languages'));
  fallbackSelect.addEventListener('change',()=>{const requested=fallbackSelect.value;fallbackSelect.value=state.fallbackTarget??'en';act('setFallbackTarget',[requested]);});
  for(const option of options)option.addEventListener('click',()=>{setOpen(null);act('setTarget',[{lang:option.dataset.lang,source:'manual'}]);});
  searchInput.addEventListener('input',filterLanguages);
  searchInput.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();options.find(option=>!option.hidden)?.click();}});
  queryForm.addEventListener('submit',event=>{event.preventDefault();submitQuery();});
  order.addEventListener('click',()=>{if(orderValue&&!disposed&&!unavailableReason){setOpen(null);hooks.openOrder?.(orderValue,'order_number');}});
  login.addEventListener('click',()=>{setOpen(null);act('openLogin');});
  accountLogin.addEventListener('click',()=>{setOpen(null);act('openLogin');});
  accountLogout.addEventListener('click',()=>{setOpen(null);act('logout');});
  pause.addEventListener('click',()=>{setOpen(null);act(state.translationPaused?'resume':'cancel');});
  disable.addEventListener('click',()=>{setOpen(null);act('setEnabled',[false]);});
  for(const option of modes)option.addEventListener('click',()=>{setOpen(null);if(option.dataset.mode!==(state.outboundMode??'send'))act('setOutboundMode',[option.dataset.mode]);});
  resume.addEventListener('click',()=>act('resume'));
  retry.addEventListener('click',()=>{if(!state.translationPaused)act('retry');});
  retryFailed.addEventListener('click',()=>{if(!state.translationPaused)act('retry');});
  copy.addEventListener('click',()=>{void copyPreview();});
  replace.addEventListener('click',()=>{if(ready())act('apply',[{mode:'replace'}]);});
  // Close popovers on Escape or a click elsewhere, in the panel or on the vendor page.
  shadow.addEventListener('keydown',event=>{if((event as KeyboardEvent).key==='Escape'&&loginPresentation){removeLogin(true);return;}if((event as KeyboardEvent).key==='Escape'&&open){const [,trigger]=popovers[open];setOpen(null);trigger.focus();}});
  shadow.addEventListener('pointerdown',event=>{const path=event.composedPath();if(loginCard&&!path.includes(loginCard))removeLogin(true);if(!open)return;const [pop,trigger]=popovers[open];if(!path.includes(pop)&&!path.includes(trigger))setOpen(null);});
  const onOutside=(event:Event)=>{if(loginCard&&!event.composedPath().includes(host))removeLogin(true);if(open&&!event.composedPath().includes(host))setOpen(null);};
  const onResize=()=>{if(open)setOpen(null);placeLogin();};
  document.addEventListener('pointerdown',onOutside,true);view.addEventListener('resize',onResize);
  const onCompositionStart=()=>{composing=true;render(state);};const onCompositionEnd=()=>{composing=false;render(state);};
  function bindEditor(next:HTMLElement|undefined){if(next===editor)return;editor?.removeEventListener('compositionstart',onCompositionStart);editor?.removeEventListener('compositionend',onCompositionEnd);editor=next;composing=false;editor?.addEventListener('compositionstart',onCompositionStart);editor?.addEventListener('compositionend',onCompositionEnd);}
  function setOrder(next:string|undefined){if(next===orderValue)return;orderValue=next;order.hidden=!next;order.replaceChildren(...(next?[icon('receipt'),orderNumber]:[]));orderNumber.textContent=next??'';order.title=unavailableReason??(next?`在 TSim 中查看订单 ${next}`:'');order.setAttribute('aria-label',next?`查看订单 ${next}`:'');order.disabled=!!unavailableReason;}
  /** Keep the host directly above .chat_area-input; the vendor may re-render either side at any time. */
  function attach(){
    if(disposed||document.visibilityState==='hidden')return false;const area=document.querySelector(CHAT_AREA_SELECTOR),input=area?.querySelector<HTMLElement>(INPUT_SELECTOR);
    // A missing host beside its still-live composer is boundary drift, not a
    // vendor rerender. Leave it detached so the runtime can revoke its lease.
    if(!host.isConnected&&anchor?.isConnected)return false;
    if(!area||!input?.parentNode){if(host.isConnected)host.remove();bindEditor(undefined);return false;}
    if(host.parentNode!==input.parentNode||host.nextSibling!==input)input.parentNode.insertBefore(host,input);
    anchor=input;
    const editors=input.querySelectorAll<HTMLElement>(EDITOR_SELECTOR);bindEditor(editors.length===1?editors[0]:undefined);return true;
  }
  const showCallout=(tone:'info'|'warn'|'bad',name:keyof typeof ICONS,text:string,action?:HTMLButtonElement,inline=false)=>{callout.hidden=false;callout.classList.toggle('inline',inline);callout.dataset.tone=tone;calloutIcon.replaceChildren(icon(name));calloutText.textContent=text;for(const item of [login,resume,retryFailed,chooseFallback])item.hidden=item!==action;};
  function render(next:PanelState){
    state=next;if(disposed)return;const on=state.enabled,paused=!!state.translationPaused;
    if(!on&&open==='languages')setOpen(null);
    panel.classList.toggle('off',!on);toggle.setAttribute('aria-checked',String(on));toggle.title=on?'关闭出站翻译':'开启出站翻译';toggle.setAttribute('aria-label',toggle.title);lang.hidden=!on;more.hidden=false;disable.disabled=!on;
    // Language chip and list.
    const following=state.followCustomer.following,customer=state.followCustomer.lang,resolution=state.followCustomer.resolution,collecting=resolution?.status==='collecting',fallback=following&&resolution?.status==='fallback',customerName=LANGUAGE_NAMES[customer??'']??(customer==='unknown'||!customer?'未识别':customer);
    const supported=!!customer&&PANEL_TARGETS.includes(customer as typeof PANEL_TARGETS[number]),targetName=LANGUAGE_NAMES[state.target]??state.target;
    const fallbackName=LANGUAGE_NAMES[state.fallbackTarget??'en']??state.fallbackTarget??'英语';fallbackSelect.value=state.fallbackTarget??'en';
    const reasons={'no-originals':'未获取到可判断语言的客户原文','no-majority':'客户原文语言没有唯一多数','unrecognized':'客户原文不足以确认语言','unsupported':`客户语言（${customerName}）暂不支持自动翻译`,'source-unavailable':'客户原文采集暂不可用'};
    const fallbackHint=fallback&&resolution.status==='fallback'?`${reasons[resolution.reason]}。当前使用${fallbackName}兜底（非识别结果）；识别明确后自动跟随客户语言。`:'';
    langText.replaceChildren();
    if(following&&customer==='zh')langText.append(make('b','','中文客户'));
    else{const shown=following?(fallback?`${fallbackName} · 兜底（非识别）`:supported?customerName:collecting?'正在识别':'选择目标语言'):targetName;langText.append('中文 ',make('span','arrow','→'),' ',make('b','',shown));}
    langTag.textContent=following?(fallback?'':'自动'):'手动';langTag.classList.toggle('manual',!following);
    lang.title=following?(fallback?fallbackHint:`自动跟随客户语言：${customerName}`):`手动目标：${targetName}；客户语言：${customerName}`;
    follow.setAttribute('aria-selected',String(following));followLang.textContent=`当前识别：${customerName}${customer==='zh'?'（无需翻译）':''}${fallback?'；使用配置的兜底语言':''}`;
    for(const option of options)option.setAttribute('aria-selected',String(!following&&option.dataset.lang===state.target));
    pauseIcon.replaceChildren(icon(paused?'play':'pause'));pauseText.textContent=paused?'恢复翻译':'暂停翻译';pause.disabled=!on||state.auth==='connecting';
    accountLogin.textContent='打开浏览器 TSim_CS';accountLogout.disabled=state.auth==='needs_login'||state.auth==='connecting';
    const mode=state.outboundMode??'send';for(const option of modes)option.setAttribute('aria-checked',String(option.dataset.mode===mode));hint.textContent=mode==='send'?SEND_HINT:PANEL_HINT;
    // Status badge.
    const status:[string,Tone]|null=notice?[notice,noticeTone]:!on?null:state.auth==='connecting'?['正在连接…','busy']:state.auth==='needs_login'?['需登录','warn']:state.auth==='failed'?['连接失败','bad']:paused?['翻译已暂停','warn']:state.sendPending?['译文生成后自动发送','busy']:STATUS[state.status];
    badge.hidden=!status;badgeText.textContent=status?.[0]??'';badge.dataset.tone=status?.[1]??'muted';badge.title=badgeText.textContent;
    // Card content.
    const text=state.preview??'',stale=!!text&&(state.status==='stale'||state.status==='translating');
    callout.hidden=true;preview.hidden=skeleton.hidden=foot.hidden=stalebar.hidden=true;
    const automaticHint=following&&!text&&!fallback?(customer==='zh'?'客户使用中文，无需翻译；如需翻译，请在左上角手动选择语言':collecting?'正在采集客户原文，完成后自动确定目标或使用配置的兜底语言':!customer||customer==='unknown'?'当前服务未提供语言识别状态，请手动选择目标语言':!supported?`客户语言（${customerName}）暂不支持自动翻译，请手动选择目标语言`:''):'';
    if(state.auth==='connecting'){skeleton.hidden=foot.hidden=false;source.textContent='正在连接 TSim 登录服务，请稍候';}
    else if(state.auth==='needs_login')showCallout('info','lock','请先登录 TSim_CS 的 Edge / Chrome 页面，助手自动复用登录，无需重复输入密码',login);
    else if(state.auth==='failed')showCallout('bad','alert',state.error||'登录服务连接失败，请稍后重试');
    else if(paused)showCallout('warn','pause','翻译已暂停，草稿不会发送到翻译服务',resume);
    else if(state.error?.includes('兜底语言'))showCallout('bad','alert',state.error,chooseFallback);
    else if(automaticHint)showCallout(customer==='zh'?'info':'warn','info',automaticHint);
    else if(state.status==='failed')showCallout('bad','alert',`翻译失败：${state.error??'未知错误'}`,retryFailed);
    else if(state.status==='unavailable')showCallout('warn','alert','未找到可用的回复编辑器，请点击回复框后重试');
    else if(state.status==='translating'&&!text){skeleton.hidden=foot.hidden=false;source.textContent=`正在翻译为${fallback?`${fallbackName}（兜底，非识别结果）`:following?customerName:targetName}…`;}
    else{
      preview.hidden=foot.hidden=false;stalebar.hidden=!stale;
      preview.textContent=text||'输入中文后自动生成译文预览';preview.classList.toggle('empty',!text);preview.classList.toggle('stale',stale);
      source.textContent=text?(following?(fallback?`${fallbackName}兜底 · 非识别结果 · `:`根据客户最近消息识别为${customerName} · `):`手动指定${targetName} · `):'';
    }
    if(fallbackHint&&state.auth==='ready'&&!paused&&state.status!=='failed'&&state.status!=='unavailable'&&!state.error?.includes('兜底语言'))showCallout('warn','info',fallbackHint,chooseFallback,!preview.hidden);
    hint.hidden=!text||stale;
    const usable=ready();card.classList.toggle('ready',usable);copy.disabled=!usable;replace.disabled=!usable;
    retry.disabled=retryFailed.disabled=following&&!supported&&!fallback||paused||!on||state.busy||state.auth!=='ready'||!state.draft?.text.trim()||state.status==='translating';
    // Order controls.
    renderLogin(state.loginPopover);
    find.disabled=!!unavailableReason;find.title=unavailableReason??'查询其他订单';queryInput.disabled=queryButton.disabled=!!unavailableReason;
  }
  const schedule=()=>{if(disposed||document.visibilityState==='hidden')return;view.clearTimeout(timer);timer=view.setTimeout(attach,REATTACH_DEBOUNCE_MS);};
  const observer=new view.MutationObserver(mutations=>{if(mutations.every(mutation=>{const target=mutation.target.nodeType===1?mutation.target as Element:mutation.target.parentElement;const changed=[...mutation.addedNodes,...mutation.removedNodes];return !!target?.closest('[data-tsim-owned="1"]')||changed.length>0&&changed.every(node=>node===host);}))return;schedule();});
  const onVisibility=()=>{view.clearTimeout(timer);if(document.visibilityState==='hidden'){setOpen(null);removeLogin(true);}else attach();};document.addEventListener('visibilitychange',onVisibility);
  render(state);attach();if(document.body)observer.observe(document.body,{childList:true,subtree:true});
  return{render,setOrder,attach,host,get anchor(){return anchor;},get editor(){return editor;},dispose(){if(disposed)return;setOpen(null);removeLogin();view.removeEventListener('message',onLoginMessage);disposed=true;view.clearTimeout(timer);view.clearTimeout(noticeTimer);observer.disconnect();document.removeEventListener('visibilitychange',onVisibility);document.removeEventListener('pointerdown',onOutside,true);view.removeEventListener('resize',onResize);bindEditor(undefined);CONTAINED.forEach(type=>host.removeEventListener(type,contain));host.remove();}};
}
