// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { StandaloneAPI, StandaloneState } from "../shared/companion-api";
let root: Root,
  container: HTMLDivElement,
  api: StandaloneAPI,
  listener: (state: StandaloneState) => void;
const connected: StandaloneState = {
  attached: true,
  targetInstanceId: "client-1",
  nativeStatus: "已绑定",
  auth: "ready",
  accountScope: "agent",
  draft: { text: "请检查设备设置", canReplace: true },
  preview: null,
  phase: "idle",
  error: null,
  language: "en",
  browserOpen: false,
  composerSource: "verified-editor",
  orderEntries: [],
  orderViewport: null,
};
function button(text: string) {
  const found = [...container.querySelectorAll("button")].find(
    (item) =>
      item.textContent?.trim() === text ||
      item.getAttribute("aria-label") === text,
  );
  if (!found) throw Error(`missing ${text}`);
  return found;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function update(state: Partial<StandaloneState>) {
  await act(async () => listener({ ...connected, ...state }));
}
async function change(id: string, value: string) {
  const element = container.querySelector<HTMLInputElement | HTMLSelectElement>(
    `#${id}`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
async function renderRoute(hash: string) {
  await act(async () => root.unmount());
  window.location.hash = hash;
  root = createRoot(container);
  await act(async () => root.render(<App />));
}
beforeEach(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  window.location.hash = "#translation";
  container = document.createElement("div");
  document.body.append(container);
  api = {
    getState: vi.fn(async () => connected),
    onState: vi.fn((cb) => {
      listener = cb;
      return () => {};
    }),
    listWindows: vi.fn(async () => [
      {
        targetInstanceId: "client-1",
        title: "客户服务",
        processName: "client",
      },
    ]),
    bindWindow: vi.fn(async () => {}),
    unbindWindow: vi.fn(async () => {}),
    readDraft: vi.fn(async () => {}),
    translate: vi.fn(async () => {}),
    setTranslationOptions:vi.fn(async()=>{}),
    copyTranslation:vi.fn(async()=>{}),
    openTranslation:vi.fn(async()=>{}),
    cancelTranslation:vi.fn(async()=>{}),
    resumeTranslation:vi.fn(async()=>{}),
    replaceDraft: vi.fn(async () => {}),
    openLogin: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    openOrder: vi.fn(async () => {}),
    closeOrder: vi.fn(async () => {}),
    connectComposer: vi.fn(async () => {}),
    startClient: vi.fn(async () => {}),
    minimize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    openSettings: vi.fn(async () => {}),
  };
  window.standalone = api;
  root = createRoot(container);
  await act(async () => root.render(<App />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.location.hash = "";
});
describe("独立跟随草稿工具", () => {
  it("默认启用原回复框快捷键，可从设置关闭并同步所有窗口状态", async () => {
    await renderRoute("#settings");
    const toggle = container.querySelector<HTMLInputElement>('.shortcut-setting input')!;
    expect(toggle.checked).toBe(true);
    await act(async () => toggle.click());
    expect(api.setTranslationOptions).toHaveBeenCalledWith({shortcutEnabled:false});
    await update({shortcutEnabled:false});
    expect(toggle.checked).toBe(false);
    await update({shortcutEnabled:false, phase:'replacing'});
    expect(toggle.disabled).toBe(true);
  });
  it("在替换旁提示快捷键可用性，渲染页面按键不会绕过原编辑器校验", async () => {
    await act(async () => root.unmount());
    window.location.hash = '#composer';
    root = createRoot(container);
    await act(async () => root.render(<App />));
    expect(container.querySelector('.shortcut-hint')?.textContent).toContain('等待当前草稿的可替换译文');
    await update({phase:'ready',preview:'Current translation'});
    expect(container.querySelector('.shortcut-hint')?.textContent).toContain('在原回复框按下即可替换');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',ctrlKey:true,altKey:true,bubbles:true})));
    expect(api.replaceDraft).not.toHaveBeenCalled();
    await update({phase:'ready',preview:'Current translation',shortcutEnabled:false});
    expect(container.querySelector('.shortcut-hint')?.textContent).toContain('快捷键已关闭');
    expect(button('替换原文').disabled).toBe(false);
    await click('替换原文');
    expect(api.replaceDraft).toHaveBeenCalledOnce();
    await update({phase:'stale',preview:'Old translation'});
    expect(button('替换原文').disabled).toBe(true);
    expect(container.querySelector('.shortcut-hint')?.textContent).toContain('仅替换，不发送');
  });
  it("读取原文本框并请求翻译，不提供手动回复或发送能力", async () => {
    expect(container.querySelector("textarea")!.readOnly).toBe(true);
    expect(container.querySelector("textarea")!.value).toBe(
      connected.draft!.text,
    );
    await click("读取草稿");
    expect(api.readDraft).toHaveBeenCalledOnce();
    await click("翻译草稿");
    expect(api.translate).toHaveBeenCalledWith("en");
    expect(
      [...container.querySelectorAll("button")].some((item) =>
        /发送/.test(item.textContent ?? ""),
      ),
    ).toBe(false);
  });
  it("仅可写且当前有效译文才能替换", async () => {
    expect(button("替换原文本框→").disabled).toBe(true);
    await update({ phase: "ready", preview: "Please check your settings." });
    expect(button("替换原文本框→").disabled).toBe(false);
    await click("替换原文本框→");
    expect(api.replaceDraft).toHaveBeenCalledOnce();
    await update({ phase: "stale", preview: "Old translation" });
    expect(button("替换原文本框→").disabled).toBe(true);
    await update({
      phase: "ready",
      preview: "Preview",
      draft: { text: "原文", canReplace: false },
    });
    expect(button("替换原文本框→").disabled).toBe(true);
  });
  it("切换目标语种后不能替换上一语种译文", async () => {
    await update({ phase: "ready", preview: "Preview" });
    await change("target-language", "ja");
    expect(button("替换原文本框→").disabled).toBe(true);
    await click("翻译草稿");
    expect(api.translate).toHaveBeenCalledWith("ja");
  });
  it("草稿事件保留待翻译语种选择", async () => {
    await change("target-language", "ko");
    await update({ draft: { text: "新的草稿", canReplace: true } });
    expect(
      container.querySelector<HTMLSelectElement>("#target-language")!.value,
    ).toBe("ko");
    await click("翻译草稿");
    expect(api.translate).toHaveBeenCalledWith("ko");
  });
  it("退出或解绑立即禁止替换", async () => {
    await update({ phase: "ready", preview: "Preview", auth: "needs_login" });
    expect(button("替换原文本框→").disabled).toBe(true);
    expect(button("翻译草稿").disabled).toBe(true);
    await update({ phase: "ready", preview: "Preview", attached: false });
    expect(button("替换原文本框→").disabled).toBe(true);
  });
  it("设置自动连接客户端，不提供窗口选择或绑定操作", async () => {
    await renderRoute("#settings");
    expect(container.querySelector("nav, select, textarea")).toBeNull();
    expect(container.textContent).toContain("翻译与订单查询显示在原客户端客服页面内");
    expect(container.textContent).not.toMatch(/选择窗口|刷新窗口|绑定窗口|解除|读取草稿/);
    expect(api.listWindows).not.toHaveBeenCalled();
    expect(api.bindWindow).not.toHaveBeenCalled();
    expect(api.unbindWindow).not.toHaveBeenCalled();
    const toggle = container.querySelector<HTMLInputElement>('.auto-translate input')!;
    await act(async () => toggle.click());
    expect(api.setTranslationOptions).toHaveBeenCalledWith({autoTranslate:false});
  });
  it("复用浏览器会话，断开入口不提供独立账号密码表单", async () => {
    await renderRoute("#settings");
    expect(container.textContent).toContain("浏览器 TSim 会话");
    expect(container.textContent).toContain("断开连接不会退出网站登录");
    expect(container.querySelector('input[type="password"], input[name="username"]')).toBeNull();
    await click("打开浏览器 TSim 页面");
    expect(api.openLogin).toHaveBeenCalledOnce();
    await click("断开浏览器会话");
    expect(api.logout).toHaveBeenCalledOnce();
  });
  it("未绑定时可启动客户端，已绑定不显示启动动作", async () => {
    await renderRoute("#settings");
    expect(
      [...container.querySelectorAll("button")].some(
        (item) => item.textContent === "启动商家客户端",
      ),
    ).toBe(false);
    await update({ attached: false, targetInstanceId: null });
    await click("启动商家客户端");
    expect(api.startClient).toHaveBeenCalledOnce();
  });
  it("客户端已连接但无法读取文本框时保留重试及重新启动入口", async () => {
    await renderRoute("#settings");
    await update({composerSource:"unavailable"});
    expect(container.textContent).toContain("先退出当前客户端");
    expect(container.querySelector("select")).toBeNull();
    await click("连接既有客户端文本框");
    expect(api.connectComposer).toHaveBeenCalledOnce();
    await click("启动商家客户端");
    expect(api.startClient).toHaveBeenCalledOnce();
  });
  it("订单覆盖查询交给系统浏览器并清除跨账户标识", async () => {
    await renderRoute("#orders");
    const input = container.querySelector<HTMLInputElement>('input[aria-label="订单标识"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "TS123456");
      input.dispatchEvent(new Event("input", {bubbles:true}));
    });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true})));
    expect(api.openOrder).toHaveBeenCalledWith("TS123456", "order_number");
    await update({ accountScope: "other" });
    expect(input.value).toBe("");
  });
  it("同页面 hash 渲染精简订单覆盖窗", async () => {
    await act(async () => root.unmount());
    window.location.hash = "#orders";
    root = createRoot(container);
    await act(async () => root.render(<App />));
    expect(container.querySelector(".order-overlay")).not.toBeNull();
    expect(container.querySelector("nav")).toBeNull();
  });
  it("订单浮层关闭入口独立于被隐藏的消息工具", async () => {
    await act(async () => root.unmount());
    window.location.hash = "#browser-controls";
    root = createRoot(container);
    await act(async () => root.render(<App />));
    expect(container.querySelector(".browser-controls")).not.toBeNull();
    expect(container.textContent).toContain("收起查询");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector("nav, input, textarea")).toBeNull();
    await click("收起订单浮层");
    expect(api.closeOrder).toHaveBeenCalledOnce();
  });
  it("设置入口只渲染紧凑设置，关闭按钮收起设置", async () => {
    await renderRoute("#settings");
    expect(container.querySelector('.settings-window')).not.toBeNull();
    expect(container.querySelector('nav, textarea, .preview-card, .tool-footer')).toBeNull();
    await click("收起设置");
    expect(api.close).toHaveBeenCalledOnce();
  });
  it("默认入口同样只显示设置，未连接时可收起", async () => {
    await renderRoute("");
    await update({attached:false});
    expect(container.querySelector('.settings-window')).not.toBeNull();
    await click("收起设置");
    expect(api.close).toHaveBeenCalledOnce();
  });
  it("独立预览入口保留完整译文、复制与替换操作", async () => {
    expect(container.querySelector('.translation-window')).not.toBeNull();
    expect(container.querySelector('nav')).toBeNull();
    const preview = '第一行\nSecond line'.repeat(40);
    await update({phase:'ready',preview});
    expect(container.querySelector('.preview-text')?.textContent).toBe(preview);
    await click('复制译文');
    expect(api.copyTranslation).toHaveBeenCalledOnce();
    await click('关闭译文预览');
    expect(api.close).toHaveBeenCalledOnce();
  });
  it("回复框内仅渲染单行翻译工具，可翻译替换并打开设置", async () => {
    await act(async () => root.unmount());
    window.location.hash = "#composer";
    root = createRoot(container);
    await act(async () => root.render(<App />));
    expect(container.querySelector(".composer-toolbar")).not.toBeNull();
    expect(
      container.querySelector(".companion-window, nav, textarea, input:not([type=checkbox])"),
    ).toBeNull();
    expect(button("替换原文").disabled).toBe(true);
    await click("翻译");
    expect(api.translate).toHaveBeenCalledWith("en");
    await update({ phase: "ready", preview: "Please check your settings." });
    expect(
      container.querySelector(".composer-preview")?.getAttribute("title"),
    ).toContain("Please check your settings.");
    await click("替换原文");
    expect(api.replaceDraft).toHaveBeenCalledOnce();
    await change("target-language", "ja");
    expect(button("替换原文").disabled).toBe(true);
    expect(
      container.querySelector(".composer-preview")?.textContent,
    ).not.toContain("Please check");
    await click("打开助手设置");
    expect(api.openSettings).toHaveBeenCalledOnce();
    expect(
      [...container.querySelectorAll("button")].some((item) =>
        /发送/.test(item.textContent ?? ""),
      ),
    ).toBe(false);
  });
  it("回复框工具显示登录和连接入口，过期译文禁止替换", async () => {
    await act(async () => root.unmount());
    window.location.hash = "#composer";
    root = createRoot(container);
    await act(async () => root.render(<App />));
    await update({ auth: "needs_login", composerSource: "unavailable" });
    expect(button("翻译").disabled).toBe(true);
    await click("打开 TSim");
    await click("连接");
    expect(api.openLogin).toHaveBeenCalledOnce();
    expect(api.connectComposer).toHaveBeenCalledOnce();
    await update({ phase: "stale", preview: "Old translation" });
    expect(button("替换原文").disabled).toBe(true);
  });
  it("原订单文字覆盖按钮使用当前事件中的标识", async () => {
    await act(async () => root.unmount());
    window.location.hash = "#order-entry-0";
    vi.mocked(api.getState).mockResolvedValue({
      ...connected,
      orderEntries: [
        {
          identifier: "TS123456",
          identifierType: "order_number",
          rect: { x: 1, y: 1, width: 80, height: 16 },
        },
      ],
    });
    root = createRoot(container);
    await act(async () => root.render(<App />));
    await click("TS123456");
    expect(api.openOrder).toHaveBeenCalledWith("TS123456", "order_number");
    await update({ orderEntries: [] });
    expect(container.querySelector("button")).toBeNull();
  });
  it("请求失败只显示通用消息，不泄漏内部错误", async () => {
    vi.mocked(api.translate).mockRejectedValueOnce(Error("secret-value"));
    await click("翻译草稿");
    expect(container.textContent).toContain("操作未完成");
    expect(container.textContent).not.toContain("secret-value");
  });
  it('copies a current read-only preview through the trusted API and reports success',async()=>{
    await act(async()=>root.unmount());window.location.hash='#composer';root=createRoot(container);await act(async()=>root.render(<App/>));
    const preview='Line one\nLine two\n長い訳文'.repeat(20);await update({phase:'ready',preview,draft:{text:'原文',canReplace:false}});
    expect(container.querySelector('.composer-preview')?.textContent).toBe(preview);expect(button('替换原文').disabled).toBe(true);expect(button('复制译文').disabled).toBe(false);
    await click('复制译文');expect(api.copyTranslation).toHaveBeenCalledOnce();expect(container.textContent).toContain('已复制译文');
    await update({phase:'stale',preview});expect(button('复制译文').disabled).toBe(true);await change('target-language','ja');expect(api.setTranslationOptions).toHaveBeenCalledWith({language:'ja'});expect(container.querySelector('.composer-preview')?.textContent).not.toContain('Line one');
  });
  it('keeps language and pause controls responsive when an old provider promise never settles',async()=>{
    await act(async()=>root.unmount());window.location.hash='#composer';root=createRoot(container);await act(async()=>root.render(<App/>));
    let release!:()=>void;vi.mocked(api.translate).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));await click('翻译');await update({phase:'translating'});
    expect(container.querySelector<HTMLSelectElement>('#target-language')!.disabled).toBe(false);await change('target-language','ko');expect(api.setTranslationOptions).toHaveBeenCalledWith({language:'ko'});
    await click('取消翻译');expect(api.cancelTranslation).toHaveBeenCalledOnce();await update({phase:'idle',translationPaused:true});await click('恢复翻译');expect(api.resumeTranslation).toHaveBeenCalledOnce();
    const checkbox=container.querySelector<HTMLInputElement>('input[type=checkbox]')!;await act(async()=>checkbox.click());expect(api.setTranslationOptions).toHaveBeenCalledWith({autoTranslate:false});await act(async()=>release());
  });
  it('shows replacing status, disables duplicate writes, and preserves replacement confirmation',async()=>{
    await act(async()=>root.unmount());window.location.hash='#composer';root=createRoot(container);await act(async()=>root.render(<App/>));
    await update({phase:'replacing',preview:'Translated'});expect(button('替换中…').disabled).toBe(true);expect(button('复制译文').disabled).toBe(true);expect(container.textContent).toContain('正在替换原草稿');
    await update({phase:'replaced',preview:null});expect(container.textContent).toContain('已替换原文');expect(container.querySelector('.composer-preview')?.textContent).not.toContain('Translated');
    await click('预览');expect(api.openTranslation).toHaveBeenCalledOnce();
  });

});
