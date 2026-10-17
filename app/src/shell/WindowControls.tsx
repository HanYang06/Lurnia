// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 自绘的三个窗口按钮：最小化 / 最大化-还原 / 关闭。
 *
 * 之所以要自己画，是因为 `tauri.conf.json` 的 `app.windows[0]` 把 `decorations` 关掉了
 * —— 系统标题栏连同它右上角的三个按钮一起消失，这是把 logo、搜索、账户位与窗口按钮
 * 收进同一条顶栏（照 VS Code 的形态）的前提。**代价是这三个动作从此归前端负责**，
 * 少画一个就等于窗口关不掉。
 *
 * 两条约束决定了这个文件的样子：
 *
 * 1. **不在 Tauri 宿主里就返回 `null`。** 浏览器预览（`pnpm dev`）与 jsdom 里没有
 *    `__TAURI_INTERNALS__`，渲染出来的按钮点了不会有任何反应 —— 摆一排点不动的按钮
 *    比不摆更糟。判据就是 Tauri v2 注入的那个全局对象，没有别的探测手段。
 * 2. **图标画在这个文件里，不进 [icons.tsx](icons.tsx)。** 那批是导航图标（20px、
 *    圆头线条），这三个是窗口控制（16px 方框、直角），尺寸与视觉都不是一类东西；
 *    混在一起会让「改导航图标」和「改窗口按钮」互相绊住。
 *
 * 尺寸按 ui.md §7.3 第 5 条：32×32 的方钮、16px 的图标 —— 最低要求是 24×24，
 * 但这三个按钮天天用，不该卡在最低要求上（同 §3.1 里「+」与收起钮的处理）。
 * 焦点环由 [base.css](../styles/base.css) 全局提供，这里不写 `outline: none`。
 */

import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import "./WindowControls.css";

/**
 * Tauri v2 注入到页面的宿主对象。这里只声明**判断宿主存在**所需的那一点形状：
 * 写成 `Record` 而不是列全字段，是为了不把 `@tauri-apps/api` 的内部类型搬进来 ——
 * 一旦上游改了 `invoke` 的签名，这里不该跟着红。
 */
type TauriInternals = Record<string, unknown>;

/**
 * `Window` 是内建的 DOM 接口，按仓库既有的写法用**声明合并**补一个字段，
 * 而不是给全局对象换一个类型（换类型会顺手改掉整个 `window` 的形状）。
 * 用 `interface` 也是声明合并的要求，这里的 `consistent-type-definitions` 是有意豁免的。
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

/**
 * 是否跑在 Tauri 宿主里。`typeof window === "undefined"` 是给 SSR / 构建期用的：
 * 那种环境下 `window` 这个标识符本身不存在，直接读会抛 ReferenceError。
 */
function isTauriHost(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.2}
      viewBox="0 0 16 16"
      width="16"
    >
      {children}
    </svg>
  );
}

/** 最小化：一条横线。 */
function MinimizeIcon() {
  return (
    <Glyph>
      <path d="M3.5 8h9" />
    </Glyph>
  );
}

/** 最大化：一个方框。 */
function MaximizeIcon() {
  return (
    <Glyph>
      <rect height="9" width="9" x="3.5" y="3.5" />
    </Glyph>
  );
}

/** 还原：两个错开的方框。 */
function RestoreIcon() {
  return (
    <Glyph>
      <rect height="7.5" width="7.5" x="5.5" y="3.5" />
      <path d="M10.5 11h-5V6" />
    </Glyph>
  );
}

/** 关闭：一个叉。 */
function CloseIcon() {
  return (
    <Glyph>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Glyph>
  );
}

/**
 * 三个窗口按钮。**不在 Tauri 宿主里时返回 `null`**（浏览器预览不该出现一堆点不动的
 * 按钮）。最大化按钮的图标随窗口状态在「最大化 / 还原」之间切换。
 */
export function WindowControls(): ReactElement | null {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauriHost()) return undefined;

    const current = getCurrentWindow();
    let alive = true;

    // 初始化读一次：挂载时窗口可能已经是最大化的（比如上一次会话留下的状态），
    // 不读的话图标会一直停在「最大化」，点一下反而切回还原。
    void current.isMaximized().then((value) => {
      if (alive) setMaximized(value);
    });

    // 窗口状态只能从事件里得知：用户双击标题栏、Win+↑、拖到屏幕上缘都会改变它。
    const unlisten = current.onResized(() => {
      void current.isMaximized().then((value) => {
        if (alive) setMaximized(value);
      });
    });

    // 卸载后不能再 setState：`onResized` 的解除是异步的，回来的那一刻组件可能已经没了。
    return () => {
      alive = false;
      void unlisten.then((off) => {
        off();
      });
    };
  }, []);

  if (!isTauriHost()) return null;

  const current = getCurrentWindow();

  return (
    <div className="lr-windowctl">
      <button
        aria-label="最小化"
        className="lr-windowctl__button"
        onClick={() => {
          void current.minimize();
        }}
        title="最小化"
        type="button"
      >
        <MinimizeIcon />
      </button>
      <button
        aria-label={maximized ? "还原" : "最大化"}
        className="lr-windowctl__button"
        onClick={() => {
          void current.toggleMaximize();
        }}
        title={maximized ? "还原" : "最大化"}
        type="button"
      >
        {maximized ? <RestoreIcon /> : <MaximizeIcon />}
      </button>
      <button
        aria-label="关闭"
        className="lr-windowctl__button lr-windowctl__button--close"
        onClick={() => {
          void current.close();
        }}
        title="关闭"
        type="button"
      >
        <CloseIcon />
      </button>
    </div>
  );
}
