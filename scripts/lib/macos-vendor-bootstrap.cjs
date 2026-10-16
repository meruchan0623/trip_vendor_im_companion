'use strict';
const path = require('node:path');
const {fileURLToPath} = require('node:url');
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
module.exports = {patchRelaunch};
// Node-only tests can import the adapter without loading Electron or vendor application code.
if (process.versions.electron && process.type === 'browser') {
  const {app} = require('electron');
  patchRelaunch(app);
  const config = require('./companion-vendor-original-main.json');
  if (!config || typeof config.main !== 'string' || !config.main || path.isAbsolute(config.main) || config.main.split(/[\\/]/).includes('..')) {
    throw new Error('INVALID_VENDOR_ORIGINAL_MAIN');
  }
  require(path.resolve(__dirname, config.main));
}
