import {app,BrowserWindow,session} from 'electron';
import {ownedLoginURL} from '../src/shared/owned-login';

/** The app's own login document. No browser profile, cookie or credential IPC is involved. */
export class OwnedLoginWindow {
  private window:BrowserWindow|undefined;
  private url:string|undefined;
  private generation=0;
  private loginSession=session.fromPartition('tsim-owned-login');
  constructor(){
    this.loginSession.setPermissionCheckHandler(()=>false);
    this.loginSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    this.loginSession.on('will-download',event=>event.preventDefault());
    this.loginSession.webRequest.onBeforeRequest((request,callback)=>{
      const login=this.url;
      callback({cancel:!login||!(request.url===login&&request.method==='GET'||request.url===`${login}/login`&&request.method==='POST')});
    });
  }
  async open(value:string):Promise<void>{
    const url=ownedLoginURL(value).href;
    const generation=++this.generation;
    if(this.window&&!this.window.isDestroyed()&&this.url===url){app.focus({steal:true});this.window.show();this.window.focus();return;}
    this.closeWindow();this.url=url;
    const window=new BrowserWindow({show:false,title:'登录 TSim 账号',width:420,height:510,resizable:false,minimizable:false,maximizable:false,autoHideMenuBar:true,webPreferences:{session:this.loginSession,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:true}});
    this.window=window;
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-attach-webview',event=>event.preventDefault());
    const allow=(target:string)=>target===url;
    window.webContents.on('will-navigate',(event,target)=>{if(!allow(target))event.preventDefault();});
    window.webContents.on('will-redirect',(event,target)=>{if(!allow(target))event.preventDefault();});
    window.webContents.on('will-frame-navigate',event=>{if(!event.isMainFrame||!allow(event.url))event.preventDefault();});
    window.webContents.on('before-input-event',(event,input)=>{if(input.type==='keyDown'&&input.key==='Escape'){event.preventDefault();window.close();}});
    window.on('page-title-updated',event=>event.preventDefault());
    window.on('closed',()=>{if(this.window===window){this.window=undefined;this.url=undefined;}});
    try{
      await window.loadURL(url);
      if(generation!==this.generation||this.window!==window||window.isDestroyed())return;
      app.focus({steal:true});window.show();window.focus();
    }catch(error){if(this.window===window)this.closeWindow();throw error;}
  }
  private closeWindow(){const window=this.window;this.window=undefined;this.url=undefined;if(window&&!window.isDestroyed())window.destroy();}
  close(){++this.generation;this.closeWindow();}
}
