import type { StandaloneAPI, StandaloneState } from "../shared/companion-api";
import type { PanelTarget } from "../shared/workbench";
import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
export type Perform = (action: () => Promise<unknown>) => Promise<void>;
export interface BaseProps {
  api: StandaloneAPI;
  state: StandaloneState;
  busy: boolean;
  perform: Perform;
}
interface TranslationProps extends BaseProps {
  language: PanelTarget;
  setLanguage: Dispatch<SetStateAction<PanelTarget>>;
  canTranslate: boolean;
  canReplace: boolean;
  canCopy: boolean;
}
const languages: [PanelTarget, string][] = [
  ["en", "English"],
  ["ja", "日本語"],
  ["ko", "한국어"],
  ["th", "ไทย"],
  ["vi", "Tiếng Việt"],
  ["id", "Indonesia"],
  ["ms", "Bahasa Melayu"],
  ["es", "Español"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["ru", "Русский"],
  ["ar", "العربية"],
  ["zh-TW", "繁體中文"],
  ["pt", "Português"],
  ["it", "Italiano"],
];
const phases = {
  idle: "等待原草稿",
  reading: "读取中",
  translating: "翻译中",
  ready: "可替换",
  stale: "原草稿已改变",
  failed: "操作未完成",
  replaced: "已替换原草稿，请在客户端确认后发送",
  waiting: "停止输入 1.5 秒后自动翻译",
  replacing: "正在替换原草稿…",
};
function ShortcutHint({ state, canReplace }: { state: StandaloneState; canReplace: boolean }) {
  const enabled = state.shortcutEnabled !== false;
  const explanation = !enabled ? "快捷键已关闭" : canReplace ? "在原回复框按下即可替换" : "等待当前草稿的可替换译文";
  return <p className="shortcut-hint" role="note"><kbd>macOS ⌘+⌥+Enter</kbd><kbd>Windows Ctrl+Alt+Enter</kbd><span>{explanation}；仅替换，不发送</span></p>;
}
export function ComposerToolbar({
  api,
  state,
  busy,
  perform,
  language,
  setLanguage,
  canTranslate,
  canReplace,
  canCopy,
  notice,
}: TranslationProps & { notice: string }) {
  const status =
    notice ||
    state.error ||
    (state.auth !== "ready"
      ? "请连接TSim 登录态"
      : state.composerSource === "unavailable"
        ? "请连接原文本框"
        : phases[state.phase]);
  const preview =
    state.preview && language === state.language ? state.preview : "";
  const [copiedText,setCopiedText]=useState<string|null>(null);
  const copied=state.phase==='ready'&&!!preview&&copiedText===preview;
  return (
    <main className="composer-toolbar" aria-label="回复翻译工具" title={state.shortcutEnabled === false ? "替换快捷键已关闭" : "在原回复框按 macOS ⌘+⌥+Enter / Windows Ctrl+Alt+Enter 替换当前有效译文，仅替换不发送"}>
      <section className="composer-expanded" aria-label="译文预览与操作">
        <div className="composer-options">
          <select aria-label="翻译目标语言" id="target-language" value={language} disabled={state.phase==='replacing'} onChange={event=>setLanguage(event.target.value as PanelTarget)}>
            {languages.map(([code,label])=><option key={code} value={code}>{label}</option>)}
          </select>
          <label className="auto-translate"><input type="checkbox" checked={state.autoTranslate!==false} disabled={state.phase==='replacing'} onChange={event=>void perform(()=>api.setTranslationOptions({autoTranslate:event.target.checked}))}/>自动翻译</label>
          <button className="secondary" disabled={!canTranslate} onClick={()=>void perform(()=>api.translate(language))}>{state.phase==='failed'?'重试翻译':'翻译'}</button>
          <button className="text-button" disabled={state.phase==='replacing'} onClick={()=>void perform(()=>state.translationPaused?api.resumeTranslation():api.cancelTranslation())}>{state.translationPaused?'恢复翻译':'取消翻译'}</button>
          {state.auth!=='ready'&&<button className="text-button" onClick={()=>void perform(()=>api.openLogin())}>打开 TSim</button>}
          {state.composerSource==='unavailable'&&<button className="text-button" disabled={!state.attached} onClick={()=>void perform(()=>api.connectComposer())}>连接</button>}
        </div>
        <div className="composer-status" role="status" aria-live="polite">{copied?'已复制译文':state.translationPaused?'当前会话已暂停翻译':status}</div>
        <div className={`composer-preview ${state.phase==='stale'?'stale':''}`} aria-label="译文全文" title={preview?`${status}\n${preview}`:status} dir="auto">{preview||'输入回复后，译文会显示在这里'}</div>
        <div className="composer-actions">
          <button className="secondary" disabled={!canCopy} onClick={()=>void perform(async()=>{await api.copyTranslation();setCopiedText(preview);})}>复制译文</button>
          <button className="primary" disabled={!canReplace} onClick={()=>void perform(()=>api.replaceDraft())}>{state.phase==='replacing'?'替换中…':'替换原文'}</button>
        </div>
        <ShortcutHint state={state} canReplace={canReplace} />
      </section>
      <div className="composer-anchor" style={{height:state.messageSurface?.toolbarRect?.height??28,flexBasis:state.messageSurface?.toolbarRect?.height??28}}>
        <span className="composer-anchor-status">{state.phase==='replaced'?'已替换原文':state.translationPaused?'翻译已暂停':'回复翻译'}</span>
        <button className="composer-compact-action" onClick={()=>void perform(()=>api.openTranslation())}>预览</button>
        <button className="composer-compact-action" disabled={state.phase==='replacing'||(!state.translationPaused&&!canTranslate)} onClick={()=>void perform(()=>state.translationPaused?api.resumeTranslation():api.translate(language))}>{state.translationPaused?'恢复':'翻译'}</button>
        <button className="composer-settings" aria-label="打开助手设置" title="翻译与账户设置" onClick={()=>void perform(()=>api.openSettings())}>设置</button>
      </div>
    </main>
  );
}

export function TranslationPanel({
  api,
  state,
  busy,
  perform,
  language,
  setLanguage,
  canTranslate,
  canReplace,
  canCopy,
}: TranslationProps) {
  return (
    <>
      <div className="section-intro">
        <span className="eyebrow">OUTBOUND / 回复</span>
        <span
          className={`phase ${state.phase === "ready" || state.phase === "replaced" ? "ready" : ""}`}
          role="status"
          aria-live="polite"
        >
          {phases[state.phase]}
        </span>
      </div>
      <section className="draft-card" aria-labelledby="draft-heading">
        <div className="card-heading">
          <h1 id="draft-heading">原文本框草稿</h1>
          <button
            className="text-button"
            disabled={!api || !state.attached || busy}
            onClick={() => api && void perform(() => api.readDraft())}
          >
            读取草稿
          </button>
        </div>
        <textarea
          aria-label="原文本框草稿"
          value={state.draft?.text ?? ""}
          readOnly
          placeholder="在客户端回复框输入中文，再读取草稿"
        />
        <div className="card-foot">
          {state.draft?.text.length ?? 0} 字
          <span>
            {state.composerSource === "unavailable"
              ? "尚未连接文本框"
              : "已连接原文本框"}
          </span>
        </div>
      </section>
      <div className="translation-direction">
        <span className="direction-line" />
        <label htmlFor="target-language">译为</label>
        <select
          id="target-language"
          value={language}
          disabled={state.phase === "replacing"}
          onChange={(event) => setLanguage(event.target.value as PanelTarget)}
        >
          {languages.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
        <button
          className="secondary"
          disabled={!canTranslate}
          onClick={() => api && void perform(() => api.translate(language))}
        >
          {state.phase === "translating" ? "翻译中…" : "翻译草稿"}
        </button>
      </div>
      <section className="preview-card" aria-labelledby="preview-heading">
        <div className="card-heading">
          <h2 id="preview-heading">译文预览</h2>
          <span>
            {languages.find(([code]) => code === state.language)?.[1]}
          </span>
        </div>
        <div
          className={`preview-text ${state.phase === "stale" ? "stale" : ""}`}
        >
          {state.preview ? (
            <p dir="auto">{state.preview}</p>
          ) : (
            <div className="empty-preview">
              <span className="translation-mark" aria-hidden="true">
                文 / A
              </span>
              <span>译文会出现在这里</span>
              <small>确认后替换回原文本框</small>
            </div>
          )}
        </div>
        <button
          className="primary replace-button"
          disabled={!canReplace}
          onClick={() => api && void perform(() => api.replaceDraft())}
        >
          {state.phase === "replaced" ? "已替换原文本框" : "替换原文本框"}
          <span aria-hidden="true">→</span>
        </button>
      </section>
      <div className="button-row"><label className="auto-translate"><input type="checkbox" checked={state.autoTranslate!==false} onChange={event=>void perform(()=>api.setTranslationOptions({autoTranslate:event.target.checked}))}/>自动翻译</label><button disabled={state.phase==='replacing'} onClick={()=>void perform(()=>state.translationPaused?api.resumeTranslation():api.cancelTranslation())}>{state.translationPaused?'恢复翻译':'取消翻译'}</button><button disabled={!canCopy} onClick={()=>void perform(()=>api.copyTranslation())}>复制译文</button></div>
      <ShortcutHint state={state} canReplace={canReplace} />
      <p className="hint workflow-note">替换后，请在客户端确认并发送。</p>
      {state.composerSource === "unavailable" && (
        <button
          className="secondary full-width"
          disabled={!api || busy || !state.attached}
          onClick={() => api && void perform(() => api.connectComposer())}
        >
          连接既有客户端文本框
        </button>
      )}
    </>
  );
}
export function SettingsPanel({ api, state, busy, perform }: BaseProps) {
  return (
    <>
      <section className="settings-section client-status" aria-label="客户端连接">
        <div className="account-row">
          <span>商家客户端</span>
          <strong>{state.attached ? "已连接" : "自动连接中"}</strong>
        </div>
        <p className="hint">{state.attached ? "翻译与订单查询显示在原客户端客服页面内。" : "打开商家客户端后，助手会自动连接。"}</p>
        {state.error && <p className="hint" role="status">{state.error}</p>}
        {api?.canStartClient && (!state.attached || state.composerSource === "unavailable") && (
          <button className="secondary full-width" disabled={!api || busy} onClick={() => api && void perform(() => api.startClient())}>启动商家客户端</button>
        )}
        {state.attached && state.composerSource === "unavailable" && (
          <>
            <button className="text-button" disabled={!api || busy} onClick={() => api && void perform(() => api.connectComposer())}>连接既有客户端文本框</button>
            <p className="hint">{api?.canStartClient ? "若仍无法连接，请先退出当前客户端，再用助手启动客户端。" : "若仍无法连接，请退出商家客户端，再从商家客户端原入口重新打开，助手会自动连接。"}</p>
          </>
        )}
      </section>
      <section className="settings-section" aria-label="翻译设置">
        <label className="auto-translate">
          <input type="checkbox" checked={state.autoTranslate !== false} disabled={!api || state.phase === "replacing"} onChange={event => void perform(() => api.setTranslationOptions({autoTranslate:event.target.checked}))} />
          自动翻译回复草稿
        </label>
        <label className="shortcut-setting">
          <input type="checkbox" checked={state.shortcutEnabled !== false} disabled={!api || state.phase === "replacing"} onChange={event => void perform(() => api.setTranslationOptions({shortcutEnabled:event.target.checked}))} />
          启用替换快捷键（macOS ⌘+⌥+Enter / Windows Ctrl+Alt+Enter）
        </label>
        <p className="hint">在原回复框内使用，仅替换当前有效译文，不发送消息。</p>
      </section>
      <section className="settings-section" aria-label="账户设置">
        <div className="account-row">
          <span>TSim 登录态</span>
          <strong>{state.auth === "ready" ? "已登录" : state.auth === "connecting" ? "正在恢复…" : state.auth === "failed" ? "恢复失败" : "未登录"}</strong>
        </div>
        {state.auth === "ready" && <p className="account-scope">{state.accountScope}</p>}
        <div className="button-row">
          <button className="secondary" disabled={!api || busy} onClick={() => api && void perform(() => api.openLogin())}>打开浏览器 TSim_CS</button>
          {state.auth === "ready" && <button className="text-button" disabled={!api || busy} onClick={() => api && void perform(() => api.logout())}>断开助手会话</button>}
        </div>
        <p className="hint">自动复用本机 Edge / Chrome 的 TSim_CS 登录，无需在助手重复输入密码。断开仅停止助手复用，不退出浏览器账号；点击打开后可重新连接。</p>
      </section>
    </>
  );
}
