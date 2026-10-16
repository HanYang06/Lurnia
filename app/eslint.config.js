// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * ESLint 门禁（前端）。形态对齐 Python 侧的 ruff：**规则集显式写出来**，
 * 不依赖「某个 preset 今天恰好包含了什么」。
 *
 * 三层：
 *
 * | 层 | 内容 |
 * | --- | --- |
 * | 类型感知 | `strictTypeChecked` + `stylisticTypeChecked`，对齐 mypy strict |
 * | React | hooks 规则 + jsx-a11y 无障碍规则 + react-refresh（HMR 正确性） |
 * | 本项目 | 颜色字面量只能写在 tokens.css；`src` 不许引 Node API |
 *
 * 最后一层是 ui.md §八 的机械落地：「所有颜色只能通过语义令牌引用，组件内不得出现
 * 十六进制字面量。这是保证两个主题完整对等的唯一机械手段。」
 */

import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

const HEX_MESSAGE =
  "颜色字面量只能写在 src/styles/tokens.css（ui.md §八）；组件与页面必须引用 var(--lr-*)。";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "src-tauri/**", "coverage/**"],
  },

  // --- 应用源码：类型感知 + React + 无障碍 --------------------------------
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
      reactHooks.configs.flat["recommended-latest"],
      reactRefresh.configs.vite,
      jsxA11y.flatConfigs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // --- 本项目独有的两条 ---------------------------------------------
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]",
          message: HEX_MESSAGE,
        },
        {
          selector:
            "TemplateElement[value.raw=/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]",
          message: HEX_MESSAGE,
        },
      ],

      // 仓库既有代码统一用 `type X = { ... }` 表达对象形状（kernel.ts 的封套类型就是），
      // 所以这条固定为 type：两套写法混用比选哪个更重要。
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],

      // 模板串里插数字是常见且无害的（`v${n}`）；剩下的窄化仍然管着。
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
    },
  },

  // --- src 不许引 Node API：这些文件要打进 WebView -------------------------
  // 测试例外：门禁测试要读 docs/design/ui.md 与 tokens.css，那是构建期的事，
  // 不随产物分发。
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "fs", "path", "url"],
              message:
                "src 下的代码会被打进 WebView，不能用 Node API。读设计文档这类事只在测试里做。",
            },
          ],
        },
      ],
    },
  },

  // --- 配置文件与脚本：纯 JS，不做类型感知 --------------------------------
  {
    files: ["*.config.{js,mjs,ts}", "scripts/**/*.mjs", "eslint.config.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },

  // prettier 放最后：关掉所有与格式化冲突的风格规则。
  // 它不是「少检查一点」—— 排版归 prettier，其余归 eslint，两套不许互相打架。
  prettier,
);
