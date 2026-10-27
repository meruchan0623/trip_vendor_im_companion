import {isLoginPopoverId} from '../src/shared/owned-login';
import {isOrderWindowIntent,isOutboundMode,isPanelTarget} from '../src/shared/workbench';
import {isCustomerLanguageReport} from '../src/shared/customer-language';
import {isOrderSummaryIntent} from '../src/shared/order-summary';

/** Page intents only: no text payloads, no snapshots, no URLs. Shapes match `invokeEmbeddedAction`. */
export function validWorkbenchAction(action:unknown,args:unknown[]):boolean{
  const arg=args[0] as Record<string,unknown>|undefined;
  const plain=(keys:string)=>!!arg&&typeof arg==='object'&&!Array.isArray(arg)&&Object.keys(arg).sort().join(',')===keys;
  switch(action){
    case 'setEnabled':return args.length===1&&typeof args[0]==='boolean';
    case 'setTarget':return args.length===1&&plain('lang,source')&&arg!.source==='manual'&&isPanelTarget(arg!.lang);
    case 'setFallbackTarget':return args.length===1&&isPanelTarget(args[0]);
    case 'customerLanguage':return args.length===1&&isCustomerLanguageReport(arg);
    case 'getRuntimeLogs':case 'followCustomer':case 'retry':case 'openLogin':case 'logout':case 'cancel':case 'resume':case 'closeOrder':return args.length===0;
    // Browser and owned order modes share one intent shape, bound to the visible conversation.
    case 'openOrder':case 'queryOrder':case 'operatorSession':return args.length===1&&isOrderWindowIntent(args[0]);
    case 'orderSummary':return args.length===1&&isOrderSummaryIntent(args[0]);
    case 'closeLogin':return args.length===1&&isLoginPopoverId(args[0]);
    case 'apply':return args.length===1&&plain('mode')&&arg!.mode==='replace';
    case 'setOutboundMode':return args.length===1&&isOutboundMode(args[0]);
    default:return false;
  }
}
