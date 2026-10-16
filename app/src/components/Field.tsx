// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 表单类原语：`Input`、`Select`、`Checkbox`、`Switch`。
 *
 * 四个都**自带标签**，不给「无标签输入框」留口子：`label` 是必填属性，内部用
 * `useId()` 把 `<label for>` 接上。这不是形式主义 —— 无标签控件在读屏下只是一个
 * 没有名字的框，而 ui.md §7.3 要的是「不依赖颜色与视觉也能用」。
 */

import { useId, type InputHTMLAttributes, type SelectHTMLAttributes } from "react";

import { cx } from "./cx";
import "./Field.css";

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
  label: string;
  className?: string;
};

export function Input({ label, id, className, ...rest }: InputProps) {
  const fieldId = useId();
  const htmlId = id ?? fieldId;
  return (
    <div className={cx("lr-field", className)}>
      <label className="lr-field__label" htmlFor={htmlId}>
        {label}
      </label>
      <input className="lr-input" id={htmlId} {...rest} />
    </div>
  );
}

export type SelectOption = { value: string; label: string };

export type SelectProps = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "children" | "className"
> & {
  label: string;
  options: readonly SelectOption[];
  className?: string;
};

export function Select({ label, id, options, className, ...rest }: SelectProps) {
  const fieldId = useId();
  const htmlId = id ?? fieldId;
  return (
    <div className={cx("lr-field", className)}>
      <label className="lr-field__label" htmlFor={htmlId}>
        {label}
      </label>
      <select className="lr-select" id={htmlId} {...rest}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export type CheckboxProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "className"
> & {
  label: string;
  className?: string;
};

export function Checkbox({ label, id, className, ...rest }: CheckboxProps) {
  const fieldId = useId();
  const htmlId = id ?? fieldId;
  return (
    <div className={cx("lr-field", "lr-field--row", className)}>
      <input className="lr-checkbox" id={htmlId} type="checkbox" {...rest} />
      <label className="lr-field__label" htmlFor={htmlId}>
        {label}
      </label>
    </div>
  );
}

export type SwitchProps = {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
};

/**
 * 开关用 `role="switch"` 而不是伪装成复选框：读屏会念出「开 / 关」，比
 * 「已选中 / 未选中」贴近它实际表达的东西。键盘可达性由 `<button>` 本身提供。
 */
export function Switch({
  label,
  checked,
  onChange,
  disabled = false,
  className,
}: SwitchProps) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={cx("lr-switch", className)}
      disabled={disabled}
      onClick={() => {
        onChange(!checked);
      }}
      role="switch"
      type="button"
    >
      <span className="lr-switch__thumb" />
    </button>
  );
}
