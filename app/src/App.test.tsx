// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 五区外壳的验收测试（路线 095）。
 *
 * ui.md §3.1 把界面切成五个区（2026-10-17 起没有右侧栏），其中**脊柱是签名元素** ——
 * 它不能只是「有个地方留给它」，得在真实渲染出来的标记里确实存在。所以这里把整个 App
 * 渲成字符串，然后逐个认这些区，并检查没有数据的地方写的是**空态**而不是假数据。
 *
 * 用 `react-dom/server`：`useEffect` 不会在服务端渲染里跑，所以内核订阅不会真的发出
 * 去，测试也不需要 Tauri 宿主。
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import App from "./App";

const html = renderToStaticMarkup(<App />);

describe("ui.md §3.1：五个区都在", () => {
  it("导航条", () => {
    expect(html).toContain('aria-label="模块"');
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

  it("没有右侧栏（本轮批注 2：编辑器页面不存在这个概念）", () => {
    // 检视器那一列与窄窗口下的图标条一起撤了；内核事实现挂在「关于」里。
    expect(html).not.toContain("lr-inspector");
    expect(html).not.toContain("lr-rail");
    expect(html).not.toContain("data-inspector");
  });

  it("状态条：核心状态与事件计数", () => {
    expect(html).toContain("lr-statusbar");
    expect(html).toContain("lr-statusbar__slot");
  });
});

describe("读面就是编辑面（editor.md §8.1）", () => {
  it("还没打开任何文档时给**欢迎面**，不是一片空白", () => {
    // 学 VS Code 的空编辑器：大 logo + 快捷键，双击这一片就新建。
    expect(html).toContain("lr-welcome");
    expect(html).toContain("Ctrl");
  });

  it("欢迎面上的快捷键与真实绑定同源（Ctrl+N / Ctrl+S / Ctrl+K / Ctrl+B）", () => {
    for (const key of ["N", "S", "K", "B"]) {
      expect(html).toContain(`>${key}<`);
    }
  });

  it("编辑面没有标题牌、没有工具栏（§3.1 批注 2 / 117 未定）", () => {
    expect(html).not.toContain("lr-read__title");
    expect(html).not.toContain("lr-toolbar");
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

  it("新建是栏顶的长条：图标 + 「新建」+ 快捷键提示（第三轮）", () => {
    expect(html).toContain("lr-list__create");
    expect(html).toContain("lr-list__create-label");
    expect(html).toContain("新建");
    // 长条右端顺手显示快捷键 —— 这是用户明确要的「信息密度靠结构」
    expect(html).toContain("lr-list__create-keys");
    expect(html).toContain("Ctrl + N");
    // 笔记模块**能新建**（doc.save 那条路已经通了），所以它不是禁用的
    expect(html).not.toMatch(/lr-list__create[^>]*disabled/);
  });

  it("收起钮在列表栏头行右端，且收起之后**收得回来**", () => {
    // 收起钮长在被收起的那个栏里：不给回头路的话这个动作就是单向的（实测撞过）。
    expect(html).toContain("lr-list__collapse");
    expect(html).toContain("收起列表");
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

describe("工具与属性在顶栏右端（第四轮）", () => {
  it("两颗钮在顶栏，不在导航条上", () => {
    // 它们是对「当前这份文档」的动作，和账户位、窗口控制同一层。
    expect(html.match(/lr-topbar__panel-host/g)).toHaveLength(2);
    expect(html).toContain('aria-label="工具"');
    expect(html).toContain('aria-label="属性"');
  });

  it("还没打开文档时两颗钮是禁用的（比弹一个空面板诚实）", () => {
    expect(html).toMatch(/lr-topbar__panel-button[^>]*disabled/);
  });
});

describe("收起列表不留列（第四轮）", () => {
  it("收起钮在栏头右端；展开钮由外壳在正文左上角浮出", () => {
    expect(html).toContain("lr-list__collapse");
    // 默认是展开的，所以浮出的展开钮此刻不出现 —— 它在 Shell 的收起状态下才渲染，
    // 由 src/shell/listpane.test.tsx 覆盖。
    expect(html).not.toContain("lr-list-rail");
  });
});
