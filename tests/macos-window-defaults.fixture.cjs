'use strict';
// Synthetic Electron windows only: no vendor entry, account, or installed app is loaded.
const {app, BrowserWindow, screen} = require('electron');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fixtureModule = {exports: {}};
vm.runInNewContext(readFileSync(process.env.TMC_WINDOW_TEST_BOOTSTRAP, 'utf8'), {
  require, module: fixtureModule, setImmediate,
  process: {versions: {}, execPath: process.execPath, argv: process.argv},
});
app.setPath('userData', path.join(process.env.TMC_WINDOW_TEST_DIRECTORY, 'profile'));
const dispose = fixtureModule.exports.maximizeMainWindowOnOpen(app);
const createdTitles = [];
app.on('browser-window-created', (_event, win) => createdTitles.push(win.getTitle()));
const waitFor = async predicate => {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'native window state did not settle');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
const create = (options = {}) => new BrowserWindow({
  title: 'Main window', width: 800, height: 600, frame: false,
  titleBarStyle: 'hidden', titleBarOverlay: {color: 'rgba(10, 37, 76, 1)', symbolColor: '#ffffff'},
  webPreferences: {sandbox: true}, ...options,
});
const watchdog = setTimeout(() => {console.error('WINDOW_FIXTURE_TIMEOUT'); app.exit(1);}, 15000);
app.whenReady().then(async () => {
  try {
    // The development Electron app quits when its last window closes; keep the fixture alive.
    const sentinel = create({title: 'Fixture sentinel', show: false});
    const main = create();
    assert.equal(main.getTitle(), 'Main window');
    await waitFor(() => main.isMaximized());
    const area = screen.getDisplayMatching(main.getBounds()).workArea;
    const bounds = main.getBounds();
    assert.ok(Math.abs(bounds.width - area.width) <= 2 && Math.abs(bounds.height - area.height) <= 2,
      `main window does not fill work area: ${JSON.stringify({bounds, area})}`);
    main.unmaximize();
    await waitFor(() => !main.isMaximized());
    main.hide(); main.show();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(main.isMaximized(), false, 'later user restore stays restored');
    main.destroy();

    const hidden = create({show: false});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(hidden.isVisible(), false, 'background start must stay hidden');
    hidden.show();
    await waitFor(() => hidden.isMaximized());
    hidden.destroy();

    const other = create({title: 'Login window'});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(other.isMaximized(), false, 'other vendor windows retain their size');
    other.destroy();
    console.log(JSON.stringify({event: 'macos_window_defaults_ok', electron: process.versions.electron,
      createdTitles, bounds, workArea: area, checks: ['visible-main', 'hidden-first-show', 'user-restore', 'other-window']}));
    dispose(); clearTimeout(watchdog); sentinel.destroy(); app.exit(0);
  } catch (error) {
    console.error(error); clearTimeout(watchdog); app.exit(1);
  }
}).catch(error => {console.error(error); app.exit(1);});
