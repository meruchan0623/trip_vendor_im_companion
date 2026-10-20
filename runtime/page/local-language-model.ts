import {detectAll} from 'tinyld';
import {eld} from 'eld/extrasmall';
// Both model distributions are bundled locally. Never restrict the model's candidate languages.
const GRAMMAR:Record<string,readonly string[]>={
  en:['i','you','he','she','it','we','they','my','your','our','their','a','an','the','to','of','in','on','at','for','with','from','is','are','was','were','do','does','did','can','could','would','will','not'],
  // Manner/degree adverbs also supply grammar in clauses without a pronoun or
  // preposition. They still require the same full-model agreement and margins.
  ru:['я','ты','он','она','мы','вы','они','мой','моя','наш','ваш','это','этот','эта','эти','в','во','на','по','для','от','до','из','за','со','не','нет','но','что','как','когда','где','плохо','хорошо','медленно','быстро','очень','слишком'],
  // Prepositions alone also occur between names or places; require clause evidence.
  ar:['أنا','انت','أنت','هو','هي','نحن','هم','هذا','هذه','لا','لم','لن','هل'],
  // For these Latin languages, articles, possessives and linking prepositions can
  // occur in full names. They are insufficient without stronger clause evidence.
  es:['yo','tú','usted','nosotros','no','es','está','estoy','puede'],
  fr:['je','tu','il','elle','nous','vous','ils','elles','ne','pas','est','sont'],
  de:['ich','du','er','sie','wir','ihr','nicht','ist','sind','kann'],
  pt:['eu','tu','ele','ela','nós','você','não','é','estou'],
  it:['io','tu','lui','lei','noi','voi','non','è','sono'],
  // Kinship pronouns anh/chị are common name components and are neutral alone.
  vi:['tôi','bạn','chúng','của','và','không','đã','sẽ','được','là','với','trong'],
  // Interrogatives, finite predicates and question particles; common names or
  // shared short pronouns (ben/sen) do not authorize a Turkish model vote.
  tr:['nasıl','neden','niçin','hangi','nerede','nereden','nereye','değil','istiyorum','istiyorsun','istiyor','istiyoruz','istiyorsunuz','istiyorlar','misiniz','mısınız','musunuz','müsünüz','miyim','mıyım','muyum','müyüm'],
};
export const LOCAL_LANGUAGE_THRESHOLDS=Object.freeze({minimumWords:3,minimumLetters:10,tinyScore:0.2,eldScore:0.7,eldMargin:0.01});
/** Scores are model-specific evidence, not calibrated probabilities. Unknown remains a vote. */
export function detectLocalLanguage(prose:string,natural:readonly string[]):string{
  // Russian finite reflexive verbs differ from neighbouring -ться/-цца forms.
  // This is only a length exception: both unrestricted models and all score/
  // separation gates below still have to identify Russian independently.
  const shortRussianClause=natural.length===2&&/^не$/iu.test(natural[0])&&/^[а-яё]{3,}(?:ется|ётся|ится|ются|утся|атся|ятся)$/iu.test(natural[1]);
  if(natural.length<3&&!shortRussianClause||[...prose.matchAll(/\p{L}/gu)].length<10||/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}$/.test(prose.trim()))return 'unknown';
  if(![/^\p{Script=Latin}[\p{Script=Latin}\p{M}]*$/u,/^\p{Script=Cyrillic}[\p{Script=Cyrillic}\p{M}]*$/u,/^\p{Script=Arabic}[\p{Script=Arabic}\p{M}]*$/u].some(script=>natural.every(word=>script.test(word))))return 'unknown';
  const candidates=detectAll(prose),tiny=candidates[0],runner=candidates[1];
  if(!tiny||shortRussianClause&&tiny.lang!=='ru'||!Number.isFinite(tiny.accuracy)||tiny.accuracy<0.2||runner&&(!Number.isFinite(runner.accuracy)||tiny.accuracy-runner.accuracy<0.01)||!Object.hasOwn(GRAMMAR,tiny.lang))return 'unknown';
  const tokens=new Set(prose.toLowerCase().match(/[\p{L}\p{M}]+/gu)??[]);
  // No unknown -> id/ms fallback: TinyLD has no Malay competitor. Explicit rules remain available.
  if(!GRAMMAR[tiny.lang].some(word=>tokens.has(word)))return 'unknown';
  const scores=Object.entries(eld.detect(prose).getScores()).filter((entry):entry is [string,number]=>Number.isFinite(entry[1])).sort((a,b)=>b[1]-a[1]),top=scores[0];
  if(!top||top[0]!==tiny.lang||top[1]<0.7||top[1]-(scores[1]?.[1]??0)<0.01)return 'unknown';
  return tiny.lang;
}
