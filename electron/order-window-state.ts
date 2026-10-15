import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Bounds } from './layout';

export interface OrderWindowState { bounds:Bounds; maximized:boolean }
export function validOrderWindowState(value:unknown):value is OrderWindowState {
  if(!value||typeof value!=='object')return false;
  const state=value as OrderWindowState,rect=state.bounds;
  return typeof state.maximized==='boolean'&&!!rect&&['x','y','width','height'].every(key=>Number.isFinite(rect[key as keyof Bounds]))
    &&Math.abs(rect.x)<100000&&Math.abs(rect.y)<100000&&rect.width>=320&&rect.height>=240&&rect.width<=20000&&rect.height<=20000;
}
/** Stored in DIP. Restore to the saved monitor, or the client's monitor after unplugging. */
export function restoreOrderWindow(saved:OrderWindowState|null,target:Bounds,workAreas:Bounds[]):OrderWindowState {
  const overlap=(a:Bounds,b:Bounds)=>Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
  const areas=workAreas.filter(area=>area.width>0&&area.height>0);
  if(!areas.length)throw new Error('DISPLAY_UNAVAILABLE');
  const anchor=saved?.bounds??target;
  const ranked=[...areas].sort((a,b)=>overlap(anchor,b)-overlap(anchor,a));
  const work=overlap(anchor,ranked[0]!)>0?ranked[0]!:[...areas].sort((a,b)=>overlap(target,b)-overlap(target,a))[0]!;
  const width=Math.min(work.width,Math.max(320,saved?.bounds.width??Math.min(1200,work.width-48)));
  const height=Math.min(work.height,Math.max(240,saved?.bounds.height??Math.min(900,work.height-48)));
  const x=saved?.bounds.x??target.x+(target.width-width)/2,y=saved?.bounds.y??target.y+(target.height-height)/2;
  return{bounds:{x:Math.round(Math.max(work.x,Math.min(x,work.x+work.width-width))),y:Math.round(Math.max(work.y,Math.min(y,work.y+work.height-height))),width:Math.round(width),height:Math.round(height)},maximized:saved?.maximized??false};
}
/** Coalesced local geometry only; no order identifiers or customer content. */
export class OrderWindowStore {
  private value:OrderWindowState|null=null;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private writes:Promise<void>=Promise.resolve();
  constructor(private path:string){}
  get state():OrderWindowState|null{return this.value;}
  async load():Promise<void>{try{const value:unknown=JSON.parse(await readFile(this.path,'utf8'));if(validOrderWindowState(value))this.value=value;}catch{/* First run or invalid settings: use a visible default. */}}
  update(value:OrderWindowState):void{
    if(!validOrderWindowState(value)||JSON.stringify(value)===JSON.stringify(this.value))return;
    this.value={bounds:{...value.bounds},maximized:value.maximized};
    if(this.timer)clearTimeout(this.timer);
    this.timer=setTimeout(()=>{this.timer=undefined;void this.persist();},500);this.timer.unref();
  }
  private persist():Promise<void>{
    if(!this.value)return this.writes;
    const data=JSON.stringify(this.value);
    this.writes=this.writes.then(async()=>{await mkdir(dirname(this.path),{recursive:true});await writeFile(this.path+'.tmp',data,'utf8');await rename(this.path+'.tmp',this.path);}).catch(()=>{console.error('ORDER_WINDOW_STATE_SAVE_FAILED');});
    return this.writes;
  }
  async flush():Promise<void>{if(this.timer){clearTimeout(this.timer);this.timer=undefined;await this.persist();}else await this.writes;}
}
