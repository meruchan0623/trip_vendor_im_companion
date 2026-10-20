import { contextBridge, ipcRenderer } from 'electron';
import type { StandaloneAPI } from '../src/shared/companion-api';
import { WINDOWS_DYNAMIC_RUNTIME } from '../runtime/build-manifest';
const api:StandaloneAPI={
  canStartClient:!WINDOWS_DYNAMIC_RUNTIME,
  getState:()=>ipcRenderer.invoke('standalone:state'),
  onState:listener=>{const wrapped=(_event:unknown,value:Parameters<typeof listener>[0])=>listener(value);ipcRenderer.on('standalone:state-event',wrapped);return()=>ipcRenderer.removeListener('standalone:state-event',wrapped);},
  listWindows:()=>ipcRenderer.invoke('standalone:list-windows'),
  startClient:()=>ipcRenderer.invoke('standalone:start-client'),
  bindWindow:id=>ipcRenderer.invoke('standalone:bind-window',id),
  unbindWindow:()=>ipcRenderer.invoke('standalone:unbind-window'),
  connectComposer:()=>ipcRenderer.invoke('standalone:connect-composer'),
  readDraft:()=>ipcRenderer.invoke('standalone:read-draft'),
  setTranslationOptions:options=>ipcRenderer.invoke('standalone:translation-options',options),
  cancelTranslation:()=>ipcRenderer.invoke('standalone:cancel-translation'),
  resumeTranslation:()=>ipcRenderer.invoke('standalone:resume-translation'),
  translate:target=>ipcRenderer.invoke('standalone:translate',target),
  replaceDraft:()=>ipcRenderer.invoke('standalone:replace-draft'),
  copyTranslation:()=>ipcRenderer.invoke('standalone:copy-translation'),
  openTranslation:()=>ipcRenderer.invoke('standalone:open-translation'),
  openSettings:()=>ipcRenderer.invoke('standalone:open-settings'),
  openLogin:()=>ipcRenderer.invoke('standalone:open-login'),
  logout:()=>ipcRenderer.invoke('standalone:logout'),
  openOrder:(identifier,type)=>ipcRenderer.invoke('standalone:open-order',{identifier,type}),
  closeOrder:()=>ipcRenderer.invoke('standalone:close-order'),
  minimize:()=>ipcRenderer.invoke('standalone:minimize'),
  close:()=>ipcRenderer.invoke('standalone:close')
};
contextBridge.exposeInMainWorld('standalone',Object.freeze(api));
