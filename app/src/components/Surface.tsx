// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 承载类原语：`Card`（面板）、`Skeleton`（占位）、`Meter`（量度）。
 *
 * 三个都是**非交互**的，所以它们没有 §4.2 的六状态 —— 这一点由
 * `states.test.ts` 显式登记，免得「没写状态」与「不该有状态」被混为一谈。
 */

import type { ReactNode } from "react";

import { cx } from "./cx";
import "./Surface.css";

export type CardProps = {
  /** 卡片在层级里抬一级（底色 → surface-raised），ui.md §2.3。 */
  raised?: boolean;
  className?: string;
  children: ReactNode;
};

export function Card({ raised = true, className, children }: CardProps) {
  return (
    <div className={cx("lr-card", raised && "lr-card--raised", className)}>
      {children}
    </div>
  );
}

export type SkeletonProps = {
  /** 占几行。行宽按 i 递减，读起来像一段正在到达的正文。 */
  lines?: number;
};

export function Skeleton({ lines = 3 }: SkeletonProps) {
  return (
    <div aria-busy="true" className="lr-skeleton">
      {Array.from({ length: lines }, (_unused, index) => (
        <span
          className="lr-skeleton__line"
          key={index}
          style={{ width: `${100 - index * 12}%` }}
        />
      ))}
    </div>
  );
}

export type MeterProps = {
  value: number;
  max: number;
  /** 无障碍名：量度必须有名字，否则读屏只报一个数。 */
  label: string;
};

/** 量度条。`role="meter"` 是 ARIA 1.2 的语义角色，比自绘进度条诚实。 */
export function Meter({ value, max, label }: MeterProps) {
  const safeMax = max <= 0 ? 1 : max;
  const clamped = Math.min(Math.max(value, 0), safeMax);
  return (
    <div
      aria-label={label}
      aria-valuemax={safeMax}
      aria-valuemin={0}
      aria-valuenow={clamped}
      className="lr-meter"
      role="meter"
    >
      <span
        className="lr-meter__fill"
        style={{ width: `${(clamped / safeMax) * 100}%` }}
      />
    </div>
  );
}
