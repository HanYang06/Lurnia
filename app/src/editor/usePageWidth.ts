// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 纸的宽度（ui.md §4.6 第 3 条）：拖拽边缘无级调整，存 `localStorage`。
 *
 * 三件事分开写，是因为它们的失效方式完全不同：
 *
 * 1. **钳位**（`clampWidth`）—— 纯函数，单独测。上下限不是随便定的：400px 以下一行
 *    放不下 20 个汉字，880px 以上一行 45 个汉字，回扫会丢行。
 * 2. **存取**（`readWidth` / `writeWidth`）—— `localStorage` 会抛（隐私模式、配额满），
 *    所以都包一层：读不到就用默认值，写不进去就当没这回事，**不能让拖拽把界面搞崩**。
 * 3. **拖拽本身** —— 用 `setPointerCapture` 而不是往 `window` 上挂监听：指针离开元素
 *    （拖到纸里面、拖出窗口）之后事件仍然回来，松手一定收得到。
 *
 * 默认 560px ≈ 58ch（16px 中文约 9.6px 一个字符），与 §3.1 的版心一致；拖过之后
 * 存的是像素值，不再跟着字号走 —— 用户拖的是**这段距离**，不是「多少个字」。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

/** 存纸宽用的键。与 `lurnia.theme` 同一族命名。 */
export const PAGE_WIDTH_KEY = "lurnia.page.width";

/** 下限：再窄一行放不下 20 个汉字（含两端内边距）。 */
export const PAGE_WIDTH_MIN = 400;
/** 上限：再宽一行 45 个汉字以上，中文回扫会丢行（§4.6）。 */
export const PAGE_WIDTH_MAX = 880;
/** 默认 ≈ 58ch，与 §3.1 的版心一致。 */
export const PAGE_WIDTH_DEFAULT = 560;
/** 方向键一次挪多少（与间距梯子同源：24）。 */
export const PAGE_WIDTH_STEP = 24;

/** 把任意输入钳进 [MIN, MAX]；非数字一律回默认值（存坏了也不该让纸变成 0 宽）。 */
export function clampWidth(value: number): number {
  if (!Number.isFinite(value)) {
    return PAGE_WIDTH_DEFAULT;
  }
  return Math.round(Math.min(PAGE_WIDTH_MAX, Math.max(PAGE_WIDTH_MIN, value)));
}

export type GripEdge = "start" | "end";

export type PageWidth = {
  width: number;
  /** 指针按下：记住起点，后续偏移都相对它算。 */
  onPointerDown: (edge: GripEdge) => (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  /** 方向键：**跟着抓取带走**，不是跟着数值走（左边那条按左键 = 变宽）。 */
  onKeyDown: (edge: GripEdge) => (event: KeyboardEvent<HTMLElement>) => void;
};

function storage(): Storage | null {
  try {
    return (globalThis as unknown as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function readWidth(): number {
  const raw = storage()?.getItem(PAGE_WIDTH_KEY) ?? null;
  if (raw === null) {
    return PAGE_WIDTH_DEFAULT;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? clampWidth(value) : PAGE_WIDTH_DEFAULT;
}

export function writeWidth(width: number): void {
  try {
    storage()?.setItem(PAGE_WIDTH_KEY, String(width));
  } catch {
    // 存不进去就算了：拖拽本身照常工作，下次打开回到默认宽度。
  }
}

export function usePageWidth(): PageWidth {
  const [width, setWidth] = useState<number>(readWidth);
  const dragging = useRef<{
    edge: GripEdge;
    startX: number;
    startWidth: number;
  } | null>(null);

  useEffect(() => {
    writeWidth(width);
  }, [width]);

  const onPointerDown = useCallback(
    (edge: GripEdge) => (event: PointerEvent<HTMLElement>) => {
      event.preventDefault();
      // 捕获指针：拖出元素/拖出窗口之后事件仍然回到这一条抓取带上。
      event.currentTarget.setPointerCapture(event.pointerId);
      dragging.current = { edge, startX: event.clientX, startWidth: width };
    },
    [width],
  );

  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    const current = dragging.current;
    if (current === null) {
      return;
    }
    const delta = event.clientX - current.startX;
    // 右边那条往右拖 = 变宽；左边那条往左拖 = 变宽。
    setWidth(
      clampWidth(current.startWidth + (current.edge === "end" ? delta : -delta)),
    );
  }, []);

  const onPointerUp = useCallback((event: PointerEvent<HTMLElement>) => {
    dragging.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const onKeyDown = useCallback(
    (edge: GripEdge) => (event: KeyboardEvent<HTMLElement>) => {
      const wider = PAGE_WIDTH_STEP;
      switch (event.key) {
        case "ArrowLeft":
        case "ArrowRight": {
          const sign = event.key === "ArrowRight" ? 1 : -1;
          const towardWider = edge === "end" ? sign : -sign;
          setWidth((current) => clampWidth(current + towardWider * wider));
          event.preventDefault();
          return;
        }
        case "Home":
          setWidth(PAGE_WIDTH_MIN);
          event.preventDefault();
          return;
        case "End":
          setWidth(PAGE_WIDTH_MAX);
          event.preventDefault();
          return;
        case "Enter":
          // 回车复位 —— 与「双击标签页恢复默认」同一类动作。
          setWidth(PAGE_WIDTH_DEFAULT);
          event.preventDefault();
          return;
        default:
          return;
      }
    },
    [],
  );

  // 卸载时清掉拖拽状态：半路换文档不该留下一个「还在拖」的引用。
  useEffect(
    () => () => {
      dragging.current = null;
    },
    [],
  );

  return { width, onPointerDown, onPointerMove, onPointerUp, onKeyDown };
}
