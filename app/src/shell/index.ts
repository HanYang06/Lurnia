// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 外壳的出口。页面只从这里拿东西，不直接 `import "./Shell"`。
 */

export {
  ListPane,
  LogSpine,
  NavRail,
  ReadPane,
  Shell,
  TopBar,
  TopPanelButton,
  type ListEntry,
  type NavModule,
  type TopPanel,
  type ShellLayout,
  type ShellProps,
  type VersionNode,
} from "./Shell";

export { BrandLockup, BrandMark } from "./brand";
export { WindowControls } from "./WindowControls";
export { Welcome, type Shortcut } from "./Welcome";

export {
  AiIcon,
  ShelfIcon,
  BackIcon,
  CollapseIcon,
  ExpandIcon,
  LockIcon,
  NoteIcon,
  PermissionIcon,
  ProjectIcon,
  SettingsIcon,
  ToolIcon,
  UserIcon,
} from "./icons";
