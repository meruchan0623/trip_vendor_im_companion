import { isPanelTarget, type PanelState, type PanelTarget } from '../src/shared/workbench';
import type { StandaloneState } from '../src/shared/companion-api';

/** The only state sent to the vendor renderer. Authentication credentials stay in the host. */
export function embeddedPanelState(state:StandaloneState,conversationKey:string|null=null):PanelState {
  const status:PanelState['status']=state.auth!=='ready'?'needs_login':!state.attached||state.composerSource!=='verified-editor'?'unavailable':state.phase==='ready'?'ready':state.phase==='translating'?'translating':state.phase==='stale'?'stale':state.phase==='failed'?'failed':'idle';
  return {auth:state.auth,conversationKey:state.messageSurface?.active?conversationKey:null,draft:state.draft?{text:state.draft.text,composing:!state.draft.canReplace}:null,enabled:state.autoTranslate!==false,target:state.language,followCustomer:{lang:state.customerLanguage??'unknown',following:state.followCustomerLanguage!==false,manualEnabled:false},status,preview:state.preview,error:state.error,busy:['reading','replacing','translating'].includes(state.phase),translationPaused:state.translationPaused===true};
}

export interface EmbeddedActions {
  getState():StandaloneState;
  setTranslationOptions(options:{language?:PanelTarget;autoTranslate?:boolean}):Promise<void>;
  reportCustomerLanguage(language:string,conversationKey:string):Promise<void>;
  followCustomerLanguage():Promise<void>;
  translate(language:PanelTarget):Promise<void>;
  replaceDraft():Promise<void>;
  cancelTranslation():Promise<void>;
  resumeTranslation():Promise<void>;
  openLogin():Promise<void>;
}

/** Fixed intents only: the renderer cannot supply text, snapshots, URLs or a send action. */
export async function invokeEmbeddedAction(service:EmbeddedActions,action:string,args:unknown[]):Promise<void> {
  if(!Array.isArray(args))throw new Error('INVALID_ACTION');
  const value=args[0],record=value as Record<string,unknown>;
  const object=(keys:string)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys;
  switch(action){
    case 'setEnabled':if(args.length!==1||typeof value!=='boolean')break;await service.setTranslationOptions({autoTranslate:value});return;
    case 'setTarget':if(args.length!==1||!object('lang,source')||record.source!=='manual'||!isPanelTarget(record.lang))break;await service.setTranslationOptions({language:record.lang});return;
    case 'followCustomer':if(args.length)break;await service.followCustomerLanguage();return;
    case 'customerLanguage':if(args.length!==1||!object('conversationKey,lang')||typeof record.lang!=='string'||!/^(unknown|zh|en|ja|ko|ar|ru|el|th|es|fr|de|pt|it|vi|id|ms)$/.test(record.lang)||typeof record.conversationKey!=='string'||record.conversationKey.length>1024)break;await service.reportCustomerLanguage(record.lang,record.conversationKey);return;
    case 'apply':if(args.length!==1||!object('mode')||record.mode!=='replace')break;await service.replaceDraft();return;
    case 'retry':if(args.length)break;await service.translate(service.getState().language);return;
    case 'openLogin':if(args.length)break;await service.openLogin();return;
    case 'cancel':if(args.length)break;await service.cancelTranslation();return;
    case 'resume':if(args.length)break;await service.resumeTranslation();return;
  }
  throw new Error('INVALID_ACTION');
}
