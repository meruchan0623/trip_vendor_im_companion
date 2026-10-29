import {parseOrderSummaryResult,type OrderSummary,type OrderSummaryFailure,type OrderSummaryIntent,type OrderSummaryPlan,type OrderSummaryResult} from '../../src/shared/order-summary';
import type {PanelAuth} from '../../src/shared/workbench';
import {isOwned} from './identifiers';
import {RUNTIME_PLATFORM} from '../build-manifest';
/**
 * Read-only plan card in the free space under the vendor's 用户信息. The order-detail frame may be out of process,
 * so the card is a fixed overlay on the main document anchored to the frame's rect; text only, Node owns every TSIM read.
 */
export const ORDER_SUMMARY_HOST_ID='tsim-order-summary';
export const ORDER_SUMMARY_FRAME_SELECTOR='.customer_info:not(.close) iframe.customer_order-detail';
/** A narrower or shorter order panel has no room for the card. */
export const ORDER_SUMMARY_MIN_FRAME={width:220,height:200} as const;
/** Without readable free space under 用户信息 the card docks to the panel bottom, at most this share of its height. */
export const ORDER_SUMMARY_DOCKED_SHARE=0.6;
/** A settled card for the same order and conversation is shown again without a new read inside this window. */
export const ORDER_SUMMARY_REUSE_MS=60_000;
export const ORDER_SUMMARY_FAILURE_TEXT:Record<OrderSummaryFailure,string>={
  login:'TSIM 登录已失效，请重新登录后查询',permission:'当前 TSIM 账号没有订单查询权限',rate_limited:'查询过于频繁，请稍后再试',
  context:'会话已切换，请在当前会话中重试',unavailable:'暂时无法获取套餐信息，请稍后重试',
};
const ORDER_RE=/^[A-Za-z0-9_-]{1,100}$/;
const MIN_FREE=150,MARGIN=8,Z_RAISED='2147482000';
const MODAL_SELECTOR='dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"],.ant-modal,.el-dialog,.modal';
const CONTAINED=['keydown','keyup','keypress','click','mousedown','pointerdown','copy','cut','wheel'];
const ICONS={
  retry:'<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',chevron:'<path d="m6 9 6 6 6-6"/>',check:'<path d="m5 12 5 5 9-10"/>',
  copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  lock:'<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',alert:'<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
} as const;
/** Every font size and face goes through these variables; the defaults are the macOS (PingFang/SF) scale of the 312 px design. */
const STYLE=`:host{all:initial;
--accent:#2f54d6;--accent-ink:#1e3fb8;--accent-soft:#edf1fd;--ink:#171d2b;--ink-2:#454e62;--ink-3:#6b7386;--line:#e4e8ef;--line-soft:#eef1f6;--sunken:#f5f6f9;--hover:#eaedf3;
--ok:#13794f;--ok-soft:#e3f3ea;--warn:#9a5a00;--warn-soft:#fcf1dc;--bad:#b9342b;--bad-soft:#fbe9e7;--muted-soft:#eef0f4;
--sans:-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI','Microsoft YaHei',sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--fs-micro:10px;--fs-tiny:10.5px;--fs-xs:11px;--fs-sm:11.5px;--fs-md:12px;--fs-base:12.5px;--fs-hero:21px;--value-weight:600;--mono-weight:400;--pad:12px;
font:var(--fs-md)/1.45 var(--sans);color:var(--ink);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
*{box-sizing:border-box;font:inherit;min-width:0}
button{color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;white-space:nowrap;text-align:left}
button:focus-visible,.cdrs:focus-visible{outline:2px solid var(--accent);outline-offset:1px;border-radius:6px}
button:disabled{opacity:.4;cursor:not-allowed}
svg{width:14px;height:14px;flex:none;stroke:currentColor;fill:none;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.card{display:flex;flex-direction:column;max-height:inherit;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 1px 2px rgba(23,29,43,.05),0 12px 32px -8px rgba(23,29,43,.16);overflow:hidden;animation:rise .14s ease-out}
.head{flex:none;display:flex;align-items:center;gap:8px;min-height:38px;padding:0 6px 0 var(--pad);border-bottom:1px solid var(--line-soft);background:linear-gradient(180deg,#fbfcfe,#fff);cursor:pointer;user-select:none}
.collapsed .head{border-bottom-color:transparent}
.tg{flex:1;align-self:stretch;display:flex;align-items:center;gap:8px;margin-left:calc(-1 * var(--pad));padding-left:var(--pad)}
.tg:focus-visible{outline-offset:-2px}.tg:hover .title{color:var(--accent-ink)}
.title{font-weight:650;font-size:var(--fs-base);letter-spacing:.01em;white-space:nowrap}
.count{font-size:var(--fs-xs);color:var(--ink-3);white-space:nowrap;padding:1px 6px;border-radius:9px;background:var(--sunken)}
.icon{width:26px;height:26px;display:grid;place-items:center;border-radius:7px;color:var(--ink-2);flex:none}
.icon:hover:not(:disabled){background:var(--hover);color:var(--ink)}
.busy .refresh svg{animation:spin .8s linear infinite}
.toggle svg{transition:transform .15s}.collapsed .toggle svg{transform:rotate(-90deg)}
.body{flex:1 1 auto;overflow:auto;overscroll-behavior:contain;padding:0 var(--pad)}
.collapsed .body,.collapsed .foot{display:none}
/* A hairline scrollbar on the card's right edge; the content keeps its own padding. */
.body::-webkit-scrollbar{width:3px;height:3px}.body::-webkit-scrollbar-track{background:transparent}
.body::-webkit-scrollbar-thumb{background:rgba(23,29,43,.28);border-radius:2px}.body::-webkit-scrollbar-thumb:hover{background:rgba(23,29,43,.5)}
.body::-webkit-scrollbar-button{display:none;width:0;height:0}
.tabs{display:flex;gap:4px;margin:0 calc(-1 * var(--pad));padding:8px 18px 7px var(--pad);overflow-x:auto;scrollbar-width:none;border-bottom:1px solid var(--line-soft);-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 18px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 18px),transparent)}
.tabs::-webkit-scrollbar{display:none}
.tab{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:7px;border:1px solid transparent;color:var(--ink-2);font-size:var(--fs-sm);flex:none}
.tab:hover:not([aria-selected="true"]){background:var(--sunken)}
.tab[aria-selected="true"]{background:#fff;color:var(--ink);font-weight:650;border-color:var(--line);box-shadow:0 1px 2px rgba(23,29,43,.06)}
.tab i{width:6px;height:6px;border-radius:50%;background:#9aa2b3}
.tab i[data-tone="ok"]{background:#1fa36a}.tab i[data-tone="warn"]{background:#e7a034}.tab i[data-tone="bad"]{background:#e0574c}
.tab .st{font-size:var(--fs-tiny);color:var(--ink-3);font-weight:400}
.more{display:inline-flex;align-items:center;height:24px;padding:0 8px;border-radius:7px;border:1px dashed #c9d0dc;color:var(--ink-3);font-size:var(--fs-tiny);white-space:nowrap;flex:none}
.row{padding:10px 0;border-bottom:1px solid var(--line-soft)}.row:last-child{border-bottom:0}
.none{color:var(--ink-3);font-weight:400}
.hero{display:grid;grid-template-columns:44px minmax(0,1fr);column-gap:10px;align-items:center}
.ring,.mini{position:relative;flex:none}.ring{width:44px;height:44px}.mini{width:22px;height:22px}
.ring svg,.mini svg{position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg)}
.ring svg{stroke-width:4}.mini svg{stroke-width:3.5}
.tr{stroke:#e6e9f0}.fg{stroke:var(--accent);transition:stroke-dasharray .4s}
[data-tone="warn"]>svg .fg{stroke:#e7a034}[data-tone="over"]>svg .fg{stroke:#e0574c}[data-tone="muted"]>svg .fg{stroke:#c3c9d5}
.ring b{position:absolute;inset:0;display:grid;place-items:center;font-size:var(--fs-tiny);font-weight:650;color:var(--ink-2)}
.lab{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:var(--fs-xs);color:var(--ink-3)}
.num{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px;line-height:1.1;margin-top:1px}
.num b{font-size:var(--fs-hero);font-weight:700;letter-spacing:-.015em;user-select:text}.num b.none{font-weight:700}
.num span{font-size:var(--fs-sm);color:var(--ink-3)}
.sub{display:flex;flex-wrap:wrap;gap:0 10px;margin-top:2px;font-size:var(--fs-xs);color:var(--ink-2)}
.sub em{font-style:normal;color:var(--ink-3)}
.pill{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 7px;border-radius:9px;font-size:var(--fs-tiny);font-weight:650;white-space:nowrap;background:var(--muted-soft);color:var(--ink-2)}
.pill::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
[data-tone="ok"].pill{background:var(--ok-soft);color:var(--ok)}[data-tone="warn"].pill{background:var(--warn-soft);color:var(--warn)}[data-tone="bad"].pill{background:var(--bad-soft);color:var(--bad)}
.nm{display:flex;flex-direction:column;gap:3px}
.ch{font-weight:650;font-size:var(--fs-base);line-height:1.35;overflow-wrap:anywhere;user-select:text}
.src{font-size:var(--fs-xs);line-height:1.4;color:var(--ink-3);overflow-wrap:anywhere;user-select:text}
.src::before{content:"源";display:inline-block;margin-right:5px;padding:0 4px;border-radius:3px;background:var(--sunken);color:var(--ink-3);font-size:var(--fs-micro);line-height:15px}
/* Columns grow toward their content, so a short supplier code stays whole while a long name still wraps. */
.spec{display:grid;grid-template-columns:repeat(3,minmax(0,auto));gap:6px;margin-top:8px}
.spec div{padding:5px 7px;border-radius:7px;background:var(--sunken);display:flex;flex-direction:column;gap:1px}
.spec small{font-size:var(--fs-micro);color:var(--ink-3);white-space:nowrap}
.spec b{font-size:var(--fs-sm);font-weight:var(--value-weight);overflow-wrap:anywhere;user-select:text}.spec b.none{font-weight:400}
.mono{font-family:var(--mono);font-weight:var(--mono-weight)}.spec b.mono{font-size:var(--fs-xs);font-weight:600}
.spec b[data-tone="ok"]{color:var(--ok)}.spec b[data-tone="warn"]{color:var(--warn)}.spec b[data-tone="bad"]{color:var(--bad)}
.ids{display:grid;grid-template-columns:44px minmax(0,1fr) 22px;column-gap:6px;row-gap:3px;margin:0;align-items:center}
.ids dt{font-size:var(--fs-xs);color:var(--ink-3);white-space:nowrap}
.ids dd{margin:0;font-family:var(--mono);font-weight:var(--mono-weight);font-size:var(--fs-sm);letter-spacing:.02em;word-break:break-all;line-height:1.4;user-select:text}
.ids dd.txt,.ids dd.none{font-family:inherit;letter-spacing:0}
.copy{width:22px;height:22px;border-radius:6px;display:grid;place-items:center;color:var(--ink-3)}
.copy:hover{background:var(--accent-soft);color:var(--accent)}.copy svg{width:12px;height:12px}.copy.done{color:var(--ok)}
.heading{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:5px;font-size:var(--fs-xs);color:var(--ink-3)}
.heading b{font-weight:600;color:var(--ink-2);white-space:nowrap}
/* Up to ten CDRs: the list scrolls under the pointer about five rows tall, without moving the card body. */
.cdrs{list-style:none;margin:0;padding:0 3px 0 0;display:flex;flex-direction:column;gap:3px;max-height:132px;overflow-y:auto;overscroll-behavior:contain}
.cdrs::-webkit-scrollbar{width:3px}.cdrs::-webkit-scrollbar-thumb{background:rgba(23,29,43,.22);border-radius:2px}.cdrs:hover::-webkit-scrollbar-thumb{background:rgba(23,29,43,.4)}
.cdr{position:relative;flex:none;display:grid;grid-template-columns:76px minmax(0,1fr) auto;column-gap:8px;align-items:center;min-height:24px;padding:3px 7px;border-radius:6px;background:var(--sunken);overflow:hidden;font-size:var(--fs-xs);line-height:1.3}
.cdr .bar{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,rgba(47,84,214,.12),rgba(47,84,214,.04))}
.cdr>*{position:relative}
.cdr time{font-family:var(--mono);font-weight:var(--mono-weight);color:var(--ink-2);white-space:nowrap}
.cdr time.today{color:var(--accent-ink);font-weight:600}
.cdr .op{overflow-wrap:anywhere}
.cdr b{font-weight:650;white-space:nowrap}
.empty{margin:0;padding:7px 9px;border-radius:6px;background:var(--sunken);color:var(--ink-3);font-size:var(--fs-xs)}
.sum{flex:none;display:flex;align-items:center;gap:8px;padding:8px var(--pad);font-size:var(--fs-md)}
.sum b{font-weight:650;white-space:nowrap}.sum span:last-child{flex:1;color:var(--ink-3);font-size:var(--fs-xs);overflow-wrap:anywhere}
.callout{display:flex;align-items:flex-start;gap:9px;padding:14px 0 10px;color:var(--ink-2)}
.callout svg{width:16px;height:16px;margin-top:1px}
.callout[data-tone="info"] svg{color:var(--accent)}.callout[data-tone="warn"] svg{color:var(--warn)}.callout[data-tone="bad"] svg{color:var(--bad)}
.callout div{flex:1;display:grid;gap:8px;justify-items:start}.callout p{margin:0;line-height:1.5;overflow-wrap:anywhere}
.solid{height:26px;padding:0 12px;border-radius:7px;background:var(--accent);color:#fff;font-weight:600;font-size:var(--fs-sm);box-shadow:0 1px 2px rgba(47,84,214,.3)}
.solid:hover{filter:brightness(1.07)}
.outline{height:26px;padding:0 12px;border-radius:7px;border:1px solid var(--line);background:#fff;font-weight:600;font-size:var(--fs-sm)}.outline:hover{background:var(--sunken)}
.skeleton{display:grid;gap:8px;padding:12px 0}
.skeleton i{display:block;height:10px;border-radius:5px;background:linear-gradient(90deg,#eef0f4 25%,#f7f8fa 50%,#eef0f4 75%);background-size:200% 100%;animation:shimmer 1.2s linear infinite}
.skeleton .r{display:grid;grid-template-columns:44px 1fr;gap:10px;align-items:center}
.skeleton .r>i{width:44px;height:44px;border-radius:50%}.skeleton .r div{display:grid;gap:6px}
.skeleton .t3{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.skeleton .t3 i{height:34px;border-radius:7px}
.foot{flex:none;display:flex;align-items:center;gap:6px;min-height:28px;padding:0 var(--pad);border-top:1px solid var(--line-soft);background:#fbfcfe;color:var(--ink-3);font-size:var(--fs-tiny);white-space:nowrap}
.foot .rel{color:var(--ink-2)}.foot .flash{margin-left:auto;color:var(--ok);font-weight:650}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes shimmer{to{background-position:-200% 0}}
@keyframes rise{from{opacity:0;transform:translateY(4px)}}
@media (prefers-reduced-motion:reduce){.card{animation:none}.skeleton i,.busy .refresh svg{animation:none!important}.fg{transition:none}}
[hidden]{display:none!important}`;
/**
 * Windows renders YaHei and Consolas visibly lighter and smaller than PingFang/SF at the same size: use the
 * Windows UI faces (Cascadia Mono ships with Windows 11, Consolas before it), keep every text size at 12px or more
 * (only the remaining-quota figure is larger), set values in bold and use near-black ink for every text tier
 * (ClearType thins grey strokes further). The spacing is tighter than macOS so the larger type still fits under 用户信息.
 */
const WINDOWS_TYPE=`
:host{--sans:'Microsoft YaHei UI','Microsoft YaHei','Segoe UI',sans-serif;--mono:'Cascadia Mono',Consolas,'Microsoft YaHei UI',monospace;
--fs-micro:12px;--fs-tiny:12px;--fs-xs:12px;--fs-sm:12.5px;--fs-md:13px;--fs-base:13.5px;--fs-hero:20px;--value-weight:700;--mono-weight:500;--pad:9px;
--ink:#0b1120;--ink-2:#262f40;--ink-3:#454e60;--line:#d5dae3;--line-soft:#e3e7ee}
.head{min-height:36px}.tab{height:26px}.pill{height:21px;border-radius:11px}.row{padding:7px 0}.tabs{padding-top:6px;padding-bottom:5px}
.spec{gap:4px;margin-top:6px}.spec div{padding:4px 6px}.ids{grid-template-columns:50px minmax(0,1fr) 22px;row-gap:2px}
.cdr{grid-template-columns:92px minmax(0,1fr) auto;min-height:26px}.cdrs{max-height:142px}.callout{padding:10px 0 8px}
.foot{min-height:26px}.solid,.outline{height:28px}.skeleton{padding:9px 0}`;
export interface OrderSummaryCardInput {identifier:string|undefined;conversationKey:string|null|undefined;auth:PanelAuth|undefined}
export interface OrderSummaryCardHooks {load(intent:OrderSummaryIntent):Promise<unknown>;openLogin():void}
export interface OrderSummaryCard {update(input:OrderSummaryCardInput):void;reposition():void;invalidateStacking(mutations:readonly MutationRecord[]):boolean;readonly host:HTMLElement;dispose():void}
type Tone='ok'|'warn'|'bad'|'muted';
/** Profile states read as healthy, needing attention or broken; anything else stays neutral. */
export function esimTone(code:string):Tone{
  if(/^(enabled?|installed|active|downloaded)$/i.test(code))return 'ok';
  if(/^(disabled?|inactive|not[ _-]?installed)$/i.test(code))return 'warn';
  return /delet|error|fail|releas|revok/i.test(code)?'bad':'muted';
}
const clock=(at:number)=>{const date=new Date(at);return [date.getHours(),date.getMinutes(),date.getSeconds()].map(part=>String(part).padStart(2,'0')).join(':');};
/** CDR usage as `formatMb` writes it on the host: `12.5 MB` or `1.2 GB`. */
const usageMb=(text:string|null)=>{const match=/^(\d+(?:\.\d+)?) (MB|GB)$/.exec(text??'');return match?Number(match[1])*(match[2]==='GB'?1024:1):null;};
const formatMb=(mb:number)=>mb>=1024?`${Number((mb/1024).toFixed(2))} GB`:`${Number(mb.toFixed(2))} MB`;
/** CDR times are the server's Asia/Shanghai `MM-DD HH:mm`; today is that zone's date. */
const shanghaiDay=()=>new Date(Date.now()+8*3600_000).toISOString().slice(5,10);
const updatedAgo=(at:number)=>{const minutes=Math.floor((Date.now()-at)/60_000);return minutes<1?'刚刚更新':minutes<60?`${minutes} 分钟前更新`:`${clock(at).slice(0,5)} 更新`;};
const sameOrder=(result:OrderSummaryResult,identifier:string)=>(result.status==='ready'?result.summary.identifier:result.identifier)===identifier;
/** One card per page. `update` follows the order shown for the bound conversation; `load` goes through the bridge. */
export function createOrderSummaryCard(document:Document,hooks:OrderSummaryCardHooks):OrderSummaryCard{
  const view=document.defaultView!;
  type Target={identifier:string;key:string};
  let disposed=false,target:Target|undefined,auth:PanelAuth|undefined,result:OrderSummaryResult|undefined,settled:{target:Target;at:number;result:OrderSummaryResult}|undefined,loading=false,sequence=0,selected=0,collapsed=false,flash='',flashTimer:number|undefined,ticker:number|undefined,frame:HTMLIFrameElement|undefined,child:Document|undefined,pending:number|undefined;
  let discoverFrame=true,discoverContent=true,geometryDirty=false,stackDirty=false,contentNodes:Element[]=[];
  let frameCandidates:HTMLIFrameElement[]=[],framePanel:Element|undefined;
  const stackingSources=new Set([...document.querySelectorAll(MODAL_SELECTOR)].filter(element=>!isOwned(element)));
  type PlacementStyles=Partial<Pick<CSSStyleDeclaration,'display'|'top'|'bottom'|'left'|'width'|'maxHeight'|'zIndex'>>;
  const host=document.createElement('div');host.id=ORDER_SUMMARY_HOST_ID;host.setAttribute('data-tsim-owned','1');host.setAttribute('role','region');host.setAttribute('aria-label','订单套餐信息');
  host.style.cssText='position:fixed;z-index:900;display:none;margin:0;padding:0;border:0';
  const contain=(event:Event)=>event.stopPropagation();CONTAINED.forEach(type=>host.addEventListener(type,contain));
  const shadow=host.attachShadow({mode:'open'});
  const make=<K extends keyof HTMLElementTagNameMap>(tag:K,className='',text='')=>{const node=document.createElement(tag);if(className)node.className=className;if(text)node.textContent=text;return node;};
  const button=(className:string,text='',label='')=>{const node=make('button',className,text);node.type='button';if(label){node.title=label;node.setAttribute('aria-label',label);}return node;};
  const icon=(name:keyof typeof ICONS)=>{const node=make('span');node.style.display='contents';node.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;return node;};
  const style=make('style');style.textContent=RUNTIME_PLATFORM==='win32'?STYLE+WINDOWS_TYPE:STYLE;
  const card=make('div','card'),head=make('div','head'),toggleTitle=button('tg'),title=make('span','title','套餐速览'),count=make('span','count');toggleTitle.append(title,count);
  const refresh=button('icon refresh','','刷新'),toggle=button('icon toggle','','收起');refresh.append(icon('retry'));toggle.append(icon('chevron'));
  head.append(toggleTitle,refresh,toggle);
  const sum=make('div','sum'),body=make('div','body'),foot=make('div','foot'),updated=make('span','rel'),meta=make('span'),flashText=make('span','flash');body.setAttribute('aria-live','polite');flashText.setAttribute('aria-live','polite');foot.append(updated,meta,flashText);
  card.append(head,sum,body,foot);shadow.append(style,card);
  const showFlash=(text:string)=>{flash=text;view.clearTimeout(flashTimer);flashTimer=view.setTimeout(()=>{flash='';renderFoot();},1500);renderFoot();};
  async function copy(text:string,label:string){
    let ok=false;
    try{await view.navigator.clipboard.writeText(text);ok=true;}catch{
      const area=make('textarea');area.value=text;area.style.cssText='position:fixed;opacity:0;pointer-events:none';shadow.append(area);area.select();try{ok=document.execCommand('copy');}catch{ok=false;}area.remove();
    }
    showFlash(ok?`已复制 ${label}`:'复制失败');return ok;
  }
  // Content.
  const section=(className:string,...nodes:Node[])=>{const node=make('section',`row ${className}`);node.append(...nodes);return node;};
  const pill=(plan:OrderSummaryPlan)=>{const node=make('span','pill',plan.status?.label??'未返回');node.dataset.tone=plan.status?.tone??'muted';if(plan.status&&plan.status.code!==plan.status.label)node.title=plan.status.code;return node;};
  /** A progress ring of `percent`; only numbers reach the markup. */
  const ring=(className:string,size:number,radius:number,percent:number)=>{
    const node=make('span',className),circumference=2*Math.PI*radius,center=size/2;
    node.innerHTML=`<svg viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle class="tr" cx="${center}" cy="${center}" r="${radius}"/><circle class="fg" cx="${center}" cy="${center}" r="${radius}" stroke-dasharray="${(circumference*percent/100).toFixed(1)} ${circumference.toFixed(1)}"/></svg>`;
    return node;
  };
  /** Remaining quota as the ring and headline figure read it: a percentage, unlimited (∞) or no data (—). */
  function gauge(plan:OrderSummaryPlan){
    const remaining=plan.remaining;
    return{
      percent:remaining?remaining.percent:plan.unlimited?100:0,label:remaining?`${remaining.percent}%`:plan.unlimited?'∞':'—',
      tone:remaining?(remaining.tone==='ok'?'':remaining.tone):'muted',
      scope:remaining?(remaining.scope==='daily'?'今日剩余':'套餐剩余'):plan.unlimited?'不限量套餐':'无用量数据',
      text:remaining?.text??(plan.unlimited?'不限量':null),quota:remaining?`/ ${remaining.quota}`:'',
    };
  }
  function skeleton(){
    const node=make('div','skeleton'),top=make('div','r'),lines=make('div'),tiles=make('div','t3'),bar=(width:string)=>{const line=make('i');line.style.width=width;return line;};
    lines.append(bar('40%'),bar('65%'));top.append(make('i'),lines);tiles.append(make('i'),make('i'),make('i'));
    node.append(top,bar('85%'),bar('70%'),tiles,bar('60%'),bar('75%'));node.setAttribute('aria-label','正在查询套餐信息');return node;
  }
  function callout(tone:'info'|'warn'|'bad',name:keyof typeof ICONS,text:string,action?:HTMLButtonElement){const node=make('div','callout'),content=make('div');node.dataset.tone=tone;content.append(make('p','',text));if(action)content.append(action);node.append(icon(name),content);return node;}
  const loginButton=()=>{const node=button('solid','登录 TSIM');node.addEventListener('click',()=>{if(!disposed)hooks.openLogin();});return node;};
  const retryButton=()=>{const node=button('outline','重试');node.addEventListener('click',()=>load(false));return node;};
  function hero(plan:OrderSummaryPlan){
    const g=gauge(plan),meter=ring('ring',44,18,g.percent),info=make('div'),lab=make('div','lab'),num=make('div','num'),sub=make('div','sub');
    if(g.tone)meter.dataset.tone=g.tone;meter.append(make('b','',g.label));
    if(plan.remaining){meter.setAttribute('role','meter');meter.setAttribute('aria-label','剩余流量');meter.setAttribute('aria-valuemin','0');meter.setAttribute('aria-valuemax','100');meter.setAttribute('aria-valuenow',String(plan.remaining.percent));}
    lab.append(pill(plan),make('span','',g.scope));
    num.append(make('b',g.text?'':'none',g.text??'—'));if(g.quota)num.append(make('span','',g.quota));
    const stat=(label:string,text:string)=>{const node=make('span');node.append(make('em','',label),` ${text}`);return node;};
    sub.append(stat('总用量',plan.totalUsage??'未回传'));if(plan.todayUsage)sub.append(stat('当日',plan.todayUsage));
    info.append(lab,num,sub);return section('hero',meter,info);
  }
  function names(plan:OrderSummaryPlan){
    const nm=make('div','nm'),spec=make('div','spec');
    nm.append(make('div',plan.channelPlanName?'ch':'ch none',plan.channelPlanName??'—'));if(plan.sourcePlanName)nm.append(make('div','src',plan.sourcePlanName));
    const cell=(label:string,text:string|null,mono=false,fallback='—')=>{const node=make('div'),value=make('b',text?(mono?'mono':''):'none',text??fallback);if(text)value.title=text;node.append(make('small','',label),value);spec.append(node);return value;};
    cell('供应商',plan.supplier);cell('APN',plan.apn,true);
    const esim=cell('eSIM',plan.esimStatus,true,'未返回');if(plan.esimStatus)esim.dataset.tone=esimTone(plan.esimStatus);
    return section('names',nm,spec);
  }
  /** Long identifiers in groups of four for reading aloud; the copy button copies the raw value. */
  function identifiers(plan:OrderSummaryPlan){
    const list=make('dl','ids');
    const rows:[string,string,string|null,boolean,string][]=[['流水号','业务流水号',plan.serialNumber,true,'未返回'],['ICCID','ICCID',plan.iccid,true,'未返回'],['EID','EID',plan.eid,true,'实体卡或未返回'],['设备','设备型号',plan.deviceModel,false,'未返回']];
    for(const [label,full,text,copyable,fallback] of rows){
      const dt=make('dt','',label),dd=make('dd',text?(copyable?'':'txt'):'none',text?(copyable?text.replace(/(.{4})(?=.)/g,'$1 '):text):fallback),slot=make('span');
      dt.title=full;if(text)dd.title=text;
      if(text&&copyable){
        const copyButton=button('copy','',`复制 ${full}`);copyButton.append(icon('copy'));
        copyButton.addEventListener('click',()=>{void copy(text,full).then(ok=>{
          if(!ok||disposed)return;copyButton.classList.add('done');copyButton.replaceChildren(icon('check'));
          view.setTimeout(()=>{copyButton.classList.remove('done');copyButton.replaceChildren(icon('copy'));},1500);
        });});
        slot.append(copyButton);
      }
      list.append(dt,dd,slot);
    }
    return section('identifiers',list);
  }
  function records(plan:OrderSummaryPlan){
    const heading=make('div','heading'),cdrs=plan.cdrs;
    if(!cdrs.length){heading.append(make('span','','CDR'));return section('records',heading,make('p','empty','暂无 CDR 记录'));}
    // One shared region moves to the heading; mixed regions stay on each row.
    const regions=new Set(cdrs.map(cdr=>cdr.region)),shared=regions.size===1?cdrs[0].region:null;
    const amounts=cdrs.map(cdr=>usageMb(cdr.usage)),known=amounts.filter((amount):amount is number=>amount!==null),max=Math.max(0,...known),today=shanghaiDay();
    heading.append(make('span','',`最近 ${cdrs.length} 条 CDR${shared?` · ${shared}`:''}`));
    if(known.length)heading.append(make('b','',`${formatMb(known.reduce((total,amount)=>total+amount,0))} 合计`));
    const list=make('ol','cdrs');list.tabIndex=0;list.setAttribute('aria-label','CDR 明细，可滚动');
    cdrs.forEach((cdr,index)=>{
      const row=make('li','cdr'),bar=make('i','bar'),amount=amounts[index],isToday=cdr.time?.length===11&&cdr.time.startsWith(`${today} `);
      bar.style.width=amount!==null&&max>0?`${Math.max(4,Math.round(amount/max*100))}%`:'0%';
      const place=(shared?[cdr.operator]:[cdr.region,cdr.operator]).filter(Boolean).join(' · '),where=make('span',place?'op':'op none',place||'—');if(place)where.title=place;
      row.append(bar,make('time',isToday?'today':'',cdr.time?(isToday?`今天 ${cdr.time.slice(6)}`:cdr.time):'—'),where,make('b',cdr.usage?'':'none',cdr.usage??'—'));list.append(row);
    });
    return section('records',heading,list);
  }
  function planView(summary:OrderSummary):Node[]{
    const plans=summary.plans,index=Math.min(selected,plans.length-1),plan=plans[index],nodes:Node[]=[];
    if(plans.length>1||summary.total>plans.length){
      const tabs=make('div','tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','套餐');
      plans.forEach((item,position)=>{
        const tab=button('tab',`套餐 ${position+1}`),dot=make('i');dot.dataset.tone=item.status?.tone??'muted';tab.prepend(dot);tab.append(make('span','st',item.status?.label??''));
        tab.setAttribute('role','tab');tab.setAttribute('aria-selected',String(position===index));tab.title=[`套餐 ${position+1}`,item.status?.label,item.channelPlanName??item.sourcePlanName].filter(Boolean).join(' · ');
        tab.addEventListener('click',()=>{if(selected===position)return;selected=position;render();});tabs.append(tab);
      });
      if(summary.total>plans.length){const more=make('span','more',`+${summary.total-plans.length}`);more.title=`该订单共 ${summary.total} 个套餐，这里显示前 ${plans.length} 个；其余请在 TSIM 中查看`;more.setAttribute('aria-label',more.title);tabs.append(more);}
      nodes.push(tabs);
    }
    nodes.push(hero(plan),names(plan),identifiers(plan),records(plan));
    return nodes;
  }
  /** The collapsed card still shows the selected plan's status and remaining quota. */
  function summaryLine(summary:OrderSummary){
    const index=Math.min(selected,summary.plans.length-1),plan=summary.plans[index],g=gauge(plan),mini=ring('mini',22,8.5,g.percent);if(g.tone)mini.dataset.tone=g.tone;
    return[mini,pill(plan),make('b',g.text?'':'none',g.text??'—'),make('span','',[`套餐 ${index+1}`,plan.channelPlanName??plan.sourcePlanName].filter(Boolean).join(' · '))];
  }
  function render(){
    if(disposed)return;
    card.classList.toggle('collapsed',collapsed);card.classList.toggle('busy',loading);body.setAttribute('aria-busy',String(loading));
    const ready=result?.status==='ready'&&auth==='ready'?result.summary:undefined;
    count.textContent=ready?`${ready.total} 个套餐`:'';count.hidden=!ready;
    refresh.disabled=!target||auth!=='ready'||loading;
    const label=collapsed?'展开':'收起';
    toggle.setAttribute('aria-expanded',String(!collapsed));toggle.title=label;toggle.setAttribute('aria-label',label);
    toggleTitle.setAttribute('aria-expanded',String(!collapsed));toggleTitle.title=`${label}套餐速览${target?` · 订单 ${target.identifier}`:''}`;
    sum.hidden=!collapsed||!ready;sum.replaceChildren(...(collapsed&&ready?summaryLine(ready):[]));
    let content:Node[]=[];
    if(!target)content=[];
    else if(!auth||auth==='connecting')content=[skeleton()];
    else if(auth!=='ready')content=[callout('info','lock',auth==='failed'?'TSIM 登录服务连接失败，重新登录后自动查询本订单套餐':'登录 TSIM 后自动查询本订单的套餐信息',loginButton())];
    else if(!result)content=[skeleton()];
    else if(result.status==='empty')content=[callout('info','info','未查询到该订单的套餐')];
    else if(result.status==='failed')content=[callout(result.reason==='permission'||result.reason==='rate_limited'?'warn':'bad','alert',ORDER_SUMMARY_FAILURE_TEXT[result.reason],result.reason==='login'?loginButton():result.reason==='permission'?undefined:retryButton())];
    else content=planView(result.summary);
    body.replaceChildren(...content);renderFoot();schedule();
  }
  function renderFoot(){
    if(disposed)return;const at=result?.status==='ready'&&auth==='ready'?result.fetchedAt:undefined;
    updated.textContent=loading&&result?'正在刷新':at!==undefined?updatedAgo(at):'';updated.title=at!==undefined?`更新于 ${clock(at)}`:'';
    meta.textContent=at!==undefined&&!loading?`· TSIM · ${ORDER_SUMMARY_REUSE_MS/1000} 秒内复用`:'';flashText.textContent=flash;
    foot.hidden=!updated.textContent&&!flash;
    // "N 分钟前" stays current while the expanded card shows a snapshot.
    const live=at!==undefined&&!collapsed;
    if(live&&ticker===undefined)ticker=view.setInterval(renderFoot,30_000);else if(!live&&ticker!==undefined){view.clearInterval(ticker);ticker=undefined;}
  }
  // Reads.
  function finish(seq:number,value:OrderSummaryResult){
    if(disposed||seq!==sequence||!target)return;loading=false;result=value;
    if(value.status==='ready'&&selected>=value.summary.plans.length)selected=0;
    settled=value.status==='failed'?undefined:{target,at:Date.now(),result:value};render();
  }
  function load(refresh:boolean){
    if(disposed||!target||auth!=='ready')return;
    const seq=++sequence,{identifier,key}=target;loading=true;if(!refresh){result=undefined;settled=undefined;}render();
    let pendingRead:Promise<unknown>;try{pendingRead=hooks.load({identifier,conversationKey:key,refresh});}catch{pendingRead=Promise.reject();}
    pendingRead.then(raw=>{const parsed=parseOrderSummaryResult(raw);finish(seq,parsed&&sameOrder(parsed,identifier)?parsed:{status:'failed',identifier,reason:'unavailable'});},()=>finish(seq,{status:'failed',identifier,reason:'unavailable'}));
  }
  function update(input:OrderSummaryCardInput){
    if(disposed)return;
    const next=input.identifier&&input.conversationKey&&ORDER_RE.test(input.identifier)?{identifier:input.identifier,key:input.conversationKey}:undefined;
    const changed=next?.identifier!==target?.identifier||next?.key!==target?.key,wasReady=auth==='ready';
    if(!changed&&input.auth===auth)return;
    auth=input.auth;
    // Nothing read under an earlier authorization is shown or reused again.
    if(auth!=='ready')settled=undefined;
    if(changed){
      discoverFrame=true;discoverContent=true;
      target=next;sequence++;loading=false;selected=0;
      // A short vendor re-render of the same order frame shows the settled card again instead of a skeleton.
      const reuse=!!next&&!!settled&&settled.target.identifier===next.identifier&&settled.target.key===next.key&&Date.now()-settled.at<ORDER_SUMMARY_REUSE_MS;
      if(reuse)result=settled!.result;else{result=undefined;if(next)settled=undefined;}
      if(next&&auth==='ready'&&!reuse){load(false);return;}
    }else if(auth!=='ready'){sequence++;loading=false;result=undefined;}
    else if(!wasReady||!result){load(false);return;}
    render();
  }
  // Placement over the order-detail frame. All geometry reads precede style writes.
  const observer=typeof view.ResizeObserver==='function'?new view.ResizeObserver(entries=>{
    if(entries.some(entry=>entry.target===child?.body))discoverContent=true;
    schedule();
  }):undefined;
  const onChildScroll=()=>schedule();
  function bindChild(next:Document|undefined){
    if(next===child)return;
    try{child?.defaultView?.removeEventListener('scroll',onChildScroll,true);}catch{/* revoked */}
    if(child?.body)observer?.unobserve(child.body);
    child=next;discoverContent=true;contentNodes=[];
    try{child?.defaultView?.addEventListener('scroll',onChildScroll,{passive:true,capture:true});}catch{child=undefined;return;}
    if(child?.body)observer?.observe(child.body);
  }
  function bindFrame(next:HTMLIFrameElement|undefined){
    if(next===frame)return;
    if(frame){frame.removeEventListener('load',onFrameLoad);observer?.unobserve(frame);}
    if(framePanel)observer?.unobserve(framePanel);framePanel=undefined;
    bindChild(undefined);frame=next;
    if(frame){frame.addEventListener('load',onFrameLoad);observer?.observe(frame);framePanel=frame.closest('.customer_info')??undefined;if(framePanel)observer?.observe(framePanel);}
  }
  function onFrameLoad(){bindChild(undefined);discoverContent=true;schedule();}
  /** Cache the relevant layout nodes, while reading their current rects only after a geometry change. */
  function contentBottom(current:HTMLIFrameElement,top:number){
    let doc:Document|null=null;try{doc=current.contentDocument;}catch{doc=null;}
    bindChild(doc??undefined);if(!doc)return;
    if(discoverContent||contentNodes.some(node=>!node.isConnected)){
      discoverContent=false;contentNodes=[];
      const lists=[...doc.querySelectorAll('.im_info_basic_list')].filter(list=>!isOwned(list)&&list.getClientRects().length>0),list=lists[lists.length-1];if(!list)return;
      contentNodes.push(list);
      // Later vendor sections below 用户信息 stay uncovered too.
      for(let node:Element|null=list;node&&node!==doc.body;node=node.parentElement)for(let sibling=node.nextElementSibling;sibling;sibling=sibling.nextElementSibling)contentNodes.push(sibling);
    }
    if(!contentNodes.length)return;
    let bottom=0;
    for(const node of contentNodes){const rect=node.getBoundingClientRect();if(rect.height>0)bottom=Math.max(bottom,rect.bottom);}
    return Number.isFinite(bottom)?top+Math.max(0,bottom):undefined;
  }
  function locate(){
    if(discoverFrame||frameCandidates.some(node=>!node.isConnected)){
      discoverFrame=false;frameCandidates=[...document.querySelectorAll<HTMLIFrameElement>(ORDER_SUMMARY_FRAME_SELECTOR)].filter(node=>!isOwned(node));
    }
    if(frameCandidates.length!==1||frameCandidates[0].closest('.customer_info.close, [hidden], [aria-hidden="true"]'))return;
    const rect=frameCandidates[0].getBoundingClientRect();
    return rect.width>=ORDER_SUMMARY_MIN_FRAME.width&&rect.height>=ORDER_SUMMARY_MIN_FRAME.height?{frame:frameCandidates[0],rect}:undefined;
  }
  function writeStyles(styles:PlacementStyles){
    let changed=false;
    for(const key of Object.keys(styles) as (keyof PlacementStyles)[]){const value=styles[key];if(value!==undefined&&host.style[key]!==value){host.style[key]=value;changed=true;}}
    return changed;
  }
  /** Run after placement has settled, never immediately after a style write. */
  function stacking(){
    if(typeof document.elementFromPoint!=='function'||host.style.display==='none')return;
    const rect=host.getBoundingClientRect();if(!rect.width||!rect.height)return;
    const x=rect.left+Math.min(rect.width/2,48),y=rect.top+Math.min(rect.height/2,20),hit=document.elementFromPoint(x,y);
    // If a dialog covers the panel, keep the normal layer. Never promote over a dialog.
    const hits=typeof document.elementsFromPoint==='function'?document.elementsFromPoint(x,y):hit?[hit]:[];
    if(hits.some(node=>node!==host&&!isOwned(node)&&!!node.closest(MODAL_SELECTOR)))return '900';
    if(hit&&hit!==host&&(hit===frame||!!hit.closest('.customer_info')))return Z_RAISED;
    return host.style.zIndex;
  }
  function place(){
    pending=undefined;if(disposed)return;
    const measure=geometryDirty,checkStack=stackDirty;geometryDirty=false;stackDirty=false;
    // No style writes occur until all requested geometry and stacking reads have completed.
    const zIndex=checkStack?stacking():undefined;
    let styles:PlacementStyles|undefined;
    if(measure){
      const found=target&&document.visibilityState!=='hidden'?locate():undefined;bindFrame(found?.frame);
      styles={display:'none'};
      if(found){
        const {rect}=found,left=Math.max(rect.left,0)+MARGIN,right=Math.min(rect.right,view.innerWidth)-MARGIN,top=Math.max(rect.top,0)+MARGIN,bottom=Math.min(rect.bottom,view.innerHeight)-MARGIN;
        if(right-left>=ORDER_SUMMARY_MIN_FRAME.width-2*MARGIN&&bottom-top>=ORDER_SUMMARY_MIN_FRAME.height/2){
          const used=contentBottom(found.frame,rect.top),start=used===undefined?undefined:Math.max(top,used+MARGIN);
          styles=start!==undefined&&bottom-start>=MIN_FREE?{top:`${start}px`,bottom:'',maxHeight:`${bottom-start}px`}:{top:'',bottom:`${view.innerHeight-bottom}px`,maxHeight:`${Math.max(ORDER_SUMMARY_MIN_FRAME.height/2,(bottom-top)*ORDER_SUMMARY_DOCKED_SHARE)}px`};
          Object.assign(styles,{left:`${left}px`,width:`${right-left}px`,display:'block'});
        }
      }
    }
    if(measure&&!host.isConnected)(document.body??document.documentElement).append(host);
    if(zIndex!==undefined)writeStyles({zIndex});
    if(styles&&writeStyles(styles)&&styles.display==='block'){stackDirty=true;queue();}
  }
  function queue(){
    if(disposed||pending!==undefined)return;
    pending=typeof view.requestAnimationFrame==='function'?view.requestAnimationFrame(place):view.setTimeout(place,16);
  }
  function schedule(){geometryDirty=true;stackDirty=true;queue();}
  function reposition(){discoverFrame=true;discoverContent=true;schedule();}
  /** Reuse the owner's mutation batch; only modal changes need another hit test. */
  function invalidateStacking(mutations:readonly MutationRecord[]){
    if(disposed)return false;
    const collect=(element:Element)=>{
      let found=false;
      if(element.matches(MODAL_SELECTOR)&&!isOwned(element)){stackingSources.add(element);found=true;}
      for(const modal of element.querySelectorAll(MODAL_SELECTOR))if(!isOwned(modal)){stackingSources.add(modal);found=true;}
      return found;
    };
    let relevant=false;
    for(const mutation of mutations){
      const element=mutation.target.nodeType===1?mutation.target as Element:mutation.target.parentElement;
      if(!element||isOwned(element))continue;
      const changed=mutation.type==='childList'?[...mutation.addedNodes,...mutation.removedNodes]:[];
      if(changed.length&&changed.every(node=>node.nodeType===1&&isOwned(node as Element)))continue;
      const modal=element.closest(MODAL_SELECTOR);
      if(modal&&!isOwned(modal)){stackingSources.add(modal);relevant=true;}
      if(mutation.type==='attributes'){
        // Retain the previous modal identity through role/class removal and ancestor hiding.
        if([...stackingSources].some(source=>source===element||element.contains(source)))relevant=true;
        if(element.matches(MODAL_SELECTOR)){stackingSources.add(element);relevant=true;}
      }
      for(const node of changed)if(node.nodeType===1&&!isOwned(node as Element)){
        const changedElement=node as Element;
        if([...stackingSources].some(source=>source===changedElement||changedElement.contains(source)))relevant=true;
        if(collect(changedElement))relevant=true;
      }
    }
    for(const source of stackingSources)if(!source.isConnected||!source.matches(MODAL_SELECTOR)||isOwned(source))stackingSources.delete(source);
    if(relevant&&target&&host.style.display!=='none'){stackDirty=true;queue();}
    return relevant;
  }
  const cancel=()=>{if(pending===undefined)return;if(typeof view.cancelAnimationFrame==='function')view.cancelAnimationFrame(pending);view.clearTimeout(pending);pending=undefined;};
  refresh.addEventListener('click',()=>load(true));
  // The whole title bar collapses and expands the card; its title and chevron are the keyboard paths, refresh stays its own action.
  head.addEventListener('click',event=>{
    if((event.target as Element).closest?.('.refresh'))return;
    collapsed=!collapsed;render();
  });
  const onResize=()=>{discoverContent=true;schedule();};view.addEventListener('resize',onResize);
  const onScroll=(event:Event)=>{
    const source=event.target;
    if(source===view||source===document){schedule();return;}
    if(source&&(source as Node).nodeType===1){const element=source as Element;if(!isOwned(element)&&frame&&(element.contains(frame)||!!framePanel?.contains(element)))schedule();}
  };view.addEventListener('scroll',onScroll,{passive:true,capture:true});
  observer?.observe(card);
  const onVisibility=()=>schedule();document.addEventListener('visibilitychange',onVisibility);
  (document.body??document.documentElement).append(host);render();
  return{update,reposition,invalidateStacking,host,dispose(){
    if(disposed)return;disposed=true;sequence++;cancel();view.clearTimeout(flashTimer);view.clearInterval(ticker);bindFrame(undefined);observer?.disconnect();
    frameCandidates=[];contentNodes=[];stackingSources.clear();view.removeEventListener('resize',onResize);view.removeEventListener('scroll',onScroll,true);document.removeEventListener('visibilitychange',onVisibility);CONTAINED.forEach(type=>host.removeEventListener(type,contain));host.remove();
  }};
}
