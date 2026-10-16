// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 组件原语的出口。**唯一的入口**：页面不直接 `import "./Button"`，
 * 免得同一个原语在仓库里长出两条导入路径。
 *
 * 组件清单见 ui.md §八。当前落了第一批（Button / Tag / StateBadge / Card /
 * Skeleton / Meter / Input / Select / Checkbox / Switch）；`Table`、`Toast`、
 * `Dialog` 还没做 —— 它们要浮层与焦点陷阱的基建，属于独立一段。
 */

export { Button, type ButtonProps, type ButtonVariant } from "./Button";
export { StateBadge, Tag, type Decision, type TagProps, type TagTone } from "./Badge";
export {
  Card,
  EmptyState,
  Meter,
  Skeleton,
  type CardProps,
  type EmptyStateProps,
  type MeterProps,
  type SkeletonProps,
} from "./Surface";
export {
  Checkbox,
  Input,
  Select,
  Switch,
  type CheckboxProps,
  type InputProps,
  type SelectOption,
  type SelectProps,
  type SwitchProps,
} from "./Field";
export { cx } from "./cx";
