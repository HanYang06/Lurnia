// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 导航用的几个小图标。**自己画，不引图标库**：五个 16px 的图形不值得为它拉一个
 * 依赖，而且 ui.md §3.1 明确「导航条用图标 + 文字，不是纯图标」—— 图标只是辅助。
 *
 * 一律 `stroke="currentColor"`、`fill="none"`：颜色由 CSS 令牌决定，这里不出现任何
 * 颜色字面量（ui.md §八）。
 */

import type { ReactNode } from "react";

function Glyph({
  children,
  size = 20,
  weight = 1.4,
}: {
  children: ReactNode;
  size?: number;
  weight?: number;
}) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={weight}
      viewBox="0 0 16 16"
      width={size}
    >
      {children}
    </svg>
  );
}

/** 笔记：一页带横线的纸。 */
export function NoteIcon() {
  return (
    <Glyph>
      <rect height="12" rx="1.5" width="10" x="3" y="2" />
      <path d="M5.5 6h5M5.5 9h5M5.5 12h3" />
    </Glyph>
  );
}

/** 项目：一个文件夹。 */
export function ProjectIcon() {
  return (
    <Glyph>
      <path d="M2 5.6A1.6 1.6 0 0 1 3.6 4h1.9l1.2 1.7h5.7A1.6 1.6 0 0 1 14 7.3v4.1A1.6 1.6 0 0 1 12.4 13H3.6A1.6 1.6 0 0 1 2 11.4z" />
    </Glyph>
  );
}

/** 权限：盾牌。 */
export function PermissionIcon() {
  return (
    <Glyph>
      <path d="M8 2.2l4.8 1.9v3.8c0 2.5-1.8 4.4-4.8 5.6-3-1.2-4.8-3.1-4.8-5.6V4.1z" />
      <path d="M6 8.1l1.5 1.5L10.3 6.8" />
    </Glyph>
  );
}

/** AI：一颗四角星。 */
export function AiIcon() {
  return (
    <Glyph>
      <path d="M8 2.4l1.4 3.7 3.7 1.4-3.7 1.4L8 12.6 6.6 8.9 2.9 7.5l3.7-1.4z" />
    </Glyph>
  );
}

/** 设置：两根带旋钮的滑杆。比齿轮好画，也更像「可调」而不是「机器」。 */
export function SettingsIcon() {
  return (
    <Glyph>
      <circle cx="8" cy="8" r="3.1" />
      <path d="M8 1.7v1.9M8 12.4v1.9M1.7 8h1.9M12.4 8h1.9M3.55 3.55l1.35 1.35M11.1 11.1l1.35 1.35M12.45 3.55l-1.35 1.35M4.9 11.1l-1.35 1.35" />
    </Glyph>
  );
}

/** 返回：窄窗口下从读面回到列表。 */
export function BackIcon() {
  return (
    <Glyph>
      <path d="M9.5 4L5.5 8l4 4" />
    </Glyph>
  );
}

/** 检视器：右侧栏的轮廓。窄窗口下它就是那条图标条上的按钮。 */
export function PanelIcon() {
  return (
    <Glyph size={16}>
      <rect height="12" rx="1.5" width="12" x="2" y="2" />
      <path d="M10 2v12" />
    </Glyph>
  );
}

/** 新建：一个加号。**不用文字** —— §1.0「能用符号说清就不写字」。 */
export function PlusIcon() {
  return (
    <Glyph size={18} weight={2}>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </Glyph>
  );
}

/** 账户：右上角那个头像位。还没有账户系统，所以先画一个通用的人形。 */
export function UserIcon() {
  return (
    <Glyph size={18}>
      <circle cx="8" cy="6" r="2.6" />
      <path d="M3.4 13c.6-2.2 2.4-3.4 4.6-3.4S12 10.8 12.6 13" />
    </Glyph>
  );
}
