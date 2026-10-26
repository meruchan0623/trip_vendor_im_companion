import type {OutboundWaitBounds} from './outbound-wait-controller';
/** Profile settings are optional and never part of the authentication identity. */
export function parseOutboundWaitBounds(value:unknown):OutboundWaitBounds|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const v=value as Record<string,unknown>;
  if(typeof v.enabled!=='boolean'||!Number.isInteger(v.min_ms)||!Number.isInteger(v.max_ms)||Number(v.min_ms)<100||Number(v.min_ms)>Number(v.max_ms)||Number(v.max_ms)>3000)return null;
  return{enabled:v.enabled,minMs:Number(v.min_ms),maxMs:Number(v.max_ms)};
}
