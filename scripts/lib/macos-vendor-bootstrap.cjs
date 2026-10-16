'use strict';
const path = require('node:path');
const {fileURLToPath} = require('node:url');
/** Give only the local IM view a bounded foreground-speed startup window. */
function prioritizeImStartup(app) {
  const allowed = new Set([
    path.join(app.getAppPath() + '.unpacked', 'dist/src/pages/imPlus/index.html'),
    path.join(app.getPath('userData'), 'dist/src/pages/imPlus/index.html'),
  ].map(value => path.resolve(value).normalize('NFC')));
  const matches = value => {
    try {
      const url = new URL(value);
      const authority = /^file:\/\/([^/]*)/i.exec(value)?.[1];
      return url.protocol === 'file:' && !authority && !url.host && !url.href.includes('?') && !url.href.includes('#') &&
        allowed.has(path.resolve(fileURLToPath(url)).normalize('NFC'));
    } catch { return false; }
  };
  const cleanups = new Set();
  const created = (_event, contents) => {
    if (typeof contents.getBackgroundThrottling !== 'function' || typeof contents.setBackgroundThrottling !== 'function') return;
    let original, deadline, finished;
    const clear = () => { clearTimeout(deadline); clearTimeout(finished); deadline = finished = undefined; };
    const restore = () => {
      clear();
      if (original === undefined) return;
      const value = original;
      original = undefined;
      try { if (!contents.isDestroyed()) contents.setBackgroundThrottling(value); } catch { /* View may close during startup. */ }
    };
    const navigating = (_event, url, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return;
      restore();
      if (!matches(url)) return;
      try {
        const value = contents.getBackgroundThrottling();
        if (value !== true) return;
        original = value;
        contents.setBackgroundThrottling(false);
        deadline = setTimeout(restore, 30000);
        deadline.unref?.();
      } catch { restore(); }
    };
    const loaded = () => {
      if (original === undefined) return;
      clearTimeout(finished);
      finished = setTimeout(restore, 5000);
      finished.unref?.();
    };
    const cleanup = () => {
      restore();
      contents.removeListener('did-start-navigation', navigating);
      contents.removeListener('did-finish-load', loaded);
      contents.removeListener('destroyed', cleanup);
      cleanups.delete(cleanup);
    };
    contents.on('did-start-navigation', navigating);
    contents.on('did-finish-load', loaded);
    contents.once('destroyed', cleanup);
    cleanups.add(cleanup);
  };
  app.on('web-contents-created', created);
  return () => {
    app.removeListener('web-contents-created', created);
    for (const cleanup of cleanups) cleanup();
  };
}
/** Commit the initial IM native surface after BOTH documents finish loading.
 * The vendor sets zoom during did-finish-load. A dom-ready reattachment is too
 * early: subsequent load/zoom work can leave the macOS native surface blank.
 * Defer until all load listeners finish, retaining selection and current bounds.
 */
function stabilizeImFirstDisplay(app) {
  const roots = [app.getAppPath() + '.unpacked', app.getPath('userData')];
  const localPage = (url, page) => {
    try {
      const parsed = new URL(url);
      if (!/^file:\/\/\//.test(url) || parsed.host || parsed.search || parsed.hash) return false;
      const file = path.resolve(fileURLToPath(parsed)).normalize('NFC');
      return roots.some(root => file === path.resolve(root, `dist/src/pages/${page}/index.html`).normalize('NFC'));
    } catch { return false; }
  };
  const ready = new WeakMap();
  const repaired = new WeakMap();
  const windows = new Set();
  const cleanups = new Set();
  const created = (_event, contents) => {
    const loaded = () => {
      if (!ready.has(contents)) ready.set(contents, {});
      for (const schedule of windows) schedule();
    };
    const navigating = (_event, _url, inPlace, main) => {
      if (main && !inPlace) { ready.delete(contents); repaired.delete(contents); }
    };
    const cleanup = () => {
      ready.delete(contents);
      contents.removeListener('did-finish-load', loaded);
      contents.removeListener('did-start-navigation', navigating);
      contents.removeListener('destroyed', cleanup);
      cleanups.delete(cleanup);
    };
    contents.on('did-finish-load', loaded);
    contents.on('did-start-navigation', navigating);
    contents.once('destroyed', cleanup);
    cleanups.add(cleanup);
  };
  const windowCreated = (_event, win) => {
    if (typeof win.setBrowserView !== 'function' || typeof win.getBrowserViews !== 'function') return;
    const original = win.setBrowserView;
    let pending;
    const schedule = () => {
      if (pending) return;
      pending = setImmediate(() => {
        pending = undefined;
        try {
          if (win.isDestroyed() || win.webContents.isDestroyed() || !ready.has(win.webContents) ||
              !localPage(win.webContents.getURL(), 'main')) return;
          const views = win.getBrowserViews();
          if (views.length !== 1) return;
          const view = views[0], contents = view.webContents;
          if (contents.isDestroyed() || !ready.has(contents) || repaired.get(contents) === ready.get(win.webContents) ||
              !localPage(contents.getURL(), 'imPlus')) return;
          const bounds = view.getBounds();
          if (bounds.width <= 0 || bounds.height <= 0) return;
          // Native attachment is synchronous; no delayed callback can steal a tab.
          original.call(win, null);
          try { original.call(win, view); }
          finally {
            // Preserve the selected view even if the platform attachment throws.
            if (!win.isDestroyed() && !contents.isDestroyed() && win.getBrowserViews().length === 0) original.call(win, view);
          }
          view.setBounds(bounds);
          contents.invalidate?.();
          repaired.set(contents, ready.get(win.webContents));
        } catch { /* Closing/navigation must never interrupt the vendor shell. */ }
      });
      pending.unref?.();
    };
    function attach(view) {
      const result = original.call(this, view);
      schedule();
      return result;
    }
    win.setBrowserView = attach;
    const cleanup = () => {
      clearImmediate(pending);
      windows.delete(schedule);
      if (win.setBrowserView === attach) win.setBrowserView = original;
      win.removeListener('closed', cleanup);
      win.removeListener('show', schedule);
      win.removeListener('resize', schedule);
      cleanups.delete(cleanup);
    };
    windows.add(schedule);
    win.on('show', schedule);
    win.on('resize', schedule);
    win.once('closed', cleanup);
    cleanups.add(cleanup);
  };
  app.on('web-contents-created', created);
  app.on('browser-window-created', windowCreated);
  return () => {
    app.removeListener('web-contents-created', created);
    app.removeListener('browser-window-created', windowCreated);
    for (const cleanup of cleanups) cleanup();
  };
}
/** Keep the vendor's default/self relaunches on the installed launcher path. */
function patchRelaunch(app, {execPath = process.execPath, argv = process.argv.slice(1), launcherPath = path.join(path.dirname(execPath), 'TripVendorLauncher')} = {}) {
  const original = app.relaunch;
  app.relaunch = function relaunch(options) {
    const requested = options?.execPath;
    if (requested === undefined || (typeof requested === 'string' && path.resolve(requested) === path.resolve(execPath))) {
      const args = (options?.args ?? argv).filter(argument => !/^--?remote-debugging(?:-|$)/.test(argument));
      return original.call(this, {...options, args, execPath: launcherPath});
    }
    return original.call(this, options);
  };
  return () => { app.relaunch = original; };
}
module.exports = {patchRelaunch, prioritizeImStartup, stabilizeImFirstDisplay};
// Node-only tests can import the adapter without loading Electron or vendor application code.
if (process.versions.electron && process.type === 'browser') {
  const {app} = require('electron');
  patchRelaunch(app);
  prioritizeImStartup(app);
  stabilizeImFirstDisplay(app);
  const config = require('./companion-vendor-original-main.json');
  if (!config || typeof config.main !== 'string' || !config.main || path.isAbsolute(config.main) || config.main.split(/[\\/]/).includes('..')) {
    throw new Error('INVALID_VENDOR_ORIGINAL_MAIN');
  }
  require(path.resolve(__dirname, config.main));
}
