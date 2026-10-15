/** Tracks panel drafts only; it never claims to know the merchant editor's identity or revision. */
export class DraftController {
  revision = 0;
  generation = 1;
  text = '';
  composing = false;
  paused = false;
  enabled = true;
  private cancelledRevision: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly trigger: (revision: number) => void, public delayMs = 1500) {}
  update(text: string): void { this.text = text; this.revision++; this.cancelledRevision = null; this.schedule(); }
  compositionStart(): void { this.composing = true; this.clear(); }
  compositionEnd(): void { this.composing = false; this.schedule(); }
  cancel(): void { this.cancelledRevision = this.revision; this.clear(); }
  pause(): void { this.paused = true; this.clear(); }
  resume(): void { this.paused = false; this.schedule(); }
  setEnabled(enabled: boolean): void { this.enabled = enabled; this.schedule(); }
  resetContext(): void { this.generation++; this.revision++; this.text = ''; this.paused = false; this.cancelledRevision = null; this.clear(); }
  retry(): void { if (this.composing || !this.text.trim()) return; this.cancelledRevision = null; this.trigger(this.revision); }
  languageChanged(): void { this.revision++; this.cancelledRevision = null; this.schedule(); }
  dispose(): void { this.clear(); }
  private clear(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private schedule(): void {
    this.clear();
    if (!this.enabled || this.paused || this.composing || !this.text.trim() || this.cancelledRevision === this.revision) return;
    const revision = this.revision;
    this.timer = setTimeout(() => { this.timer = undefined; if (revision === this.revision) this.trigger(revision); }, this.delayMs);
  }
}
