import {detectLocalLanguage} from './local-language-model';
/** Explicit script/word evidence followed by conservative, entirely local model agreement. */
const HANZI=/[一-龥㐀-䶿豈-﫿]/;
const LATIN_WORD=/[a-zA-Z]{2,}/g;
const TECHNICAL_LATIN_TOKEN=/^(?:apn|esim|sim|iccid|imsi|imei|eid|pin|puk|lpa|smdp\+?|ios|iphone|android|lte|4g|5g)$/i;
const URL_ONLY=/^(?:https?:\/\/|www\.)\S+$/i;
const EMAIL_ONLY=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LPA_ACTIVATION_CODE=/^lpa:1\$[^\s$]+\$[^\s$]+(?:\$[^\s$]+)?$/i;
const SERIAL_OR_NUMERIC_TOKEN=/^(?:\d+(?:[\s,.-]\d+)*|89\d{17,20}|[A-Z]{1,5}-\d+)$/i;
// Shared Russian/Ukrainian confirmation, only when it is the entire original.
// It supplies no language identity; do not remove this word from real clauses.
const SHARED_NEUTRAL_CONFIRMATION=/^[\s\p{P}\p{S}\uFE0F\u200D]*так[\s\p{P}\p{S}\uFE0F\u200D]*$/iu;
export const CUSTOMER_TEXT_SELECTOR='.chat_list_content li.normal-message-item.customer .chat-content .chat-text';
/** Group chats render the merchant's own colleagues as `.customer` too; the vendor marks real guests with a `.tag-guest` name tag. */
const GUEST_TAG_SELECTOR='.message-name .tag-guest';
/** The vendor appends its own machine translation ("来自google翻译") as a second `.chat-text` inside `.tran-group`; only the original counts. */
// Vendor YTe marks order/product cards as .chat-send-order; their .chat-text fallback
// is a product title, not the guest's authored language (including CBZ59 cards).
const NON_ORIGINAL_CONTENT_SELECTOR='.tran-group,.chat-send-order,.cite-container,.cite-text,blockquote,[data-translation],[data-quoted-message]';
export const CUSTOMER_SAMPLE_LIMIT=5;
export const CUSTOMER_LANGUAGE_LOOKBACK=30;
/** Values that must remain literal even when a target locale differs. */
export function isNonTranslatableToken(text:string){const trimmed=String(text||'').trim();return !!trimmed&&(URL_ONLY.test(trimmed)||EMAIL_ONLY.test(trimmed)||LPA_ACTIVATION_CODE.test(trimmed)||SERIAL_OR_NUMERIC_TOKEN.test(trimmed)||TECHNICAL_LATIN_TOKEN.test(trimmed));}
/** Device nouns such as iPhone/APN inside Chinese do not count; two ordinary Latin words do. */
export function hasSubstantiveLatinText(text:string){const words=String(text||'').match(LATIN_WORD)||[];return words.filter(word=>!TECHNICAL_LATIN_TOKEN.test(word)&&!/^[A-Z]{2,5}$/.test(word)).length>=2;}
/** Remove identifiers before scoring: domain paths, mailbox names and activation codes are not prose. */
function languageProse(text:string){
  let prose=text.normalize('NFC')
    .replace(/\blpa:1\$[^\s]+/giu,' ')
    .replace(/(?:https?:\/\/|www\.)[^\s<>]+/giu,' ');
  // The unanchored mailbox pattern otherwise retries at every character in a
  // long no-whitespace message. Match each token once with an anchored check.
  if(prose.includes('@'))prose=prose.replace(/[^\s<>]+/gu,token=>/^[^@]+@[^@]+\.[^@]+$/u.test(token)?' ':token);
  return prose
    // Consume a dotted token once; retrying the full domain pattern at every
    // dot is quadratic for strings such as "a.a.a..." with no valid TLD.
    .replace(/\b[a-z\d-]+(?:\.[a-z\d-]+)+(?:\/[^\s<>]*)?/giu,token=>/^(?:[a-z\d-]+\.)+[a-z]{2,24}(?:\/[^\s<>]*)?$/iu.test(token)?' ':token)
    .replace(/\b[\p{L}\d_+.-]+\b/gu,token=>/\d/u.test(token)?' ':token)
    .replace(/\b[A-Z]{2,}(?:[-_][A-Z]{2,})+\b/gu,' ')
    .replace(/[’‘]/gu,"'");
}
// Match sentence evidence, not a growing list of device nouns. Shared replies (ok/yes/no),
// personal names and isolated technical terms never supply English evidence by themselves.
// Auxiliary + personal pronoun + a real predicate survives misspelled content nouns.
// A bare "Can I" or a following personal name is not a clause.
const ENGLISH_ACTION_PREDICATE='(?:have|do|get|receive|send|resend|use|try|retry|connect|reconnect|install|activate|open|close|start|restart|stop|check|change|cancel|book|buy|pay|return|refund|help|wait|arrive|leave|go|come|see|know|ask|find|download|upload|scan|add|remove|update|work|keep|make|take|need|want)';
const ENGLISH_QUESTION_PREDICATE='(?:be|'+ENGLISH_ACTION_PREDICATE+')';
const ENGLISH_PERSONAL_QUESTION=new RegExp('\\b(?:can|could|may|might|must|shall|should|will|would|do|does|did)\\s+(?:i|we|you|he|she|it|they)\\s+(?:not\\s+)?'+ENGLISH_QUESTION_PREDICATE+'\\b');
// Passive grammar remains evidence with noun subjects and non-native wording;
// neither a product noun nor a particular subject is needed to establish it.
const ENGLISH_NEGATIVE_MODAL="(?:cannot|can't|couldn't|won't|wouldn't|shouldn't|mustn't|(?:can|could|will|would|should|must|may|might)\\s+not)";
const ENGLISH_NEGATIVE_PASSIVE=new RegExp('\\b'+ENGLISH_NEGATIVE_MODAL+'\\s+be\\s+(?:[a-z]{2,}ed|known|given|taken|made|sent|done|seen|found|shown|bought|sold|broken|written|read|built|lost)\\b');
const ENGLISH_NEGATIVE_ACTION=new RegExp('\\b'+ENGLISH_NEGATIVE_MODAL+'\\s+'+ENGLISH_ACTION_PREDICATE+'\\b');
const ENGLISH_PHRASES=[
  ENGLISH_PERSONAL_QUESTION,
  ENGLISH_NEGATIVE_PASSIVE,
  ENGLISH_NEGATIVE_ACTION,
  /\bstill\s+(?:the\s+same|same|unchanged|offline|online|pending|disconnected|connected|loading|waiting|broken|stuck|slow|unavailable)\b/,
  // Elliptical status and imperative replies often omit a subject or copula.
  /\b(?:very|too|really)\s+(?:bad|good|slow|fast|weak|poor|strong|unstable|unreliable|expensive|cheap|difficult|easy)\b/,
  /\b(?:try|retry|check|restart|reconnect|connect|activate|install|wait|open|close|send|resend|cancel|stop|update|scan|pay|refund)\s+(?:it\s+)?(?:now|again|later)\b/,
  /\bsame\s+(?:issue|problem|error|result|status|message|situation)\b/,
  /\bgood\s+(?:morning|afternoon|evening|night|day)\b/,
  /\b(?:i|we)\s+(?:am|are|have|need|want|would|think|tried|bought|cannot|can't|couldn't|don't|didn't)\b/,
  /\bi'(?:m|ve|ll|d)\b/,
  /\b(?:it|this|that)\s+(?:is|isn't|was|wasn't|doesn't|does not|won't|cannot|can't|still)\b/,
  /\b(?:this|that|my|the)\s+(?:sim|esim|phone|device|connection|data|internet)\s+(?:is|isn't|was|does|doesn't|will|won't)\b/,
  /\b(?:can|could|would|will)\s+you\b/,
  /\b(?:is|does|will|can|should)\s+it\b/,
  /\b(?:how|where|when|why|what)\s+(?:can|could|do|does|is|are|should|did)\b/,
  /\bhow\s+about\b/,
  /\bno\s+(?:internet|connection|network|data|signal|service)\b/,
  /\bstill\s+not\s+(?:connected|working|activated)\b/,
  /\b(?:not working|doesn't work|does not work|unable to|thank you|help me)\b/,
  /\b(?:my|your|the|this)\s+(?:order|connection|internet|phone|device|problem|issue|refund)\b/,
];
const ENGLISH_DISTINCTIVE=new Set(['hi','hello','thanks','please','english','sorry']);
const RUSSIAN_DISTINCTIVE=new Set([
  'здравствуйте','привет','спасибо','пожалуйста','заказ','русский','где','нужна','нужен','нужно',
  'помогите','помощь','работает','работают','могу','подключить','активировать','активация',
  'подключение','ошибка','купил','купила','возврат','вернуть','проверить','получилось',
  'меня','приходит','установить','всё',
]);
// Russian inflections, not shared short Cyrillic words such as я/не/да.
const RUSSIAN_GRAMMAR_EVIDENCE=new Set(['это','этот','этого','этой','этом','эти','эту','эта','который','которая','которые','почему','сейчас','здесь','ещё','еще','имею']);
// Exact Russian interrogative inflections, not shared Cyrillic question prefixes.
// These are independent rule evidence: XS models rank neighbouring languages
// almost equally for short questions, so their statistical gates stay unchanged.
const RUSSIAN_QUESTION_WORDS=new Set(['какой','какая','какое','какие','какого','какому','какую','каким','какими','каких']);
const RUSSIAN_QUESTION_FUNCTION_WORDS=new Set(['и','а','но','или','не','нет','да','в','во','на','по','для','от','до','из','за','с','со','к','ко','у','о','об','при','я','ты','он','она','оно','мы','вы','они','мне','тебе','ему','ей','нам','вам','им','мой','моя','мое','моё','твой','твоя','его','ее','её','наш','ваш','кто','что','как','где','когда']);
function hasRussianQuestionEvidence(words:readonly string[]){
  return words.length>=2&&words.some(word=>RUSSIAN_QUESTION_WORDS.has(word))&&words.some(word=>word.length>=3&&!RUSSIAN_QUESTION_WORDS.has(word)&&!RUSSIAN_QUESTION_FUNCTION_WORDS.has(word)&&!RUSSIAN_GRAMMAR_EVIDENCE.has(word));
}
/** Distinctive vocabulary and sentence patterns; unsupported or conflicting evidence stays unknown. */
function latinSignals(text:string){
  const prose=languageProse(text).toLowerCase();
  const words=new Set(prose.match(/[\p{Script=Latin}\p{M}]+/gu)??[]);
  const vocabulary:Record<string,string[]>={
    es:['hola','gracias','pedido','necesito','ayuda','puedo','quiero','reembolso','español'],
    fr:['bonjour','merci','commande','besoin','voudrais','remboursement','français'],
    de:['hallo','danke','bestellung','brauche','bitte','rückerstattung','deutsch'],
    pt:['olá','obrigado','obrigada','preciso','reembolso','português'],
    it:['ciao','grazie','ordine','vorrei','rimborso','italiano'],
    vi:['chào','cảm','ơn','tôi','đơn','hàng','tiếng','việt'],
    id:['nggak','butuh','pesanan','indonesia'],
    ms:['nak','tempahan','melayu'],
    tr:['merhaba','merhabalar','teşekkürler','lütfen','türkçe'],
  };
  const scores=Object.entries(vocabulary).map(([lang,tokens])=>[lang,tokens.filter(token=>words.has(token)).length] as const).filter(([,score])=>score>0).sort((a,b)=>b[1]-a[1]);
  const english=ENGLISH_PHRASES.some(pattern=>pattern.test(prose))||[...words].some(word=>ENGLISH_DISTINCTIVE.has(word));
  return{prose,scores,english};
}
function latinLanguage(text:string):string{
  const{prose,scores,english}=latinSignals(text);
  // Do not let English scaffolding override clear foreign vocabulary. Mixed identified
  // languages are deliberately unresolved rather than silently choosing English.
  if(scores.length){
    if(english||scores.length>1&&scores[0][1]===scores[1][1])return 'unknown';
    return scores[0][0];
  }
  // Accented prose without a supported vocabulary hit may be another Latin language.
  if(/[^\x00-\x7F]/u.test(prose.replace(/[^\p{Script=Latin}\p{M}]/gu,'')))return 'unknown';
  return english?'en':'unknown';
}
function detectRuleLanguage(text:string):string{
  if(!text||text.trim().length<2)return 'unknown';const trimmed=languageProse(text.trim());if(isNonTranslatableToken(trimmed)||!/[\p{L}]/u.test(trimmed))return 'unknown';
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
    if(letters.every(letter=>/[А-Яа-яЁё]/u.test(letter))&&hasRussianQuestionEvidence(words))return 'ru';
    return words.some(word=>RUSSIAN_DISTINCTIVE.has(word))||/(?:^|\s)добрый\s+(?:день|вечер)(?:\s|[!.,?]|$)/u.test(trimmed.toLowerCase())?'ru':'unknown';
  }
  if(hasScript(/\p{Script=Greek}/u))return 'el';
  if(hasScript(/\p{Script=Thai}/u))return 'th';
  // Emoji, punctuation and combining accents do not veto otherwise valid prose.
  if(letters.every(letter=>/\p{Script=Latin}/u.test(letter)))return latinLanguage(trimmed);
  return 'unknown';
}
export function detectLanguage(text:string):string{
  const known=detectRuleLanguage(text);if(known!=='unknown')return known;
  const prose=languageProse(String(text??'')).trim(),words=prose.match(/[\p{L}\p{M}]+/gu)??[],natural=words.filter(word=>!TECHNICAL_LATIN_TOKEN.test(word)&&!/^(?:ok|okay|yes|no)$/i.test(word));
  if([...prose].some(letter=>/\p{Script=Cyrillic}/u.test(letter)&&!/[А-Яа-яЁё]/u.test(letter))||[...prose].some(letter=>/\p{Script=Arabic}/u.test(letter)&&!/[ء-غف-ي\p{M}]/u.test(letter)))return 'unknown';
  if(natural.every(word=>/^[А-Яа-яЁё]+$/u.test(word))&&natural.some(word=>RUSSIAN_GRAMMAR_EVIDENCE.has(word.toLowerCase())))return 'ru';
  const{scores,english}=latinSignals(prose);if(scores.length&&(english||scores.length>1&&scores[0][1]===scores[1][1]))return 'unknown';
  // Device/code labels must not contribute unique model n-grams. Keep the
  // original prose for rule conflicts and the original message for voting.
  const modelProse=prose.replace(/[\p{L}\p{M}]+/gu,word=>TECHNICAL_LATIN_TOKEN.test(word)||/^qr$/i.test(word)?' ':word);
  const modelNatural=natural.filter(word=>!/^qr$/i.test(word));
  return detectLocalLanguage(modelProse,modelNatural);
}
/** Unknown natural prose still votes unknown; only identifiers and neutral acknowledgements abstain. */
export function isLanguageEvidence(text:string,language=detectLanguage(text)){
  if(SHARED_NEUTRAL_CONFIRMATION.test(String(text??'').normalize('NFC')))return false;
  if(language!=='unknown')return true;
  const prose=languageProse(text).trim(),words=prose.match(/[\p{L}\p{M}]+/gu)??[];
  // A name cannot safely be distinguished from unknown natural language by length
  // or capitalization. Such text votes unknown rather than granting another language a majority.
  return words.length>0&&!words.every(word=>TECHNICAL_LATIN_TOKEN.test(word)||/^(?:ok|okay|yes|no)$/i.test(word));
}
/** Only a strict majority of non-neutral originals is a target, including unknown prose in the denominator. */
export function languageEvidence(texts:readonly string[]){
  const counts:Record<string,number>={};let recognizedCount=0,evidenceCount=0;
  for(const text of texts){const language=detectLanguage(text);if(!isLanguageEvidence(text,language))continue;counts[language]=(counts[language]??0)+1;evidenceCount++;if(language!=='unknown')recognizedCount++;}
  const language=Object.keys(counts).find(key=>key!=='unknown'&&counts[key]>evidenceCount/2)??'unknown';
  return {language,counts,sampleCount:texts.length,recognizedCount,evidenceCount};
}
export function dominantLanguage(texts:readonly string[]):string{return languageEvidence(texts).language;}
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
  const rows=[...lists[0].querySelectorAll<HTMLElement>('li.normal-message-item.customer')];
  const belongsToRow=(node:Element,row:Element)=>node.closest('li.normal-message-item')===row&&!node.closest(NON_ORIGINAL_CONTENT_SELECTOR);
  const originalText=(node:Node):string=>{
    if(node.nodeType===3)return node.textContent??'';
    if(node.nodeType!==1)return '';
    const element=node as Element;if(element.matches(NON_ORIGINAL_CONTENT_SELECTOR)||!visible(element))return '';
    if(element.tagName==='BR')return '\n';
    return [...node.childNodes].map(originalText).join('');
  };
  const texts:string[]=[];
  for(let index=rows.length-1;index>=0&&texts.length<limit;index--){
    const row=rows[index];
    if(!visible(row)||![...row.querySelectorAll(GUEST_TAG_SELECTOR)].some(tag=>belongsToRow(tag,row)&&visible(tag))||[...row.querySelectorAll('.tag-merchant')].some(tag=>belongsToRow(tag,row)))continue;
    const parts=[...row.querySelectorAll<HTMLElement>('.chat-content .chat-text')].filter(node=>belongsToRow(node,row)&&!node.parentElement?.closest('.chat-text'));
    const text=parts.map(originalText).map(part=>part.trim()).filter(Boolean).join('\n');if(text)texts.unshift(text);
  }
  return texts;
}
/** Fixed window of actual guest originals; only neutral messages abstain from the vote. */
export function customerLanguage(document:Document,limit=CUSTOMER_LANGUAGE_LOOKBACK){return customerLanguageEvidence(document,limit).language;}
export function customerLanguageEvidence(document:Document,limit=CUSTOMER_LANGUAGE_LOOKBACK){
  const boundedLimit=Number.isFinite(limit)?Math.max(0,Math.min(CUSTOMER_LANGUAGE_LOOKBACK,Math.floor(limit))):CUSTOMER_LANGUAGE_LOOKBACK;
  return languageEvidence(collectCustomerTexts(document,boundedLimit));
}
/** One current-conversation window only. DOM visibility is re-read on each
 * relevant change; unchanged originals do not repeat model/rule inference. */
export function createCustomerLanguageReader(document:Document){
  let signature:string|undefined,evidence:ReturnType<typeof languageEvidence>|undefined;
  return{
    read(){
      const texts=collectCustomerTexts(document,CUSTOMER_LANGUAGE_LOOKBACK),next=JSON.stringify(texts);
      if(evidence&&next===signature)return evidence;
      const result=languageEvidence(texts);
      // Large messages retain their full detection semantics without becoming
      // a persistent cache of customer content.
      if(next.length<=65536){signature=next;evidence=result;}else{signature=undefined;evidence=undefined;}
      return result;
    },
    reset(){signature=undefined;evidence=undefined;},
  };
}
/** Ignore editor input and unrelated UI changes. Removal/class changes of a
 * message list and ancestor visibility still invalidate the current window. */
export function affectsCustomerLanguage(mutation:MutationRecord):boolean{
  const target=mutation.target.nodeType===1?mutation.target as Element:mutation.target.parentElement;
  if(!target)return false;
  if(target.closest('.chat_list_content'))return true;
  if(mutation.type==='attributes')return !!target.querySelector('.chat_list_content')||mutation.attributeName==='class'&&(mutation.oldValue??'').split(/\s+/).includes('chat_list_content');
  if(mutation.type==='childList')return [...mutation.addedNodes,...mutation.removedNodes].some(node=>node.nodeType===1&&((node as Element).matches('.chat_list_content')||!!(node as Element).querySelector('.chat_list_content')));
  return false;
}
