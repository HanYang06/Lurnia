// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 编辑面的结构验收（第五轮：纸、头区、正文区）。
 *
 * 这里只认**静态标记**：ProseMirror 的视图挂在 `useEffect` 里，服务端渲染根本不跑它，
 * 所以这段测试不碰编辑器内部，只证明「纸上有头区、头区里有标题、正文有一个宿主」这件
 * 结构与样式表对得上。视图那一半由 [session.test.ts](session.test.ts) 与真机负责。
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NoteEditor } from "./Editor";
import { emptyNoteBody } from "./session";

function render(props: Partial<Parameters<typeof NoteEditor>[0]> = {}): string {
  return renderToStaticMarkup(
    <NoteEditor body={emptyNoteBody()} onChange={() => undefined} {...props} />,
  );
}

describe("一张纸：头区 + 正文区", () => {
  it("纸左右各有一条抓取带：slider + 上下限 + 可 Tab 到", () => {
    const html = render();
    expect(html.match(/class="lr-editor__grip"/g)).toHaveLength(2);
    // 它是连续值调节器，所以取 slider 角色：读屏能念出「纸宽 560，可调节」。
    expect(html.match(/role="slider"/g)).toHaveLength(2);
    // 只靠鼠标拖 = 键盘用户没有这个功能，所以它必须是可聚焦的。
    expect(html.match(/tabindex="0"/g)).toHaveLength(2);
    expect(html).toContain('aria-valuemin="400"');
    expect(html).toContain('aria-valuemax="880"');
    expect(html).toContain('aria-label="纸宽"');
  });

  it("纸里有两个区，标题与正文各归各的宿主", () => {
    const html = render();
    expect(html).toContain("lr-editor__head");
    expect(html).toContain("lr-editor__title");
    expect(html).toContain("lr-editor__body");
  });

  it("标题是一个**有标签**的输入：占位说「无标题」，读屏念「标题」", () => {
    const html = render();
    expect(html).toContain('aria-label="标题"');
    expect(html).toContain('placeholder="无标题"');
    // 不给 onChange 时是只读的同一片版面（只读视图也走这个组件）。
    expect(html).toMatch(/lr-editor__title[^>]*readonly/i);
  });

  it("给了 onTitleChange 就可写，并且显示传进来的标题", () => {
    const html = render({ onTitleChange: () => undefined, title: "周报" });
    expect(html).not.toMatch(/lr-editor__title[^>]*readonly/i);
    expect(html).toContain('value="周报"');
  });

  it('空页的水印是**装饰**：带 alt="" 与 aria-hidden，读屏与 Tab 都不会碰到它', () => {
    const html = render();
    const mark = /<img[^>]*lr-editor__mark[^>]*>/.exec(html)?.[0] ?? "";
    expect(mark).not.toBe("");
    // 属性顺序不该被测试绑住，所以先切出这一颗 img 再逐条查。
    expect(mark).toContain('alt=""');
    expect(mark).toContain('aria-hidden="true"');
  });

  it("标题**不写进正文**：正文宿主是空的（内容是编辑器挂载后塞进去的）", () => {
    const html = render({ onTitleChange: () => undefined, title: "周报" });
    expect(html).toContain('<div class="lr-editor__body"></div>');
    expect(html).not.toContain("lr-editor__surface");
  });
});
