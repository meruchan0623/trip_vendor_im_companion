import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {afterEach, describe, expect, it, vi} from 'vitest';
const {stabilizeImFirstDisplay} = createRequire(import.meta.url)('../scripts/lib/macos-vendor-bootstrap.cjs');
const root = '/Applications/Vendor.app/Contents/Resources/app.asar';
const url = (page: string) => `file://${root}.unpacked/dist/src/pages/${page}/index.html`;
class Contents extends EventEmitter {
  destroyed = false;
  invalidate = vi.fn();
  constructor(public url: string) { super(); }
  getURL() { return this.url; }
  isDestroyed() { return this.destroyed; }
}
function setup() {
  vi.useFakeTimers();
  const app = Object.assign(new EventEmitter(), {getAppPath: () => root, getPath: () => '/users/test'});
  const stop = stabilizeImFirstDisplay(app);
  const host = new Contents(url('main')), im = new Contents(url('imPlus'));
  for (const contents of [host, im]) app.emit('web-contents-created', {}, contents);
  const view = {webContents: im, getBounds: vi.fn(() => ({x: 68, y: 40, width: 1212, height: 920})), setBounds: vi.fn()};
  let views: typeof view[] = [];
  const original = vi.fn((next: typeof view | null) => { views = next ? [next] : []; });
  const win = Object.assign(new EventEmitter(), {
    webContents: host, destroyed: false, isDestroyed() { return this.destroyed; },
    setBrowserView: original, getBrowserViews: () => views,
  });
  app.emit('browser-window-created', {}, win);
  const flush = () => vi.runAllTimers();
  return {app, host, im, view, win, original, stop, flush};
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe('IM initial native surface commit', () => {
  it.each(['host-first', 'im-first', 'attach-last'])('waits for both renderers and attachment: %s', order => {
    const {host, im, view, win, original, flush} = setup();
    if (order !== 'attach-last') win.setBrowserView(view);
    (order === 'im-first' ? im : host).emit('did-finish-load'); flush();
    expect(original).toHaveBeenCalledTimes(order === 'attach-last' ? 0 : 1);
    (order === 'im-first' ? host : im).emit('did-finish-load');
    if (order === 'attach-last') win.setBrowserView(view);
    flush();
    expect(original.mock.calls.map(call => call[0])).toEqual([view, null, view]);
    expect(view.setBounds).toHaveBeenCalledWith({x: 68, y: 40, width: 1212, height: 920});
    expect(im.invalidate).toHaveBeenCalledOnce();
    host.emit('did-finish-load'); im.emit('did-finish-load'); win.emit('show'); win.emit('resize'); flush();
    expect(im.invalidate).toHaveBeenCalledOnce();
  });
  it('does not repair at dom-ready before the vendor final load/zoom handlers', () => {
    const {host, im, view, win, original, flush} = setup();
    win.setBrowserView(view); host.emit('dom-ready'); im.emit('dom-ready'); flush();
    expect(original).toHaveBeenCalledOnce();
    host.emit('did-finish-load'); flush(); expect(original).toHaveBeenCalledOnce();
    // The vendor's listener runs after ours and updates bounds before the deferred commit.
    im.on('did-finish-load', () => view.getBounds.mockReturnValue({x: 68, y: 40, width: 900, height: 600}));
    im.emit('did-finish-load'); flush();
    expect(view.setBounds).toHaveBeenCalledWith({x: 68, y: 40, width: 900, height: 600});
    expect(im.invalidate).toHaveBeenCalledOnce();
  });
  it('recommits an existing IM when the host document reloads', () => {
    const {host, im, view, win, flush} = setup();
    win.setBrowserView(view); host.emit('did-finish-load'); im.emit('did-finish-load'); flush();
    host.emit('did-start-navigation', {}, host.url, false, true);
    win.emit('show'); flush(); expect(im.invalidate).toHaveBeenCalledTimes(1);
    host.emit('did-finish-load'); flush(); expect(im.invalidate).toHaveBeenCalledTimes(2);
    host.emit('did-finish-load'); flush(); expect(im.invalidate).toHaveBeenCalledTimes(2);
  });
  it('does not steal the selected tab while IM finishes in the background', () => {
    const {host, im, view, win, original, flush} = setup();
    win.setBrowserView(view); host.emit('did-finish-load'); im.emit('did-finish-load');
    const notice = {...view, webContents: new Contents(url('notice'))};
    win.setBrowserView(notice); flush();
    expect(original.mock.calls.map(call => call[0])).toEqual([view, notice]);
    expect(im.invalidate).not.toHaveBeenCalled();
    win.setBrowserView(view); flush();
    expect(im.invalidate).toHaveBeenCalledOnce();
  });
  it.each(['https://example.com/imPlus/index.html', url('notice'), url('imPlus') + '#other'])('ignores unrelated documents: %s', document => {
    const {host, im, view, win, original, flush} = setup();
    im.url = document; win.setBrowserView(view); host.emit('did-finish-load'); im.emit('did-finish-load'); flush();
    expect(original).toHaveBeenCalledOnce();
  });
  it('recognizes the official hot-update IM path', () => {
    const {host, im, view, win, flush} = setup();
    host.url = 'file:///users/test/dist/src/pages/main/index.html';
    im.url = 'file:///users/test/dist/src/pages/imPlus/index.html';
    win.setBrowserView(view); host.emit('did-finish-load'); im.emit('did-finish-load'); flush();
    expect(im.invalidate).toHaveBeenCalledOnce();
  });
  it('leaves multiple attached views untouched', () => {
    const {host, im, view, win, original, flush} = setup();
    win.setBrowserView(view);
    win.getBrowserViews = () => [view, {...view, webContents: new Contents(url('notice'))}];
    host.emit('did-finish-load'); im.emit('did-finish-load'); flush();
    expect(original).toHaveBeenCalledOnce();
    expect(im.invalidate).not.toHaveBeenCalled();
  });
  it('does not touch a view hosted by a different shell', () => {
    const {host, im, view, win, original, flush} = setup();
    host.url = url('web'); win.setBrowserView(view); host.emit('did-finish-load'); im.emit('did-finish-load'); flush();
    expect(original).toHaveBeenCalledOnce();
  });
  it('uses the current bounds and waits for usable dimensions', () => {
    const {host, im, view, win, flush} = setup();
    view.getBounds.mockReturnValue({x: 68, y: 40, width: 0, height: 0});
    win.setBrowserView(view); host.emit('did-finish-load'); im.emit('did-finish-load'); flush();
    expect(im.invalidate).not.toHaveBeenCalled();
    view.getBounds.mockReturnValue({x: 68, y: 40, width: 900, height: 600});
    win.emit('resize'); flush();
    expect(view.setBounds).toHaveBeenCalledWith({x: 68, y: 40, width: 900, height: 600});
  });
  it('resets readiness on reload but ignores subframe and same-document navigation', () => {
    const {host, im, view, win, flush} = setup();
    win.setBrowserView(view); host.emit('did-finish-load'); im.emit('did-finish-load'); flush();
    im.emit('did-start-navigation', {}, im.url, false, false);
    im.emit('did-start-navigation', {}, im.url, true, true);
    win.emit('show'); flush(); expect(im.invalidate).toHaveBeenCalledTimes(1);
    im.emit('did-start-navigation', {}, im.url, false, true);
    win.emit('show'); flush(); expect(im.invalidate).toHaveBeenCalledTimes(1);
    im.emit('did-finish-load'); flush(); expect(im.invalidate).toHaveBeenCalledTimes(2);
  });
  it.each(['window', 'view', 'stop'])('cancels pending repair safely on %s teardown', mode => {
    const {app, host, im, view, win, original, stop, flush} = setup();
    win.setBrowserView(view); host.emit('did-finish-load'); im.emit('did-finish-load');
    if (mode === 'window') { win.destroyed = true; win.emit('closed'); }
    if (mode === 'view') { im.destroyed = true; im.emit('destroyed'); }
    if (mode === 'stop') stop();
    flush(); expect(original).toHaveBeenCalledOnce(); expect(im.invalidate).not.toHaveBeenCalled();
    stop(); expect(app.listenerCount('web-contents-created')).toBe(0);
    expect(host.listenerCount('did-finish-load')).toBe(0); expect(win.setBrowserView).toBe(original);
    expect(vi.getTimerCount()).toBe(0);
  });
});
