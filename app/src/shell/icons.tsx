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

/**
 * 收起列表：两个左向尖角。以前这里是文字字符「«」—— 字号小、点击目标只有 24px，
 * 实测点不准（本轮批注 3），所以改画成 16px 的图形，按钮本身给到 32×32。
 */
export function CollapseIcon() {
  return (
    <Glyph size={16}>
      <path d="M8.4 4.2L4.6 8l3.8 3.8" />
      <path d="M12.4 4.2L8.6 8l3.8 3.8" />
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

/**
 * 工具：一把扳手。**它和「设置」不是一回事**：设置是「这套工具怎么配」，工具是
 * 「当前这份东西能做什么」。点开是上层浮层（弹出框），不是又一列。
 */
export function ToolIcon() {
  return (
    <Glyph>
      <path d="M10.6 2.6a3.6 3.6 0 0 0-4.4 4.6L2.6 10.8l2.6 2.6 3.6-3.6a3.6 3.6 0 0 0 4.6-4.4l-2 2-2.4-.6-.6-2.4z" />
    </Glyph>
  );
}

/**
 * 属性：**书架**，不是档案盒。维护者原话：「它应该是档案图标，不是归档图标」
 * —— 档案是**存着的东西**（书架上一排书），归档是一个动作（往盒子里塞）。
 * 这里画三本立着的书 + 一条搁板，缩到 20px 也还认得出是书架。
 */
export function ShelfIcon() {
  return (
    <Glyph>
      <path d="M2.4 3.2h2.4v9.4H2.4z" />
      <path d="M5.9 3.2h2.4v9.4H5.9z" />
      <path d="M9.3 4.3l2.3-.65 1.9 8.75-2.3.65z" />
      <path d="M1.8 12.6h12.4" />
    </Glyph>
  );
}

/**
 * 锁：条目的「改不了」标记。**只标真的改不了的**（权限判定的结果），不标「暂时没做」——
 * 后者该由禁用态表达，而不是在名字后面挂一把锁。
 */
export function LockIcon() {
  return (
    <Glyph size={12} weight={1.6}>
      <rect height="6" rx="1.2" width="9" ry="1.2" x="3.5" y="7" />
      <path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" />
    </Glyph>
  );
}

/** 展开列表栏：收起之后留在读面左边那条窄条上的那颗钮（收起方向的反面）。 */
export function ExpandIcon() {
  return (
    <Glyph size={16}>
      <path d="M7.6 4.2L11.4 8l-3.8 3.8" />
      <path d="M3.6 4.2L7.4 8l-3.8 3.8" />
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
