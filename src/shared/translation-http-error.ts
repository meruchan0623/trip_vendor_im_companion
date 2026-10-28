const ERROR_BODY_LIMIT=16_384;
const FIELDS=new Set(['text','texts','target_lang','source_lang','purpose','draft_request_id','composer_content_version','client_source']);
const TYPES=new Set(['extra_forbidden','missing','string_type','string_too_long','string_too_short','literal_error','enum','value_error','list_type']);
export interface SafeValidationIssue {field:string;type:string}
export class TranslationHttpError extends Error {
  constructor(readonly status:number,readonly validation:SafeValidationIssue[]=[],readonly requestId?:string){
    super(`PSIM_HTTP_${status}${status===422&&validation.length?'_VALIDATION':''}`);
    this.name='TranslationHttpError';
  }
}
/** No server message, input, response body or arbitrary location is retained. */
export async function translationHttpError(response:Response,signal?:AbortSignal):Promise<TranslationHttpError> {
  const header=response.headers.get('x-request-id');
  const requestId=header&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(header)?header:undefined;
  const fallback=()=>new TranslationHttpError(response.status,[],requestId);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  let abort:(()=>void)|undefined;
  try {
    reader=response.body?.getReader();
    if(!reader)return fallback();
    if(response.status!==422)return fallback();
    if(Number(response.headers.get('content-length'))>ERROR_BODY_LIMIT)return fallback();
    const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(new Error('REQUEST_ABORTED'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
    let size=0;const chunks:Uint8Array[]=[];
    for(;;){const next=await Promise.race([reader.read(),cancelled]);if(next.done)break;size+=next.value.byteLength;if(size>ERROR_BODY_LIMIT)return fallback();chunks.push(next.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    const value=JSON.parse(new TextDecoder().decode(bytes));
    const issues:SafeValidationIssue[]=[];
    if(response.status===422&&Array.isArray(value?.detail))for(const item of value.detail.slice(0,8)){
      if(Array.isArray(item?.loc)&&item.loc.length===2&&item.loc[0]==='body'&&FIELDS.has(item.loc[1])&&TYPES.has(item.type))issues.push({field:item.loc[1],type:item.type});
    }
    return new TranslationHttpError(response.status,issues,requestId);
  }catch{return fallback();}
  finally{if(abort)signal?.removeEventListener('abort',abort);if(reader)void reader.cancel().catch(()=>{});}
}
export const normalizeTsimDisplay=(value:string)=>value.replace(/\b(?:PSIM|TSIM|TSim|tsim)(?:_CS)?\b/g,'TSIM').replace(/\bPSIM_/g,'TSIM_');
export function serviceErrorMessage(error:unknown):string|undefined {
  const code=error instanceof Error?error.message:typeof error==='string'?error:'';
  const match=/^(?:PSIM|TSIM)_HTTP_(\d{3})(_VALIDATION)?$/.exec(code);
  if(!match)return undefined;
  const status=Number(match[1]),diagnostic=error instanceof TranslationHttpError&&error.requestId?`，诊断编号 ${error.requestId}`:'';
  const suffix=`（HTTP ${status}${diagnostic}）`;
  if(status===401)return `TSIM 登录已失效，请重新登录。${suffix}`;
  if(status===423)return `TSIM 账号已锁定或会话不可用，请检查账号状态并重新登录。${suffix}`;
  if(status===403)return `当前 TSIM 账号没有此操作权限。${suffix}`;
  if(status===422)return match[2]?`TSIM 请求格式或客户端兼容校验失败，请更新助手或联系支持。${suffix}`:`TSIM 未接受此请求，请联系支持核对请求。${suffix}`;
  if(status===429)return `TSIM 请求过于频繁，请稍后重试。${suffix}`;
  if(status>=500)return `TSIM 服务暂时不可用，请稍后重试。${suffix}`;
  return `TSIM 请求未完成，请联系支持。${suffix}`;
}
