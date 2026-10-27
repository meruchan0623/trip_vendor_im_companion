/** Only scalar, versioned measurements from TSim's request envelope enter runtime logs. */
const SOURCES=['upstream','memory_cache','shared_cache','singleflight','mixed','none'] as const;
const DURATION_FIELDS={server_ms:'serverMs',upstream_ms:'providerMs',provider_queue_ms:'providerQueueMs'} as const;
const COUNT_FIELDS={upstream_calls:'upstreamCalls',upstream_calls_completed:'upstreamCallsCompleted',input_tokens:'inputTokens',output_tokens:'outputTokens',cached_input_tokens:'cachedInputTokens',cache_write_tokens:'cacheWriteTokens',reasoning_tokens:'reasoningTokens'} as const;
function own(value:unknown,key:string):unknown {
  if(!value||typeof value!=='object')return;
  try{if(Array.isArray(value))return;const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;}catch{return;}
}
export function projectTranslationDiagnostics(value:unknown):Record<string,unknown>|undefined {
  if(own(value,'version')!==1||own(value,'attribution')!=='request_owned_calls')return;
  const result:Record<string,unknown>={diagnosticsVersion:1,usageAttribution:'request_owned_calls'};
  for(const [wire,key] of Object.entries(DURATION_FIELDS)){
    const item=own(value,wire);
    if(item===null&&wire!=='server_ms'||typeof item==='number'&&Number.isFinite(item)&&item>=0)result[key]=item;
  }
  for(const [wire,key] of Object.entries(COUNT_FIELDS)){
    const item=own(value,wire);
    if(item===null&&wire!=='upstream_calls'&&wire!=='upstream_calls_completed'||typeof item==='number'&&Number.isSafeInteger(item)&&item>=0)result[key]=item;
  }
  const complete=own(value,'usage_complete'),source=own(value,'result_source');
  if(typeof complete==='boolean')result.usageComplete=complete;
  if(typeof source==='string'&&(SOURCES as readonly string[]).includes(source))result.cacheSource=source;
  return result;
}
/** Batch diagnostics belong to the envelope, never to each item or cached translation. */
export function translationDiagnosticsFromResponse(value:unknown):Record<string,unknown>|undefined {
  return projectTranslationDiagnostics(own(value,'diagnostics'))??projectTranslationDiagnostics(own(own(value,'detail'),'diagnostics'));
}
