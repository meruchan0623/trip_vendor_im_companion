'use strict';
const path = require('node:path');
const {fileURLToPath} = require('node:url');
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
module.exports = {patchRelaunch, prioritizeImStartup};
// Node-only tests can import the adapter without loading Electron or vendor application code.
if (process.versions.electron && process.type === 'browser') {
  const {app} = require('electron');
  patchRelaunch(app);
  prioritizeImStartup(app);
  const config = require('./companion-vendor-original-main.json');
  if (!config || typeof config.main !== 'string' || !config.main || path.isAbsolute(config.main) || config.main.split(/[\\/]/).includes('..')) {
    throw new Error('INVALID_VENDOR_ORIGINAL_MAIN');
  }
  require(path.resolve(__dirname, config.main));
}
