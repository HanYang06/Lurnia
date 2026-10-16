// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 界面门禁：ui.md §4.2「每个可交互元素必须定义**六个**状态，缺一不可」，
 * 以及 §3.3 的收窄顺序。
 *
 * 这些规则靠人守是守不住的 —— 少写一个 `:disabled` 不会有任何报错，只会在某个用户
 * 手里变成「点了没反应」；把三个断点写反顺序，也不会报错，只会在窄窗口下先牺牲正文。
 * 所以都变成机械检查。
 *
 * 同时反向登记**非交互**的样式表：它们**不该**有悬停/按压态。这样「没写」与
 * 「不该写」在代码里是两件事，而不是靠读代码猜。
 *
 * 焦点环是唯一一处刻意的集中：ui.md §4.3 说它是可用性基础设施，所以由 base.css 全局
 * 提供，组件不重复写；这里改为检查「没有任何一处把它关掉」。
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const appDir = process.cwd();
const srcDir = path.join(appDir, "src");

function readCss(relative: string): string {
  return readFileSync(path.join(srcDir, relative), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
}

type StateRule = { label: string; pattern: RegExp };

/** 交互元素必须声明的状态选择器（§4.2）。路径相对 src/。 */
const INTERACTIVE: { file: string; rules: StateRule[] }[] = [
  {
    file: "components/Button.css",
    rules: [
      { label: "hover", pattern: /\.lr-button:hover/ },
      { label: "active/press", pattern: /\.lr-button:active/ },
      { label: "disabled", pattern: /\.lr-button:disabled/ },
      // §4.2：disabled 不改颜色，只降不透明度 + 换光标。
      { label: "disabled 的不透明度 0.45", pattern: /opacity:\s*0?\.45/ },
      { label: "disabled 的 cursor", pattern: /cursor:\s*not-allowed/ },
    ],
  },
  {
    file: "components/Field.css",
    rules: [
      { label: "input hover", pattern: /\.lr-input:hover/ },
      { label: "input active", pattern: /\.lr-input:active/ },
      { label: "input disabled", pattern: /\.lr-input:disabled/ },
      { label: "select hover", pattern: /\.lr-select:hover/ },
      { label: "select disabled", pattern: /\.lr-select:disabled/ },
      { label: "checkbox hover", pattern: /\.lr-checkbox:hover/ },
      { label: "checkbox disabled", pattern: /\.lr-checkbox:disabled/ },
      { label: "switch hover", pattern: /\.lr-switch:hover/ },
      { label: "switch active", pattern: /\.lr-switch:active/ },
      { label: "switch disabled", pattern: /\.lr-switch:disabled/ },
      // 开态：颜色之外还有位移（§7.3 第 1 条，状态不许只靠颜色）。
      { label: "switch 开态", pattern: /\.lr-switch\[aria-checked="true"\]/ },
      {
        label: "switch 开态的滑块位移",
        pattern: /\[aria-checked="true"\]\s+\.lr-switch__thumb\s*\{[^}]*translateX/,
      },
    ],
  },
  {
    file: "shell/Shell.css",
    rules: [
      { label: "导航项 hover", pattern: /\.lr-nav__item:hover/ },
      { label: "导航项 active", pattern: /\.lr-nav__item:active/ },
      { label: "导航项 disabled", pattern: /\.lr-nav__item:disabled/ },
      // 第六态：选中项。导航用 aria-current="page"，列表用 aria-current="true"。
      { label: "导航项选中态", pattern: /\.lr-nav__item\[aria-current="page"\]/ },
      { label: "列表项 hover", pattern: /\.lr-list__item:hover/ },
      { label: "列表项 active", pattern: /\.lr-list__item:active/ },
      { label: "列表项 disabled", pattern: /\.lr-list__item:disabled/ },
      { label: "列表项选中态", pattern: /\.lr-list__item\[aria-current="true"\]/ },
      {
        label: "选中项的 2.5px 强调条（§3.1）",
        pattern:
          /\.lr-list__item\[aria-current="true"\]\s*\{[^}]*border-inline-start-color:\s*var\(--lr-accent\)/,
      },
      {
        label: "选中项的 surface-raised 底（§4.2）",
        pattern:
          /\.lr-list__item\[aria-current="true"\]\s*\{[^}]*background:\s*var\(--lr-surface-raised\)/,
      },
      // 选中条的占位：不占住位置的话，选中时整行文字会跳一下。
      { label: "选中条占位 2.5px", pattern: /border-inline-start:\s*2\.5px/ },
    ],
  },
];

/** 非交互样式表：**不该**有这些状态，写上去多半是把纯展示做成了按钮。 */
const NON_INTERACTIVE = ["components/Badge.css", "components/Surface.css"];

describe("ui.md §4.2：交互元素的六个状态", () => {
  for (const { file, rules } of INTERACTIVE) {
    for (const { label, pattern } of rules) {
      it(`${file} 声明了 ${label}`, () => {
        const css = readCss(file);
        expect(
          pattern.test(css),
          `${file} 里找不到 ${label}（${String(pattern)}）`,
        ).toBe(true);
      });
    }
  }

  for (const file of NON_INTERACTIVE) {
    it(`${file} 是非交互的，不该有悬停/按压态`, () => {
      expect(readCss(file)).not.toMatch(/:hover|:active|:disabled/);
    });
  }
});

describe("ui.md §4.3：焦点环是基础设施，不许被某处关掉", () => {
  const cssFiles = [
    ...readdirSync(path.join(srcDir, "components"))
      .filter((name) => name.endsWith(".css"))
      .map((name) => `components/${name}`),
    ...readdirSync(path.join(srcDir, "shell"))
      .filter((name) => name.endsWith(".css"))
      .map((name) => `shell/${name}`),
    "App.css",
  ];

  it("确实有样式表要检查（否则这组测试是空的）", () => {
    expect(cssFiles.length).toBeGreaterThan(3);
  });

  for (const file of cssFiles) {
    it(`${file} 没有把 outline 关掉`, () => {
      expect(readCss(file), "§4.3 明确禁止 outline: none 之后不补替代物").not.toMatch(
        /outline:\s*(none|0)\b/,
      );
    });
  }

  it("base.css 提供全局焦点环，用的是强调色与焦点令牌", () => {
    const css = readCss("styles/base.css");
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:[^;]*--lr-focus-ring-width/);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:[^;]*var\(--lr-accent\)/);
    expect(css).toMatch(
      /:focus-visible\s*\{[^}]*outline-offset:[^;]*--lr-focus-ring-offset/,
    );
  });
});

describe("ui.md §3.3：收窄顺序必须是「先检视器，再列表，最后读面」", () => {
  const shell = readCss("shell/Shell.css");

  it("三个断点都在，且数值就是文档写的 1180 / 1000 / 820", () => {
    expect(shell).toMatch(/@media \(width < 1180px\)/);
    expect(shell).toMatch(/@media \(width < 1000px\)/);
    expect(shell).toMatch(/@media \(width < 820px\)/);
  });

  it("断点在文件里按 1180 → 1000 → 820 排列（正文优先级最高，最后才动读面）", () => {
    const inspector = shell.indexOf("@media (width < 1180px)");
    const list = shell.indexOf("@media (width < 1000px)");
    const single = shell.indexOf("@media (width < 820px)");
    expect(inspector).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(inspector);
    expect(single).toBeGreaterThan(list);
  });

  it("≥820px 时不折叠脊柱（它是签名元素，也是 I5 的可视证据）", () => {
    // 「脊柱不折叠」= 1180 与 1000 两个断点里都不许出现把它藏起来的规则。
    const beforeSingle = shell.slice(0, shell.indexOf("@media (width < 820px)"));
    expect(beforeSingle).not.toMatch(/\.lr-shell__spine\s*\{[^}]*display:\s*none/);
  });

  it("正文限制用 --lr-measure（§3.1 的 58ch）", () => {
    expect(shell).toMatch(/\.lr-read__body\s*\{[^}]*max-width:\s*var\(--lr-measure\)/);
  });

  it("<820px 是单栏：列表与读面互斥，脊柱改为读面顶部的横向条", () => {
    const single = shell.slice(shell.indexOf("@media (width < 820px)"));
    expect(single).toMatch(/data-pane="list"[^}]*\.lr-shell__read/);
    expect(single).toMatch(/flex-direction:\s*row/);
  });

  it("栏位预算就是 §3.1 的 72 / 242 / 88 / 232，状态条 28", () => {
    expect(shell).toMatch(/\.lr-shell__nav\s*\{[^}]*width:\s*72px/);
    expect(shell).toMatch(/\.lr-shell__list\s*\{[^}]*width:\s*242px/);
    expect(shell).toMatch(/\.lr-shell__spine\s*\{[^}]*width:\s*88px/);
    expect(shell).toMatch(/\.lr-shell__inspector\s*\{[^}]*width:\s*232px/);
    expect(shell).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)\s*28px/);
  });
});
