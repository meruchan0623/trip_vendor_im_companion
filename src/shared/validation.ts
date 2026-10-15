import { HOST_ORIGIN, HOST_URL, type ContextSnapshot, type QueryRequest, type TranslationRequest } from './types';
const languages = new Set(['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'th', 'vi', 'id', 'es', 'fr', 'de']);
export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function exactKeys(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
export function validId(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
export function validContext(value: unknown): value is ContextSnapshot {
  return isRecord(value) && exactKeys(value, ['accountScope','platformAccountScope','conversationKey','generation','authGeneration','draftRevision']) &&
    ['accountScope','platformAccountScope','conversationKey'].every(key => typeof value[key] === 'string' && (value[key] as string).length > 0 && (value[key] as string).length <= 200) &&
    ['generation','authGeneration','draftRevision'].every(key => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0);
}
export function sameContext(a: ContextSnapshot, b: ContextSnapshot): boolean { return Object.keys(a).every(key => a[key as keyof ContextSnapshot] === b[key as keyof ContextSnapshot]); }
export function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 20_000 && !/^(?:data:|blob:|file:)/i.test(value.trim()) &&
    !/^\[(?:image|video|audio|图片|语音|文件)\]$/i.test(value.trim()) && !(value.length > 256 && /^[A-Za-z0-9+/=\s]+$/.test(value) && !value.includes(' '));
}
export function validTranslatedText(value:unknown):value is string {return typeof value==='string' && value.trim().length>0 && value.length<=50_000;}
export function validTranslation(value: unknown): value is TranslationRequest {
  return isRecord(value) && exactKeys(value,['requestId','text','targetLanguage','sourceLanguage','purpose','context','configurationVersion']) &&
    validId(value.requestId) && validText(value.text) && languages.has(value.targetLanguage as string) &&
    (value.sourceLanguage === 'auto' || languages.has(value.sourceLanguage as string)) &&
    ['inbound','outbound','sent_message_review'].includes(value.purpose as string) && validContext(value.context) &&
    typeof value.configurationVersion === 'string' && value.configurationVersion.length > 0 && value.configurationVersion.length <= 100;
}
export function validQuery(value: unknown): value is QueryRequest {
  return isRecord(value) && exactKeys(value,['requestId','identifier','identifierType','context','confirmed']) && validId(value.requestId) &&
    typeof value.identifier === 'string' && /^[A-Za-z0-9]{3,64}$/.test(value.identifier) &&
    ['order_number','iccid','eiccid'].includes(value.identifierType as string) && value.confirmed === true && validContext(value.context);
}
export function allowedHostURL(value: string): boolean {
  try { const url = new URL(value); return url.origin === HOST_ORIGIN && !url.username && !url.password && ['/desktop-host','/login'].includes(url.pathname); } catch { return false; }
}
export function approvedHostFrame(value: string): boolean { try { const url = new URL(value); return url.origin === HOST_ORIGIN && url.pathname === new URL(HOST_URL).pathname && !url.username && !url.password; } catch { return false; } }
/** Safe network boundary applies even when a deployed site accidentally exposes unrelated controls. */
export function allowedRemoteRequest(value:string,method:string):boolean {
  try {
    const url=new URL(value);
    if(url.username||url.password||url.protocol!=='https:')return false;
    if(![HOST_ORIGIN,'https://csapi.tsim.tech'].includes(url.origin))return false;
    if(['GET','HEAD','OPTIONS'].includes(method))return true;
    return method==='POST' && ['/agent/login','/agent/logout','/agent/auth/refresh','/agent/translate','/agent/translate/batch','/agent/package-query/perform','/agent/package-query/esim-info'].includes(url.pathname);
  }catch{return false;}
}
