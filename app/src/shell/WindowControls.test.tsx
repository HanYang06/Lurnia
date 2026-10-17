// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 自绘窗口按钮的验收测试。
 *
 * 两件事必须被钉住，因为它们在真机上不会立刻暴露：
 *
 * 1. **不在 Tauri 宿主里就什么都不渲染。** `pnpm dev` 的浏览器预览与 jsdom 都没有
 *    Tauri，那时摆出来的三个按钮点了不会有反应 —— 一条静默的坏路径。所以第一条测试
 *    用 `renderToStaticMarkup`（服务端渲染，不碰 DOM）断言标记里没有按钮。
 * 2. **三个动作接到三个不同的方法上。** 最小化 / 最大化 / 关闭在界面上挨着，接错一个
 *    会「点了最大化结果窗口关了」，所以这里逐个点、逐个断言，包括最大化按钮在
 *    「最大化 / 还原」两种状态下的 `aria-label`。
 *
 * `@tauri-apps/api/window` 整个被替掉：真模块的 `getCurrentWindow()` 会去读
 * `__TAURI_INTERNALS__.metadata.currentWindow.label`，在 jsdom 里没有那段元数据。
 * 替身因此只提供这个组件真正会碰的五个方法。
 */

// React 的 act() 需要一个显式标志，否则每个用例都会往控制台打一条
// 「The current testing environment is not configured to support act(...)」。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/** 替身的形状：组件只碰这五个方法，多一个都不需要。 */
type WindowStub = {
  minimize: ReturnType<typeof vi.fn>;
  toggleMaximize: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  isMaximized: ReturnType<typeof vi.fn>;
  onResized: ReturnType<typeof vi.fn>;
};

const host = vi.hoisted(() => ({ current: {} as WindowStub }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => host.current,
}));

const { WindowControls } = await import("./WindowControls");

/** 一次全新的替身，每个方法都解析成「没最大化、监听立即解除」。 */
function freshWindow(): WindowStub {
  return {
    minimize: vi.fn(() => Promise.resolve()),
    toggleMaximize: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    isMaximized: vi.fn(() => Promise.resolve(false)),
    onResized: vi.fn(() => Promise.resolve(() => undefined)),
  };
}

/**
 * 判断宿主的那个全局对象。**故意不是完整替身**：这个组件只用它回答「我在不在 Tauri 里」
 * 这一个问题（见 WindowControls.tsx 的 `isTauriHost`），把 `invoke` 之类也塞进来只会
 * 让测试看起来在用 IPC。
 */
function hostStub(): { invoke: () => Promise<void> } {
  return { invoke: () => Promise.resolve() };
}

function entersTauri(): void {
  host.current = freshWindow();
  window.__TAURI_INTERNALS__ = hostStub();
}

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

function buttons(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>("button")];
}

function buttonNamed(root: HTMLElement, label: string): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (found === null) throw new Error(`没有 aria-label 为「${label}」的按钮`);
  return found;
}

/**
 * `act` 的异步包装。**目的是把排队的 promise 冲干净**：挂载时要等 `isMaximized()` 与
 * `onResized()` 回来，`renderToStaticMarkup` 那种同步渲染看不到它们的结果。
 *
 * 包一层而不是直接写 `act(async () => { ... })`，是因为回调里没有 `await` 的话
 * `@typescript-eslint/require-await` 会报「异步函数没有 await」；`await flush()` 是
 * 这次刷新真正等的那一下，不是为过检而加的。
 */
async function actAsync(run: () => void): Promise<void> {
  await act(async () => {
    run();
    await flush();
  });
}

/** 真正把微任务队列让出去的那一下。 */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** 挂载、点击、卸载：`createRoot` 之外没有测试库，手写这一小段。 */
async function withMountedControls(run: (root: HTMLElement) => void) {
  const container = document.createElement("div");
  document.body.append(container);
  const reactRoot = createRoot(container);
  await actAsync(() => {
    reactRoot.render(<WindowControls />);
  });
  try {
    run(container);
  } finally {
    await actAsync(() => {
      reactRoot.unmount();
    });
    container.remove();
  }
}

describe("不在 Tauri 宿主里", () => {
  it("一个按钮都不渲染（浏览器预览里点不动的按钮比没有更糟）", () => {
    // jsdom 默认没有 __TAURI_INTERNALS__，这里不摆替身。
    const html = renderToStaticMarkup(<WindowControls />);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("aria-label");
  });
});

describe("在 Tauri 宿主里", () => {
  it("三个按钮都带 aria-label 与 title", async () => {
    entersTauri();
    await withMountedControls((root) => {
      const labels = buttons(root).map((element) => element.getAttribute("aria-label"));
      expect(labels).toEqual(["最小化", "最大化", "关闭"]);
      for (const element of buttons(root)) {
        expect(element.getAttribute("title")).toBe(element.getAttribute("aria-label"));
      }
    });
  });

  it("点最小化 → minimize()", async () => {
    entersTauri();
    await withMountedControls((root) => {
      buttonNamed(root, "最小化").click();
      expect(host.current.minimize).toHaveBeenCalledTimes(1);
      expect(host.current.toggleMaximize).not.toHaveBeenCalled();
      expect(host.current.close).not.toHaveBeenCalled();
    });
  });

  it("点关闭 → close()", async () => {
    entersTauri();
    await withMountedControls((root) => {
      buttonNamed(root, "关闭").click();
      expect(host.current.close).toHaveBeenCalledTimes(1);
      expect(host.current.minimize).not.toHaveBeenCalled();
    });
  });

  it("点最大化 → toggleMaximize()", async () => {
    entersTauri();
    await withMountedControls((root) => {
      buttonNamed(root, "最大化").click();
      expect(host.current.toggleMaximize).toHaveBeenCalledTimes(1);
      expect(host.current.close).not.toHaveBeenCalled();
    });
  });

  it("初始化时读一次窗口状态，已经在最大化就显示「还原」", async () => {
    entersTauri();
    host.current.isMaximized.mockResolvedValue(true);
    await withMountedControls((root) => {
      expect(host.current.isMaximized).toHaveBeenCalled();
      const element = buttonNamed(root, "还原");
      element.click();
      expect(host.current.toggleMaximize).toHaveBeenCalledTimes(1);
    });
  });
});
