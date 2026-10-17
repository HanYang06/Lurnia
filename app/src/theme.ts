// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 主题切换骨架（路线 096 / 097 的机制部分）。口径：[docs/design/ui.md](../../../docs/design/ui.md) §五。
 *
 * ui.md §五 的三条要求，逐条对应这里的实现：
 *
 * 1. **跟随系统为默认，允许手动锁定深/浅/跟随三态** —— 存 `localStorage`，读不到就是 `system`；
 * 2. **切换是瞬时的** —— 只改 `<html data-theme>`，不做全屏渐变过渡；
 * 3. **组件不得出现 `if (darkMode)`** —— 这个模块把方案写进 `data-theme`，颜色全交给
 *    [tokens.css](styles/tokens.css) 的两个块。调用方拿到的是 `Scheme`，不是「要不要走深色」。
 *
 * 这里不碰任何颜色，也不碰主题包（098 未实现）：`data-pack` 是另一条属性，本模块不管。
 */

/** 用户的选择。三态，缺一不可 —— 只有 bool 的话「跟随系统」就没地方放了。 */
export type ThemeChoice = "system" | "dark" | "light";

/** 实际生效的方案。界面只认这个，不认「用户选了什么」。 */
export type Scheme = "dark" | "light";

/** 供界面遍历渲染用的三态顺序：跟随系统在最前，因为它是默认。 */
export const THEME_CHOICES = [
  "system",
  "dark",
  "light",
] as const satisfies readonly ThemeChoice[];

/** 系统偏好查询。写成常量是为了测试与宿主用同一个字符串。 */
export const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * 存储键。**导出是为了钉住 `index.html` 里那份内联的防闪脚本** ——
 * 那段脚本没法 import 本模块，只能复制一条规则；`theme.test.ts` 会去核对
 * 它用的键与查询串跟这里一致。
 */
export const THEME_STORAGE_KEY = "lurnia.theme";

/**
 * jsdom 没有实现 `matchMedia`（真机上一定有）。这里从 `unknown` 取，
 * 于是「可能没有」是类型上成立的事实，不需要靠 eslint-disable 压掉告警。
 */
function systemQuery(): MediaQueryList | null {
  const host = globalThis as unknown as { matchMedia?: (q: string) => MediaQueryList };
  return typeof host.matchMedia === "function" ? host.matchMedia(DARK_QUERY) : null;
}

/** 存储可能在隐私模式/沙箱下抛异常，读不到就当没有，不把启动搞崩。 */
function storage(): Storage | null {
  try {
    return (globalThis as unknown as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "system" || value === "dark" || value === "light";
}

/** 纯函数：选择 + 系统偏好 → 生效方案。这是本模块唯一值得单测的逻辑。 */
export function resolveScheme(choice: ThemeChoice, prefersDark: boolean): Scheme {
  if (choice === "system") {
    return prefersDark ? "dark" : "light";
  }
  return choice;
}

export function systemPrefersDark(): boolean {
  return systemQuery()?.matches ?? false;
}

/** 读回上次的选择；没存过、存坏了、读不了，一律回落到 `system`。 */
export function storedChoice(): ThemeChoice {
  const raw = storage()?.getItem(THEME_STORAGE_KEY) ?? null;
  return isThemeChoice(raw) ? raw : "system";
}

function persist(choice: ThemeChoice): void {
  try {
    storage()?.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // 存不下不影响这次切换生效，只是下次启动回落到跟随系统。
  }
}

let choice: ThemeChoice = "system";
let query: MediaQueryList | null = null;

function apply(): Scheme {
  const scheme = resolveScheme(choice, query?.matches ?? false);
  // tokens.css 的 `[data-theme="light"]` 覆盖块就是靠这个属性生效。
  document.documentElement.dataset.theme = scheme;
  return scheme;
}

function onSystemChange(): void {
  // 只在「跟随系统」时跟着动；用户锁定过就听用户的。
  if (choice === "system") {
    apply();
  }
}

/**
 * 启动时调用一次：应用存下来的选择，并在跟随系统时订阅偏好变化。
 * 重复调用是幂等的（React 严格模式会双跑 effect，不幂等就会挂两条监听）。
 */
export function initTheme(): Scheme {
  choice = storedChoice();
  query?.removeEventListener("change", onSystemChange);
  query = systemQuery();
  query?.addEventListener("change", onSystemChange);
  return apply();
}

/** 用户显式切换。写存储 + 立刻生效，不需要重载。 */
export function setThemeChoice(next: ThemeChoice): Scheme {
  choice = next;
  persist(next);
  return apply();
}

export function currentChoice(): ThemeChoice {
  return choice;
}

/** 当前生效的方案。优先读 DOM —— 它就是唯一事实。 */
export function currentScheme(): Scheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** 卸载/测试用：退订系统偏好。 */
export function disposeTheme(): void {
  query?.removeEventListener("change", onSystemChange);
  query = null;
}
