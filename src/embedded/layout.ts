export const COLLAPSED_WIDTH = 32;
export const EXPANDED_WIDTH = 320;
export const MIN_NATIVE_WIDTH = 1180;
const MARKER = 'data-tsim-embedded';

/** Reserves a sibling column. It never enters or replaces the original React tree. */
export function reserveEmbeddedLayout(document: Document, nativeRoot: HTMLElement, host: HTMLElement, onForcedCollapse: () => void) {
  const saved: { element: HTMLElement; key: string; value: string; priority: string; applied: string }[] = [];
  const set = (element: HTMLElement, key: string, value: string) => {
    const existing = saved.find(item => item.element === element && item.key === key);
    if (existing) { element.style.setProperty(key, value); existing.applied = value; return; }
    saved.push({ element, key, value: element.style.getPropertyValue(key), priority: element.style.getPropertyPriority(key), applied: value });
    element.style.setProperty(key, value);
  };
  const originalMarker = document.body.getAttribute(MARKER);
  document.body.setAttribute(MARKER, '1');
  const nativeStyle = document.createElement('style');
  nativeStyle.dataset.tsimLayout = '1';
  nativeStyle.textContent = 'body[data-tsim-embedded="1"] > #root .body-container{width:100%!important;max-width:100%!important}';
  document.head.append(nativeStyle);
  set(document.body, 'display', 'flex');
  set(document.body, 'flex-direction', 'row');
  set(document.body, 'flex-wrap', 'nowrap');
  set(nativeRoot, 'flex', '1 1 0%');
  set(nativeRoot, 'min-width', '0px');
  set(nativeRoot, 'height', '100%');
  set(host, 'flex', '0 0 auto');
  set(host, 'height', '100%');
  set(host, 'width', `${COLLAPSED_WIDTH}px`);
  let expanded = false;
  const width = () => document.documentElement.clientWidth;
  const setExpanded = (value: boolean) => {
    if (value && width() - EXPANDED_WIDTH < MIN_NATIVE_WIDTH) return false;
    expanded = value;
    set(host, 'width', `${value ? EXPANDED_WIDTH : COLLAPSED_WIDTH}px`);
    return true;
  };
  const resize = () => { if (expanded && width() - EXPANDED_WIDTH < MIN_NATIVE_WIDTH) { setExpanded(false); onForcedCollapse(); } };
  document.defaultView?.addEventListener('resize', resize);
  return {
    setExpanded,
    destroy() {
      document.defaultView?.removeEventListener('resize', resize);
      nativeStyle.remove();
      if (document.body.getAttribute(MARKER) === '1') { if (originalMarker === null) document.body.removeAttribute(MARKER); else document.body.setAttribute(MARKER, originalMarker); }
      for (const item of saved.reverse()) {
        if (item.element.style.getPropertyValue(item.key) !== item.applied) continue;
        if (item.value) item.element.style.setProperty(item.key, item.value, item.priority); else item.element.style.removeProperty(item.key);
      }
    },
  };
}
