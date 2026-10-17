// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 品牌标识：图形（BrandMark）与「图形 + 字标」（BrandLockup）。
 *
 * ## 关于「一体化的 SVG」
 *
 * 维护者要的是「一次对齐、到处一致」，而不是某个具体格式。这里没有矢量源 —— 水豚是
 * 一张低多边形位图，照着描一遍只会得到一版更差的图形；**真正的矢量锁定图要等 logo
 * 重设计（路线 014）**。在那之前，这一版用「裁好的位图 + 写死的对齐规则」拿到同样的
 * 确定性：组合只在本文件里画一次，顶栏和以后任何用到它的地方都是同一个组合。
 *
 * ## 旧组合为什么错位
 *
 * 不是因为留白，主要是因为行内基线：旧实现把 `<img>` 直接放进文本流，图片默认
 * `vertical-align: baseline`，**底边**落在字标基线上。26px 的图形因此比字标高一截，
 * 图形中心在基线上方 13px、cap-height 中心只在基线上方 5.6px，差约 7px。
 *
 * 留白也量过：`lurnia-rich-256.png` 的 alpha 包围盒是 (4, 12, 254, 244)，四边留白
 * 4 / 12 / 2 / 12 —— 垂直方向本来就是对半分的，裁掉它并不会移动垂直中线。
 * 留白真正的问题是让**盒子的边**不再等于**内容的边**，任何按盒子对不齐的地方都会
 * 累积出偏差；所以资源仍然按包围盒裁紧，但对齐交给下面的规则显式完成。
 *
 * ## 现在的对齐规则（可测）
 *
 * 规则只有一句：**字标的 cap-height 中线 == 图形的中线**。
 *
 * 1. 图形资源是紧贴内容的：`lurnia-mark-250.png` 是 256 那张按 alpha 包围盒裁出的
 *    250×232（四边 0 透明像素），`lurnia-mark-64.png` 是它的 64 宽版本（64×59）。
 *    BrandMark 只引 64 那一档：顶栏用 26px，64px 的源仍有 2.46 倍余量；250 是给
 *    欢迎面那种大尺寸留的主资源（等 Welcome 换裁剪版时直接换 import）。
 * 2. 图形画进 `size × size` 的方框，`object-fit: contain` 按原始长宽比居中 ——
 *    方框中线就是内容中线，`size` 仍然表示方框边长，水豚也不会被拉扁。
 * 3. 组合用 `inline-flex` + `align-items: center`，图形方框与字标行盒各自居中。
 *    但行盒中线**不是** cap-height 中线：Segoe UI（Windows/Tauri 的 system-ui）
 *    的 ascent 约 1.08em、descent 约 0.25em、cap-height 约 0.70em —— 上方比
 *    cap-height 多出的空间比下方 descender 多约 0.065em，行盒中线因此比 cap
 *    中线低：16px 下实算 cap 中心 11.8、行盒中心 10.8（14px 下约 0.9px）。
 *    所以字标上移 `WORDMARK_OFFSET_PX`（-1px）让两条中线重合。这是字体度量，
 *    不是审美微调。
 *
 * 这个 1px 只按 Windows 的 system-ui（Segoe UI）标定；换到别的字体误差在 1px 以内。
 *
 * 几处刻意的不做，都是 ui.md §1.0 的判断：
 *
 * - **不加 `title`**。顶栏那圈里已经有「Lurnia」四个字，再给图片挂一个悬停提示只是
 *   让同一个名字出现两遍。
 * - **不做动画、不加边框底纹**。标识不是状态，没有状态变化要表达（§1.0「非必要不动」）。
 * - **字标不超过 `--lr-font-size-read`**。顶栏只有 48px 高，字号再大就会把顶栏撑开，
 *   而顶栏高度是 §3.1 的栏位预算，不归标识决定。
 *
 * 返回类型写 `ReactElement` 而不是全局 `JSX.Element`：本仓库的 `jsx` 是 `react-jsx`，
 * React 19 之后没有全局 `JSX` 命名空间，`JSX.Element` 在这个 TS 版本下根本解析不了
 * （`src/shell/WindowControls.tsx` 里也踩过同一个坑）。
 */

import type { ReactElement } from "react";

import mark64 from "../assets/brand/lurnia-mark-64.png";

/**
 * 字标相对图形中线的上下偏移（px，负值上移）。数值的来历见文件头：行盒中线比
 * cap-height 中线低约 1px。导出成常量，是为了让测试认「规则」而不是随手写下的字面量。
 */
export const WORDMARK_OFFSET_PX = -1;

/**
 * 只有图形，给需要单独标志的地方用（顶栏的锁定组合内部，以及以后只放图形的位置）。
 *
 * `alt=""`：单独用的时候图形旁边一定有文字（否则没人知道这是什么），
 * 所以这一层不承担朗读职责，别让读屏把品牌念两遍。
 *
 * `object-fit: contain` 是裁剪资源的配套：裁紧的位图不是正方形（250×232），
 * 塞进 `size × size` 的方框时必须按比例居中，不能默认拉伸铺满。
 */
export function BrandMark({ size }: { size: number }): ReactElement {
  return (
    <img
      alt=""
      height={size}
      src={mark64}
      style={{ display: "block", objectFit: "contain" }}
      width={size}
    />
  );
}

/**
 * 「图标 + 文字」的水平锁定：左边图形、右边 Lurnia 字标。
 *
 * **锁定**是字面意思：图形与字标之间的 8 是固定的，`size` 一起决定图形边长与字标字号，
 * 两者不会各自漂移 —— 于是顶栏的 26 与以后任何更大的刻度是同一个组合的两个刻度，
 * 不是两套排版。
 *
 * 用 `<span>` 而不是 `<h1>`：这是标识的复述，不是页面标题（欢迎面本身也不是页面）。
 */
export function BrandLockup({ size }: { size: number }): ReactElement {
  // 两档而已：16px 的图形配正文档，更大的图形配 read 档（字标允许的最大档）。
  // 不按 size 连续缩放字号 —— 字号只有五档（§4.5），标识不例外。
  const fontSize = size > 20 ? "var(--lr-font-size-read)" : "var(--lr-font-size-body)";

  return (
    <span
      style={{
        // 组合自己就是对齐容器：图形方框与字标行盒按 cross axis 居中，
        // 不再让 `<img>` 落进文本流的基线（那正是旧版错位约 7px 的原因）。
        alignItems: "center",
        color: "var(--lr-text-strong)",
        display: "inline-flex",
        fontFamily: "var(--lr-font-sans)",
        fontSize,
        fontWeight: 600,
        // 8 做成容器的 gap：两条边固定，图形换成更大一档时字标不会贴上去。
        gap: "var(--lr-space-8)",
        // 行高跟着字号档收紧：标识是一行，不该按正文的行距把自己撑高。
        lineHeight: "var(--lr-line-tight)",
      }}
    >
      <BrandMark size={size} />
      {/*
       * 只挪字标、不挪图形：图形是参照物，`inset-block-start` 让字标的
       * cap-height 中线落回图形中线上（见文件头的 1px 实测）。
       * 用 `position: relative` 而不是改 margin：偏移不参与布局，组合的盒高不变。
       */}
      <span
        style={{
          insetBlockStart: `${WORDMARK_OFFSET_PX}px`,
          position: "relative",
        }}
      >
        Lurnia
      </span>
    </span>
  );
}
