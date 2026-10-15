// Controlled anonymous Edge smoke: no identifiers, credentials, or original-client writes.
import { build } from 'esbuild';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
const work=resolve('work/system-browser-smoke',String(Date.now()));await mkdir(work,{recursive:true});
const modulePath=join(work,'system-browser.mjs');await build({entryPoints:['electron/system-browser.ts'],bundle:true,platform:'node',format:'esm',outfile:modulePath});
// Production/browser smoke uses the native launch lease; no untracked Node Edge spawn.
const helper=spawn(resolve('native/windows/bin/publish/TravelMerchant.WindowHelper.exe'),[],{stdio:['pipe','pipe','pipe'],windowsHide:true});
const waiting=new Map();const lines=createInterface({input:helper.stdout});
lines.on('line',line=>{try{const event=JSON.parse(line),entry=waiting.get(event.requestId);if(entry){waiting.delete(event.requestId);clearTimeout(entry.timer);event.type==='error'?entry.reject(new Error(event.payload?.code??'helper_error')):entry.resolve(event.payload);}}catch{}});
helper.stderr.on('data',chunk=>{const code=String(chunk).trim();console.log(JSON.stringify({event:'helper_diagnostic',code:/^browser_adoption_exception:[A-Za-z]+:[A-F0-9]{8}:[a-z_]+$/.test(code)?code:'redacted'}));});
helper.on('error',error=>console.log(JSON.stringify({event:'helper_failed',code:error.code??'unknown'})));
function request(type,payload={}){const requestId=randomUUID();console.log(JSON.stringify({command:type}));return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiting.delete(requestId);reject(new Error('helper_timeout'));},10000);waiting.set(requestId,{resolve,reject,timer});helper.stdin.write(JSON.stringify({protocolVersion:'1.0',requestId,type,payload})+'\n');});}
const run=promisify(execFile);
async function capture(handle,path,insets={left:0,top:0,right:0,bottom:0}){
  if(!/^\d+$/.test(handle))throw new Error('invalid_handle');
  if(!Object.values(insets).every(value=>Number.isSafeInteger(value)&&value>=0&&value<1000))throw new Error('invalid_crop');
  const script=`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Drawing;Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class CaptureWin {[StructLayout(LayoutKind.Sequential)]public struct Point{public int X,Y;}[DllImport("user32.dll")]public static extern IntPtr WindowFromPoint(Point p);[DllImport("user32.dll")]public static extern IntPtr GetAncestor(IntPtr h,uint flags);[DllImport("user32.dll")]public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr h);[DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h,IntPtr dc,int flags);}
'@;[void][CaptureWin]::SetThreadDpiAwarenessContext([IntPtr]::new(-4));$h=[IntPtr]::new([long]${handle});$owned=$true;for($x=120;$x -lt 920;$x+=40){for($y=120;$y -lt 720;$y+=40){$p=[CaptureWin+Point]::new();$p.X=$x;$p.Y=$y;if([CaptureWin]::GetAncestor([CaptureWin]::WindowFromPoint($p),2)-ne $h){$owned=$false}}};$bitmap=[Drawing.Bitmap]::new(${800+insets.left+insets.right},${600+insets.top+insets.bottom});$graphics=[Drawing.Graphics]::FromImage($bitmap);$dc=$graphics.GetHdc();try{[void][CaptureWin]::PrintWindow($h,$dc,2)}finally{$graphics.ReleaseHdc($dc)};$visible=$bitmap.Clone([Drawing.Rectangle]::new(${insets.left},${insets.top},800,600),[Drawing.Imaging.PixelFormat]::Format32bppArgb);$method='PrintWindow';if($owned){$g=[Drawing.Graphics]::FromImage($visible);try{$g.CopyFromScreen(120,120,0,0,[Drawing.Size]::new(800,600));$method='verified-own-window-screen'}finally{$g.Dispose()}};try{$visible.Save('${path.replace(/'/g,"''")}',[Drawing.Imaging.ImageFormat]::Png);@{method=$method}|ConvertTo-Json -Compress}finally{$visible.Dispose();$graphics.Dispose();$bitmap.Dispose()}`;
  const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000});return JSON.parse(stdout.trim()).method;
}
async function inspect(handle){
  if(!/^\d+$/.test(handle))throw new Error('invalid_handle');
  const script=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class SmokeWin { [StructLayout(LayoutKind.Sequential)] public struct Rect { public int L,T,R,B; } [StructLayout(LayoutKind.Sequential)] public struct Point {public int X,Y;} [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h,out Rect r); [DllImport("user32.dll")]public static extern bool ClientToScreen(IntPtr h,ref Point p); [DllImport("user32.dll")]public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr p); [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r); [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetStyle(IntPtr h,int n); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }
'@;[void][SmokeWin]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)); $h=[IntPtr]::new([long]${handle});$r=[SmokeWin+Rect]::new();$c=[SmokeWin+Rect]::new();$p=[SmokeWin+Point]::new();[void][SmokeWin]::GetWindowRect($h,[ref]$r);[void][SmokeWin]::GetClientRect($h,[ref]$c);[void][SmokeWin]::ClientToScreen($h,[ref]$p);@{exists=[SmokeWin]::IsWindow($h);visible=[SmokeWin]::IsWindowVisible($h);style=[SmokeWin]::GetStyle($h,-16).ToInt64();clientTop=$p.Y-$r.T;clientWidth=$c.R-$c.L;clientHeight=$c.B-$c.T;bounds=@{x=$r.L;y=$r.T;width=$r.R-$r.L;height=$r.B-$r.T};foreground=[SmokeWin]::GetForegroundWindow().ToInt64().ToString()}|ConvertTo-Json -Compress`;
  const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000});return JSON.parse(stdout.trim());
}
let adopted;
const launchKey={launchId:randomUUID()};
async function cleanup(){const deadline=Date.now()+14000;for(;;){const result=await request('cleanupBrowserLaunch',launchKey);if(result.complete)return;if(Date.now()>=deadline)throw new Error('cleanup_unconfirmed');await new Promise(resolve=>setTimeout(resolve,150));}}
try{
  const profilePath=join(work,'system-browser-profile');await mkdir(profilePath);
  const url='https://csagent.tsim.tech/embed/operator?source=travel-merchant-companion';
  const proof=await request('launchBrowser',{...launchKey,profilePath,appURL:url});
  const deadline=Date.now()+10000;
  for(;;){try{adopted=await request('adoptBrowser',proof);break;}catch(error){if(error.message!=='browser_window_pending'||Date.now()>deadline)throw error;await new Promise(resolve=>setTimeout(resolve,150));}}
  const before=await inspect(adopted.handle);const stripped=(before.style&0x00C00000)===0&&(before.style&0x00040000)===0&&(before.style&0x00800000)===0;
  console.log(JSON.stringify({event:'adopted',profileMatched:adopted.profileMatched,captionAndBorderRemoved:stripped,clientTop:before.clientTop,clientWidth:before.clientWidth,clientHeight:before.clientHeight}));
  const bounds={x:120,y:120,width:800,height:600};let placed=await request('placeBrowser',{bounds,visible:true});const shown=await inspect(adopted.handle);
  await new Promise(resolve=>setTimeout(resolve,1000));placed=await request('placeBrowser',{bounds,visible:true});const screenshot=join(work,'edge-app-smoke.png');const method=await capture(adopted.handle,screenshot,placed.cropInsets);console.log(JSON.stringify({event:'captured',path:screenshot,cropInsets:placed.cropInsets,method}));
  await request('placeBrowser',{bounds,visible:false});const hidden=await inspect(adopted.handle);
  console.log(JSON.stringify({event:'placement',shown:shown.visible,bounds:placed.bounds,hidden:!hidden.visible,foregroundPreserved:before.foreground===shown.foreground}));
  await cleanup();const closed=await inspect(adopted.handle);
  console.log(JSON.stringify({event:'released',closed:!closed.exists,anonymousOnly:true,identifierSupplied:false,originalClientUntouched:true}));
  if(!stripped||!shown.visible||hidden.visible||closed.exists||JSON.stringify(placed.bounds)!==JSON.stringify(bounds))throw new Error('system_browser_smoke_failed');
}finally{await cleanup().catch(()=>{});helper.stdin.end();}
