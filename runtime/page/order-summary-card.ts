import {parseOrderSummaryResult,type OrderSummary,type OrderSummaryCdr,type OrderSummaryFailure,type OrderSummaryIntent,type OrderSummaryPlan,type OrderSummaryResult} from '../../src/shared/order-summary';
import type {PanelAuth} from '../../src/shared/workbench';
import {isOwned} from './identifiers';
import {RUNTIME_PLATFORM} from '../build-manifest';
/**
 * Read-only plan card in the free space under the vendor's 用户信息. The order-detail frame may be out of process,
 * so the card is a fixed overlay on the main document anchored to the frame's rect; text only, Node owns every TSim read.
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
  login:'TSim 登录已失效，请重新登录后查询',permission:'当前 TSim 账号没有订单查询权限',rate_limited:'查询过于频繁，请稍后再试',
  context:'会话已切换，请在当前会话中重试',unavailable:'暂时无法获取套餐信息，请稍后重试',
};
const ORDER_RE=/^[A-Za-z0-9_-]{1,100}$/;
const MIN_FREE=150,MARGIN=8,Z_RAISED='2147482000';
const CONTAINED=['keydown','keyup','keypress','click','mousedown','pointerdown','copy','cut','wheel'];
const ICONS={
  sim:'<path d="M8 3h6.5L19 7.5V20a1 1 0 0 1-1 1H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><rect x="9" y="11" width="7" height="7" rx="1.2"/><path d="M12.5 11v7M9 14.5h7"/>',
  retry:'<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',chevron:'<path d="m6 9 6 6 6-6"/>',
  copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  lock:'<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',alert:'<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
} as const;
/** Every font size and face goes through these variables; the defaults are the macOS (PingFang/SF) scale. */
const STYLE=`:host{all:initial;
--accent:#3a5bd9;--accent-soft:#eef1fd;--ink:#1d2433;--ink-2:#4b5568;--ink-3:#8a93a6;--line:#e3e7ee;--sunken:#f6f7fa;--hover:#eceff4;
--ok:#16855a;--ok-soft:#e6f4ed;--warn:#b26a00;--warn-soft:#fdf2df;--bad:#c2382f;--bad-soft:#fcebea;--muted-soft:#f1f2f5;
--sans:-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI','Microsoft YaHei',sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--fs-micro:10.5px;--fs-xs:11px;--fs-sm:11.5px;--fs-md:12px;--fs-base:12.5px;--fs-title:13px;--fs-value:14px;--value-weight:400;--mono-weight:400;
font:var(--fs-base)/1.5 var(--sans);color:var(--ink)}
*{box-sizing:border-box;font:inherit;min-width:0}
button{color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;white-space:nowrap}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
button:disabled{opacity:.4;cursor:not-allowed}
svg{width:14px;height:14px;flex:none;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.card{display:flex;flex-direction:column;max-height:inherit;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 28px rgba(15,23,42,.10),0 1px 3px rgba(15,23,42,.06);overflow:hidden;animation:rise .14s ease-out}
.head{flex:none;display:flex;align-items:center;gap:8px;min-height:42px;padding:0 6px 0 10px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,#fafbfe,#fff)}
.collapsed .head{border-bottom-color:transparent}
.mark{width:24px;height:24px;border-radius:7px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent);flex:none}
.title{font-weight:600;font-size:var(--fs-title);white-space:nowrap}
.order{font:500 var(--fs-sm)/18px var(--mono);padding:0 6px;border-radius:5px;background:var(--sunken);color:var(--ink-2);white-space:nowrap;flex:none;user-select:text}
.spacer{flex:1}
.icon{width:26px;height:26px;display:grid;place-items:center;border-radius:7px;color:var(--ink-2);flex:none}
.icon:hover:not(:disabled){background:var(--hover);color:var(--ink)}
.busy .refresh svg{animation:spin .8s linear infinite}
.toggle svg{transition:transform .15s}.collapsed .toggle svg{transform:rotate(-90deg)}
.body{flex:1 1 auto;overflow:auto;overscroll-behavior:contain;padding:10px 12px 6px}
.collapsed .body,.collapsed .foot{display:none}
/* A hairline scrollbar on the card's right edge; the content keeps its own padding. */
.body::-webkit-scrollbar{width:3px;height:3px}.body::-webkit-scrollbar-track{background:transparent}
.body::-webkit-scrollbar-thumb{background:rgba(29,36,51,.28);border-radius:2px}.body::-webkit-scrollbar-thumb:hover{background:rgba(29,36,51,.5)}
.body::-webkit-scrollbar-button{display:none;width:0;height:0}
.tabs{display:flex;gap:4px;margin:0 0 10px;overflow-x:auto;scrollbar-width:none}
.tab{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 10px;border-radius:12px;background:var(--sunken);color:var(--ink-2);font-size:var(--fs-md)}
.tab:hover:not([aria-selected="true"]){background:var(--hover);color:var(--ink)}
.tab[aria-selected="true"]{background:var(--accent);color:#fff;font-weight:600}
.tab i{width:6px;height:6px;border-radius:50%;background:var(--ink-3)}
.tab i[data-tone="ok"]{background:var(--ok)}.tab i[data-tone="warn"]{background:var(--warn)}.tab i[data-tone="bad"]{background:var(--bad)}
.tab[aria-selected="true"] i{box-shadow:0 0 0 1.5px #fff}
.note{margin:0 0 10px;padding:6px 9px;border-radius:8px;background:var(--accent-soft);color:var(--accent);font-size:var(--fs-sm)}
.section{padding:9px 0;border-top:1px dashed var(--line)}.section:first-of-type{border-top:0;padding-top:0}
.kv{display:grid;grid-template-columns:64px minmax(0,1fr);column-gap:10px;row-gap:6px;margin:0;align-items:baseline}
.kv dt{color:var(--ink-3);font-size:var(--fs-sm);white-space:nowrap}
.kv dd{margin:0;overflow-wrap:anywhere;user-select:text;font-weight:var(--value-weight)}
.mono{font-family:var(--mono);font-size:var(--fs-sm);font-weight:var(--mono-weight)}
.none{color:var(--ink-3);font-weight:400}
.status{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.label{color:var(--ink-3);font-size:var(--fs-sm)}
.pill{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:10px;font-size:var(--fs-sm);font-weight:600;background:var(--muted-soft);color:var(--ink-2);white-space:nowrap}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.pill small{font:500 var(--fs-micro) var(--mono);opacity:.75}
[data-tone="ok"].pill{background:var(--ok-soft);color:var(--ok)}[data-tone="warn"].pill{background:var(--warn-soft);color:var(--warn)}[data-tone="bad"].pill{background:var(--bad-soft);color:var(--bad)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(76px,1fr));gap:6px}
.tile{padding:7px 9px;border-radius:9px;background:var(--sunken)}
.tile small{display:block;color:var(--ink-3);font-size:var(--fs-xs);white-space:nowrap}
.tile b{display:block;font-size:var(--fs-value);font-weight:650;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;user-select:text}
.tile b.none{font-weight:400}
.tile.remain{background:var(--accent-soft)}.tile.remain b{color:var(--accent)}
.tile.remain[data-tone="warn"]{background:var(--warn-soft)}.tile.remain[data-tone="warn"] b{color:var(--warn)}
.tile.remain[data-tone="over"]{background:var(--bad-soft)}.tile.remain[data-tone="over"] b{color:var(--bad)}
.meter{margin-top:8px;height:6px;border-radius:3px;background:#e8ecf2;overflow:hidden}
.meter i{display:block;height:100%;border-radius:inherit;background:var(--accent);transition:width .3s}
.meter[data-tone="warn"] i{background:#e09a2c}.meter[data-tone="over"] i{background:var(--bad)}
.caption{display:flex;flex-wrap:wrap;justify-content:space-between;gap:0 8px;margin-top:4px;color:var(--ink-3);font-size:var(--fs-xs)}
.code{display:inline-block;padding:0 7px;border-radius:5px;font:600 var(--fs-xs)/19px var(--mono);letter-spacing:.02em;background:var(--muted-soft);color:var(--ink-2)}
.code[data-tone="ok"]{background:var(--ok-soft);color:var(--ok)}.code[data-tone="warn"]{background:var(--warn-soft);color:var(--warn)}.code[data-tone="bad"]{background:var(--bad-soft);color:var(--bad)}
.eid{display:flex;align-items:flex-start;gap:4px}.eid span{flex:1;word-break:break-all;line-height:1.45}
.copy{width:20px;height:20px;border-radius:5px;display:grid;place-items:center;color:var(--ink-3);flex:none}.copy:hover{background:var(--hover);color:var(--ink)}.copy svg{width:12px;height:12px}
.heading{display:flex;align-items:center;justify-content:space-between;color:var(--ink-3);font-size:var(--fs-sm);margin-bottom:6px}
.cdrs{list-style:none;margin:0;padding:0;display:grid;gap:4px}
.cdr{display:grid;grid-template-columns:auto minmax(0,1fr) auto;column-gap:9px;align-items:center;padding:6px 9px;border-radius:8px;background:var(--sunken)}
.cdr time{font:500 var(--fs-xs) var(--mono);color:var(--ink-2);white-space:nowrap}
.cdr .where{display:flex;flex-direction:column;line-height:1.35;overflow:hidden}
.cdr .where span{overflow-wrap:anywhere}
.cdr .where small{font:var(--fs-micro) var(--mono);color:var(--ink-3)}
.cdr b{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.callout{display:flex;align-items:flex-start;gap:9px;padding:2px 0 6px;color:var(--ink-2)}
.callout svg{width:16px;height:16px;margin-top:1px}
.callout[data-tone="info"] svg{color:var(--accent)}.callout[data-tone="warn"] svg{color:var(--warn)}.callout[data-tone="bad"] svg{color:var(--bad)}
.callout div{flex:1;display:grid;gap:8px;justify-items:start}.callout p{margin:0;overflow-wrap:anywhere}
.solid{height:26px;padding:0 12px;border-radius:7px;background:var(--accent);color:#fff;font-weight:600;font-size:var(--fs-md);box-shadow:0 1px 2px rgba(58,91,217,.3)}
.solid:hover{filter:brightness(1.07)}
.outline{height:26px;padding:0 12px;border-radius:7px;border:1px solid var(--line);background:#fff;font-size:var(--fs-md)}.outline:hover{background:var(--sunken)}
.skeleton{display:grid;gap:9px;padding:2px 0 8px}
.skeleton i{display:block;height:10px;border-radius:5px;background:linear-gradient(90deg,#eef0f4 25%,#f7f8fa 50%,#eef0f4 75%);background-size:200% 100%;animation:shimmer 1.1s linear infinite}
.skeleton i:nth-child(1){width:58%}.skeleton i:nth-child(2){width:86%}.skeleton i:nth-child(3){width:72%}
.skeleton .tiles i{width:auto;height:46px;border-radius:9px}
.foot{flex:none;display:flex;align-items:center;gap:6px;padding:6px 12px 8px;border-top:1px solid var(--line);color:var(--ink-3);font-size:var(--fs-xs);white-space:nowrap}
.foot .flash{margin-left:auto;color:var(--ok);font-weight:600}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes shimmer{to{background-position:-200% 0}}
@keyframes rise{from{opacity:0;transform:translateY(4px)}}
@media (prefers-reduced-motion:reduce){.card{animation:none}.skeleton i,.busy .refresh svg{animation:none!important}}
[hidden]{display:none!important}`;
/**
 * Windows renders YaHei and Consolas visibly lighter and smaller than PingFang/SF at the same size: use the
 * Windows UI faces (Cascadia Mono ships with Windows 11, Consolas before it), keep every size at 12px or more,
 * set values in bold and use near-black ink for every text tier (ClearType thins grey strokes further). The
 * spacing is tighter than macOS so the larger type still fits the space under 用户信息.
 */
const WINDOWS_TYPE=`
:host{--sans:'Microsoft YaHei UI','Microsoft YaHei','Segoe UI',sans-serif;--mono:'Cascadia Mono',Consolas,'Microsoft YaHei UI',monospace;
--fs-micro:12px;--fs-xs:12px;--fs-sm:12.5px;--fs-md:13px;--fs-base:13px;--fs-title:14px;--fs-value:15px;--value-weight:600;--mono-weight:500;
--ink:#0b1120;--ink-2:#262f40;--ink-3:#454e60;--line:#d5dae3;line-height:1.45}
.head{min-height:38px;padding:3px 4px 3px 8px}.order{line-height:20px}.tab{height:26px}.pill{height:22px;border-radius:11px}.code{line-height:21px}
.body{padding:7px 8px 3px 9px}.tabs{margin:0 0 6px}.note{margin:0 0 6px;padding:4px 8px}
.section{padding:6px 0}.kv{grid-template-columns:70px minmax(0,1fr);column-gap:8px;row-gap:3px}
.tiles{grid-template-columns:repeat(auto-fit,minmax(80px,1fr));gap:4px}.tile{padding:5px 8px}.caption{margin-top:2px}
.heading{margin-bottom:4px}.cdr{padding:4px 8px}.cdrs{gap:3px}.callout{padding:0 0 4px}
.foot{padding:4px 9px 5px}.solid,.outline{height:28px}.copy{width:22px;height:22px}`;
export interface OrderSummaryCardInput {identifier:string|undefined;conversationKey:string|null|undefined;auth:PanelAuth|undefined}
export interface OrderSummaryCardHooks {load(intent:OrderSummaryIntent):Promise<unknown>;openLogin():void}
export interface OrderSummaryCard {update(input:OrderSummaryCardInput):void;reposition():void;readonly host:HTMLElement;dispose():void}
type Tone='ok'|'warn'|'bad'|'muted';
/** Profile states read as healthy, needing attention or broken; anything else stays neutral. */
export function esimTone(code:string):Tone{
  if(/^(enabled?|installed|active|downloaded)$/i.test(code))return 'ok';
  if(/^(disabled?|inactive|not[ _-]?installed)$/i.test(code))return 'warn';
  return /delet|error|fail|releas|revok/i.test(code)?'bad':'muted';
}
const clock=(at:number)=>{const date=new Date(at);return [date.getHours(),date.getMinutes(),date.getSeconds()].map(part=>String(part).padStart(2,'0')).join(':');};
const sameOrder=(result:OrderSummaryResult,identifier:string)=>(result.status==='ready'?result.summary.identifier:result.identifier)===identifier;
/** One card per page. `update` follows the order shown for the bound conversation; `load` goes through the bridge. */
export function createOrderSummaryCard(document:Document,hooks:OrderSummaryCardHooks):OrderSummaryCard{
  const view=document.defaultView!;
  type Target={identifier:string;key:string};
  let disposed=false,target:Target|undefined,auth:PanelAuth|undefined,result:OrderSummaryResult|undefined,settled:{target:Target;at:number;result:OrderSummaryResult}|undefined,loading=false,sequence=0,selected=0,collapsed=false,flash='',flashTimer:number|undefined,frame:HTMLIFrameElement|undefined,child:Document|undefined,pending:number|undefined;
  const host=document.createElement('div');host.id=ORDER_SUMMARY_HOST_ID;host.setAttribute('data-tsim-owned','1');host.setAttribute('role','region');host.setAttribute('aria-label','订单套餐信息');
  host.style.cssText='position:fixed;z-index:900;display:none;margin:0;padding:0;border:0';
  const contain=(event:Event)=>event.stopPropagation();CONTAINED.forEach(type=>host.addEventListener(type,contain));
  const shadow=host.attachShadow({mode:'open'});
  const make=<K extends keyof HTMLElementTagNameMap>(tag:K,className='',text='')=>{const node=document.createElement(tag);if(className)node.className=className;if(text)node.textContent=text;return node;};
  const button=(className:string,text='',label='')=>{const node=make('button',className,text);node.type='button';if(label){node.title=label;node.setAttribute('aria-label',label);}return node;};
  const icon=(name:keyof typeof ICONS)=>{const node=make('span');node.style.display='contents';node.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;return node;};
  const style=make('style');style.textContent=RUNTIME_PLATFORM==='win32'?STYLE+WINDOWS_TYPE:STYLE;
  const card=make('div','card'),head=make('div','head'),mark=make('span','mark'),title=make('span','title','套餐速览'),order=make('span','order');mark.append(icon('sim'));
  const refresh=button('icon refresh','','刷新'),toggle=button('icon toggle','','收起');refresh.append(icon('retry'));toggle.append(icon('chevron'));
  head.append(mark,title,order,make('span','spacer'),refresh,toggle);
  const body=make('div','body'),foot=make('div','foot'),updated=make('span'),flashText=make('span','flash');body.setAttribute('aria-live','polite');foot.append(updated,flashText);
  card.append(head,body,foot);shadow.append(style,card);
  const showFlash=(text:string)=>{flash=text;view.clearTimeout(flashTimer);flashTimer=view.setTimeout(()=>{flash='';renderFoot();},1500);renderFoot();};
  async function copy(text:string,label:string){
    try{await view.navigator.clipboard.writeText(text);showFlash(`已复制 ${label}`);return;}catch{/* fall back below */}
    const area=make('textarea');area.value=text;area.style.cssText='position:fixed;opacity:0;pointer-events:none';shadow.append(area);area.select();let ok=false;try{ok=document.execCommand('copy');}catch{ok=false;}area.remove();showFlash(ok?`已复制 ${label}`:'复制失败');
  }
  // Content.
  const value=(text:string|null,mono=false)=>{const node=make('span',text?(mono?'mono':''):'none',text??'—');return node;};
  const kv=(rows:[string,Node][])=>{const list=make('dl','kv');for(const [label,node] of rows){const dd=make('dd');dd.append(node);list.append(make('dt','',label),dd);}return list;};
  const section=(...nodes:Node[])=>{const node=make('section','section');node.append(...nodes);return node;};
  const pill=(text:string,tone:Tone,code?:string)=>{const node=make('span','pill',text);node.dataset.tone=tone;if(code&&code!==text){node.append(' ',make('small','',code));node.title=code;}return node;};
  const tile=(label:string,text:string|null,className='')=>{const node=make('div',`tile ${className}`.trim()),number=make('b',text?'':'none',text??'—');node.append(make('small','',label),number);return node;};
  function skeleton(){const node=make('div','skeleton'),tiles=make('div','tiles');tiles.append(make('i'),make('i'),make('i'));node.append(make('i'),make('i'),tiles,make('i'));node.setAttribute('aria-label','正在查询套餐信息');return node;}
  function callout(tone:'info'|'warn'|'bad',name:keyof typeof ICONS,text:string,action?:HTMLButtonElement){const node=make('div','callout'),content=make('div');node.dataset.tone=tone;content.append(make('p','',text));if(action)content.append(action);node.append(icon(name),content);return node;}
  const loginButton=()=>{const node=button('solid','登录 TSim');node.addEventListener('click',()=>{if(!disposed)hooks.openLogin();});return node;};
  const retryButton=()=>{const node=button('outline','重试');node.addEventListener('click',()=>load(false));return node;};
  function usage(plan:OrderSummaryPlan){
    const status=make('div','status');status.append(make('span','label','套餐状态'),plan.status?pill(plan.status.label,plan.status.tone,plan.status.code):pill('未返回','muted'));
    const tiles=make('div','tiles'),remaining=plan.remaining;
    tiles.append(tile('总用量',plan.totalUsage));if(plan.todayUsage)tiles.append(tile('当日用量',plan.todayUsage));
    const rest=tile(remaining?.scope==='daily'?'今日剩余':'套餐剩余',remaining?.text??(plan.unlimited?'不限量':null),'remain');if(remaining)rest.dataset.tone=remaining.tone;tiles.append(rest);
    const nodes:Node[]=[status,tiles];
    if(remaining){
      const meter=make('div','meter'),fill=make('i');meter.dataset.tone=remaining.tone;fill.style.width=`${remaining.percent}%`;meter.append(fill);meter.setAttribute('role','meter');meter.setAttribute('aria-label','剩余流量');meter.setAttribute('aria-valuemin','0');meter.setAttribute('aria-valuemax','100');meter.setAttribute('aria-valuenow',String(remaining.percent));
      const caption=make('div','caption');caption.append(make('span','',`剩余 ${remaining.percent}%`),make('span','',`${remaining.scope==='daily'?'每日':'总'}流量 ${remaining.quota}`));nodes.push(meter,caption);
    }
    return section(...nodes);
  }
  function cdrRow(cdr:OrderSummaryCdr){
    const row=make('li','cdr'),time=make('time','',cdr.time??'—'),where=make('div','where'),place=[cdr.region,cdr.operator].filter(Boolean).join(' · ');
    where.append(make('span',place?'':'none',place||'—'));if(cdr.plmn)where.append(make('small','',`PLMN ${cdr.plmn}`));if(place)where.title=place;
    row.append(time,where,make('b',cdr.usage?'':'none',cdr.usage??'—'));return row;
  }
  function planView(summary:OrderSummary):Node[]{
    // A monospace value with a copy button; empty values fall back to the dash.
    function copyable(text:string|null,label:string):Node{
      if(!text)return value(null);
      const wrap=make('span','eid mono'),copyButton=button('copy','',`复制 ${label}`);copyButton.append(icon('copy'));
      copyButton.addEventListener('click',()=>{void copy(text,label);});wrap.append(make('span','',text),copyButton);return wrap;
    }
    const plans=summary.plans,index=Math.min(selected,plans.length-1),plan=plans[index],nodes:Node[]=[];
    if(plans.length>1){
      const tabs=make('div','tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','套餐');
      plans.forEach((item,position)=>{const tab=button('tab',`套餐 ${position+1}`);const dot=make('i');dot.dataset.tone=item.status?.tone??'muted';tab.prepend(dot);tab.setAttribute('role','tab');tab.setAttribute('aria-selected',String(position===index));tab.title=item.channelPlanName??item.sourcePlanName??`套餐 ${position+1}`;tab.addEventListener('click',()=>{if(selected===position)return;selected=position;render();});tabs.append(tab);});
      nodes.push(tabs);
    }
    if(summary.total>plans.length)nodes.push(make('p','note',`该订单共 ${summary.total} 个套餐，这里显示前 ${plans.length} 个`));
    nodes.push(section(kv([['业务流水号',copyable(plan.serialNumber,'业务流水号')],['ICCID',copyable(plan.iccid,'ICCID')]])));
    nodes.push(section(kv([['供应商',value(plan.supplier)],['APN',value(plan.apn,true)]])));
    nodes.push(section(kv([['渠道套餐',value(plan.channelPlanName)],['源套餐',value(plan.sourcePlanName)]])));
    nodes.push(usage(plan));
    const device:[string,Node][]=[];
    const esim=plan.esimStatus?make('span','code',plan.esimStatus):value(null);if(plan.esimStatus)esim.dataset.tone=esimTone(plan.esimStatus);device.push(['eSIM 状态',esim]);
    if(plan.eid)device.push(['EID',copyable(plan.eid,'EID')]);
    if(plan.deviceModel)device.push(['设备型号',value(plan.deviceModel)]);
    nodes.push(section(kv(device)));
    if(plan.cdrs.length){const heading=make('div','heading'),list=make('ol','cdrs');heading.append(make('span','',`最近 ${plan.cdrs.length} 条 CDR`),make('span','','用量'));list.append(...plan.cdrs.map(cdrRow));nodes.push(section(heading,list));}
    return nodes;
  }
  function render(){
    if(disposed)return;
    card.classList.toggle('collapsed',collapsed);card.classList.toggle('busy',loading);body.setAttribute('aria-busy',String(loading));
    order.textContent=target?.identifier??'';order.title=target?`订单 ${target.identifier}`:'';
    refresh.disabled=!target||auth!=='ready'||loading;
    toggle.setAttribute('aria-expanded',String(!collapsed));toggle.title=collapsed?'展开':'收起';toggle.setAttribute('aria-label',toggle.title);
    let content:Node[]=[];
    if(!target)content=[];
    else if(!auth||auth==='connecting')content=[skeleton()];
    else if(auth!=='ready')content=[callout('info','lock',auth==='failed'?'TSim 登录服务连接失败，重新登录后自动查询本订单套餐':'登录 TSim 后自动查询本订单的套餐信息',loginButton())];
    else if(!result)content=[skeleton()];
    else if(result.status==='empty')content=[callout('info','info','未查询到该订单的套餐')];
    else if(result.status==='failed')content=[callout(result.reason==='permission'||result.reason==='rate_limited'?'warn':'bad','alert',ORDER_SUMMARY_FAILURE_TEXT[result.reason],result.reason==='login'?loginButton():result.reason==='permission'?undefined:retryButton())];
    else content=planView(result.summary);
    body.replaceChildren(...content);renderFoot();
  }
  function renderFoot(){
    if(disposed)return;const at=result?.status==='ready'&&auth==='ready'?result.fetchedAt:undefined;
    updated.textContent=loading&&result?'正在刷新':at!==undefined?`更新于 ${clock(at)} · TSim`:'';flashText.textContent=flash;
    foot.hidden=!updated.textContent&&!flash;
  }
  // Reads.
  function finish(seq:number,value:OrderSummaryResult){
    if(disposed||seq!==sequence||!target)return;loading=false;result=value;
    if(value.status==='ready'&&selected>=value.summary.plans.length)selected=0;
    settled=value.status==='failed'?undefined:{target,at:Date.now(),result:value};render();schedule();
  }
  function load(refresh:boolean){
    if(disposed||!target||auth!=='ready')return;
    const seq=++sequence,{identifier,key}=target;loading=true;if(!refresh){result=undefined;settled=undefined;}render();schedule();
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
      target=next;sequence++;loading=false;selected=0;
      // A short vendor re-render of the same order frame shows the settled card again instead of a skeleton.
      const reuse=!!next&&!!settled&&settled.target.identifier===next.identifier&&settled.target.key===next.key&&Date.now()-settled.at<ORDER_SUMMARY_REUSE_MS;
      if(reuse)result=settled!.result;else{result=undefined;if(next)settled=undefined;}
      if(next&&auth==='ready'&&!reuse)load(false);
    }else if(auth!=='ready'){sequence++;loading=false;result=undefined;}
    else if(!wasReady||!result)load(false);
    render();schedule();
  }
  // Placement over the order-detail frame.
  const observer=typeof view.ResizeObserver==='function'?new view.ResizeObserver(()=>schedule()):undefined;
  const onChildScroll=()=>schedule();
  function bindChild(next:Document|undefined){
    if(next===child)return;
    try{child?.defaultView?.removeEventListener('scroll',onChildScroll);}catch{/* revoked */}
    if(child?.body)observer?.unobserve(child.body);
    child=next;
    try{child?.defaultView?.addEventListener('scroll',onChildScroll,{passive:true});}catch{child=undefined;return;}
    if(child?.body)observer?.observe(child.body);
  }
  function bindFrame(next:HTMLIFrameElement|undefined){
    if(next===frame)return;
    if(frame){frame.removeEventListener('load',onFrameLoad);observer?.unobserve(frame);}
    bindChild(undefined);frame=next;
    if(frame){frame.addEventListener('load',onFrameLoad);observer?.observe(frame);}
  }
  function onFrameLoad(){bindChild(undefined);schedule();}
  /** Viewport y where the vendor content of a readable frame ends; undefined for an out-of-process frame. */
  function contentBottom(current:HTMLIFrameElement,top:number){
    let doc:Document|null=null;try{doc=current.contentDocument;}catch{doc=null;}
    bindChild(doc??undefined);if(!doc)return;
    const lists=[...doc.querySelectorAll('.im_info_basic_list')].filter(list=>!isOwned(list)&&list.getClientRects().length>0),list=lists[lists.length-1];if(!list)return;
    let bottom=list.getBoundingClientRect().bottom;
    // Later vendor sections below 用户信息 stay uncovered too.
    for(let node:Element|null=list;node&&node!==doc.body;node=node.parentElement)for(let sibling=node.nextElementSibling;sibling;sibling=sibling.nextElementSibling){const rect=sibling.getBoundingClientRect();if(rect.height>0)bottom=Math.max(bottom,rect.bottom);}
    return Number.isFinite(bottom)?top+Math.max(0,bottom):undefined;
  }
  function locate(){
    const frames=[...document.querySelectorAll<HTMLIFrameElement>(ORDER_SUMMARY_FRAME_SELECTOR)].filter(node=>!isOwned(node));
    if(frames.length!==1||frames[0].closest('[hidden],[aria-hidden="true"]'))return;
    const rect=frames[0].getBoundingClientRect();
    return rect.width>=ORDER_SUMMARY_MIN_FRAME.width&&rect.height>=ORDER_SUMMARY_MIN_FRAME.height?{frame:frames[0],rect}:undefined;
  }
  function place(){
    pending=undefined;if(disposed)return;
    const found=target&&document.visibilityState!=='hidden'?locate():undefined;bindFrame(found?.frame);
    if(!found){host.style.display='none';return;}
    if(!host.isConnected)(document.body??document.documentElement).append(host);
    const {rect}=found,left=Math.max(rect.left,0)+MARGIN,right=Math.min(rect.right,view.innerWidth)-MARGIN,top=Math.max(rect.top,0)+MARGIN,bottom=Math.min(rect.bottom,view.innerHeight)-MARGIN;
    if(right-left<ORDER_SUMMARY_MIN_FRAME.width-2*MARGIN||bottom-top<ORDER_SUMMARY_MIN_FRAME.height/2){host.style.display='none';return;}
    const used=contentBottom(found.frame,rect.top),start=used===undefined?undefined:Math.max(top,used+MARGIN);
    // Directly under 用户信息 when the frame is readable and has room; otherwise docked to the panel bottom.
    if(start!==undefined&&bottom-start>=MIN_FREE)Object.assign(host.style,{top:`${start}px`,bottom:'',maxHeight:`${bottom-start}px`});
    else Object.assign(host.style,{top:'',bottom:`${view.innerHeight-bottom}px`,maxHeight:`${Math.max(ORDER_SUMMARY_MIN_FRAME.height/2,(bottom-top)*ORDER_SUMMARY_DOCKED_SHARE)}px`});
    Object.assign(host.style,{left:`${left}px`,width:`${right-left}px`,display:'block'});
    raise();
  }
  /** A vendor stacking context over the order panel would hide the card; vendor dialogs elsewhere stay on top. */
  function raise(){
    if(host.style.zIndex===Z_RAISED||typeof document.elementFromPoint!=='function')return;
    const rect=host.getBoundingClientRect();if(!rect.width||!rect.height)return;
    const hit=document.elementFromPoint(rect.left+Math.min(rect.width/2,48),rect.top+Math.min(rect.height/2,20));
    if(hit&&hit!==host&&(hit===frame||!!hit.closest('.customer_info')))host.style.zIndex=Z_RAISED;
  }
  function schedule(){
    if(disposed||pending!==undefined)return;
    pending=typeof view.requestAnimationFrame==='function'?view.requestAnimationFrame(place):view.setTimeout(place,16);
  }
  const cancel=()=>{if(pending===undefined)return;if(typeof view.cancelAnimationFrame==='function')view.cancelAnimationFrame(pending);view.clearTimeout(pending);pending=undefined;};
  refresh.addEventListener('click',()=>load(true));
  toggle.addEventListener('click',()=>{collapsed=!collapsed;render();schedule();});
  const onResize=()=>schedule();view.addEventListener('resize',onResize);
  const onVisibility=()=>schedule();document.addEventListener('visibilitychange',onVisibility);
  (document.body??document.documentElement).append(host);render();
  return{update,reposition:schedule,host,dispose(){
    if(disposed)return;disposed=true;sequence++;cancel();view.clearTimeout(flashTimer);bindFrame(undefined);observer?.disconnect();
    view.removeEventListener('resize',onResize);document.removeEventListener('visibilitychange',onVisibility);CONTAINED.forEach(type=>host.removeEventListener(type,contain));host.remove();
  }};
}
