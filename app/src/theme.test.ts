// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 主题切换的单测（路线 096 / 097）。
 *
 * ui.md §五 的可验部分都在这里：「跟随系统为默认」「允许手动锁定深/浅/跟随」「切换瞬时」，
 * 以及那条容易漏的 —— **组件不应该知道现在是深是浅**，所以这里验的是 `data-theme`
 * 这个属性有没有被正确写上去，而不是某个组件的颜色。
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DARK_QUERY,
  THEME_STORAGE_KEY,
  currentChoice,
  currentScheme,
  disposeTheme,
  initTheme,
  isThemeChoice,
  resolveScheme,
  setThemeChoice,
  storedChoice,
  systemPrefersDark,
} from "./theme";

type SchemeStub = {
  matches: boolean;
  listeners: Set<() => void>;
  emit(next: boolean): void;
};

/** jsdom 没有实现 `matchMedia`，这里按真机的形状补一个。 */
function installMatchMedia(initial: boolean): SchemeStub {
  const listeners = new Set<() => void>();
  const stub: SchemeStub = {
    matches: initial,
    listeners,
    emit(next: boolean): void {
      stub.matches = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      // 用 getter：真机上 matches 会随系统变化，读的必须是最新值。
      get matches(): boolean {
        return stub.matches;
      },
      media: query,
      addEventListener: (_type: string, listener: () => void): void => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void): void => {
        listeners.delete(listener);
      },
    }),
  });
  return stub;
}

function removeMatchMedia(): void {
  Reflect.deleteProperty(globalThis, "matchMedia");
}

const root = (): HTMLElement => document.documentElement;

/** 把 `localStorage` 换成「一访问就抛」的形状（隐私模式）。恢复由 afterEach 负责。 */
let restoreStorage: (() => void) | null = null;

function breakStorage(): void {
  if (restoreStorage) {
    return;
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => {
      throw new Error("SecurityError");
    },
  });
  restoreStorage = () => {
    if (original) {
      Object.defineProperty(globalThis, "localStorage", original);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
    restoreStorage = null;
  };
}

beforeEach(() => {
  localStorage.clear();
  removeMatchMedia();
  disposeTheme();
  Reflect.deleteProperty(root().dataset, "theme");
});

afterEach(() => {
  // **先恢复存储再清理**：否则上一条测试留下的「一访问就抛」的 localStorage
  // 会让本文件后面每一条测试的 beforeEach 都炸 —— 一次污染，十一条假失败。
  restoreStorage?.();
  disposeTheme();
  removeMatchMedia();
  localStorage.clear();
});

describe("resolveScheme：选择 + 系统偏好 → 生效方案", () => {
  it("跟随系统时两个方向都跟着走", () => {
    expect(resolveScheme("system", true)).toBe("dark");
    expect(resolveScheme("system", false)).toBe("light");
  });

  it("锁定之后系统偏好不再影响结果", () => {
    expect(resolveScheme("dark", false)).toBe("dark");
    expect(resolveScheme("light", true)).toBe("light");
  });

  it("只认三态，别的一律拒绝", () => {
    expect(isThemeChoice("system")).toBe(true);
    expect(isThemeChoice("dark")).toBe(true);
    expect(isThemeChoice("light")).toBe(true);
    expect(isThemeChoice("Dark")).toBe(false);
    expect(isThemeChoice(true)).toBe(false);
    expect(isThemeChoice(null)).toBe(false);
    expect(isThemeChoice("auto")).toBe(false);
  });
});

describe("存下来的选择", () => {
  it("没存过就是跟随系统", () => {
    expect(storedChoice()).toBe("system");
  });

  it("存过就读回来", () => {
    localStorage.setItem("lurnia.theme", "light");
    expect(storedChoice()).toBe("light");
  });

  it("存坏了不崩，回落到跟随系统", () => {
    localStorage.setItem("lurnia.theme", "solarized");
    expect(storedChoice()).toBe("system");
  });

  it("读存储会抛异常时也不崩（隐私模式）", () => {
    breakStorage();
    expect(storedChoice()).toBe("system");
    expect(initTheme()).toBe("light");
  });
});

describe("initTheme：把方案写到 <html data-theme>", () => {
  it("默认跟随系统", () => {
    const media = installMatchMedia(true);
    expect(initTheme()).toBe("dark");
    expect(root().dataset.theme).toBe("dark");
    media.emit(false);
    expect(root().dataset.theme).toBe("light");
  });

  it("没有 matchMedia 时按「系统不是深色」处理，而不是抛异常", () => {
    expect(systemPrefersDark()).toBe(false);
    expect(initTheme()).toBe("light");
    expect(root().dataset.theme).toBe("light");
  });

  it("存下来的选择优先于系统偏好", () => {
    installMatchMedia(true);
    localStorage.setItem("lurnia.theme", "light");
    expect(initTheme()).toBe("light");
    expect(currentChoice()).toBe("light");
  });

  it("重复调用是幂等的（React 严格模式会双跑）", () => {
    const media = installMatchMedia(false);
    initTheme();
    initTheme();
    expect(media.listeners.size).toBe(1);
  });
});

describe("setThemeChoice：瞬时切换", () => {
  it("立刻改属性并记住选择", () => {
    installMatchMedia(false);
    initTheme();
    expect(setThemeChoice("dark")).toBe("dark");
    expect(root().dataset.theme).toBe("dark");
    expect(localStorage.getItem("lurnia.theme")).toBe("dark");
    expect(currentScheme()).toBe("dark");
  });

  it("锁定之后系统偏好翻面也不动它", () => {
    const media = installMatchMedia(false);
    initTheme();
    setThemeChoice("light");
    media.emit(true);
    expect(root().dataset.theme).toBe("light");
  });

  it("切回跟随系统后，系统偏好立刻重新生效", () => {
    const media = installMatchMedia(true);
    initTheme();
    setThemeChoice("light");
    expect(root().dataset.theme).toBe("light");
    media.emit(true);
    setThemeChoice("system");
    expect(root().dataset.theme).toBe("dark");
  });

  it("用的是 ui.md 约定的查询串", () => {
    expect(DARK_QUERY).toBe("(prefers-color-scheme: dark)");
  });
});

/**
 * `index.html` 里有一份内联的防闪脚本，它没法 import 本模块，只能复制同一条规则。
 * 复制就有分叉风险，所以这里把「两份用的是同一个键、同一个查询串」钉住。
 */
describe("index.html 的首帧防闪脚本", () => {
  // 从 cwd 算路径：vitest 的 root 就是 app/，而 `import.meta.url` 在 jsdom 下
  // 不是 file: 协议（`new URL(..., import.meta.url)` 会报 "must be of scheme file"）。
  const html = readFileSync(path.join(process.cwd(), "index.html"), "utf8");

  it("与本模块用同一个存储键和同一个媒体查询", () => {
    expect(html).toContain(THEME_STORAGE_KEY);
    expect(html).toContain(DARK_QUERY);
  });

  it("在模块入口之前执行（否则防闪没有意义）", () => {
    const inline = html.indexOf("dataset.theme");
    const entry = html.indexOf("main.tsx");
    expect(inline).toBeGreaterThan(0);
    expect(entry).toBeGreaterThan(0);
    expect(inline).toBeLessThan(entry);
  });
});
