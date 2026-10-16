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

  it("脊柱不再占一列（批注 1：空的时候是个突兀的窄条）", () => {
    expect(html).not.toContain('aria-label="版本时间线"');
    expect(html).not.toContain("lr-shell__spine");
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
  it("没有内容时读面**什么都不写**（§1.0 留白）", () => {
    expect(html).not.toContain("还没有内容");
    expect(html).not.toContain("等内核把文档的读接口露出来");
    expect(html).not.toContain("lr-empty__next");
  });

  it("读面没有标题与分隔线（批注 2：不压编辑器的头部）", () => {
    expect(html).not.toContain("lr-read__header");
    expect(html).not.toContain("lr-read__title");
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

  it("折叠钮在列表栏右上角，新建是左端一个「+」（§1.0：符号优先）", () => {
    expect(html).toContain("lr-list__collapse");
    expect(html).toContain("收起列表");
    // 新建是符号，不是文字按钮
    expect(html).toContain("lr-list__create");
    expect(html).toContain('aria-label="新建"');
    // 状态条上不该再有开关
    expect(html).not.toContain("lr-statusbar__chrome");
  });

  it("右上角是账户位，不是「新建」", () => {
    expect(html).toContain("lr-avatar");
    expect(html).toContain('aria-label="账户"');
  });

  it("空列表不写字（批注 4b）", () => {
    expect(html).not.toContain("lr-list__empty");
  });

  it("导航是纯图标：图标不占可见文字，但名字给了读屏与悬停", () => {
    expect(html).not.toContain("lr-nav__label");
    expect(html).toContain('aria-label="笔记"');
    expect(html).toContain('title="笔记"');
  });
});
