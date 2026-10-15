import type { Session, WebContents } from 'electron';
import { HOST_ORIGIN } from '../src/shared/types';
import { allowedHostURL,allowedRemoteRequest } from '../src/shared/validation';
export function lockSession(session: Session): void {
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents,_permission,callback) => callback(false));
  session.on('will-download', event => event.preventDefault());
  session.webRequest.onBeforeRequest((details,callback) => {
    callback({cancel:!allowedRemoteRequest(details.url,details.method)});
  });
}
const lockedLocalSessions=new WeakSet<Session>();
export function lockLocalSession(session:Session):void {
  if(lockedLocalSessions.has(session))return;
  lockedLocalSessions.add(session);
  session.setPermissionCheckHandler(()=>false);
  session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  session.on('will-download',event=>event.preventDefault());
  session.webRequest.onBeforeRequest((details,callback)=>{ callback({cancel:!details.url.startsWith('file:')}); });
}
export function lockContents(contents: WebContents, remote: boolean): void {
  contents.setWindowOpenHandler(() => ({ action:'deny' }));
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('will-navigate', (event,url) => { if (!remote || !allowedHostURL(url)) event.preventDefault(); });
  contents.on('will-redirect', (event,url) => { if (!remote || !allowedHostURL(url)) event.preventDefault(); });
  contents.on('will-frame-navigate', (event) => {
    if (!remote) { event.preventDefault(); return; }
    try { const url = new URL(event.url); if (url.origin !== HOST_ORIGIN || !['/desktop-host','/embed/operator','/login'].includes(url.pathname)) event.preventDefault(); } catch { event.preventDefault(); }
  });
}
