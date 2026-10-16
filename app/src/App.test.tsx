// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 四区外壳的验收测试（路线 095）。
 *
 * ui.md §3.1 把界面切成六个区，其中**脊柱是签名元素** —— 它不能只是「有个地方留给
 * 它」，得在真实渲染出来的标记里确实存在。所以这里把整个 App 渲成字符串，然后逐个
 * 认这六个区，并检查没有数据的地方写的是**空态**而不是假数据。
 *
 * 用 `react-dom/server`：`useEffect` 不会在服务端渲染里跑，所以内核订阅不会真的发出
 * 去，测试也不需要 Tauri 宿主。
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import App from "./App";

const html = renderToStaticMarkup(<App />);

describe("ui.md §3.1：六个区都在", () => {
  it("导航条", () => {
    expect(html).toContain('aria-label="模块"');
    // §3.1：图标 + 文字，不是纯图标 —— 四个模块名都得在。
    for (const label of ["笔记", "项目", "权限", "AI"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("设置");
  });

  it("列表栏", () => {
    expect(html).toContain("lr-list");
  });

  it("日志脊柱（签名元素）", () => {
    expect(html).toContain('aria-label="版本时间线"');
    expect(html).toContain("lr-spine");
  });

  it("读面", () => {
    expect(html).toContain('aria-label="读面"');
    expect(html).toContain("lr-read__body");
  });

  it("检视器", () => {
    expect(html).toContain('aria-label="内核"');
    expect(html).toContain("lr-inspector");
  });

  it("状态条：核心状态与本地性", () => {
    expect(html).toContain("lr-statusbar");
    expect(html).toContain("本地");
  });
});

describe("没有数据的地方写空态，不写假数据", () => {
  it("脊柱空态说明的是「还没有版本记录」", () => {
    expect(html).toContain("还没有版本记录");
  });

  it("笔记模块的空态讲清楚「为什么空」与「将来长出什么」", () => {
    expect(html).toContain("笔记还没有内容");
    expect(html).toContain("doc 能力的读接口");
    // 三段式：只有一行灰字的空面板看起来像是界面坏了。
    expect(html).toContain("lr-empty__why");
    expect(html).toContain("lr-empty__next");
  });

  it("核心没起来时不编造版本号，只说在等", () => {
    expect(html).toContain("等待核心…");
    expect(html).not.toMatch(/v\d+\.\d+\.\d+/);
  });
});

describe("顶栏与折叠钮各就各位（§3.1 2026-10-17 改版）", () => {
  it("顶栏在，搜索居中且是带标签的输入（标签只念不显示）", () => {
    expect(html).toContain("lr-topbar");
    expect(html).toContain('type="search"');
    // 「不给无标签输入框留口子」这条没有因为搜索框变宽而破掉
    expect(html).toContain("lr-field--hidden-label");
  });

  it("折叠钮搬到了列表栏自己的右上角，不再占用状态条", () => {
    expect(html).toContain("lr-list__collapse");
    expect(html).toContain("收起列表");
    // 状态条上不该再有开关
    expect(html).not.toContain("lr-statusbar__chrome");
  });

  it("导航是纯图标：图标不占可见文字，但名字给了读屏与悬停", () => {
    expect(html).not.toContain("lr-nav__label");
    expect(html).toContain('aria-label="笔记"');
    expect(html).toContain('title="笔记"');
  });
});
