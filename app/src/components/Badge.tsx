// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 标签类原语：`Tag`（中性标签）与 `StateBadge`（三态徽标）。
 *
 * **`StateBadge` 是唯一允许内置三态语义的组件**（ui.md §八）。别的地方不许猜状态颜色，
 * 更不许把 `Decision` 压成布尔 —— I2 规定三态不得塌陷，所以这里的入参是**三值枚举**，
 * 类型上就传不进 `true`。三个状态在视觉上同级：同明度同彩度，只有色相不同。
 */

import type { ReactNode } from "react";

import { cx } from "./cx";
import "./Badge.css";

/** 与内核 `Decision` 的三个取值逐字一致（`src/lurnia/core/contracts.py`）。 */
export type Decision = "allow" | "deny" | "uncertain";

/** 形状是**冗余编码**，不是装饰（ui.md §2.5 第 3 条）：色觉异常或灰度下信息不丢。 */
const SHAPE: Record<Decision, string> = {
  allow: "✓",
  deny: "✗",
  uncertain: "?",
};

const LABEL: Record<Decision, string> = {
  allow: "允许",
  deny: "拒绝",
  // 不确定是一等状态，不是错误 —— 措辞里不许出现「失败」。
  uncertain: "待裁",
};

export function StateBadge({ decision }: { decision: Decision }) {
  return (
    <span
      className={cx("lr-state-badge", `lr-state-badge--${decision}`)}
      data-decision={decision}
    >
      <span aria-hidden="true" className="lr-state-badge__shape">
        {SHAPE[decision]}
      </span>
      {LABEL[decision]}
    </span>
  );
}

export type TagTone = "neutral" | "accent";

export type TagProps = {
  tone?: TagTone;
  children: ReactNode;
};

/** 中性标签。分类靠图标与文字，**不靠颜色**（ui.md §十 待裁第 3 条的当前倾向）。 */
export function Tag({ tone = "neutral", children }: TagProps) {
  return <span className={cx("lr-tag", `lr-tag--${tone}`)}>{children}</span>;
}
