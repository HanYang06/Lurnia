// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 列表栏的三个「不得不」：新建长条、收起钮、只读小锁。
 *
 * 这些都不是业务逻辑，但它们一旦回归就是**用户直接撞上**的那种：新建点不动、
 * 收起了回不来、改不了的条目看起来和能改的一模一样。
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ListPane, Shell, type ListEntry } from "./Shell";

function render(props: Partial<Parameters<typeof ListPane>[0]> = {}): string {
  return renderToStaticMarkup(
    <ListPane
      active={null}
      entries={[]}
      label="笔记"
      onCollapse={() => undefined}
      onSelect={() => undefined}
      {...props}
    />,
  );
}

describe("列表栏", () => {
  it("给了 onCreate 才渲染新建长条，且带快捷键提示", () => {
    const withCreate = render({ createKeys: "Ctrl + N", onCreate: () => undefined });
    expect(withCreate).toContain("lr-list__create");
    expect(withCreate).toContain("新建");
    expect(withCreate).toContain("Ctrl + N");
  });

  it("没有新建这件事的模块就不该有一颗永远禁用的加号", () => {
    expect(render()).not.toContain("lr-list__create");
  });

  it("收起钮与新建**不在同一行**：收起钮独占头行，胶囊在下一行吃满整栏", () => {
    // 第七轮：挤在同一行时胶囊被挤窄 39px，右缘和下面的条目对不齐。
    const html = render({ createKeys: "Ctrl + N", onCreate: () => undefined });
    expect(html).toContain("lr-list__create-row");
    const head = /<div class="lr-list__head">[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
    expect(head).toContain("lr-list__collapse");
    expect(head).not.toContain("lr-list__create");
    // 胶囊在头行**之后**，不在里面。
    expect(html.indexOf("lr-list__create-row")).toBeGreaterThan(
      html.indexOf("lr-list__head"),
    );
  });

  it("收起钮一直在（它是「怎么把这一栏收回去」的唯一入口）", () => {
    expect(render()).toContain("收起列表");
  });

  it("只读条目带一把小锁，且锁不是颜色单通道（有读屏文本）", () => {
    const entries: readonly ListEntry[] = [
      { id: "a", label: "能改的" },
      { id: "b", label: "改不了的", locked: true },
    ];
    const html = renderToStaticMarkup(
      <ListPane
        active={null}
        entries={entries}
        label="笔记"
        onCollapse={() => undefined}
        onSelect={() => undefined}
      />,
    );
    expect(html).toContain("lr-list__lock");
    expect(html).toContain('aria-label="只读"');
    // 只有那一条带锁：能改的条目上多一把锁比没有锁更坏。
    expect(html.match(/lr-list__lock/g)).toHaveLength(1);
    expect(html).toContain("改不了的");
  });
});

describe("外壳：列表栏收起之后必须收得回来", () => {
  const slots = {
    list: <p>列表内容</p>,
    nav: <p>导航</p>,
    read: <p>读面</p>,
    status: <p>状态</p>,
    top: <p>顶栏</p>,
  };
  const shell = renderToStaticMarkup(
    <Shell
      {...slots}
      layout={{ listOpen: false, pane: "read" }}
      onExpandList={() => undefined}
    />,
  );

  it("收起时**不留列**，但正文左上角浮出一颗展开钮 —— 收起仍然不是单向的", () => {
    // 第四轮：留一列 32px 等于「为一个按钮多出一列」，很丑；改成浮出的小箭头。
    expect(shell).not.toContain("lr-list-rail");
    expect(shell).toContain("lr-shell__expand");
    expect(shell).toContain("展开列表");
  });

  it("展开时那条窄条不出现（它只在收起状态下有意义）", () => {
    const open = renderToStaticMarkup(
      <Shell
        {...slots}
        layout={{ listOpen: true, pane: "read" }}
        onExpandList={() => undefined}
      />,
    );
    expect(open).not.toContain("lr-shell__expand");
  });
});
