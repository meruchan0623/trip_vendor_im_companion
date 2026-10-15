import {isPanelTarget,outboundFingerprint,sameVerifiedDraft,type PanelApplyMode,type PanelState,type PanelTarget,type PsimIdentity,type VerifiedComposerPort,type VerifiedComposerSnapshot} from '../src/shared/workbench';
import {detectLanguage} from './page/language';
import type {OwnedAuthClient} from './auth-client';
import type {NativePoll} from './native-composer';
type Service=Pick<OwnedAuthClient,'identity'|'onIdentity'|'translate'|'openLogin'>;
interface ConversationPrefs {autoLang?:string;manualEnabled?:boolean;manualTarget?:PanelTarget}
interface ReviewedResult {snapshot:VerifiedComposerSnapshot;target:PanelTarget;text:string}
export const TRANSLATE_DELAY_MS=800;
const AUTO_LANG=/^(?:unknown|[a-z]{2}(?:-[A-Z]{2})?)$/;
const equalAuth=(a:PsimIdentity|null,b:PsimIdentity|null)=>JSON.stringify(a)===JSON.stringify(b);
const failureText=(error:unknown,fallback:string)=>{const code=error instanceof Error&&/^[A-Z_]{3,64}$/.test(error.message)?error.message:'';return code?`${fallback}（${code}）`:fallback;};
/** Node-owned controller. The page only sends intents; HTTP, credentials and CAS writes stay here. Legacy non-production controller. */
export class OutboundController {
  private state:PanelState={auth:'needs_login',conversationKey:null,draft:null,enabled:true,target:'en',followCustomer:{lang:null,following:true,manualEnabled:false},status:'unavailable',preview:null,error:null,busy:false};
  private listeners=new Set<(value:PanelState)=>void>();private prefs=new Map<string,ConversationPrefs>();private source?:VerifiedComposerSnapshot;private identity:PsimIdentity|null;private stopAuth:()=>void;private dead=false;
  private sequence=0;private request?:AbortController;private timer?:ReturnType<typeof setTimeout>;private phase:'idle'|'translating'|'failed'='idle';private error:string|null=null;private result?:ReviewedResult;private failedKey='';private applied='';private busy=false;private auth:'connecting'|'failed'|undefined;
  constructor(private port:VerifiedComposerPort,private service:Service,private delay=TRANSLATE_DELAY_MS){this.identity=service.identity();this.stopAuth=service.onIdentity(value=>{this.identity=value;this.invalidate();this.result=undefined;this.source=undefined;this.failedKey='';this.publish();});this.publish();}
  getState=():PanelState=>structuredClone(this.state);
  onState=(listener:(value:PanelState)=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private key(){return this.source?.conversationId??'';}
  private conversation(){const key=this.key();let value=this.prefs.get(key);if(!value){value={};this.prefs.set(key,value);if(this.prefs.size>200)this.prefs.delete(this.prefs.keys().next().value!);}return value;}
  /** Manual choices win; otherwise a Chinese-speaking customer turns the panel off and any other language becomes the target. */
  private settings(){const prefs=this.prefs.get(this.key())??{};const auto=prefs.autoLang;return{enabled:prefs.manualEnabled??auto!=='zh',target:prefs.manualTarget??(isPanelTarget(auto)?auto:'en'),prefs};}
  private status():PanelState['status']{
    if(!this.identity)return 'needs_login';if(!this.source)return 'unavailable';if(this.phase==='translating')return 'translating';
    // A failed apply keeps its reviewed result but must surface the failure; 重试 starts a fresh review.
    if(this.phase==='failed')return 'failed';const {target}=this.settings();if(this.result)return this.result.target===target&&JSON.stringify(this.result.snapshot)===JSON.stringify(this.source)?'ready':'stale';
    return 'idle';
  }
  private publish(){
    if(this.dead)return;const {enabled,target,prefs}=this.settings();const status=this.status();
    this.state={auth:this.identity?'ready':this.auth??'needs_login',conversationKey:this.source?.conversationId??null,draft:this.source?{text:this.source.text,composing:this.source.composing}:null,enabled,target,followCustomer:{lang:prefs.autoLang??null,following:!prefs.manualTarget,manualEnabled:prefs.manualEnabled!==undefined},status,preview:this.result?.text??null,error:status==='failed'?this.error:null,busy:this.busy};
    for(const listener of this.listeners)listener(this.getState());
  }
  private invalidate(){this.sequence++;if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.request?.abort();this.request=undefined;if(this.phase==='translating')this.phase='idle';}
  private translatable(source:VerifiedComposerSnapshot|undefined,auth:PsimIdentity|null):source is VerifiedComposerSnapshot{return !!source&&!!auth&&source.authGeneration===auth.authGeneration&&!source.composing&&source.isPlainText&&!!source.text.trim()&&source.text.length<=20000&&detectLanguage(source.text)==='zh';}
  private attemptKey(source:VerifiedComposerSnapshot,target:string){return outboundFingerprint(source,target);}
  updateSource(poll:NativePoll){
    if(this.dead)return;const next=poll.snapshot,previous=this.source;
    if(!next||!previous||JSON.stringify(next)!==JSON.stringify(previous)){
      this.invalidate();if(!next||!previous||next.conversationId!==previous.conversationId||next.scopeGeneration!==previous.scopeGeneration){this.result=undefined;this.phase='idle';this.failedKey='';}
      else if(next.text!==previous.text&&this.phase==='failed')this.phase='idle';
      this.source=next;this.port.writeVerified=poll.writeVerified;if(next&&!next.text.trim())this.result=undefined;this.schedule();
    }
    this.publish();
  }
  private schedule(){
    const source=this.source,{enabled,target}=this.settings();if(this.dead||!enabled||this.busy||!this.translatable(source,this.identity)||this.applied===JSON.stringify(source)||this.failedKey===this.attemptKey(source,target)||this.result&&this.result.target===target&&JSON.stringify(this.result.snapshot)===JSON.stringify(source))return;
    this.timer=setTimeout(()=>{this.timer=undefined;void this.translate();},this.delay);
  }
  private async fresh(expected:VerifiedComposerSnapshot,auth:PsimIdentity){const current=await this.port.readCurrent();if(this.dead||!equalAuth(auth,this.identity)||!sameVerifiedDraft(expected,current)||!this.source||!sameVerifiedDraft(expected,this.source))throw new Error('DRAFT_CHANGED');return current;}
  private async translate(){
    this.invalidate();const source=this.source,auth=this.identity,{enabled,target}=this.settings();if(!enabled||this.busy||!this.translatable(source,auth))return;
    const seq=this.sequence,request=new AbortController();this.request=request;
    const body={text:source.text,target_lang:target,source_lang:'zh' as const,purpose:'outbound' as const,draft_request_id:`${Date.now().toString(36)}-${seq}`,composer_content_version:outboundFingerprint(source,target)};
    this.phase='translating';this.error=null;this.publish();
    try{
      await this.fresh(source,auth!);if(seq!==this.sequence)return;const result=await this.service.translate(body,auth!,request.signal);await this.fresh(source,auth!);
      if(seq!==this.sequence||request.signal.aborted||this.settings().target!==target)return;
      // Exact echo of the request identity; anything else is a stale or foreign result.
      if(result.success!==true||result.data.draft_request_id!==body.draft_request_id||result.data.composer_content_version!==body.composer_content_version)throw new Error('OUTBOUND_ECHO_MISMATCH');
      this.result={snapshot:{...source},target,text:result.data.translated_text};this.phase='idle';this.failedKey='';
    }catch(error){if(seq===this.sequence&&!request.signal.aborted){this.phase='failed';this.error=failureText(error,'翻译未完成');this.failedKey=this.attemptKey(source,target);}}
    finally{if(seq===this.sequence){this.request=undefined;if(this.phase==='translating')this.phase='idle';this.publish();}}
  }
  private async apply(mode:PanelApplyMode){
    if(mode!=='replace')throw new Error('INVALID_APPLY_MODE');
    const source=this.source,auth=this.identity,result=this.result,{target}=this.settings();
    if(this.busy||!source||!auth||!result||result.target!==target||JSON.stringify(result.snapshot)!==JSON.stringify(source)||!sameVerifiedDraft(result.snapshot,source)||!this.port.writeVerified||!result.text.trim()||result.text.length>20000)throw new Error('REVIEW_EXPIRED');
    this.busy=true;this.publish();
    try{
      const seq=this.sequence;await this.fresh(source,auth);if(seq!==this.sequence)throw new Error('REVIEW_EXPIRED');
      await this.port.replaceDraft(source,result.text);const next=await this.port.readCurrent();
      if(!equalAuth(auth,this.identity))throw new Error('AUTH_CHANGED');
      if(next.text!==result.text||next.conversationId!==source.conversationId||next.composing)throw new Error('DRAFT_READBACK_MISMATCH');
      this.invalidate();this.result=undefined;this.phase='idle';this.applied=JSON.stringify(next);this.updateSource({snapshot:next,writeVerified:true});
    }catch(error){this.phase='failed';this.error=failureText(error,'替换未完成');throw error;}
    finally{this.busy=false;this.publish();}
  }
  readonly actions={
    setEnabled:(value:boolean)=>{const prefs=this.conversation();prefs.manualEnabled=value;this.invalidate();if(!value)this.phase='idle';this.schedule();this.publish();},
    setTarget:(value:{lang:string;source:'auto'|'manual';conversationKey?:string})=>{
      if(value.source==='manual'){if(!isPanelTarget(value.lang))throw new Error('INVALID_TARGET');this.conversation().manualTarget=value.lang;this.failedKey='';}
      else{if(!AUTO_LANG.test(value.lang)||!this.source||value.conversationKey!==this.source.conversationId)return;const prefs=this.conversation();if(prefs.autoLang===value.lang)return;prefs.autoLang=value.lang;}
      this.invalidate();this.schedule();this.publish();
    },
    retry:async()=>{this.failedKey='';if(this.settings().enabled)await this.translate();},
    apply:(mode:PanelApplyMode)=>this.apply(mode),
    openLogin:async()=>{this.auth='connecting';this.publish();try{await this.service.openLogin();this.auth=undefined;}catch{this.auth='failed';throw new Error('LOGIN_UNAVAILABLE');}finally{this.publish();}},
  };
  async dispose(){if(this.dead)return;this.dead=true;this.invalidate();this.stopAuth();this.listeners.clear();}
}
