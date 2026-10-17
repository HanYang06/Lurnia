// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * Button（ui.md §八 的原语清单之一）。
 *
 * 六个状态全在 [Button.css](Button.css) 里写死（§4.2 要求「缺一不可」），其中焦点环由
 * base.css 全局提供 —— 这是有意的：§4.3 说焦点可见性是基础设施，每个组件各写一遍
 * 迟早会有一个漏掉。`src/components/states.test.ts` 盯着这条。
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cx } from "./cx";
import "./Button.css";

export type ButtonVariant = "primary" | "quiet";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** `primary` 是填充态（强调色），`quiet` 是次级动作。 */
  variant?: ButtonVariant;
  children: ReactNode;
};

export function Button({
  variant = "primary",
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cx("lr-button", `lr-button--${variant}`, className)}
      // 默认 button 而不是 submit：这个界面里没有表单提交语义，误触提交更难查。
      type={type}
      {...rest}
    />
  );
}
