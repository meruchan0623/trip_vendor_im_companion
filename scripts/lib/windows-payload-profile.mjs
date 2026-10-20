import {mkdir,readdir,copyFile,lstat,access} from 'node:fs/promises';
import {join} from 'node:path';

// These are Chromium UI translations, not customer translation languages. Keep
// ICU, GPU/software-renderer resources, codecs, snapshots and all license files.
export const WINDOWS_HELPER_LOCALES=Object.freeze(['en-US','zh-CN','zh-TW']);
// Store ZIP entries once, then compress the complete archive with Brotli. The
// installer restores an ordinary ZIP before existing manifest/transaction checks.
export const WINDOWS_PAYLOAD_ZIP_OPTIONS=Object.freeze(['-tzip','-mx=0']);
export function windowsPayloadExclusion(path){
  if(typeof path!=='string'||!path||path.includes('\\')||path.split('/').some(part=>!part||part==='.'||part==='..')||path.includes(':'))throw new Error('INVALID_PAYLOAD_RELATIVE_PATH');
  if(/\.pdb$/i.test(path))return'debug-symbol';
  const locale=/^locales\/([^/]+)\.pak$/.exec(path);
  if(locale&&!WINDOWS_HELPER_LOCALES.includes(locale[1]))return'unused-chromium-ui-locale';
  return null;
}
export async function copyWindowsHelperPayload(source,destination){
  if((await lstat(source)).isSymbolicLink())throw new Error('PAYLOAD_LINK_REJECTED');
  const report={locales:[...WINDOWS_HELPER_LOCALES],sourceBytes:0,payloadBytes:0,sourceFiles:0,payloadFiles:0,excluded:[]};
  async function copy(from,to,prefix=''){
    await mkdir(to,{recursive:true});
    for(const item of await readdir(from,{withFileTypes:true})){
      if(item.isSymbolicLink())throw new Error('PAYLOAD_LINK_REJECTED');
      const relative=prefix+item.name,origin=join(from,item.name),target=join(to,item.name);
      if(item.isDirectory()){await copy(origin,target,relative+'/');continue;}
      if(!item.isFile())throw new Error('PAYLOAD_SPECIAL_FILE_REJECTED');
      const size=(await lstat(origin)).size;report.sourceBytes+=size;report.sourceFiles++;
      const reason=windowsPayloadExclusion(relative);
      if(reason){report.excluded.push({path:relative,bytes:size,reason});continue;}
      await copyFile(origin,target);report.payloadBytes+=size;report.payloadFiles++;
    }
  }
  await copy(source,destination);
  // Missing these must fail packaging, rather than produce a small broken app.
  for(const file of ['旅游商家助手.exe','resources/app.asar','resources/native/windows/TravelMerchant.WindowHelper.exe','icudtl.dat','LICENSE.electron.txt','LICENSES.chromium.html',...WINDOWS_HELPER_LOCALES.map(locale=>'locales/'+locale+'.pak')])await access(join(destination,file));
  return{...report,savedBytes:report.sourceBytes-report.payloadBytes};
}
