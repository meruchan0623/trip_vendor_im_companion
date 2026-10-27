import {formatTelemetry,sanitizeTelemetry} from '../../src/shared/runtime-telemetry';
/** Fallback viewer for standalone/Mac panels. Windows bootstrap owns the viewer even before mount. */
export function createRuntimeLogDialog(document:Document,load:()=>Promise<unknown>){
  const view=document.defaultView!;let host:HTMLElement|undefined,refreshTimer:number|undefined,request=0;
  let restore:HTMLElement|undefined;const loadTimers=new Set<number>();
  const close=()=>{request++;for(const timer of loadTimers)view.clearTimeout(timer);loadTimers.clear();view.clearTimeout(refreshTimer);refreshTimer=undefined;host?.remove();host=undefined;restore?.focus();};
  const open=()=>{
    if(host)return;
    restore=document.activeElement instanceof view.HTMLElement?document.activeElement:undefined;
    host=document.createElement('div');host.setAttribute('data-tsim-owned','1');host.id='tsim-runtime-logs';
    const shadow=host.attachShadow({mode:'open'});
    shadow.innerHTML=`<style>:host{all:initial;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#1d2433}*{box-sizing:border-box}.shade{position:fixed;inset:0;z-index:2147483600;background:#17243955;display:grid;place-items:center;padding:16px}.dialog{width:min(760px,100%);max-height:90vh;background:#fff;border:1px solid #dce1eb;border-radius:12px;box-shadow:0 14px 50px #17243944;display:flex;flex-direction:column;padding:16px;gap:10px}header,footer{display:flex;align-items:center;gap:8px}h2{font-size:16px;font-weight:600;line-height:1.4;margin:0;flex:1}.note{color:#647087;margin:0;font-size:12px}textarea{resize:none;width:100%;height:min(420px,55vh);min-height:80px;border:1px solid #dce1eb;border-radius:6px;padding:10px;background:#f6f7fa;color:#263247;font:12px/1.6 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto}button{border:1px solid #dce1eb;border-radius:6px;background:#fff;color:#263247;padding:6px 12px;cursor:pointer;font:inherit}button:focus-visible,textarea:focus-visible{outline:2px solid #3a5bd9;outline-offset:2px}.status{flex:1;color:#647087;font-size:12px}</style>
      <div class="shade"><section class="dialog" role="dialog" aria-modal="true" aria-label="运行日志"><header><h2>运行日志</h2><button class="close" type="button" aria-label="关闭运行日志">关闭</button></header><p class="note">仅保留本次运行最近 1000 条；超过上限自动淘汰最早记录。不含客户正文、译文或登录凭据。</p><label><input class="raw" type="checkbox"> 原始字段</label><textarea readonly aria-label="运行日志内容" spellcheck="false"></textarea><footer><span class="status" role="status">正在读取…</span><button class="refresh" type="button">刷新</button><button class="copy" type="button">复制日志</button></footer></section></div>`;
    const area=shadow.querySelector('textarea')!,status=shadow.querySelector<HTMLElement>('.status')!,copy=shadow.querySelector<HTMLButtonElement>('.copy')!,refresh=shadow.querySelector<HTMLButtonElement>('.refresh')!;
    const current=host,raw=shadow.querySelector<HTMLInputElement>('.raw')!;
    let records:unknown[]=[];
    const render=(force=false)=>{
      if(!force&&shadow.activeElement===area&&area.selectionStart!==area.selectionEnd)return;
      const rows=records.map(value=>{
        const safe=sanitizeTelemetry(value);if(!safe)return JSON.stringify(value);
        const at=value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,'at')?.value:undefined;
        const timestamp=typeof at==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at)&&Number.isFinite(Date.parse(at))?at:undefined;
        if(raw.checked)return JSON.stringify(timestamp?{at:timestamp,...safe}:safe);
        const trace=typeof safe.traceId==='string'?` [${safe.traceId.slice(0,8)}${typeof safe.parentTraceId==='string'?` ← ${safe.parentTraceId.slice(0,8)}`:''}]`:typeof safe.parentTraceId==='string'?` [← ${safe.parentTraceId.slice(0,8)}]`:'';
        return (timestamp?timestamp+' ':'')+formatTelemetry(safe)+trace;
      }).filter(line=>line&&line.length<=4096);
      const text=rows.join('\n'),atEnd=area.scrollHeight-area.scrollTop-area.clientHeight<24;
      if(area.value!==text){area.value=text;if(atEnd)area.scrollTop=area.scrollHeight;}
      status.textContent=`${rows.length} / 1000 条 · 每 2 秒刷新`;copy.disabled=!text;
    };
    raw.addEventListener('change',()=>render(true));
    const update=async(force=false)=>{
      const id=++request;view.clearTimeout(refreshTimer);refresh.disabled=true;
      let timeout:number|undefined;
      try{
        const result=await Promise.race([load(),new Promise((_,reject)=>{timeout=view.setTimeout(()=>reject(new Error('LOG_TIMEOUT')),5000);loadTimers.add(timeout);})]);
        if(host!==current||request!==id)return;
        if(!Array.isArray(result))throw new Error('INVALID_LOGS');
        // The host sends only sanitized records. Bound the response again before rendering.
        records=result.slice(-1000);render(force);
      }catch{if(host===current&&request===id)status.textContent='日志读取失败；已显示的记录仍可复制，可点击刷新重试。';}
      finally{view.clearTimeout(timeout);if(timeout!==undefined)loadTimers.delete(timeout);if(host===current&&request===id){refresh.disabled=false;refreshTimer=view.setTimeout(()=>void update(),2000);}}
    };
    shadow.querySelector('.close')!.addEventListener('click',close);
    refresh.addEventListener('click',()=>void update(true));
    copy.addEventListener('click',()=>{void(async()=>{try{await view.navigator.clipboard.writeText(area.value);if(host===current)status.textContent='已复制日志';}catch{if(host===current){area.focus();area.select();status.textContent='日志已选中，请按 Ctrl+C（Mac：⌘C）复制。';}}})();});
    shadow.querySelector('.shade')!.addEventListener('click',event=>{if(event.target===shadow.querySelector('.shade'))close();});
    shadow.addEventListener('keydown',event=>{
      const key=event as KeyboardEvent;
      if(key.key==='Escape'){key.preventDefault();close();return;}
      if(key.key==='Tab'){const controls=[...shadow.querySelectorAll<HTMLElement>('button:not(:disabled),textarea,input:not(:disabled)')];const first=controls[0],last=controls.at(-1);if(key.shiftKey&&shadow.activeElement===first){key.preventDefault();last?.focus();}else if(!key.shiftKey&&shadow.activeElement===last){key.preventDefault();first.focus();}}
    });
    for(const type of ['keydown','keyup','keypress','beforeinput','input','paste','copy','cut','mousedown','pointerdown','click'])host.addEventListener(type,event=>event.stopPropagation());
    document.documentElement.append(host);shadow.querySelector<HTMLButtonElement>('.close')!.focus();void update();
  };
  return{open,dispose:close};
}
