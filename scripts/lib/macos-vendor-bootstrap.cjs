'use strict';
const path = require('node:path');
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
// Startup preference, kept identical in windows-vendor-bootstrap.cjs: each vendor main window opens
// maximized once. Only its construction title identifies it; a later restore or resize is the user's.
// No show/hide/close, BrowserView or throttling behaviour of the official window is changed.
const VENDOR_MAIN_WINDOW_TITLE = 'Main window';
function maximizeMainWindowOnOpen(app, {defer = setImmediate} = {}) {
  const created = (_event, win) => {
    let title;
    try { title = win.getTitle(); } catch { return; }
    if (title !== VENDOR_MAIN_WINDOW_TITLE) return;
    const maximize = () => {
      try {
        if (win.isDestroyed() || win.isMaximized() || win.isFullScreen() || win.isMinimized() || !win.isMaximizable() || !win.isResizable()) return;
        win.maximize();
      } catch { /* A window preference never blocks the vendor. */ }
    };
    // Run after the vendor's constructor block so its resize listener sizes the attached BrowserView.
    defer(() => {
      try {
        if (win.isDestroyed()) return;
        // maximize() also shows a hidden window; a background start waits for the vendor's own first show.
        if (win.isVisible()) maximize(); else win.once('show', maximize);
      } catch { /* Same as above. */ }
    });
  };
  app.on('browser-window-created', created);
  return () => app.removeListener('browser-window-created', created);
}
module.exports = {patchRelaunch, maximizeMainWindowOnOpen};
// Node-only tests can import the adapter without loading Electron or vendor application code.
if (process.versions.electron && process.type === 'browser') {
  const {app} = require('electron');
  patchRelaunch(app);
  maximizeMainWindowOnOpen(app);
  const config = require('./companion-vendor-original-main.json');
  if (!config || typeof config.main !== 'string' || !config.main || path.isAbsolute(config.main) || config.main.split(/[\\/]/).includes('..')) {
    throw new Error('INVALID_VENDOR_ORIGINAL_MAIN');
  }
  require(path.resolve(__dirname, config.main));
}
