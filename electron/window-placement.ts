import type { Bounds } from './layout';

export interface LocalWindow {
  getBounds():Bounds; setBounds(bounds:Bounds):void;
  setPosition?(x:number,y:number):void;
  isVisible():boolean; showInactive():void; hide():void;
  isAlwaysOnTop():boolean; setAlwaysOnTop(value:boolean):void;
  moveTop?():void;
  setSkipTaskbar(value:boolean):void;
  webContents?:{invalidate():void};
}
export const sameBounds=(a:Bounds,b:Bounds):boolean=>a.x===b.x&&a.y===b.y&&a.width===b.width&&a.height===b.height;
const taskbar=new WeakMap<LocalWindow,boolean>();
const placements=new WeakMap<LocalWindow,{requested:Bounds;actual:Bounds}>();
const convertedExtents=new WeakMap<object,{width:number;height:number;context:string;convertedWidth:number;convertedHeight:number}>();
/** Keep translation independent of coordinate-rounding phase at a fixed scale. */
export function stableConvertedBounds(key:object,source:Bounds,converted:Bounds,context:string):Bounds {
  const previous=convertedExtents.get(key);
  if(previous&&previous.width===source.width&&previous.height===source.height&&previous.context===context)return{...converted,width:previous.convertedWidth,height:previous.convertedHeight};
  convertedExtents.set(key,{width:source.width,height:source.height,context,convertedWidth:converted.width,convertedHeight:converted.height});
  return converted;
}
/** Polling must not repeatedly resize, restack or show an unchanged native window. */
export function placeLocalWindow(window:LocalWindow,options:{visible:boolean;topmost?:boolean;bounds?:Bounds;skipTaskbar?:boolean;restack?:boolean}):void {
  if(options.bounds){
    const requested=options.bounds,actual=window.getBounds(),previous=placements.get(window);
    // OS normalization may finish after setPosition returns. An unchanged
    // requested extent remains a move even when the accepted extent drifts.
    const accepted=!!previous&&actual.x===previous.actual.x&&actual.y===previous.actual.y;
    const sameSize=previous?previous.requested.width===requested.width&&previous.requested.height===requested.height:actual.width===requested.width&&actual.height===requested.height;
    // Observed Windows 150% normalization varies by up to 2 DIP after a move.
    // Compare against a fixed baseline, so larger or cumulative drift is repaired.
    const normalizedSize=!previous||Math.abs(actual.width-previous.actual.width)<=2&&Math.abs(actual.height-previous.actual.height)<=2;
    const resize=!sameSize||!normalizedSize;
    if(resize)window.setBounds(requested);
    else if((actual.x!==requested.x||actual.y!==requested.y)&&!(accepted&&sameBounds(previous.requested,requested))){
      if(window.setPosition)window.setPosition(requested.x,requested.y);
      else window.setBounds(requested);
    }
    const placed=window.getBounds();
    placements.set(window,{requested:{...requested},actual:previous&&!resize?{...placed,width:previous.actual.width,height:previous.actual.height}:{...placed}});
  }
  const topmost=options.topmost??false;
  if(window.isAlwaysOnTop()!==topmost)window.setAlwaysOnTop(topmost);
  if(options.skipTaskbar!==undefined&&taskbar.get(window)!==options.skipTaskbar){window.setSkipTaskbar(options.skipTaskbar);taskbar.set(window,options.skipTaskbar);}
  const becameVisible=options.visible&&!window.isVisible();
  if(window.isVisible()!==options.visible){
    if(options.visible){window.showInactive();window.webContents?.invalidate();}
    else window.hide();
  }
  // Raising the native surface does not activate it or steal the merchant's focus.
  if(options.visible&&topmost&&(becameVisible||options.restack))window.moveTop?.();
}
