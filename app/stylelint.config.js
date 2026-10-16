// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * stylelint：CSS 门禁（路线 093 / 099 / 100 / 101 的机械部分）。
 *
 * 两条硬规则来自 ui.md：
 *
 * 1. **颜色字面量只能出现在 `src/styles/tokens.css`**（ui.md §八）。所以 `color-no-hex`
 *    与 `function-disallowed-list` 全局打开，只在那一个文件里开洞 —— 组件样式里写
 *    `#00babc` 或 `rgb(...)` 一律失败。
 * 2. **不允许随手值**：间距与圆角只能引用 `--lr-*` 令牌（ui.md §4.1）。
 *
 * 规则集刻意显式写出来（与 ruff 的 `select` 同一种做法）：不依赖「standard 今天恰好
 * 打开了什么」。
 */

export default {
  extends: ["stylelint-config-standard"],

  rules: {
    // --- 颜色只能走令牌 ---------------------------------------------------
    "color-no-hex": true,
    "color-named": "never",
    "function-disallowed-list": [
      "rgb",
      "rgba",
      "hsl",
      "hsla",
      "hwb",
      "lab",
      "lch",
      "oklab",
      "oklch",
      "color",
      "color-mix",
    ],

    // --- 令牌本身 ---------------------------------------------------------
    // 命名沿用 stylelint 的 kebab-case；`--lr-` 前缀是 ui.md 定的。
    "custom-property-pattern": [
      "^lr(-[a-z0-9]+)+$",
      { message: (name) => `令牌名必须是 --lr-* 的 kebab-case，收到 ${name}` },
    ],

    // --- 写法 -------------------------------------------------------------
    // ui.md 把色相与明度写成裸数字（`oklch(0.170 0.014 196)`），standard 默认要求
    // 写成 196deg / 17%。照抄文档优先，所以这里选 number。
    "hue-degree-notation": "number",
    "lightness-notation": "number",

    // 仓库约定是**两行连续的 SPDX 注释**（Python / CSS / TS 都一样），
    // standard 会要求它们之间空行 —— 那样反而不像头了，所以豁免 after-comment。
    "comment-empty-line-before": [
      "always",
      {
        except: ["first-nested"],
        ignore: ["after-comment", "stylelint-commands"],
      },
    ],

    // ui.md §4.1：组件内部用 4 的倍数，不允许 5px、7px、13px 这类随手值。
    // 这条只能靠「值必须来自令牌」来保证，见下面的自定义检查。

    // BEM（`block__element--modifier`）是 App.css 已有的写法，standard 的
    // kebab-case 会把它判错，所以显式放开这两段。
    "selector-class-pattern": [
      "^[a-z][a-z0-9]*(-[a-z0-9]+)*(__[a-z0-9]+(-[a-z0-9]+)*)?(--[a-z0-9]+(-[a-z0-9]+)*)?$",
      { message: (selector) => `类名不在约定内：${selector}` },
    ],

    // 装饰性 `!important` 是坏味道；base.css 里「动效可关」那一条是有意的例外。
    "declaration-no-important": true,

    // grid-template 的三件套（areas / columns / rows）**分开写才读得懂**：这个布局
    // 用命名区域表达五栏位，合成一行 shorthand 会把区域名淹没在一串长度里。
    // 所以只关掉「建议合并 grid-template」这一条建议，其余长手属性照旧要求合并。
    "declaration-block-no-redundant-longhand-properties": [
      true,
      { ignoreShorthands: ["grid-template"] },
    ],
  },

  overrides: [
    {
      // tokens.css 是**唯一**允许出现颜色字面量的文件 —— 它就是这个门禁的边界。
      files: ["**/styles/tokens.css"],
      rules: {
        "color-no-hex": null,
        "function-disallowed-list": null,
      },
    },
    {
      // 减少动效的那条必须压过组件自己的过渡声明，否则「可关」是假的（ui.md §4.4）。
      files: ["**/styles/base.css"],
      rules: {
        "declaration-no-important": null,
      },
    },
  ],
};
