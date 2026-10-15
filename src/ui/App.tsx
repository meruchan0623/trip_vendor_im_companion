import { ComposerToolbar, TranslationPanel, SettingsPanel } from "./Panels";
import { useEffect, useRef, useState } from "react";
import type { StandaloneState } from "../shared/companion-api";
import type { PanelTarget } from "../shared/workbench";
const initial: StandaloneState = {
  attached: false,
  targetInstanceId: null,
  nativeStatus: "尚未绑定客户端",
  auth: "needs_login",
  accountScope: "unknown",
  draft: null,
  preview: null,
  phase: "idle",
  error: null,
  language: "en",
  browserOpen: false,
  composerSource: "unavailable",
  orderEntries: [],
  orderViewport: null,
};
type OrderType = "order_number" | "iccid" | "eiccid";
export function App() {
  const api = window.standalone,
    ordersOnly = window.location.hash === "#orders";
  const [state, setState] = useState(initial);
  const [notice, setNotice] = useState(""),
    [pending, setPending] = useState(false),
    pendingRef = useRef(false);
  const [language, setLanguage] = useState<PanelTarget>("en");
  const backendLanguage = useRef<PanelTarget>("en");
  const [identifier, setIdentifier] = useState(""),
    [identifierType, setIdentifierType] = useState<OrderType>("order_number");
  useEffect(() => {
    if (!api) {
      setNotice("请打开桌面助手以连接客户端。");
      return;
    }
    let mounted = true,
      receivedEvent = false;
    const apply = (next: StandaloneState) => {
      if (mounted) {
        setState(next);
        if (next.language !== backendLanguage.current) {
          backendLanguage.current = next.language;
          setLanguage(next.language);
        }
      }
    };
    const unsubscribe = api.onState((next) => {
      receivedEvent = true;
      apply(next);
    });
    void api
      .getState()
      .then((next) => {
        if (!receivedEvent) apply(next);
      })
      .catch(() => {
        if (mounted) setNotice("桌面连接暂不可用，请重新打开助手。");
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [api]);
  useEffect(() => {
    setIdentifier("");
  }, [state.auth, state.accountScope, state.targetInstanceId]);
  async function perform(action: () => Promise<unknown>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setNotice("");
    try {
      await action();
    } catch (error) {
      setNotice(error instanceof Error && error.message.includes("BROWSER_SPACE_TOO_SMALL")
        ? "订单查询空间不足，请先放大商家窗口，再打开订单。"
        : error instanceof Error && error.message.includes("BROWSER_MEASUREMENT_PENDING")
          ? "窗口尺寸正在更新，请稍后重新打开订单。"
        : "操作未完成，请检查连接后重试。");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  const busy =
    pending || state.phase === "reading" || state.phase === "replacing";
  const canTranslate =
    !!api &&
    state.attached &&
    state.auth === "ready" &&
    !!state.draft?.text.trim() &&
    state.composerSource !== "unavailable" &&
    !state.translationPaused && state.phase !== "translating" && !busy;
  const canCopy = !!api && state.attached && state.auth==='ready' && state.phase==='ready' && !!state.preview && language===state.language && !busy;
  const canReplace = canCopy && !!state.draft?.canReplace;
  const selectLanguage = (value: React.SetStateAction<PanelTarget>) => {
    const next = typeof value === 'function' ? value(language) : value;
    setLanguage(next);
    void translationAction(() => api.setTranslationOptions({language:next}));
  };
  // Provider requests may outlive cancellation. They never lock language/pause controls.
  async function translationAction(action: () => Promise<unknown>) {
    setNotice('');
    try { await action(); } catch { setNotice('操作未完成，请检查连接后重试。'); }
  }
  const entryMatch = /^#order-entry-(\d+)$/.exec(window.location.hash);
  if (window.location.hash === "#browser-controls")
    return (
      <main className="browser-controls">
        <span>查询窗口</span>
        <button
          aria-label="收起订单浮层"
          title="收起订单浮层"
          disabled={!api || pending}
          onClick={() => api && void perform(() => api.closeOrder())}
        >
          收起查询 <span aria-hidden="true">×</span>
        </button>
      </main>
    );
  if (entryMatch) {
    const entry = state.orderEntries[Number(entryMatch[1])];
    return (
      <main className="inline-order-entry">
        {entry && (
          <button
            disabled={!api || pending || !state.attached}
            onClick={() =>
              api &&
              void perform(() =>
                api.openOrder(entry.identifier, entry.identifierType),
              )
            }
          >
            {entry.identifier}
          </button>
        )}
      </main>
    );
  }
  if (ordersOnly)
    return (
      <main
        className="order-overlay"
        title={notice || "订单速查 · 在系统浏览器中打开"}
      >
        <form
          className="compact-order-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (api && identifier.trim() && !pending && state.attached)
              void perform(() =>
                api.openOrder(identifier.trim(), identifierType),
              );
          }}
        >
          <select
            aria-label="查询类型"
            value={identifierType}
            disabled={pending}
            onChange={(event) =>
              setIdentifierType(event.target.value as OrderType)
            }
          >
            <option value="order_number">订单号</option>
            <option value="iccid">ICCID</option>
            <option value="eiccid">eICCID</option>
          </select>
          <input
            aria-label="订单标识"
            value={identifier}
            maxLength={128}
            placeholder="订单标识"
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            onChange={(event) => setIdentifier(event.target.value)}
          />
          <button
            type="submit"
            aria-label="打开订单"
            disabled={!api || pending || !state.attached || !identifier.trim()}
          >
            ↗
          </button>
          {state.browserOpen && (
            <button
              type="button"
              aria-label="收起订单浮层"
              disabled={!api || pending}
              onClick={() => api && void perform(() => api.closeOrder())}
            >
              ×
            </button>
          )}
        </form>
      </main>
    );
  if (window.location.hash === "#composer")
    return (
      <ComposerToolbar
        api={api}
        state={state}
        busy={busy}
        perform={translationAction}
        language={language}
        setLanguage={selectLanguage}
        canTranslate={canTranslate}
        canReplace={canReplace}
        canCopy={canCopy}
        notice={notice}
      />
    );
  const settingsOnly = window.location.hash !== "#translation";
  return (
    <main className={`companion-window ${settingsOnly ? "settings-window" : "translation-window"}`}>
      <header className="titlebar">
        <div className="brand-mark">旅</div>
        <strong>{settingsOnly ? "助手设置" : "译文预览"}</strong>
        <div className="window-buttons">
          <button
            className="close-button"
            aria-label={settingsOnly ? "收起设置" : "关闭译文预览"}
            disabled={!api}
            onClick={() => api && void perform(() => api.close())}
          >×</button>
        </div>
      </header>
      <div className="panel-content">
        {(notice || state.error) && (
          <div className="notice" role="status">{notice || state.error}</div>
        )}
        {settingsOnly ? (
          <SettingsPanel api={api} state={state} busy={busy} perform={perform} />
        ) : (
          <TranslationPanel
            api={api}
            state={state}
            busy={busy}
            perform={translationAction}
            language={language}
            setLanguage={selectLanguage}
            canTranslate={canTranslate}
            canReplace={canReplace}
            canCopy={canCopy}
          />
        )}
      </div>
    </main>
  );
}
