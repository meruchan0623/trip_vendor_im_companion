/** Lightweight rules ported from TSim agent-frontend languageDetector; decides translation and follow-customer only. */
const HANZI=/[一-龥㐀-䶿豈-﫿]/;
const LATIN_WORD=/[a-zA-Z]{2,}/g;
const TECHNICAL_LATIN_TOKEN=/^(?:apn|esim|sim|iccid|imsi|imei|eid|pin|puk|lpa|smdp\+?|ios|iphone|android|lte|4g|5g)$/i;
const URL_ONLY=/^(?:https?:\/\/|www\.)\S+$/i;
const EMAIL_ONLY=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LPA_ACTIVATION_CODE=/^lpa:1\$[^\s$]+\$[^\s$]+(?:\$[^\s$]+)?$/i;
const SERIAL_OR_NUMERIC_TOKEN=/^(?:\d+(?:[\s,.-]\d+)*|89\d{17,20}|[A-Z]{1,5}-\d+)$/i;
export const CUSTOMER_TEXT_SELECTOR='.chat_list_content li.normal-message-item.customer .chat-content .chat-text';
/** Group chats render the merchant's own colleagues as `.customer` too; the vendor marks real guests with a `.tag-guest` name tag. */
const GUEST_TAG_SELECTOR='.message-name .tag-guest';
/** The vendor appends its own machine translation ("来自google翻译") as a second `.chat-text` inside `.tran-group`; only the original counts. */
const VENDOR_TRANSLATION_SELECTOR='.tran-group';
export const CUSTOMER_SAMPLE_LIMIT=5;
/** Values that must remain literal even when a target locale differs. */
export function isNonTranslatableToken(text:string){const trimmed=String(text||'').trim();return !!trimmed&&(URL_ONLY.test(trimmed)||EMAIL_ONLY.test(trimmed)||LPA_ACTIVATION_CODE.test(trimmed)||SERIAL_OR_NUMERIC_TOKEN.test(trimmed)||TECHNICAL_LATIN_TOKEN.test(trimmed));}
/** Device nouns such as iPhone/APN inside Chinese do not count; two ordinary Latin words do. */
export function hasSubstantiveLatinText(text:string){const words=String(text||'').match(LATIN_WORD)||[];return words.filter(word=>!TECHNICAL_LATIN_TOKEN.test(word)&&!/^[A-Z]{2,5}$/.test(word)).length>=2;}
/** Distinctive vocabulary only: short replies and shared Latin words cannot reliably identify a language. */
function latinLanguage(text:string):string{
  const words=new Set(text.normalize('NFC').toLowerCase().match(/[\p{Script=Latin}\p{M}]+/gu)??[]);
  const vocabulary:Record<string,string[]>={
    en:['hello','thanks','please','order','could','how','where','your','would','cancel','refund','issue','problems','check','there','this','with','english'],
    es:['hola','gracias','pedido','necesito','ayuda','puedo','quiero','reembolso','español'],
    fr:['bonjour','merci','commande','besoin','voudrais','remboursement','français'],
    de:['hallo','danke','bestellung','brauche','bitte','rückerstattung','deutsch'],
    pt:['olá','obrigado','obrigada','preciso','reembolso','português'],
    it:['ciao','grazie','ordine','vorrei','rimborso','italiano'],
    vi:['chào','cảm','ơn','tôi','đơn','hàng','tiếng','việt'],
    id:['nggak','butuh','pesanan','indonesia'],
    ms:['nak','tempahan','melayu'],
  };
  const scores=Object.entries(vocabulary).map(([lang,tokens])=>[lang,tokens.filter(token=>words.has(token)).length] as const).filter(([,score])=>score>0).sort((a,b)=>b[1]-a[1]);
  if(!scores.length||scores.length>1&&scores[0][1]===scores[1][1])return 'unknown';
  // A single shared loanword (e.g. reembolso) remains ambiguous; ties above reject it.
  return scores[0][0];
}
export function detectLanguage(text:string):string{
  if(!text||text.trim().length<2)return 'unknown';const trimmed=text.trim().normalize('NFC');if(isNonTranslatableToken(trimmed)||!/[\p{L}]/u.test(trimmed))return 'unknown';
  const letters=[...trimmed.matchAll(/\p{L}/gu)].map(match=>match[0]);
  const hasScript=(script:RegExp)=>letters.some(letter=>script.test(letter));
  // Japanese before Hanzi: Japanese sentences routinely mix kanji and kana.
  if(hasScript(/[\p{Script=Hiragana}\p{Script=Katakana}]/u))return 'ja';
  if(hasScript(/\p{Script=Hangul}/u))return 'ko';
  if(HANZI.test(trimmed))return hasSubstantiveLatinText(trimmed)?latinLanguage(trimmed):'zh';
  if(hasScript(/\p{Script=Arabic}/u)){
    // Arabic script is also used for Persian and Urdu. Reject non-Arabic letters,
    // and require actual Arabic vocabulary instead of guessing from the script.
    const scriptLetters=letters.filter(letter=>/\p{Script=Arabic}/u.test(letter));
    if(scriptLetters.some(letter=>!/[ء-غف-ي]/u.test(letter)))return 'unknown';
    const words=trimmed.replace(/\p{M}/gu,'').match(/[ء-غف-ي]+/gu)??[];
    return words.some(word=>['مرحبا','شكرا','شكراً','كيف','الطلب','طلب','العربية','فضلك','أحتاج'].includes(word))?'ar':'unknown';
  }
  if(hasScript(/\p{Script=Cyrillic}/u)){
    // Cyrillic alone cannot distinguish Russian from Ukrainian or Bulgarian.
    const scriptLetters=letters.filter(letter=>/\p{Script=Cyrillic}/u.test(letter));
    if(scriptLetters.some(letter=>!/[А-Яа-яЁё]/u.test(letter)))return 'unknown';
    const words=trimmed.toLowerCase().match(/[а-яё]+/gu)??[];
    return words.some(word=>['здравствуйте','привет','спасибо','пожалуйста','заказ','русский','где','нужна'].includes(word))?'ru':'unknown';
  }
  if(hasScript(/\p{Script=Greek}/u))return 'el';
  if(hasScript(/\p{Script=Thai}/u))return 'th';
  if(/^[\p{Script=Latin}\s\d\p{P}]+$/u.test(trimmed))return latinLanguage(trimmed);
  return 'unknown';
}
/** Majority of the given texts (oldest first); a tie goes to the language of the newest tied message. */
export function dominantLanguage(texts:readonly string[]):string{
  const counts=new Map<string,number>(),latest=new Map<string,number>();
  texts.forEach((text,index)=>{const language=detectLanguage(text);if(language==='unknown')return;counts.set(language,(counts.get(language)??0)+1);latest.set(language,index);});
  let best='unknown',count=0;for(const [language,value] of counts)if(value>count||value===count&&latest.get(language)!>latest.get(best)!){best=language;count=value;}
  return best;
}
/** Last N guest bubbles, text only, oldest first. Positive guest attribution is required; untagged rows may be merchant colleagues. */
export function collectCustomerTexts(document:Document,limit=CUSTOMER_SAMPLE_LIMIT):string[]{
  const visibility=new Map<Element,boolean>();
  const visible=(node:Element)=>{
    const path:Element[]=[];let result=true;
    for(let current:Element|null=node;current;current=current.parentElement){
      const cached=visibility.get(current);if(cached!==undefined){result=cached;break;}
      path.push(current);
      if(current.hasAttribute('hidden')||current.getAttribute('aria-hidden')==='true'){result=false;break;}
      const style=document.defaultView?.getComputedStyle(current);
      if(style?.display==='none'||style?.visibility==='hidden'){result=false;break;}
    }
    // Cache ancestors too: the last five bubbles share most of their layout tree.
    // This cache is local to one scan, so later visibility changes remain observable.
    for(const element of path)visibility.set(element,result);
    return result;
  };
  const lists=[...document.querySelectorAll('.chat_list_content')].filter(visible);if(lists.length!==1)return [];
  const nodes=[...lists[0].querySelectorAll<HTMLElement>('li.normal-message-item.customer .chat-content .chat-text')].filter(node=>!node.closest(VENDOR_TRANSLATION_SELECTOR));
  const texts:string[]=[];
  for(let index=nodes.length-1;index>=0&&texts.length<limit;index--){const node=nodes[index],row=node.closest('li.normal-message-item');if(!row?.querySelector(GUEST_TAG_SELECTOR)||row.querySelector('.tag-merchant')||!visible(node))continue;const text=(node.textContent??'').trim();if(text)texts.unshift(text);}
  return texts;
}
export function customerLanguage(document:Document,limit=CUSTOMER_SAMPLE_LIMIT){return dominantLanguage(collectCustomerTexts(document,limit));}
