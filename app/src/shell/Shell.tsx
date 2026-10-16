// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 四区外壳（ui.md §3.1）。这一段是**布局**，不含业务：六个区都以插槽传入，
 * 谁来填由 App 决定；折叠/前后台状态也由 App 持有，Shell 只把它们写成 `data-*`，
 * 让 CSS 去决定长什么样。
 *
 * | 区 | 宽度 | 可折叠 |
 * | --- | --- | --- |
 * | 导航条 | 72px | 否 |
 * | 列表栏 | 242px | 是 |
 * | 日志脊柱 | 88px | 否（≥820px） |
 * | 读面 | 弹性，正文 `58ch` | — |
 * | 检视器 | 232px | 是，默认展开 |
 * | 状态条 | 28px | 否 |
 *
 * 收窄行为（§3.3）**全在 CSS 里**，不靠 JS 读窗口宽度：**先收检视器，再收列表栏，
 * 最后才动读面**。JS 只表达两件 CSS 表达不了的事 —— 用户手动的折叠开关，以及
 * `< 820px` 时「列表 / 读面」谁在前台。这样拖窗口时不会出现「React 状态与真实宽度
 * 不一致」的那一帧。
 */

import type { ReactNode } from "react";

import { Button } from "../components";
import "./Shell.css";

export type NavModule = {
  id: string;
  label: string;
  icon: ReactNode;
};

/** 导航条：图标 + 文字（§3.1：纯图标是桌面工具最常见的傲慢）。 */
export function NavRail({
  modules,
  active,
  onSelect,
  settings,
}: {
  modules: readonly NavModule[];
  active: string;
  onSelect: (id: string) => void;
  settings: NavModule;
}) {
  const renderItem = (module: NavModule) => (
    <li key={module.id}>
      <button
        aria-current={module.id === active ? "page" : undefined}
        className="lr-nav__item"
        onClick={() => {
          onSelect(module.id);
        }}
        type="button"
      >
        <span aria-hidden="true" className="lr-nav__icon">
          {module.icon}
        </span>
        <span className="lr-nav__label">{module.label}</span>
      </button>
    </li>
  );

  return (
    <nav aria-label="模块" className="lr-nav">
      <ul className="lr-nav__list">{modules.map(renderItem)}</ul>
      {/* 设置固定在底部：它是「关于这套工具」，不是某个模块（§3.1）。 */}
      <ul className="lr-nav__foot">{renderItem(settings)}</ul>
    </nav>
  );
}

export type ListEntry = { id: string; label: string };

/** 列表栏：当前模块的条目集合；选中项由左侧 2.5px 强调条标识（§3.1、§4.2）。 */
export function ListPane({
  title,
  entries,
  active,
  onSelect,
  empty,
}: {
  title: string;
  entries: readonly ListEntry[];
  active: string | null;
  onSelect: (id: string) => void;
  empty: string;
}) {
  return (
    <div className="lr-list">
      <h2 className="lr-list__title">{title}</h2>
      {entries.length === 0 ? (
        <p className="lr-list__empty">{empty}</p>
      ) : (
        <ul className="lr-list__items">
          {entries.map((entry) => (
            <li key={entry.id}>
              <button
                aria-current={entry.id === active ? "true" : undefined}
                className="lr-list__item"
                onClick={() => {
                  onSelect(entry.id);
                }}
                type="button"
              >
                {entry.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export type VersionNode = {
  id: string;
  label: string;
  stamp: string;
  /** 当前版本用实心点、历史版本用空心点 —— 形状冗余，不只靠颜色（§3.2）。 */
  current: boolean;
};

/**
 * **签名元素**：读面左侧 88px 的竖向版本时间线（§3.2）。
 *
 * 它把 I5（先写事件日志）与 I4（一切持久化数据带 version）变成屏幕左边一直看得见
 * 的东西。现在还没有数据源 —— 文档版本时间线要等 doc 能力的读接口，所以这里渲染的是
 * **诚实的空态**，不是假数据。
 */
export function LogSpine({ versions }: { versions: readonly VersionNode[] }) {
  return (
    <aside aria-label="版本时间线" className="lr-spine">
      <h2 className="lr-spine__title">版本</h2>
      {versions.length === 0 ? (
        <p className="lr-spine__empty">还没有版本记录</p>
      ) : (
        <ol className="lr-spine__list">
          {versions.map((node) => (
            <li className="lr-spine__node" data-current={node.current} key={node.id}>
              <span className="lr-spine__dot" />
              <span className="lr-spine__label">{node.label}</span>
              <time className="lr-spine__stamp">{node.stamp}</time>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

/** 检视器：属性、标签、权限判定（§3.1）。默认展开，可折叠。 */
export function Inspector({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside aria-label={title} className="lr-inspector">
      <h2 className="lr-inspector__title">{title}</h2>
      <div className="lr-inspector__body">{children}</div>
    </aside>
  );
}

/** 读面：正文限制 58ch，窗口拉宽时**留白增长，行宽不增长**（§3.1）。 */
export function ReadPane({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack?: () => void;
  children: ReactNode;
}) {
  return (
    <section aria-label="读面" className="lr-read">
      <header className="lr-read__header">
        {onBack && (
          <span className="lr-read__back">
            <Button onClick={onBack} variant="quiet">
              列表
            </Button>
          </span>
        )}
        <h1 className="lr-read__title">{title}</h1>
      </header>
      <div className="lr-read__body">{children}</div>
    </section>
  );
}

/** App 持有的界面状态：两个折叠开关 + 窄窗口下的前后台。 */
export type ShellLayout = {
  listOpen: boolean;
  inspectorOpen: boolean;
  pane: "list" | "read";
};

export type ShellProps = {
  nav: ReactNode;
  list: ReactNode;
  spine: ReactNode;
  read: ReactNode;
  inspector: ReactNode;
  status: ReactNode;
  layout: ShellLayout;
  onToggleList: () => void;
  onToggleInspector: () => void;
};

/**
 * 外壳本体。
 *
 * 折叠开关放在状态条右侧：ui.md §3.1 说状态条承载的是「持久状态」，把两个开关塞进去
 * 是**这一版的权宜** —— 真正的窗口 chrome 要等 102/103 定稿，先把收窄行为做成看得见、
 * 点得到的东西。`aria-pressed` 让读屏用户知道这两个是开关而不是动作。
 */
export function Shell({
  nav,
  list,
  spine,
  read,
  inspector,
  status,
  layout,
  onToggleList,
  onToggleInspector,
}: ShellProps) {
  return (
    <div
      className="lr-shell"
      data-inspector={layout.inspectorOpen ? "open" : "closed"}
      data-list={layout.listOpen ? "open" : "closed"}
      data-pane={layout.pane}
    >
      <div className="lr-shell__nav">{nav}</div>
      <div className="lr-shell__list">{list}</div>
      <div className="lr-shell__spine">{spine}</div>
      <div className="lr-shell__read">{read}</div>
      <div className="lr-shell__inspector">{inspector}</div>
      <footer className="lr-statusbar">
        <div className="lr-statusbar__slot">{status}</div>
        <div className="lr-statusbar__chrome">
          <Button aria-pressed={layout.listOpen} onClick={onToggleList} variant="quiet">
            列表
          </Button>
          <Button
            aria-pressed={layout.inspectorOpen}
            onClick={onToggleInspector}
            variant="quiet"
          >
            检视器
          </Button>
        </div>
      </footer>
    </div>
  );
}
