// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 品牌标识的验收测试。
 *
 * 这里锁三件事，都是「改一行代码就会悄悄坏、但屏幕上未必立刻看得出来」的：
 *
 * 1. **图形用的是裁掉透明留白的那一档**。`lurnia-rich-*` 还留给别处用，但标识本身
 *    必须指向 `lurnia-mark-*`；否则哪天有人把 import 换回带留白的旧图，对齐规则的
 *    前提（盒子边 = 内容边）就没了。
 * 2. **图形是装饰**：`alt=""`。品牌名由文字承担，图片再念一遍就是念两遍。
 * 3. **对齐规则**：`inline-flex` + `align-items: center` 把图形方框与字标行盒居中，
 *    字标再上移 `WORDMARK_OFFSET_PX` 补偿 cap-height 中线与行盒中线的 1px 差。
 *    规则本身是常量，测试认的是「标记里真的用上了这个常量」，不是某个魔法数字。
 *
 * 用 `renderToStaticMarkup`（与 `welcome.test.tsx` 同一写法）：断言都在静态标记里，
 * 不需要挂载 DOM。
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BrandLockup, BrandMark, WORDMARK_OFFSET_PX } from "./brand";

const lockup = renderToStaticMarkup(<BrandLockup size={26} />);
const mark = renderToStaticMarkup(<BrandMark size={26} />);

/** 从标记里取出唯一那张图的 src，避免「整段里恰好没有某字样」式的假断言。 */
function imageSrc(markup: string): string {
  return /<img[^>]*\ssrc="([^"]+)"/.exec(markup)?.[1] ?? "";
}

describe("品牌锁定组合", () => {
  it("同时给出图形与「Lurnia」字标", () => {
    expect(lockup).toContain("<img");
    expect(lockup).toContain(">Lurnia<");
    // 图形在字标之前：锁定的读法是「先图后名」。
    expect(lockup.indexOf("<img")).toBeLessThan(lockup.indexOf("Lurnia"));
  });

  it("图形用的是裁剪后的新资源，不是带留白的 rich 图", () => {
    expect(imageSrc(lockup)).toBe("/src/assets/brand/lurnia-mark-64.png");
    expect(lockup).not.toContain("lurnia-rich");
  });

  it("图形是装饰：alt 为空", () => {
    expect(lockup).toContain('alt=""');
    expect(lockup).not.toContain('alt="Lurnia"');
  });

  it("字标走令牌：sans、600、strong", () => {
    expect(lockup).toContain("font-family:var(--lr-font-sans)");
    expect(lockup).toContain("font-weight:600");
    expect(lockup).toContain("color:var(--lr-text-strong)");
  });

  it("对齐规则可测：居中 + 字标上移 WORDMARK_OFFSET_PX", () => {
    expect(lockup).toContain("display:inline-flex");
    expect(lockup).toContain("align-items:center");
    expect(lockup).toContain("gap:var(--lr-space-8)");
    expect(lockup).toContain(`inset-block-start:${WORDMARK_OFFSET_PX}px`);
    // 这是 1px 级字体度量修正，不是可以随便拧大的布局参数。
    expect(Math.abs(WORDMARK_OFFSET_PX)).toBeLessThanOrEqual(2);
  });
});

describe("单独使用的图形", () => {
  it("只有图形，且不朗读", () => {
    expect(mark).toContain('alt=""');
    expect(mark).not.toContain("Lurnia");
  });

  it("方框内按比例居中，不把裁紧的位图拉扁", () => {
    expect(mark).toContain('width="26"');
    expect(mark).toContain('height="26"');
    expect(mark).toContain("object-fit:contain");
  });
});
