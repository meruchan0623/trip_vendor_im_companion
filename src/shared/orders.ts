import type { OrderCandidate } from './types';
/** Only explicit labels produce candidates. Arbitrary digit scans cannot establish order identity. */
export function parseOrderCandidates(text: string): OrderCandidate[] {
  const candidates: OrderCandidate[] = [];
  const seen = new Set<string>();
  const normalized = text.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  const pattern = /(TSim订单号|供应商订单号|订单号|订单ID|order\s*(?:number|no\.?|id)|EICCID|ICCID)\s*[:：#]?\s*([A-Za-z0-9]+(?:[- ][0-9]+)*)/gi;
  for (const match of normalized.matchAll(pattern)) {
    const label = match[1]!;
    const fragment = match[2]!.trim();
    const identifier = fragment.replace(/[ -]/g, '');
    if (!/^[A-Za-z0-9]{3,64}$/.test(identifier)) continue;
    const identifierType = /^eiccid$/i.test(label) ? 'eiccid' : /^iccid$/i.test(label) ? 'iccid' : 'order_number';
    const key = `${identifierType}:${identifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const originalFragment = text.slice(match.index!, match.index! + match[0].length);
    candidates.push({ id: key, identifier, identifierType, source: 'labeled_text', originalFragment, label,
      confidence: /TSim|供应商|ICCID/i.test(label) ? 'medium' : 'low', normalized: originalFragment !== match[0] || fragment !== identifier,
      requiresConfirmation: true });
  }
  return candidates;
}
