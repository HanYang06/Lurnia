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

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.4"
      viewBox="0 0 16 16"
      width="16"
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
      <path d="M3 5.2h10M3 10.8h10" />
      <circle cx="6" cy="5.2" r="1.6" />
      <circle cx="10.4" cy="10.8" r="1.6" />
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
