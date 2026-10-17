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
        label: "选中项：淡底填充（§4.2 / 第七轮对照成熟产品）",
        pattern:
          /\.lr-list__item\[aria-current="true"\]\s*\{[^}]*background:\s*var\(--lr-accent-subtle\)/,
      },
      {
        /*
         * 选中态的第二路是**字色**（第七轮）。不再用投影：列表里没有成熟产品用
         * 「白卡 + 影子」表达选中，那等于说「这一行可以拖走」。也不再改字重 ——
         * 中文 13px 是合成加粗，笔画一变、整列的呼吸就乱。剩下两路：填充 + 字色。
         */
        label: "选中项：填充之外还有字色（两路并行，不靠单一通道）",
        pattern:
          /\.lr-list__item\[aria-current="true"\]\s*\{[^}]*color:\s*var\(--lr-text\)/,
      },
      {
        label: "条目是椭圆长条（批注 4）",
        pattern: /\.lr-list__item\s*\{[^}]*border-radius:\s*calc\(/,
      },
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
    // 编辑面也是界面：它不在 components/ 也不在 shell/，但 §4.3 / §4.5 一样管它。
    ...readdirSync(path.join(srcDir, "editor"))
      .filter((name) => name.endsWith(".css"))
      .map((name) => `editor/${name}`),
    "App.css",
  ];

  it("确实有样式表要检查（否则这组测试是空的）", () => {
    // 至少：components/ 与 shell/ 的几张 + 编辑面 + App.css。
    expect(cssFiles.length).toBeGreaterThan(5);
  });

  /*
   * §4.3 的唯一例外：**文本输入面**不画外环（编辑面的正文与标题）。焦点由光标承载 ——
   * VS Code / Obsidian / Notion 都不给编辑区套框；一圈 2px 外环套在 58ch 的正文列上，
   * 读起来是表单输入框，不是「我正在写字」。
   *
   * 例外**不是豁免**：它被按「文件 + 选择器」钉住 —— 别处写 `outline: none` 一样红，
   * 而且不允许用 `*` 之类把整片区域一起关掉。
   */
  const FOCUS_EXEMPT = {
    file: "editor/Editor.css",
    selectors: [
      ".lr-editor__title:focus-visible",
      ".lr-editor__surface:focus-visible",
      ".lr-editor__grip:focus-visible",
    ],
  };

  for (const file of cssFiles) {
    it(`${file} 没有把 outline 关掉（关了就必须是 §4.3 那条例外）`, () => {
      const css = readCss(file);
      if (!/outline:\s*(none|0)\b/.test(css)) {
        return;
      }
      expect(file, "只有编辑面的文本输入面允许不画外环").toBe(FOCUS_EXEMPT.file);
      for (const selector of FOCUS_EXEMPT.selectors) {
        expect(css, `例外必须逐条列在选择器上：缺 ${selector}`).toContain(selector);
      }
      // 不许「顺手整片关掉」：通配选择器上的 outline: none 一律算违规。
      expect(css).not.toMatch(/\*[^{}]*\{[^}]*outline:\s*none/);
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

describe("ui.md §3.3：收窄顺序必须是「先收列表栏，最后才动读面」", () => {
  const shell = readCss("shell/Shell.css");

  it("两个断点都在，且数值就是文档写的 1000 / 820", () => {
    expect(shell).toMatch(/@media \(width < 1000px\)/);
    expect(shell).toMatch(/@media \(width < 820px\)/);
    // 原来的 1180 那条是给右侧栏的；右侧栏撤了，它跟着撤（本轮批注 2）。
    expect(shell).not.toMatch(/@media \(width < 1180px\)/);
  });

  it("断点在文件里按 1000 → 820 排列（正文优先级最高，最后才动读面）", () => {
    const list = shell.indexOf("@media (width < 1000px)");
    const single = shell.indexOf("@media (width < 820px)");
    expect(list).toBeGreaterThan(-1);
    expect(single).toBeGreaterThan(list);
  });

  it("没有右侧栏：检视器那一列与图标条都不在样式表里（本轮批注 2）", () => {
    expect(shell).not.toMatch(/\.lr-inspector/);
    expect(shell).not.toMatch(/\.lr-rail/);
    expect(shell).not.toMatch(/data-inspector/);
  });

  it("脊柱不占全局列（批注 1：空的时候它把动线劈成两半）", () => {
    expect(shell).not.toMatch(/\.lr-shell__spine/);
    expect(shell).not.toMatch(/"nav list spine/);
  });

  it("版心归纸：宽度由 --lr-page-width 决定，缺省退回 --lr-measure（§3.1 的 58ch）", () => {
    // 第六轮起用户可以把纸拖宽（§4.6），于是「58ch」从硬上限变成了**默认值**。
    expect(readCss("editor/Editor.css")).toMatch(
      /\.lr-editor\s*\{[^}]*width:\s*var\(--lr-page-width,\s*var\(--lr-measure\)\)/,
    );
  });

  it("<820px 是单栏：列表与读面互斥，脊柱改为读面顶部的横向条", () => {
    const single = shell.slice(shell.indexOf("@media (width < 820px)"));
    expect(single).toMatch(/data-pane="list"[^}]*\.lr-shell__read/);
    expect(single).toMatch(/flex-direction:\s*row/);
  });

  it("栏位预算：导航条 56 / 列表栏 242，状态条 28", () => {
    expect(shell).toMatch(/\.lr-shell__nav\s*\{[^}]*width:\s*56px/);
    expect(shell).toMatch(/\.lr-shell__list\s*\{[^}]*width:\s*242px/);
    // 顶栏 48 / 内容弹性 / 状态条 28（§3.1 2026-10-17）
    expect(shell).toMatch(/grid-template-rows:\s*48px\s*minmax\(0,\s*1fr\)\s*28px/);
    // 左栏顶天立地（批注 6）：nav 同时出现在内容行与状态条行
    expect(shell).toMatch(/"nav\s+status/);
  });
});

describe("本轮批注 1 / 3 / 4 落在样式表里", () => {
  const shell = readCss("shell/Shell.css");

  it("顶栏三格：品牌在左、搜索居中、动作在右（第三轮）", () => {
    expect(shell).toMatch(/\.lr-topbar__brand\s*\{[^}]*grid-column:\s*1/);
    expect(shell).toMatch(/\.lr-topbar__search\s*\{[^}]*grid-column:\s*2/);
    expect(shell).toMatch(/\.lr-topbar__action\s*\{[^}]*grid-column:\s*3/);
    // 搜索居中靠的是左右两列都是 1fr，不是靠算宽度。
    expect(shell).toMatch(/grid-template-columns:\s*1fr\s+auto\s+1fr/);
  });

  it("新建是栏顶的长条，且悬停有反馈（第三轮）", () => {
    // 它独占一行、吃满整栏（第七轮：收起钮搬到上面一行）。
    expect(shell).toMatch(/\.lr-list__head\s*\{[^}]*display:\s*flex/);
    /*
     * **这一条是补的坑**：JSX 里给胶囊多包了一层 `.lr-list__create-row`，样式却忘了写，
     * 于是那个 div 是块级、按钮退回 inline-block，胶囊缩到内容宽（实测 76px）——悬停时
     * 那 24px 的让位直接把加号推出了胶囊，键位压在字上。只差这一条 `display: flex`。
     */
    expect(shell).toMatch(/\.lr-list__create-row\s*\{[^}]*display:\s*flex/);
    expect(shell).toMatch(/\.lr-list__create\s*\{[^}]*flex:\s*1/);
    // 32 高（第七轮第二次改）：40 被用户嫌"太胖"，收一档到与条目同高。
    expect(shell).toMatch(/\.lr-list__create\s*\{[^}]*height:\s*var\(--lr-space-32\)/);
    expect(shell).toMatch(/\.lr-list__create\s*\{[^}]*border-radius:\s*calc\(/);
    expect(shell).toMatch(/\.lr-list__create:hover\s*\{/);
    expect(shell).toMatch(/\.lr-list__create:active\s*\{/);
    /*
     * 静止时**居中**、键位绝对定位贴右端、悬停才淡入（第五轮第二次改）。
     * 上一版的毛病不是「绝对定位」，是「居中 + 绝对定位 + 不让位」：148px 里两者必然
     * 相撞（截图上是「新建Ctrl + N」）。所以现在钉三件事：居中、键位脱流、悬停时让位。
     */
    expect(shell).toMatch(/\.lr-list__create\s*\{[^}]*justify-content:\s*center/);
    expect(shell).toMatch(/\.lr-list__create-keys\s*\{[^}]*opacity:\s*0/);
    expect(shell).toMatch(/\.lr-list__create-keys\s*\{[^}]*position:\s*absolute/);
    expect(shell).toMatch(/\.lr-list__create-keys\s*\{[^}]*inset-inline-end/);
    // 让位：悬停/键盘焦点时图标 + 名称整组左移，位移量走间距令牌。
    expect(shell).toMatch(
      /\.lr-list__create:hover \.lr-list__create-main,[^{]*\{[^}]*translateX\(calc\(var\(--lr-space-24\)/,
    );
    expect(shell).toMatch(
      /\.lr-list__create:focus-visible\s+\.lr-list__create-main\s*\{/,
    );
  });

  it("收起之后**不留列**：整列消失，只在正文左上角浮出一颗小箭头（第四轮）", () => {
    // 留一列 32px 等于「为一个按钮多出一列」—— 屏幕上很难看。
    expect(shell).toMatch(
      /\.lr-shell\[data-list="closed"\]\s+\.lr-shell__list\s*\{[^}]*display:\s*none/,
    );
    expect(shell).not.toMatch(/\.lr-list-rail/);
    expect(shell).toMatch(/\.lr-shell__expand\s*\{[^}]*position:\s*absolute/);
  });

  it("收起钮放大到 32×32（批注 3：24×24 里塞个「«」点不准）", () => {
    expect(shell).toMatch(
      /\.lr-list__collapse\s*\{[^}]*height:\s*var\(--lr-space-32\)/,
    );
    expect(shell).toMatch(/\.lr-list__collapse\s*\{[^}]*width:\s*var\(--lr-space-32\)/);
  });

  it("导航条底部那条分隔线没了（批注 4）", () => {
    expect(shell).toMatch(/\.lr-nav__foot\s*\{/);
    expect(shell).not.toMatch(/\.lr-nav__foot\s*\{[^}]*border-block-start/);
  });
});

describe("读面/编辑面的层级（ui.md §2.4：抬起来的是正文那一栏，不是整个区）", () => {
  const shell = readCss("shell/Shell.css");
  const editor = readCss("editor/Editor.css");

  it("读面退成画布（与侧栏同级），正文那一栏才抬一级 —— 桌面和正文不能同色", () => {
    // 上一版把整个读面抬成 surface-raised，实机反馈是「看不出要往哪儿写」：
    // 桌面与正文一个白。第五轮把抬起来的那层缩到文档本身。
    expect(shell).toMatch(/\.lr-read\s*\{[^}]*background:\s*var\(--lr-surface\)/);
    expect(editor).toMatch(
      /\.lr-editor\s*\{[^}]*background:\s*var\(--lr-surface-raised\)/,
    );
  });

  it("纸**不描边**：描边是「画一个框」，投影才是「东西浮起来」", () => {
    // 用户原话：「加上去给人一种强调的感觉」。删掉的是 border，不是「浮起感」——
    // 所以下面那条同时钉住圆角与投影：纯白纸必须靠这两样才站得起来（§4.6）。
    expect(editor).not.toMatch(/\.lr-editor\s*\{[^}]*border:\s*1px/);
    expect(editor).not.toMatch(/\.lr-editor:focus-within/);
  });

  it("纸有圆角与投影（§4.6）", () => {
    expect(editor).toMatch(
      /\.lr-editor\s*\{[^}]*border-radius:\s*var\(--lr-radius-lg\)/,
    );
    expect(editor).toMatch(/\.lr-editor\s*\{[^}]*box-shadow:\s*var\(--lr-shadow-3\)/);
  });

  it("纸宽走内联变量，缺省退回 58ch 的版心；两条抓取带可拖可键盘", () => {
    expect(editor).toMatch(
      /\.lr-editor\s*\{[^}]*width:\s*var\(--lr-page-width,\s*var\(--lr-measure\)\)/,
    );
    expect(editor).toMatch(/\.lr-editor__grip\s*\{[^}]*cursor:\s*col-resize/);
    expect(editor).toMatch(/\.lr-editor__grip\[data-edge="start"\]/);
    expect(editor).toMatch(/\.lr-editor__grip\[data-edge="end"\]/);
  });

  it("里面分头区与正文区：标题是字段，不是标题牌", () => {
    expect(editor).toMatch(/\.lr-editor__head\s*\{/);
    expect(editor).toMatch(
      /\.lr-editor__title\s*\{[^}]*font-size:\s*var\(--lr-font-size-title\)/,
    );
  });
});

describe("ui.md §4.5：字号与行距只能走令牌", () => {
  const cssFiles = [
    ...readdirSync(path.join(srcDir, "components"))
      .filter((name) => name.endsWith(".css"))
      .map((name) => `components/${name}`),
    ...readdirSync(path.join(srcDir, "shell"))
      .filter((name) => name.endsWith(".css"))
      .map((name) => `shell/${name}`),
    // 编辑面一样受 §4.5 约束：字号只有五档，行距只有三档。
    ...readdirSync(path.join(srcDir, "editor"))
      .filter((name) => name.endsWith(".css"))
      .map((name) => `editor/${name}`),
    "App.css",
    "styles/base.css",
  ];

  for (const file of cssFiles) {
    it(`${file} 没有裸字号`, () => {
      // 10 / 11 / 12 / 13 / 14 / 16px 六个随手值就是这么长出来的；
      // 文档 §4.5 定了五档，实现里就只能引用它们。
      expect(readCss(file)).not.toMatch(/font-size:\s*[\d.]+(px|rem|em|pt)/);
    });

    it(`${file} 的行距要么走令牌，要么是 0 / 1 / inherit / normal`, () => {
      for (const declaration of readCss(file).match(/line-height:\s*[^;]+/g) ?? []) {
        expect(declaration).toMatch(/var\(--lr-line-|:\s*(0|1|inherit|normal)$/);
      }
    });
  }
});

describe("ui.md §4.6：层级是一套系统，不是一个个元素补影子", () => {
  // 与上面几组同样口径：组件、外壳、编辑面、App 全在检查范围内。
  const cssFiles = [
    ...readdirSync(path.join(srcDir, "components"))
      .filter((name) => name.endsWith(".css"))
      .map((name) => `components/${name}`),
    ...readdirSync(path.join(srcDir, "shell"))
      .filter((name) => name.endsWith(".css"))
      .map((name) => `shell/${name}`),
    ...readdirSync(path.join(srcDir, "editor"))
      .filter((name) => name.endsWith(".css"))
      .map((name) => `editor/${name}`),
    "App.css",
  ];

  it("不许手写投影：只能引用 --lr-shadow-1/2/3（三级之外的影子没有出处）", () => {
    for (const file of cssFiles) {
      for (const declaration of readCss(file).match(/box-shadow:\s*[^;]+/g) ?? []) {
        expect(declaration, `${file} 里有一处手写投影`).toMatch(
          /box-shadow:\s*(none|var\(--lr-shadow-[123]\))$/,
        );
      }
    }
  });

  it("三级都必须真的被用上（声明了没人用 = 假层级）", () => {
    const used = new Set<string>();
    for (const file of cssFiles) {
      for (const match of readCss(file).matchAll(/var\(--lr-shadow-([123])\)/g)) {
        used.add(match[1]);
      }
    }
    expect([...used].sort()).toEqual(["1", "2", "3"]);
  });

  it("该配影的都配了，而且**不跨级**（小控件 1 / 控件 2 / 物体 3）", () => {
    const shell = readCss("shell/Shell.css");
    // 主操作胶囊是控件级。
    expect(shell).toMatch(/\.lr-list__create\s*\{[^}]*var\(--lr-shadow-2\)/);
    // 浮层与纸是物体级。
    expect(shell).toMatch(/\.lr-panel\s*\{[^}]*var\(--lr-shadow-3\)/);
    expect(readCss("editor/Editor.css")).toMatch(
      /\.lr-editor\s*\{[^}]*var\(--lr-shadow-3\)/,
    );
  });

  it("**行不配影**：选中是底色变了，不是这一行浮起来了（第七轮）", () => {
    // 对照成熟产品（Notion / ChatGPT / WPS 的侧栏）：列表里没有一家用「白卡 + 投影」
    // 表达选中 —— 浮起来意味着「这一行可以被拖走」，而它只是「当前在这一行」。
    const shell = readCss("shell/Shell.css");
    for (const selector of [
      '\\.lr-list__item\\[aria-current="true"\\]',
      '\\.lr-nav__item\\[aria-current="page"\\]',
    ]) {
      const block = new RegExp(`${selector}\\s*\\{[^}]*\\}`).exec(shell)?.[0] ?? "";
      expect(block).not.toBe("");
      expect(block, `${selector} 不该有投影`).not.toMatch(/box-shadow/);
    }
  });

  it("悬停必须**排除选中项**：否则鼠标扫过正在编辑的那条，底色会被 hover 盖掉", () => {
    const shell = readCss("shell/Shell.css");
    expect(shell).toMatch(
      /\.lr-list__item:hover:not\(:disabled, \[aria-current="true"\]\)/,
    );
    expect(shell).toMatch(
      /\.lr-list__item:active:not\(:disabled, \[aria-current="true"\]\)/,
    );
    expect(shell).toMatch(
      /\.lr-nav__item:hover:not\(:disabled, \[aria-current="page"\]\)/,
    );
  });

  it("悬停态不许配影：投影跟着层级走，不跟着鼠标走（§4.6 第 2 条）", () => {
    for (const file of cssFiles) {
      for (const rule of readCss(file).match(/[^{}]*:hover[^{}]*\{[^}]*\}/g) ?? []) {
        expect(rule, `${file} 的悬停态加了投影`).not.toMatch(/box-shadow/);
      }
    }
  });
});

describe("选中态：靠填充、投影、字色，不靠字重", () => {
  it("条目被选中时**不改字重**（中文 13px 合成加粗会连字宽一起变，整列看起来在跳）", () => {
    expect(readCss("shell/Shell.css")).not.toMatch(
      /\.lr-list__item\[aria-current="true"\]\s*\{[^}]*font-weight/,
    );
  });

  it("行高是整数：条目的高度定死（36.8 那种行界落在半个像素上，白条上下边缘会抖）", () => {
    const shell = readCss("shell/Shell.css");
    expect(shell).toMatch(/\.lr-list__item\s*\{[^}]*height:\s*var\(--lr-space-32\)/);
    expect(shell).not.toMatch(
      /\.lr-list__item\s*\{[^}]*padding:\s*var\(--lr-space-8\)\s+var\(--lr-space-12\)/,
    );
  });
});
