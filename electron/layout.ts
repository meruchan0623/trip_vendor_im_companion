export interface Bounds {x:number;y:number;width:number;height:number}
/** Coordinates must already be Electron DIP; caller converts the native physical DWM rectangle. */
export function pinnedBounds(target:Bounds,work:Bounds,panelWidth:number):{bounds:Bounds;layout:'right'|'left'|'overlay'} {
  const width=Math.min(panelWidth,work.width);
  let x:number;let layout:'right'|'left'|'overlay';
  if(target.x+target.width+width<=work.x+work.width){x=target.x+target.width;layout='right';}
  else if(target.x-width>=work.x){x=target.x-width;layout='left';}
  else{x=Math.max(work.x,Math.min(target.x+target.width-width,work.x+work.width-width));layout='overlay';}
  const height=Math.min(Math.max(320,target.height),work.height);
  const y=Math.max(work.y,Math.min(target.y,work.y+work.height-height));
  return {bounds:{x,y,width,height},layout};
}
/** Small local order launcher; no changes to the merchant page or its layout. */
export function orderLauncherBounds(target:Bounds,work:Bounds):Bounds {
  const width=Math.min(250,work.width),height=Math.min(44,work.height);
  return {x:Math.max(work.x,Math.min(target.x+target.width-width-16,work.x+work.width-width)),y:Math.max(work.y,Math.min(target.y+12,work.y+work.height-height)),width,height};
}
// 44 DIP clears the verified Windows frameless minimum height (42 DIP).
export const ORDER_ACTION_BAR_HEIGHT=44;
/** Frame includes a separate local action bar and never covers the measured reply area. */
export function browserBounds(target:Bounds,work:Bounds,replyTop?:number):Bounds|null {
  if(replyTop===undefined||![target.x,target.y,target.width,target.height,work.x,work.y,work.width,work.height,replyTop].every(Number.isFinite))return null;
  const left=Math.max(work.x,target.x+16),right=Math.min(work.x+work.width,target.x+target.width-16);
  const top=Math.max(work.y,target.y+48),bottom=Math.min(work.y+work.height,target.y+target.height-12,replyTop-8);
  const width=Math.min(960,right-left),height=Math.min(760,bottom-top);
  // Do not shrink an interactive result to an unreadable strip on short displays.
  if(width<480||height<240+ORDER_ACTION_BAR_HEIGHT)return null;
  return{x:Math.round(left+(right-left-width)/2),y:top,width,height};
}
export function browserContentBounds(frame:Bounds):Bounds {
  return{...frame,y:frame.y+ORDER_ACTION_BAR_HEIGHT,height:frame.height-ORDER_ACTION_BAR_HEIGHT};
}
export function attachedVisible(state:{visible:boolean;minimized:boolean;foreground:boolean;groupForeground?:boolean}):boolean {
  return state.visible&&!state.minimized&&(state.groupForeground??state.foreground);
}
/** All inputs are physical Win32 pixels except the viewport and DOM rect in CSS pixels. */
export function identifierOverlayBounds(client:Bounds,viewport:{width:number;height:number;dpr:number;clientOffset?:{x:number;y:number}},rect:Bounds):Bounds|null {
  const values=[client.x,client.y,client.width,client.height,viewport.width,viewport.height,viewport.dpr,rect.x,rect.y,rect.width,rect.height];
  if(!values.every(Number.isFinite)||viewport.dpr<=0||viewport.dpr>8||viewport.width<=0||viewport.height<=0||rect.width<=0||rect.height<=0)return null;
  const offset=viewport.clientOffset;
  if(offset){
    if(!Number.isFinite(offset.x)||!Number.isFinite(offset.y)||offset.x<0||offset.y<0)return null;
    if(Math.abs(client.width-offset.x-viewport.width*viewport.dpr)>4||Math.abs(client.height-offset.y-viewport.height*viewport.dpr)>4)return null;
  }else if(Math.abs(client.width-viewport.width*viewport.dpr)>4||viewport.height*viewport.dpr>client.height+4)return null;
  if(rect.x<0||rect.y<0||rect.x+rect.width>viewport.width+1||rect.y+rect.height>viewport.height+1)return null;
  const x=Math.floor(client.x+(offset?.x??0)+rect.x*viewport.dpr),y=Math.floor(client.y+(offset?.y??client.height-viewport.height*viewport.dpr)+rect.y*viewport.dpr);
  return{x,y,width:Math.max(1,Math.ceil(rect.width*viewport.dpr)),height:Math.max(1,Math.ceil(rect.height*viewport.dpr))};
}

/** CSS viewport geometry. Expansion occupies the message area immediately above the
 * verified toolbar, never any part of the reply editor below that range. */
export function composerPreviewBounds(toolbar:Bounds,reply:Bounds,viewport:{width:number;height:number},expanded:boolean):Bounds|null {
  const values=[...Object.values(toolbar),...Object.values(reply),viewport.width,viewport.height];
  if(!values.every(Number.isFinite)||toolbar.width<180||toolbar.height<24||toolbar.height>44||toolbar.x<0||toolbar.y<0||toolbar.x+toolbar.width>viewport.width+1||toolbar.y+toolbar.height>viewport.height+1)return null;
  // composerRect is the entire reply container, including top padding and toolbar.
  // The source verifier guarantees this free toolbar range ends before the editor.
  if(toolbar.y<reply.y||toolbar.x<reply.x||toolbar.x+toolbar.width>reply.x+reply.width+1)return null;
  const available=Math.max(0,toolbar.y-48);
  const previewHeight=expanded&&available>=120?Math.min(190,available):0;
  // Windows normalizes tiny frameless windows to at least 42 DIP. Reserve 44
  // above the anchor so that normalization cannot extend into the reply editor.
  const height=Math.max(44,toolbar.height+previewHeight),y=toolbar.y+toolbar.height-height;
  if(y<0)return null;
  return{x:toolbar.x,y,width:toolbar.width,height};
}
