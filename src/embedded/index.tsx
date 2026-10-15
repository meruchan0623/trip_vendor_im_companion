import { createRoot } from 'react-dom/client';
import type { CompanionAPI } from '../shared/types';
import { EmbeddedApp, type RuntimeWorkbenchAPI } from './App';
import { reserveEmbeddedLayout } from './layout';
import { embeddedStyles } from './styles';

export interface EmbeddedInstance {
  host: HTMLElement;
  expanded(): boolean;
  setExpanded(value: boolean): boolean;
  heartbeat(sequence: number): void;
  detach(): Promise<void>;
  destroy(): Promise<void>;
}

/** Explicit factory only. Importing the artifact never mounts or alters a document.
 * The product runtime must verify its target before invoking this factory. */
export function mountEmbedded(options: { document?: Document; api?: CompanionAPI; workbench?: RuntimeWorkbenchAPI; leaseMs?: number } = {}): EmbeddedInstance {
  const document = options.document ?? window.document;
  const view = document.defaultView;
  const nativeRoot = document.getElementById('root');
  if (!view || !nativeRoot) throw new Error('Native root was not found');
  if (document.getElementById('tsim-embedded-companion')) throw new Error('Companion is already mounted');
  const leaseMs = options.leaseMs ?? 10_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 30_000) throw new Error('Invalid lease timeout');
  const host = document.createElement('aside');
  host.id = 'tsim-embedded-companion'; host.setAttribute('aria-label', '内嵌客服助手');
  // Composed events must not reach native document-level send shortcuts.
  // Bubble phase preserves React handlers, IME and the input's default behavior.
  const isolatedEvents = ['keydown', 'keyup', 'keypress', 'compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'paste', 'copy', 'cut'] as const;
  const contain = (event: Event) => event.stopPropagation();
  for (const type of isolatedEvents) host.addEventListener(type, contain);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = embeddedStyles;
  const mount = document.createElement('div'); mount.style.height = '100%'; mount.style.position = 'relative';
  shadow.append(style, mount);
  const root = createRoot(mount);
  let open = false, disposed = false, lastSequence = 0, lastHeartbeat = Date.now();
  let cleanup: (() => Promise<void>) | undefined;
  let detachment: Promise<void> | undefined;
  let layout: ReturnType<typeof reserveEmbeddedLayout> | undefined;
  let watchdog: number | undefined;
  const registerCleanup = (callback: () => Promise<void>) => { cleanup = callback; return () => { if (cleanup === callback) cleanup = undefined; }; };
  const setExpanded = (value: boolean) => { if (disposed || !layout?.setExpanded(value)) return false; open = value; render(); return true; };
  function render() { root.render(<EmbeddedApp workbench={options.workbench} expanded={open} isExpanded={() => !disposed && open} onExpanded={setExpanded} registerCleanup={registerCleanup} onDetach={() => { void detach(); }} />); }
  function detach(): Promise<void> {
    if (detachment) return detachment;
    disposed = true; open = false;
    if (watchdog !== undefined) view!.clearInterval(watchdog);
    view!.removeEventListener('pagehide', pagehide);
    // Start cancellation before unmount; restore locally without waiting for an
    // offline service, while the returned promise records bounded cleanup.
    const external = cleanup?.() ?? Promise.allSettled(options.api ? [Promise.resolve().then(() => options.api!.resetQuery()), Promise.resolve().then(() => options.api!.hideHost())] : []).then(() => undefined);
    try { root.unmount(); } finally {
      for (const type of isolatedEvents) host.removeEventListener(type, contain);
      layout?.destroy(); host.remove();
    }
    let timeout: number | undefined;
    const bounded = new Promise<void>(resolve => { timeout = view!.setTimeout(resolve, 500); });
    detachment = Promise.race([external, bounded]).then(() => undefined).finally(() => { if (timeout !== undefined) view!.clearTimeout(timeout); });
    return detachment;
  }
  const pagehide = () => { void detach(); };
  try {
    // Arm fail-safe cleanup before changing original layout.
    watchdog = view.setInterval(() => { if (Date.now() - lastHeartbeat >= leaseMs) void detach(); }, Math.min(1000, leaseMs));
    view.addEventListener('pagehide', pagehide);
    document.body.append(host);
    layout = reserveEmbeddedLayout(document, nativeRoot, host, () => { open = false; render(); });
    render();
  } catch (error) { void detach(); throw error; }
  return { host, expanded: () => !disposed && open, setExpanded, detach, destroy: detach, heartbeat(sequence) {
    if (disposed) throw new Error('LEASE_ENDED');
    if (!Number.isSafeInteger(sequence) || sequence <= lastSequence) throw new Error('STALE_HEARTBEAT');
    lastSequence = sequence; lastHeartbeat = Date.now();
  } };
}
