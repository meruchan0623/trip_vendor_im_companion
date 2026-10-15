import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopHostAPI, HostCommand } from '../src/shared/types';
const api: DesktopHostAPI = {
  ready: () => ipcRenderer.send('host:ready'),
  authChanged: accountScope => ipcRenderer.send('host:auth', accountScope),
  respond: response => ipcRenderer.send('host:response', response),
  onCommand: listener => { const wrapped = (_event: unknown, command: HostCommand) => listener(command); ipcRenderer.on('host:command', wrapped); return () => ipcRenderer.removeListener('host:command', wrapped); }
};
if (window.top === window) contextBridge.exposeInMainWorld('desktopHost', Object.freeze(api));
