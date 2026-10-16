import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';
const {prioritizeImStartup} = createRequire(import.meta.url)('../scripts/lib/macos-vendor-bootstrap.cjs');

const bundled = '/Applications/旅游商家.app/Contents/Resources/app.asar.unpacked/dist/src/pages/imPlus/index.html';
const updated = '/Users/test/Library/Application Support/vbk-electron/dist/src/pages/imPlus/index.html';
class Contents extends EventEmitter {
  throttling = true;
  destroyed = false;
  getBackgroundThrottling() { return this.throttling; }
  setBackgroundThrottling = vi.fn((value: boolean) => { this.throttling = value; });
  isDestroyed() { return this.destroyed; }
  navigate(url: string, main = true) { this.emit('did-start-navigation', {}, url, false, main); }
}
function setup(appPath = '/Applications/旅游商家.app/Contents/Resources/app.asar') {
  vi.useFakeTimers();
  const app = Object.assign(new EventEmitter(), {
    getAppPath: () => appPath,
    getPath: () => '/Users/test/Library/Application Support/vbk-electron',
  });
  const stop = prioritizeImStartup(app);
  const contents = new Contents();
  app.emit('web-contents-created', {}, contents);
  return {app, contents, stop};
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe('bounded local IM startup priority', () => {
  it.each([bundled, updated])('accelerates the approved document %s and restores after load grace', file => {
    const {contents} = setup();
    contents.navigate(pathToFileURL(file).href);
    expect(contents.throttling).toBe(false);
    contents.emit('did-finish-load');
    vi.advanceTimersByTime(4999);
    expect(contents.throttling).toBe(false);
    vi.advanceTimersByTime(1);
    expect(contents.throttling).toBe(true);
  });
  it.each([
    'https://example.com/dist/src/pages/imPlus/index.html',
    pathToFileURL(updated.replace('imPlus', 'notice')).href,
    pathToFileURL(updated + '.bak').href,
    pathToFileURL(updated).href + '?',
    pathToFileURL(updated).href + '#',
    pathToFileURL(updated).href.replace('file:///', 'file://localhost/'),
    pathToFileURL(updated).href.replace('file:///', 'file://server/'),
  ])('does not change other or decorated documents: %s', url => {
    const {contents} = setup();
    contents.navigate(url);
    expect(contents.setBackgroundThrottling).not.toHaveBeenCalled();
  });
  it('ignores subframe navigation and preserves an already unthrottled view', () => {
    const {contents} = setup();
    contents.navigate(pathToFileURL(updated).href, false);
    contents.throttling = false;
    contents.navigate(pathToFileURL(updated).href);
    vi.advanceTimersByTime(40000);
    expect(contents.setBackgroundThrottling).not.toHaveBeenCalled();
  });
  it('restores at the deadline even when load never finishes or finishes late', () => {
    const {contents} = setup();
    contents.navigate(pathToFileURL(updated).href);
    vi.advanceTimersByTime(29000);
    contents.emit('did-finish-load');
    vi.advanceTimersByTime(1000);
    expect(contents.throttling).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('restores immediately on navigation away, clearing both timers', () => {
    const {contents} = setup();
    contents.navigate(pathToFileURL(updated).href);
    contents.emit('did-finish-load');
    contents.navigate('https://example.com/');
    expect(contents.throttling).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('restarts the bounded window on a new approved navigation without losing original state', () => {
    const {contents} = setup();
    contents.navigate(pathToFileURL(updated).href);
    contents.emit('did-finish-load');
    vi.advanceTimersByTime(4000);
    contents.navigate(pathToFileURL(bundled).href);
    vi.advanceTimersByTime(1000);
    expect(contents.throttling).toBe(false);
    vi.advanceTimersByTime(29000);
    expect(contents.throttling).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('removes listeners and timers on destruction without calling a destroyed view', () => {
    const {contents} = setup();
    contents.navigate(pathToFileURL(updated).href);
    contents.destroyed = true;
    contents.emit('destroyed');
    expect(contents.setBackgroundThrottling).toHaveBeenCalledTimes(1);
    expect(contents.listenerCount('did-start-navigation')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('normalizes Unicode paths and allows cleanup to restore live views', () => {
    const accentedApp = '/Applications/Café.app/Contents/Resources/app.asar';
    const {app, contents, stop} = setup(accentedApp);
    contents.navigate(pathToFileURL((accentedApp + '.unpacked/dist/src/pages/imPlus/index.html').normalize('NFD')).href);
    expect(contents.throttling).toBe(false);
    stop();
    expect(contents.throttling).toBe(true);
    expect(app.listenerCount('web-contents-created')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('leaves older contents without the APIs alone', () => {
    const {app} = setup();
    const old = new EventEmitter();
    app.emit('web-contents-created', {}, old);
    expect(old.listenerCount('did-start-navigation')).toBe(0);
  });
});
