/** Compatibility probes, not proof that mutable local resources came from the vendor. */
export const WINDOWS_EXECUTABLE='C:\\Program Files\\vbk-electron\\旅游商家桌面版.exe';
export const WINDOWS_MANIFEST_PATH='C:\\Program Files\\vbk-electron\\resources\\TripVendorCompanion\\vendor-runtime-manifest.json';
/** Browser-safe syntax check; filesystem reparse/ACL checks remain Node-side. */
function installationPath(value){
  if(typeof value!=='string'||value.length>32767||!/^\w:/.test(value))throw new Error('WINDOWS_INSTALLATION_PATH_REJECTED');
  const path=value.replaceAll('/','\\');
  if(!/^[A-Za-z]:\\/.test(path))throw new Error('WINDOWS_INSTALLATION_PATH_REJECTED');
  const segments=path.slice(3).split('\\');
  if(segments.length<2||segments.some(segment=>!segment||segment==='.'||segment==='..'||/[<>:"|?*\x00-\x1f]/.test(segment)||/[. ]$/.test(segment)||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment)))throw new Error('WINDOWS_INSTALLATION_PATH_REJECTED');
  return path;
}
export function windowsInstallationFromExecutable(executable){
  const path=installationPath(executable),suffix='\\旅游商家桌面版.exe';
  if(!path.toLowerCase().endsWith(suffix.toLowerCase()))throw new Error('WINDOWS_INSTALLATION_PATH_REJECTED');
  const root=path.slice(0,-suffix.length),resources=root+'\\resources',helperDirectory=resources+'\\TripVendorCompanion';
  if(root.length>240)throw new Error('WINDOWS_INSTALLATION_PATH_REJECTED');
  return{root,resources,executable:path,helperDirectory,helper:helperDirectory+'\\旅游商家助手.exe',manifest:helperDirectory+'\\vendor-runtime-manifest.json',asar:resources+'\\app.asar',dist:resources+'\\app.asar.unpacked\\dist'};
}
export function windowsInstallationFromHelper(helper){
  try{
    const path=installationPath(helper),suffix='\\resources\\TripVendorCompanion\\旅游商家助手.exe';
    if(!path.toLowerCase().endsWith(suffix.toLowerCase()))throw new Error();
    return windowsInstallationFromExecutable(path.slice(0,-suffix.length)+'\\旅游商家桌面版.exe');
  }catch{throw new Error('WINDOWS_INSTALLED_HELPER_REQUIRED');}
}
export const IM_CONTRACT=Object.freeze(['chat-editor','chat_area-input','chat_area-button','btn_send','setContent','chat_area-list','chat_list_content','normal-message-item','customer_order-detail','group-chat-hover-box','chat-text','preserveWhitespace']);
export const NAVIGATION_CONTRACT=Object.freeze(['menu-item-wrapper','menu-text']);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const object=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export function supportedWindowsVersion(value){
  if(typeof value!=='string'||!/^\d{1,4}\.\d{1,4}\.\d{1,9}(?:\.\d{1,10})?$/.test(value))return false;
  const [major,minor,patch]=value.split('.').map(Number);return major>1||major===1&&(minor>2||minor===2&&patch>=11);
}
export function compareWindowsAres(left,right){
  if(![left,right].every(value=>typeof value==='string'&&/^\d{1,4}\.\d{1,4}\.\d{1,9}$/.test(value)))throw new Error('UNSUPPORTED_WINDOWS_PAGE_VERSION');
  const a=left.split('.').map(Number),b=right.split('.').map(Number);for(let index=0;index<3;index++)if(a[index]!==b[index])return a[index]<b[index]?-1:1;return 0;
}
export function validateWindowsPage(value){
  const keys=['packageVersion','aresVersion','rendererName','navigationRendererName','htmlSha256','rendererSha256','navigationHtmlSha256','navigationRendererSha256'];
  if(!object(value,keys)||!supportedWindowsVersion(value.packageVersion)||value.packageVersion.split('.').length!==3||typeof value.aresVersion!=='string'||!/^\d{1,4}\.\d{1,4}\.\d{1,9}$/.test(value.aresVersion)||typeof value.rendererName!=='string'||typeof value.navigationRendererName!=='string'||!/^imWindow-[A-Za-z0-9_-]{1,80}\.js$/.test(value.rendererName)||!/^mainWindow-[A-Za-z0-9_-]{1,80}\.js$/.test(value.navigationRendererName)||keys.filter(key=>key.endsWith('Sha256')).some(key=>!hash(value[key])))throw new Error('INVALID_WINDOWS_PAGE_MANIFEST');
  return value;
}
export function validateWindowsRuntimeManifest(value,expectedExecutable){
  const keys=['schemaVersion','executable','executableVersion','executableSha256','asarSha256','chromiumMajor','bundledPage'];
  if(!object(value,keys)||value.schemaVersion!==1||!supportedWindowsVersion(value.executableVersion)||!hash(value.executableSha256)||!hash(value.asarSha256)||!Number.isInteger(value.chromiumMajor)||value.chromiumMajor<118||value.chromiumMajor>999)throw new Error('INVALID_WINDOWS_RUNTIME_MANIFEST');
  let executable;try{executable=windowsInstallationFromExecutable(value.executable).executable;}catch{throw new Error('INVALID_WINDOWS_RUNTIME_MANIFEST');}
  if(expectedExecutable!==undefined&&executable.toLowerCase()!==windowsInstallationFromExecutable(expectedExecutable).executable.toLowerCase())throw new Error('WINDOWS_MANIFEST_EXECUTABLE_MISMATCH');
  validateWindowsPage(value.bundledPage);
  if(value.executableVersion.split('.').slice(0,3).join('.')!==value.bundledPage.packageVersion)throw new Error('WINDOWS_PACKAGE_VERSION_MISMATCH');
  return value;
}
export function windowsRendererName(html,kind){
  if(!['imWindow','mainWindow'].includes(kind)||typeof html!=='string'||html.length>20000||[...html.matchAll(/\bid\s*=\s*["']root["']/g)].length!==1)throw new Error('UNSUPPORTED_WINDOWS_PAGE_STRUCTURE');
  const modules=[...html.matchAll(/<script\b([^>]*)>/gi)].filter(([,attrs])=>/\btype\s*=\s*["']module["']/i.test(attrs));
  if(modules.length!==1)throw new Error('UNSUPPORTED_WINDOWS_PAGE_STRUCTURE');
  const attrs=modules[0][1],sources=[...attrs.matchAll(/\bsrc\s*=\s*(["'])([^"']+)\1/gi)];
  if(sources.length!==1)throw new Error('UNSUPPORTED_WINDOWS_PAGE_STRUCTURE');
  const match=new RegExp('^\\.\\./\\.\\./\\.\\./js/('+kind+'-[A-Za-z0-9_-]{1,80}\\.js)$').exec(sources[0][2]);
  if(!match)throw new Error('UNSUPPORTED_WINDOWS_PAGE_STRUCTURE');return match[1];
}
export function assertWindowsRendererContract(im,nav){
  if(typeof im!=='string'||im.length>8_000_000||typeof nav!=='string'||nav.length>200_000||IM_CONTRACT.some(token=>!im.includes(token))||NAVIGATION_CONTRACT.some(token=>!nav.includes(token)))throw new Error('UNSUPPORTED_WINDOWS_RENDERER_CONTRACT');
}
