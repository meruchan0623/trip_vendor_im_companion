import {customerLanguage} from './language';
import type {PanelState} from '../../src/shared/workbench';
import {startOrderObservation,isOwned} from './identifiers';
import {createOperatorOverlay,operatorFrameURL,OPERATOR_FRAME_ID,TSIM_OPERATOR_ORIGIN,type OperatorOverlay} from './operator-overlay';
import {createOutboundPanel,PANEL_HOST_ID,type OutboundPanel,type PanelBridge} from './outbound-panel';
export {TSIM_OPERATOR_ORIGIN};
export const CUSTOMER_SCAN_DEBOUNCE_MS=300;
export interface PageGeometry {x:number;y:number;width:number;height:number;viewportWidth:number;viewportHeight:number;devicePixelRatio:number}
export interface PageFeatures {update(state:PanelState):void;boundary():true;geometry():PageGeometry;dispose():void;readonly overlay:OperatorOverlay;readonly panel:OutboundPanel|undefined}
/** Production workbench: explicit order queries open the original TSim page. */
export function mountPageFeatures(document:Document,options:{bridge?:PanelBridge;state?:PanelState;origin?:string;prewarmDelayMs?:number}={}):PageFeatures{
  const view=document.defaultView!;let disposed=false,state=options.state,conversation:string|null|undefined;
  const overlay=createOperatorOverlay(document,{origin:options.origin,prewarmDelayMs:options.prewarmDelayMs});
  const panel=options.bridge&&state?createOutboundPanel(document,options.bridge,state,{openOrder:(identifier,identifierType)=>overlay.open({identifier,identifierType})}):undefined;
  /** Keep the visible order chip aligned with the vendor's current order-detail frame. */
  let customerTimer:number|undefined,lastCustomerReport='';
  const scanCustomer=()=>{customerTimer=undefined;if(disposed||document.visibilityState==='hidden'||!state?.conversationKey||!options.bridge)return;const lang=customerLanguage(document),key=state.conversationKey,signature=JSON.stringify([key,lang]);if(signature===lastCustomerReport)return;lastCustomerReport=signature;void options.bridge.invoke('customerLanguage',[{lang,conversationKey:key}]).catch(()=>{if(lastCustomerReport===signature)lastCustomerReport='';});};
  const scheduleCustomer=()=>{view.clearTimeout(customerTimer);customerTimer=view.setTimeout(scanCustomer,CUSTOMER_SCAN_DEBOUNCE_MS);};
  const orderObservation=panel?startOrderObservation(document,order=>{if(!disposed&&document.visibilityState!=='hidden')panel.setOrder(order);},state?.conversationKey??null):undefined;
  let orderTimer:number|undefined;const syncOrder=()=>{orderTimer=undefined;if(!disposed&&document.visibilityState!=='hidden')orderObservation?.refresh();};
  const orderObserver=new view.MutationObserver(mutations=>{if(disposed||document.visibilityState==='hidden'||orderTimer!==undefined||mutations.every(m=>{const target=m.target.nodeType===1?m.target as Element:m.target.parentElement;const changed=[...m.addedNodes,...m.removedNodes];return isOwned(target)||changed.length>0&&changed.every(n=>n.nodeType===1&&isOwned(n as Element));}))return;orderTimer=view.setTimeout(syncOrder,150);scheduleCustomer();});
  if(panel&&document.body){orderObserver.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden','aria-hidden','src']});syncOrder();}
  function update(next:PanelState){
    if(disposed)return;state=next;
    // Close the order page on conversation change.
    if(conversation!==undefined&&conversation!==next.conversationKey)overlay.close();
    orderObservation?.setConversationKey(next.conversationKey);
    if(conversation!==next.conversationKey){conversation=next.conversationKey;lastCustomerReport='';scheduleCustomer();}
    panel?.render(next);
  }
  const onVisibility=()=>{view.clearTimeout(orderTimer);orderTimer=undefined;if(document.visibilityState!=='hidden'){syncOrder();scheduleCustomer();}};document.addEventListener('visibilitychange',onVisibility);
  if(state)update(state);
  return{update,overlay,panel,
    boundary(){
      if(panel){
        const own=document.getElementById(PANEL_HOST_ID);
        // A verified document may precede login/conversation rendering. Absence
        // of both host and composer is a waiting state, never permission to
        // accept a foreign host or restore one removed beside a live composer.
        if(panel.host.id!==PANEL_HOST_ID||own&&own!==panel.host||document.querySelectorAll(`[id="${PANEL_HOST_ID}"]`).length>1||!panel.host.isConnected&&panel.anchor?.isConnected)throw new Error('OWNED_FRAME_BOUNDARY_FAILED');
        // Reconcile synchronously before a heartbeat can race the observer's
        // debounce when the vendor replaces the composer subtree.
        panel.attach();
        if(panel.host.isConnected&&document.getElementById(PANEL_HOST_ID)!==panel.host)throw new Error('OWNED_FRAME_BOUNDARY_FAILED');
      }
      const own=document.getElementById(PANEL_HOST_ID),frame=document.getElementById(OPERATOR_FRAME_ID);
      if(disposed||panel&&own!==null&&own!==panel.host||frame&&frame!==overlay.frame||overlay.frame&&(!overlay.frame.isConnected||frame!==overlay.frame||document.querySelectorAll(`[id="${OPERATOR_FRAME_ID}"]`).length!==1||!overlay.active||overlay.frame.src!==operatorFrameURL(options.origin??TSIM_OPERATOR_ORIGIN,overlay.active)))throw new Error('OWNED_FRAME_BOUNDARY_FAILED');
      return true;
    },
    geometry(){const rect=panel?.host.isConnected?panel.host.getBoundingClientRect():{x:0,y:0,width:0,height:0};return{x:rect.x,y:rect.y,width:rect.width,height:rect.height,viewportWidth:view.innerWidth,viewportHeight:view.innerHeight,devicePixelRatio:view.devicePixelRatio||1};},
    dispose(){if(disposed)return;disposed=true;view.clearTimeout(customerTimer);view.clearTimeout(orderTimer);orderObserver.disconnect();orderObservation?.dispose();document.removeEventListener('visibilitychange',onVisibility);panel?.dispose();overlay.dispose();},
  };
}
