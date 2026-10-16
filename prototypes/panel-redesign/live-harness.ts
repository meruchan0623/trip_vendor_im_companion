// Local visual harness: mounts the real outbound panel over a fake vendor composer.
// Build: npx esbuild prototypes/panel-redesign/live-harness.ts --bundle --outfile=prototypes/panel-redesign/live-harness.js, then inline it into live.html as <script id="harness">.
import {createOutboundPanel} from '../../runtime/page/outbound-panel';
import type {PanelState} from '../../src/shared/workbench';

let state:PanelState={auth:'ready',conversationKey:'c1',draft:{text:'集合时间是早上8点30分',composing:false},enabled:true,target:'en',followCustomer:{lang:'ja',following:true,manualEnabled:false},status:'ready',preview:'集合時間は朝8時30分です。ホテルのロビーまでお迎えにあがります。',error:null,busy:false};
const log=document.getElementById('log')!;
const set=(patch:Partial<PanelState>)=>{state={...state,...patch};panel.render(state);};
const panel=createOutboundPanel(document,{async invoke(action,args){
  log.textContent=`${action} ${JSON.stringify(args??[])}\n`+log.textContent;
  if(action==='setEnabled')set({enabled:!!(args as boolean[])[0]});
  if(action==='setTarget')set({target:(args as {lang:PanelState['target']}[])[0].lang,followCustomer:{...state.followCustomer,following:false}});
  if(action==='followCustomer')set({followCustomer:{...state.followCustomer,following:true}});
  if(action==='cancel')set({translationPaused:true});
  if(action==='resume')set({translationPaused:false});
}},state,{openOrder:(id,type)=>{log.textContent=`openOrder ${id} ${type??''}\n`+log.textContent;}});
panel.setOrder('1128834920517');
(window as unknown as {setPanel:typeof set}).setPanel=set;
