// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 欢迎面与品牌标识的验收测试。
 *
 * 这里盯的是三件**只在标记里成立**的事，因为这三件都容易被「顺手简化」掉：
 *
 * 1. **键帽是分开的**。把 `["Ctrl","N"]` 拼成 `Ctrl+N` 一个字符串渲染出来，屏幕上
 *    几乎一样，但键帽的边界（两颗分开的 `<kbd>`）没了 —— 而边界正是这个东西的全部形式。
 * 2. **大图用 256 那一档**。换成 64 那一档肉眼也能看出来糊，但测试认的是资源路径，
 *    这样「哪天有人统一改成 64」会在门禁上红，而不是等到截图里才发现。
 * 3. **装饰图不朗读**：`alt=""`。品牌名在标识里由文字承担，图片再来一遍就是念两遍。
 *
 * 用 `renderToStaticMarkup`（与 App.test.tsx 同一写法）：这几个断言都在静态标记里，
 * 不需要 DOM 事件，也就不需要挂载。
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BrandLockup, BrandMark } from "./brand";
import { Welcome, type Shortcut } from "./Welcome";

/** 三条，覆盖单键、双键与三键三种长度。 */
const SHORTCUTS: readonly Shortcut[] = [
  { label: "新建笔记", keys: ["Ctrl", "N"] },
  { label: "搜索", keys: ["Ctrl", "K"] },
  { label: "保存", keys: ["Ctrl", "Shift", "S"] },
];

const welcome = renderToStaticMarkup(
  <Welcome onNew={() => undefined} shortcuts={SHORTCUTS} />,
);

describe("欢迎面：标签在左、键位在右", () => {
  it("三条快捷键的标签都在", () => {
    for (const shortcut of SHORTCUTS) {
      expect(welcome).toContain(shortcut.label);
    }
  });

  it("键帽是**分开**渲染的，不是拼成 `Ctrl+N`", () => {
    // 每颗键帽各自一个 <kbd>：数一数就知道有没有被拼起来（3 条共 7 颗键）。
    expect(welcome.match(/<kbd/g)).toHaveLength(7);
    // 拼成一串的写法会留下 `Ctrl+N` 这样的文本；它不该出现。
    expect(welcome).not.toContain("Ctrl+N");
    expect(welcome).not.toContain("Ctrl+K");
    expect(welcome).not.toContain("Ctrl+Shift+S");
    // `+` 仍然在，只是作为两颗键帽之间的装饰，不进无障碍树。
    expect(welcome).toContain('aria-hidden="true" class="lr-welcome__plus"');
  });

  it("每条快捷键的标签与键位在**同一行**里，且标签在键位之前", () => {
    const row = welcome.slice(
      welcome.indexOf("lr-welcome__row"),
      welcome.indexOf("lr-welcome__row") + 400,
    );
    expect(row.indexOf("新建笔记")).toBeGreaterThan(-1);
    expect(row.indexOf("lr-welcome__key")).toBeGreaterThan(row.indexOf("新建笔记"));
  });
});

describe("欢迎面：大 logo", () => {
  it("用的是 256 那一档资源", () => {
    // 只认**这张图**的 src，不用信整段标记里恰好没有 64 的字样。
    const src = /<img alt="" class="lr-welcome__mark"[^>]*src="([^"]+)"/.exec(
      welcome,
    )?.[1];
    expect(src).toContain("lurnia-mark-250");
  });

  it("图是装饰：alt 为空", () => {
    expect(welcome).toContain('<img alt="" class="lr-welcome__mark"');
    expect(welcome).not.toContain('<img alt="Lurnia"');
  });

  it("这一片不是按钮：没有 role 与 tabindex", () => {
    // 双击是隐藏操作，它的可达路径是列表栏那颗新建按钮，不是把这一片伪装成控件。
    expect(welcome).not.toContain('role="button"');
    expect(welcome).not.toContain("tabindex");
  });
});

describe("品牌标识", () => {
  it("BrandLockup 同时给出图形与「Lurnia」字标", () => {
    const markup = renderToStaticMarkup(<BrandLockup size={16} />);
    expect(markup).toContain("<img");
    expect(markup).toContain("lurnia-mark-64");
    expect(markup).toContain("Lurnia");
  });

  it("BrandMark 只有图形，且不朗读", () => {
    const markup = renderToStaticMarkup(<BrandMark size={16} />);
    expect(markup).toContain('alt=""');
    expect(markup).toContain('src="/src/assets/brand/lurnia-mark-64.png"');
    expect(markup).not.toContain("Lurnia");
  });
});
