import {matchesPageConversation} from './conversation';
import {RUNTIME_PLATFORM} from '../build-manifest';
import {customerLanguageEvidence} from './language';
import type {OperatorSessionGrant,OrderWindowIntent,PanelState} from '../../src/shared/workbench';
import {resolveCustomerLanguage,sameCustomerLanguageResolution,unavailableCustomerLanguage,type CustomerLanguageResolution} from '../../src/shared/customer-language';
import {startOrderObservation,isOwned,inferIdentifierType} from './identifiers';
import {createOperatorOverlay,OPERATOR_FRAME_ID,TSIM_OPERATOR_ORIGIN,type OperatorOverlay} from './operator-overlay';
import {createOutboundPanel,PANEL_HOST_ID,type OutboundPanel,type PanelBridge} from './outbound-panel';
export {TSIM_OPERATOR_ORIGIN};
export const CUSTOMER_SCAN_DEBOUNCE_MS=300;
export const CUSTOMER_REPORT_RETRY_MS=1000;
export const CUSTOMER_REPORT_MAX_ATTEMPTS=4;
/** After the quick retry window, retain progress at a bounded background rate. */
export const CUSTOMER_REPORT_RECOVERY_MS=30000;
export const CUSTOMER_ORIGINALS_LOAD_WINDOW_MS=1500;
export interface PageGeometry {x:number;y:number;width:number;height:number;viewportWidth:number;viewportHeight:number;devicePixelRatio:number}
export interface PageFeatures {update(state:PanelState):void;boundary():true;geometry():PageGeometry;dispose():void;readonly overlay:OperatorOverlay;readonly panel:OutboundPanel|undefined}
/** Production workbench: explicit order queries open the original TSim page inside the merchant client. */
export function mountPageFeatures(document:Document,options:{bridge?:PanelBridge;state?:PanelState;origin?:string;prewarmDelayMs?:number}={}):PageFeatures{
  const view=document.defaultView!;let disposed=false,state=options.state,conversation:string|null|undefined,originalsDeadline=0;
  // Both platforms: the original TSim operator inside this page, signed in with the companion's verified session.
  const overlay=createOperatorOverlay(document,{origin:options.origin,prewarmDelayMs:options.prewarmDelayMs,requestSession:request=>{
    const conversationKey=state?.conversationKey;
    if(!options.bridge||!conversationKey||state?.auth!=='ready'||!bound())return Promise.reject(new Error('SESSION_UNAVAILABLE'));
    const intent:OrderWindowIntent={identifier:request.identifier,identifierType:request.identifierType??inferIdentifierType(request.identifier)??'order_number',conversationKey};
    return options.bridge.invoke('operatorSession',[intent]) as Promise<OperatorSessionGrant>;
  }});
  const bound=()=>!!state&&matchesPageConversation(document,state.conversationKey);
  const panel=options.bridge&&state?createOutboundPanel(document,options.bridge,state,{openOrder:(identifier,identifierType)=>{
    if(!bound()){overlay.close();return;}
    // The operator needs the companion's account; sign in first instead of showing TSim's own login.
    if(state!.auth!=='ready'){void options.bridge!.invoke('openLogin',[]).catch(()=>{});return;}
    overlay.open({identifier,identifierType});
  }}):undefined;
  let renderedBound:boolean|undefined;
  const renderCurrent=(onlyBindingChange=false)=>{if(!state)return;const currentBound=bound();if(state.auth!=='ready')overlay.reset();else if(!currentBound)overlay.close();if(onlyBindingChange&&renderedBound===currentBound)return;renderedBound=currentBound;panel?.render(currentBound?state:{...state,conversationKey:null,draft:null,preview:null,error:null,status:'unavailable',target:state.fallbackTarget??'en',followCustomer:{lang:'unknown',following:true,manualEnabled:false,resolution:unavailableCustomerLanguage()},sendPending:false});if(state.detectedOrder)panel?.setOrder(currentBound?state.detectedOrder.identifier??undefined:undefined);};
  renderCurrent();
  /** Keep the visible order chip aligned with the vendor's current order-detail frame. */
  type CustomerReport={signature:string;key:string;lang:string;resolution:CustomerLanguageResolution;attempts:number;done:boolean;attempt:number};
  let customerTimer:number|undefined,retryTimer:number|undefined,customerReport:CustomerReport|undefined;
  const clearRetry=()=>{view.clearTimeout(retryTimer);retryTimer=undefined;};
  const reflected=(report:CustomerReport)=>state?.conversationKey===report.key&&state.followCustomer.lang===report.lang&&(!state.followCustomer.resolution||sameCustomerLanguageResolution(state.followCustomer.resolution,report.resolution));
  const active=(report:CustomerReport)=>!disposed&&customerReport===report&&state?.conversationKey===report.key&&bound();
  const retry=(report:CustomerReport)=>{
    clearRetry();
    if(!active(report)||report.done||document.visibilityState==='hidden')return;
    const delay=report.attempts>=CUSTOMER_REPORT_MAX_ATTEMPTS?CUSTOMER_REPORT_RECOVERY_MS:CUSTOMER_REPORT_RETRY_MS;
    retryTimer=view.setTimeout(()=>{retryTimer=undefined;if(active(report)&&document.visibilityState!=='hidden')sendCustomer(report);},delay);
  };
  const sendCustomer=(report:CustomerReport)=>{
    if(!active(report)||document.visibilityState==='hidden')return;
    if(reflected(report)){report.done=true;clearRetry();return;}
    report.attempts=Math.min(report.attempts+1,CUSTOMER_REPORT_MAX_ATTEMPTS);const attempt=++report.attempt;
    // A missing binding reply also gets a bounded retry. A stale completion
    // cannot acknowledge or restart the newer attempt/conversation.
    retry(report);
    void options.bridge!.invoke('customerLanguage',[{lang:report.lang,conversationKey:report.key,resolution:report.resolution}]).then(()=>{
      if(!active(report)||report.attempt!==attempt)return;
      // The bridge can accept an invocation while the service rejects its stale
      // binding. Every observation needs matching state, including unknown.
      if(reflected(report)){report.done=true;clearRetry();}
    },()=>{if(active(report)&&report.attempt===attempt&&!report.done)retry(report);});
  };
  const scanCustomer=()=>{
    customerTimer=undefined;
    if(disposed||document.visibilityState==='hidden'||!state?.conversationKey||!options.bridge||!bound())return;
    const evidence=customerLanguageEvidence(document);
    if(!evidence.sampleCount&&state.followCustomer.resolution?.status==='collecting'&&Date.now()<originalsDeadline){customerTimer=view.setTimeout(scanCustomer,originalsDeadline-Date.now());return;}
    const lang=evidence.language,key=state.conversationKey,resolution=resolveCustomerLanguage(lang,{sampleCount:evidence.sampleCount,evidenceCount:evidence.evidenceCount,recognizedCount:evidence.recognizedCount}),signature=JSON.stringify([key,lang,resolution]);
    if(customerReport?.signature!==signature){clearRetry();customerReport={signature,key,lang,resolution,attempts:0,done:false,attempt:0};}
    const report=customerReport;
    if(reflected(report)){report.done=true;clearRetry();return;}
    if(report.done||retryTimer!==undefined)return;
    // Visibility/binding recovery must not turn an exhausted quick window into
    // a new burst. DOM activity cannot reset the report's retry budget either.
    if(report.attempts>=CUSTOMER_REPORT_MAX_ATTEMPTS){retry(report);return;}
    sendCustomer(report);
  };
  // A throttle guarantees progress while scrolling/rendering continuously.
  const scheduleCustomer=()=>{if(customerTimer===undefined&&!disposed)customerTimer=view.setTimeout(scanCustomer,CUSTOMER_SCAN_DEBOUNCE_MS);};
  // macOS keeps its existing iframe observer when the pinned renderer cannot
  // provide a verified early hint. Host hints take precedence while present.
  const orderObservation=panel&&(RUNTIME_PLATFORM==='darwin'||!state?.detectedOrder)?startOrderObservation(document,order=>{if(!disposed&&document.visibilityState!=='hidden'&&!state?.detectedOrder)panel.setOrder(order);},state?.conversationKey??null):undefined;
  let orderTimer:number|undefined;const syncOrder=()=>{orderTimer=undefined;if(!disposed&&document.visibilityState!=='hidden')orderObservation?.refresh();};
  const orderObserver=new view.MutationObserver(mutations=>{if(disposed||document.visibilityState==='hidden'||mutations.every(m=>{const target=m.target.nodeType===1?m.target as Element:m.target.parentElement;const changed=[...m.addedNodes,...m.removedNodes];return isOwned(target)||changed.length>0&&changed.every(n=>n.nodeType===1&&isOwned(n as Element));}))return;renderCurrent(true);if(orderTimer===undefined)orderTimer=view.setTimeout(syncOrder,150);scheduleCustomer();});
  if(panel&&document.body){orderObserver.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden','aria-hidden','src']});syncOrder();}
  function update(next:PanelState){
    if(disposed)return;const previousLanguage=JSON.stringify(state?.followCustomer);state=next;
    // Hide the order page on conversation change; the warm TSim page is reused only after a fresh authorization.
    if(conversation!==undefined&&conversation!==next.conversationKey)overlay.close();
    orderObservation?.setConversationKey(next.conversationKey);
    if(conversation!==next.conversationKey){conversation=next.conversationKey;originalsDeadline=Date.now()+CUSTOMER_ORIGINALS_LOAD_WINDOW_MS;clearRetry();customerReport=undefined;view.clearTimeout(customerTimer);customerTimer=undefined;scheduleCustomer();}
    else if(previousLanguage!==JSON.stringify(next.followCustomer)){
      if(customerReport&&reflected(customerReport)){customerReport.done=true;clearRetry();}
      else if(customerReport?.done){customerReport=undefined;}
      scheduleCustomer();
    }
    renderCurrent();
  }
  const onVisibility=()=>{view.clearTimeout(orderTimer);orderTimer=undefined;clearRetry();if(document.visibilityState!=='hidden'){renderCurrent(true);syncOrder();scheduleCustomer();}};document.addEventListener('visibilitychange',onVisibility);
  if(state)update(state);
  return{update,overlay,panel,
    boundary(){
      renderCurrent(true);
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
      if(disposed||panel&&own!==null&&own!==panel.host||frame&&frame!==overlay.frame||overlay.frame&&(!overlay.frame.isConnected||frame!==overlay.frame||document.querySelectorAll(`[id="${OPERATOR_FRAME_ID}"]`).length!==1||!overlay.frameURL||overlay.frame.src!==overlay.frameURL))throw new Error('OWNED_FRAME_BOUNDARY_FAILED');
      return true;
    },
    geometry(){const rect=panel?.host.isConnected?panel.host.getBoundingClientRect():{x:0,y:0,width:0,height:0};return{x:rect.x,y:rect.y,width:rect.width,height:rect.height,viewportWidth:view.innerWidth,viewportHeight:view.innerHeight,devicePixelRatio:view.devicePixelRatio||1};},
    dispose(){if(disposed)return;disposed=true;clearRetry();customerReport=undefined;view.clearTimeout(customerTimer);view.clearTimeout(orderTimer);orderObserver.disconnect();orderObservation?.dispose();document.removeEventListener('visibilitychange',onVisibility);panel?.dispose();overlay.dispose();},
  };
}
