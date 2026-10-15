import type { TranslationRequest, TranslationResult } from './types';
/** Memory only: account/session logout clears every entry. Never persisted to diagnostics. */
export class TranslationCache {
  private entries = new Map<string, { expires: number; value: TranslationResult }>();
  constructor(private capacity = 200, private ttlMs = 30 * 60_000) {}
  key(request: TranslationRequest, sourceHash: string): string {
    const c = request.context;
    return JSON.stringify([c.accountScope,c.platformAccountScope,c.conversationKey,c.authGeneration,request.purpose,sourceHash,request.targetLanguage,request.sourceLanguage,request.configurationVersion]);
  }
  get(key: string): TranslationResult | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.expires <= Date.now()) { this.entries.delete(key); return undefined; }
    this.entries.delete(key); this.entries.set(key, entry); return structuredClone(entry.value);
  }
  set(key: string, value: TranslationResult): void {
    this.entries.delete(key);
    this.entries.set(key, { expires: Date.now() + this.ttlMs, value: structuredClone(value) });
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }
  clear(): number { const count = this.entries.size; this.entries.clear(); return count; }
}
