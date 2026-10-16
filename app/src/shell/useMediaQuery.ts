// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 一个媒体查询的布尔值。**只在 CSS 表达不了的地方用** —— 布局本身仍然全在样式表里。
 *
 * 这里要它，是因为「检视器现在是显示着还是收着」得让读屏知道（`aria-pressed`），
 * 而窗口宽度决定默认值：宽窗口默认展开、窄窗口默认折叠成图标条。这个默认值
 * 没法只靠一个布尔属性在 CSS 里表达（同一个属性在两种宽度下含义不同）。
 *
 * 用 `useSyncExternalStore` 而不是 `useEffect` + `useState`：媒体查询本来就是外部
 * 数据源，前者的语义正好，也不会在订阅之前先渲染一帧错的。
 */

import { useCallback, useSyncExternalStore } from "react";

/** jsdom 没有实现 `matchMedia`，所以从 `unknown` 取，「可能没有」才是类型事实。 */
function queryList(query: string): MediaQueryList | null {
  const host = globalThis as unknown as {
    matchMedia?: (raw: string) => MediaQueryList;
  };
  return typeof host.matchMedia === "function" ? host.matchMedia(query) : null;
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const list = queryList(query);
      list?.addEventListener("change", onStoreChange);
      return () => {
        list?.removeEventListener("change", onStoreChange);
      };
    },
    [query],
  );

  const getSnapshot = useCallback(() => queryList(query)?.matches ?? false, [query]);

  // 服务端/无 matchMedia 时按「宽窗口」算：那是布局最完整的一侧，降级不会少东西。
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
