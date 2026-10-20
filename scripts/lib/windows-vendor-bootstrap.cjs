'use strict';
// Runs before the unchanged vendor main. No business API or vendor content is read here; the
// only renderer access is a DOM-only startup placeholder drawn in our own isolated world.
const path = require('node:path');
// Progress stages the helper may report. Anything else on the pipe is ignored.
const HELPER_STAGES = new Set(['host-ready', 'start', 'files-verified', 'transport-ready', 'target-found', 'page-verified', 'native-ready', 'panel-mounted', 'failed']);
const LOADING_STEPS = {
  launching: [1, '启动助手进程'],
  'host-ready': [2, '等待客服窗口就绪'],
  start: [3, '校验客户端文件'],
  'files-verified': [4, '建立安全连接'],
  'transport-ready': [5, '定位客服页面'],
  'target-found': [6, '校验页面完整性'],
  'page-verified': [7, '挂载翻译面板'],
  'native-ready': [7, '挂载翻译面板'],
};
const LOADING_TOTAL = 7;
// Electron reserves 0 (main) and 999 (preload isolation); this world holds only the placeholder.
const LOADING_WORLD_ID = 7301;
const MAX_PROGRESS_LINE = 256;
function loadingView(stage) {
  const step = LOADING_STEPS[stage];
  if (step) return {tone: 'busy', title: '翻译助手加载中', label: step[1], step: step[0], total: LOADING_TOTAL};
  if (stage === 'failed') return {tone: 'warn', title: '翻译助手连接失败', label: '稍后自动重试', step: 0, total: LOADING_TOTAL};
  if (stage === 'exited') return {tone: 'bad', title: '翻译助手未运行', label: '请完全退出并重新打开客户端', step: 0, total: LOADING_TOTAL};
  return {tone: 'hidden', title: '', label: '', step: 0, total: LOADING_TOTAL};
}
/**
 * Serialized into the vendor document's isolated world. Self-contained: it may use only its
 * arguments and DOM globals. It sits exactly where the outbound panel will attach and yields
 * as soon as that panel exists, so the composer does not jump when loading finishes.
 */
function companionLoadingIndicator(view, doc) {
  doc = doc || document;
  const win = doc.defaultView, KEY = '__tsimCompanionLoading';
  let ui = win[KEY];
  if (view.tone === 'hidden') {
    if (ui) { ui.observer.disconnect(); win.clearTimeout(ui.pending); win.clearInterval(ui.clock); ui.host.remove(); delete win[KEY]; }
    return;
  }
  if (!ui) {
    const host = doc.createElement('div');
    host.id = 'tsim-companion-loading'; host.setAttribute('data-tsim-owned', '1'); host.setAttribute('role', 'status'); host.setAttribute('aria-live', 'polite');
    const root = host.attachShadow({mode: 'closed'});
    root.innerHTML = '<style>:host{all:initial;display:block;width:100%;box-sizing:border-box;font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI","Microsoft YaHei",sans-serif;color:#1d2433}'
      + '*{box-sizing:border-box}.bar{position:relative;container-type:inline-size;display:flex;align-items:center;gap:8px;height:36px;padding:0 12px;background:#f6f7fa;border-top:1px solid #e3e7ee;overflow:hidden}'
      + '.mark{width:14px;height:14px;flex:none;border-radius:50%;border:2px solid #d5dbf6;border-top-color:#3a5bd9;animation:spin .8s linear infinite}'
      + '.title{font-weight:600;font-size:12.5px;white-space:nowrap}.label{font-size:12px;color:#4b5568;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}'
      + '.step{font-size:11px;line-height:16px;padding:0 5px;border-radius:4px;background:#eef1fd;color:#3a5bd9;font-weight:600;font-variant-numeric:tabular-nums;flex:none}'
      + '.spacer{flex:1}.elapsed{font-size:11.5px;color:#8a93a6;white-space:nowrap;font-variant-numeric:tabular-nums}'
      + '.track{position:absolute;left:0;right:0;bottom:0;height:2px;background:#e3e7ee}.fill{display:block;height:100%;width:0;background:#3a5bd9;transition:width .4s ease}'
      + '.close{all:unset;cursor:pointer;width:22px;height:22px;display:grid;place-items:center;border-radius:6px;color:#8a93a6;font-size:15px;flex:none}.close:hover{background:#eceff4;color:#1d2433}'
      + '.close:focus-visible{outline:2px solid #3a5bd9;outline-offset:1px}'
      + '[data-tone="warn"] .mark{border:0;width:8px;height:8px;margin:0 3px;background:#b26a00;animation:pulse 1.2s infinite}[data-tone="warn"] .title{color:#b26a00}'
      + '[data-tone="bad"] .mark{border:0;width:8px;height:8px;margin:0 3px;background:#c2382f;animation:none}[data-tone="bad"] .title{color:#c2382f}'
      + '[data-tone="warn"] .track,[data-tone="bad"] .track{display:none}'
      + '@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{50%{opacity:.25}}'
      + '@container (max-width:420px){.elapsed{display:none}}@media (prefers-reduced-motion:reduce){.mark{animation:none}.fill{transition:none}}'
      + '[hidden]{display:none!important}</style>'
      + '<div class="bar"><span class="mark" aria-hidden="true"></span><span class="title"></span><span class="label"></span><span class="step"></span>'
      + '<span class="spacer"></span><span class="elapsed"></span><button class="close" type="button" title="关闭提示" aria-label="关闭提示">×</button>'
      + '<span class="track" aria-hidden="true"><span class="fill"></span></span></div>';
    const part = name => root.querySelector('.' + name);
    ui = win[KEY] = {host, view, bar: part('bar'), title: part('title'), label: part('label'), step: part('step'), elapsed: part('elapsed'), close: part('close'), fill: part('fill'), shownAt: 0, dismissed: '', pending: undefined, clock: undefined, observer: undefined};
    // Clicks stay inside the placeholder, like the outbound panel's own containment.
    for (const type of ['click', 'mousedown', 'pointerdown', 'keydown']) host.addEventListener(type, event => event.stopPropagation());
    ui.close.addEventListener('click', () => { ui.dismissed = ui.view.title + ui.view.label; ui.sync(); });
    const tick = () => {
      const seconds = Math.floor((Date.now() - ui.shownAt) / 1000);
      ui.elapsed.textContent = ui.view.tone === 'busy' && seconds >= 3 ? '已等待 ' + seconds + ' 秒' : '';
    };
    ui.sync = () => {
      const area = doc.querySelector('.im_detail.inform-con > .chat_area'), input = area && area.querySelector('.chat_area-input');
      const show = !ui.dismissed && !doc.getElementById('tsim-outbound-panel') && !!input && !!input.parentNode;
      if (!show) { if (ui.host.isConnected) ui.host.remove(); win.clearInterval(ui.clock); ui.clock = undefined; ui.shownAt = 0; return; }
      if (ui.host.parentNode !== input.parentNode || ui.host.nextSibling !== input) input.parentNode.insertBefore(ui.host, input);
      if (!ui.shownAt) ui.shownAt = Date.now();
      if (ui.clock === undefined) ui.clock = win.setInterval(tick, 1000);
      tick();
    };
    // The vendor re-renders the chat area freely; follow it with a short debounce.
    ui.observer = new win.MutationObserver(mutations => {
      if (mutations.every(mutation => [...mutation.addedNodes, ...mutation.removedNodes].every(node => node === ui.host) && mutation.addedNodes.length + mutation.removedNodes.length > 0)) return;
      if (ui.pending === undefined) ui.pending = win.setTimeout(() => { ui.pending = undefined; ui.sync(); }, 100);
    });
    ui.observer.observe(doc.documentElement, {childList: true, subtree: true});
  }
  const key = view.title + view.label;
  if (ui.dismissed && ui.dismissed !== key) ui.dismissed = '';
  ui.view = view;
  ui.bar.dataset.tone = view.tone;
  ui.title.textContent = view.title;
  ui.label.textContent = view.label;
  ui.step.textContent = view.step ? view.step + '/' + view.total : '';
  ui.step.hidden = !view.step;
  ui.close.hidden = view.tone !== 'bad';
  ui.fill.style.width = view.step ? Math.round(view.step / view.total * 100) + '%' : '0';
  ui.host.setAttribute('aria-label', view.title + '：' + view.label);
  ui.sync();
}
function installBootstrap({app, spawn, createServer = require('node:net').createServer, randomBytes = require('node:crypto').randomBytes, execPath = process.execPath, pid = process.pid, argv = process.argv}) {
  // The vendor disables site-isolation trials and webSecurity. Without an
  // explicit isolated process, its renderer can read a sandboxed login iframe
  // and Chromium 118 omits Origin on its fetches. Force isolation before the
  // original main runs; this takes precedence over disabling isolation trials.
  app.commandLine.appendSwitch('site-per-process');
  // Port 0 lets the OS allocate a free, non-reserved port atomically. Random
  // guesses can land inside Windows excluded ranges or collide with a listener.
  const port = 0;
  // Electron initializes its DevTools server after executing the main entry.
  app.commandLine.removeSwitch('remote-debugging-port');
  app.commandLine.removeSwitch('remote-debugging-address');
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', String(port));
  let child, childRunning = false, quitting = false, stage = 'launching';
  // A helper is alive while our child runs or any helper holds a progress connection:
  // a running helper can adopt this vendor while our own child exits on its instance lock.
  const sockets = new Set();
  const helperGone = () => { if (!childRunning && sockets.size === 0) setStage('exited'); };
  // Startup progress: the helper reports fixed stage names over a private pipe;
  // the vendor document shows them where the outbound panel will appear.
  const documents = new Set();
  const paint = contents => {
    try {
      if (contents.isDestroyed() || !/^file:/i.test(contents.getURL())) return;
      const code = `(${companionLoadingIndicator.toString()})(${JSON.stringify(loadingView(stage))})`;
      Promise.resolve(contents.executeJavaScriptInIsolatedWorld(LOADING_WORLD_ID, [{code}])).catch(() => {});
    } catch { /* Progress display must never affect the official client. */ }
  };
  const setStage = next => {
    if (next === stage || quitting) return;
    stage = next;
    for (const contents of documents) paint(contents);
  };
  app.on('web-contents-created', (_event, contents) => {
    documents.add(contents);
    contents.on('dom-ready', () => paint(contents));
    contents.once('destroyed', () => documents.delete(contents));
  });
  const progressPipe = `\\\\.\\pipe\\tsim-companion-progress-${pid}-${randomBytes(16).toString('hex')}`;
  let progress;
  try {
    progress = createServer(socket => {
      let buffered = '';
      sockets.add(socket);
      socket.once('close', () => { sockets.delete(socket); helperGone(); });
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      socket.on('data', chunk => {
        buffered += chunk;
        let index;
        while ((index = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, index);buffered = buffered.slice(index + 1);
          try { const value = JSON.parse(line); if (value && Object.keys(value).length === 1 && HELPER_STAGES.has(value.stage)) setStage(value.stage); } catch { /* Ignore malformed progress. */ }
        }
        if (buffered.length > MAX_PROGRESS_LINE) socket.destroy();
      });
    });
    progress.on('error', () => { progress = undefined; setStage('hidden'); });
    progress.listen(progressPipe);
    progress.unref?.();
  } catch { progress = undefined; stage = 'hidden'; }
  app.once('before-quit', () => { quitting = true; });
  app.once('will-quit', () => { try { child?.kill(); } catch { /* Owner watch also handles crashes. */ } try { progress?.close(); } catch { /* Already closed. */ } });
  app.whenReady().then(() => {
    // A rejected second vendor instance calls app.quit() in its original main.
    if (quitting) return;
    const executable = path.join(path.dirname(execPath), 'resources', 'TripVendorCompanion', '旅游商家助手.exe');
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ASAR;
    delete env.NODE_OPTIONS;
    // Windows PowerShell must construct its own classic module search path.
    // Inheriting PowerShell 7's PSModulePath can make Get-Acl/CIM modules unloadable.
    delete env.PSModulePath;
    // The helper discovers the sole listener owned by this exact process, then
    // performs its usual full identity/loopback/handshake checks before HTTP/CDP.
    child = spawn(executable, [`--vendor-owner=${pid}`, '--vendor-debug-port=auto', ...(progress ? [`--vendor-progress=${progressPipe}`] : [])], {shell:false, windowsHide:true, stdio:'ignore', env});
    childRunning = true;
    child.on('error', () => { childRunning = false; helperGone(); /* Failure must not prevent the official client from running. */ });
    child.on('exit', () => { childRunning = false; helperGone(); });
  }).catch(() => {});
  return {port, progressPipe: progress ? progressPipe : undefined, stage: () => stage};
}
module.exports = {installBootstrap, companionLoadingIndicator, loadingView, LOADING_WORLD_ID};
if (process.versions.electron && process.type === 'browser') {
  const {app} = require('electron');
  installBootstrap({app, spawn:require('node:child_process').spawn});
  const config = require('./companion-vendor-original-main.json');
  if (!config || typeof config.main !== 'string' || !config.main || path.isAbsolute(config.main) || config.main.split(/[\\/]/).includes('..')) throw new Error('INVALID_VENDOR_ORIGINAL_MAIN');
  require(path.resolve(__dirname, config.main));
}
