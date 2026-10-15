/** Minimal admission rules mirrored from the current C-end languageDetector. */
const technical=/^(?:apn|esim|sim|iccid|imsi|imei|eid|pin|puk|lpa|smdp\+?|ios|iphone|android|lte|4g|5g)$/i;
export function shouldTranslateChineseDraft(text:string,target:string){
  const trimmed=text.trim();if(trimmed.length<2||/^zh(?:-|$)/i.test(target))return false;
  if(/^(?:https?:\/\/|www\.)\S+$/i.test(trimmed)||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)||/^lpa:1\$[^\s$]+\$[^\s$]+(?:\$[^\s$]+)?$/i.test(trimmed)||/^(?:\d+(?:[\s,.-]\d+)*|89\d{17,20}|[A-Z]{1,5}-\d+)$/i.test(trimmed)||technical.test(trimmed))return false;
  if(/[\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\u1100-\u11ff]/.test(trimmed)||!/[\u4e00-\u9fa5\u3400-\u4dbf\uf900-\ufaff]/.test(trimmed))return false;
  return (trimmed.match(/[a-zA-Z]{2,}/g)??[]).filter(word=>!technical.test(word)&&!/^[A-Z]{2,5}$/.test(word)).length<2;
}
