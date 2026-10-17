// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * Vitest 配置。测试跑在 jsdom 里 —— 令牌与主题这两层都要碰 DOM
 * （`<html data-theme>` 与 `localStorage`），不是纯函数测试。
 *
 * 单独的配置文件而不是塞进 `vite.config.ts`：那个文件是 Tauri 的构建配置，
 * 与测试的生命周期无关，混在一起会让「改了测试环境」看起来像在改打包。
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    // 门禁测试要能打印实算出来的对比度，默认的截断会吃掉有用的信息。
    disableConsoleIntercept: true,
  },
});
