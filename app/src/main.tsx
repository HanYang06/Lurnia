// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 应用入口。
 *
 * 顺序是有意的：**先把样式与主题装上，再渲染**。ui.md §五 要求跟随系统为默认、
 * 切换瞬时；主题晚一步落到 `<html>` 上，用户就会先看到一帧错误的配色。
 * （`index.html` 里还有一份内联的防闪脚本，那是首帧之前的事。）
 */

import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import "./styles/tokens.css";
import "./styles/base.css";
import { initTheme } from "./theme";

initTheme();

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html 里没有 #root，应用起不来");
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
