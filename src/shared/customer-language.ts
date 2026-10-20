import {isCustomerLanguage,isPanelTarget} from './workbench';

export interface CustomerLanguageCounts {sampleCount:number;evidenceCount:number;recognizedCount:number}
export type CustomerLanguageReason='no-originals'|'no-majority'|'unrecognized'|'unsupported'|'source-unavailable';
export type CustomerLanguageResolution=CustomerLanguageCounts&({status:'collecting'|'identified'}|{status:'fallback';reason:CustomerLanguageReason});
export const emptyLanguageCounts=():CustomerLanguageCounts=>({sampleCount:0,evidenceCount:0,recognizedCount:0});
export const collectingCustomerLanguage=():CustomerLanguageResolution=>({status:'collecting',...emptyLanguageCounts()});
export const unavailableCustomerLanguage=():CustomerLanguageResolution=>({status:'fallback',reason:'source-unavailable',...emptyLanguageCounts()});
export const sameCustomerLanguageResolution=(a:CustomerLanguageResolution|undefined,b:CustomerLanguageResolution)=>!!a&&a.status===b.status&&('reason'in a?a.reason:undefined)===('reason'in b?b.reason:undefined)&&a.sampleCount===b.sampleCount&&a.evidenceCount===b.evidenceCount&&a.recognizedCount===b.recognizedCount;
export function resolveCustomerLanguage(language:string,counts:CustomerLanguageCounts):CustomerLanguageResolution {
  const summary={sampleCount:counts.sampleCount,evidenceCount:counts.evidenceCount,recognizedCount:counts.recognizedCount};
  if(language==='zh'||isPanelTarget(language))return{status:'identified',...summary};
  const reason:CustomerLanguageReason=language!=='unknown'?'unsupported':!counts.sampleCount?'no-originals':!counts.recognizedCount?'unrecognized':'no-majority';
  return{status:'fallback',reason,...summary};
}
/** Fixed bounded summaries only; message text and arbitrary metadata never cross this bridge. */
export function isCustomerLanguageResolution(value:unknown,language:string):value is CustomerLanguageResolution {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const v=value as Record<string,unknown>,keys=Object.keys(v).sort().join(',');
  if(keys!=='evidenceCount,recognizedCount,sampleCount,status'&&keys!=='evidenceCount,reason,recognizedCount,sampleCount,status')return false;
  if(![v.sampleCount,v.evidenceCount,v.recognizedCount].every(n=>typeof n==='number'&&Number.isInteger(n)&&n>=0&&n<=30))return false;
  if((v.recognizedCount as number)>(v.evidenceCount as number)||(v.evidenceCount as number)>(v.sampleCount as number))return false;
  if(v.status==='identified')return !('reason' in v)&&(language==='zh'||isPanelTarget(language));
  if(v.status!=='fallback')return false;
  if(v.reason==='source-unavailable')return language==='unknown'&&v.sampleCount===0;
  const expected=resolveCustomerLanguage(language,v as unknown as CustomerLanguageCounts);
  return expected.status==='fallback'&&expected.reason===v.reason;
}
export interface CustomerLanguageReport {lang:string;conversationKey:string;resolution?:CustomerLanguageResolution}
export function isCustomerLanguageReport(value:unknown):value is CustomerLanguageReport {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const v=value as Record<string,unknown>,keys=Object.keys(v).sort().join(',');
  return(keys==='conversationKey,lang'||keys==='conversationKey,lang,resolution')&&isCustomerLanguage(v.lang)&&typeof v.conversationKey==='string'&&v.conversationKey.length<=1024&&(!('resolution' in v)||isCustomerLanguageResolution(v.resolution,v.lang));
}
