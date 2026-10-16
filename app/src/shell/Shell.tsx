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

import { useState, type ReactNode } from "react";

import { Button, Input } from "../components";
import { PanelIcon } from "./icons";
import "./Shell.css";
import { useMediaQuery } from "./useMediaQuery";

export type NavModule = {
  id: string;
  label: string;
  icon: ReactNode;
};

/**
 * 导航条：**纯图标**（§3.1 2026-10-17 改版）。旧版是「图标 + 文字」，理由是纯图标
 * 要求用户悬停才知道是什么 —— 那个代价没有消失，只是被接受了。所以这里：
 * `aria-label` 给读屏、`title` 给鼠标用户，且图标本身必须画得能自解释。
 */
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
        aria-label={module.label}
        className="lr-nav__item"
        onClick={() => {
          onSelect(module.id);
        }}
        title={module.label}
        type="button"
      >
        <span aria-hidden="true" className="lr-nav__icon">
          {module.icon}
        </span>
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

/**
 * 顶栏（§3.1 2026-10-17 新增）：搜索居中、主操作在右。
 *
 * 它**不承载模块切换** —— 那是左侧图标栏的事。搜索居中是因为它是这个界面的第一动作：
 * 打开 APP 先找东西，而不是先选模块。
 */
export function TopBar({
  query,
  onQueryChange,
  placeholder = "搜索",
  action,
}: {
  query: string;
  onQueryChange: (next: string) => void;
  placeholder?: string;
  action?: ReactNode;
}) {
  return (
    <header className="lr-topbar">
      <div className="lr-topbar__search">
        <Input
          hideLabel
          label={placeholder}
          onChange={(event) => {
            onQueryChange(event.target.value);
          }}
          placeholder={placeholder}
          type="search"
          value={query}
        />
      </div>
      {action && <div className="lr-topbar__action">{action}</div>}
    </header>
  );
}

export type ListEntry = { id: string; label: string };

/**
 * 列表栏：当前模块的条目集合；选中项由左侧 2.5px 强调条标识（§3.1、§4.2）。
 *
 * **没有标题**（§3.1 2026-10-17）：区里挂一个标题只是让空面板证明自己存在。
 * `label` 只给读屏用。折叠钮放在本栏右上角，不再占用状态条。
 */
export function ListPane({
  label,
  entries,
  active,
  onSelect,
  onCollapse,
  empty,
}: {
  label: string;
  entries: readonly ListEntry[];
  active: string | null;
  onSelect: (id: string) => void;
  onCollapse: () => void;
  empty: string;
}) {
  return (
    <div aria-label={label} className="lr-list" role="group">
      {/* 折叠钮在本栏右上角（§3.1 2026-10-17：不再占用状态条的黄金位）。 */}
      <div className="lr-list__head">
        <button
          aria-label="收起列表"
          className="lr-list__collapse"
          onClick={onCollapse}
          title="收起列表"
          type="button"
        >
          <span aria-hidden="true">«</span>
        </button>
      </div>
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

/**
 * 检视器：属性、标签、权限判定（§3.1）。宽窗口默认展开，窄窗口退化成图标条。
 * `label` 只作读屏名，不再渲染成面板标题（§3.1：标题只在承载信息时出现）。
 */
export function Inspector({ label, children }: { label: string; children: ReactNode }) {
  return (
    <aside aria-label={label} className="lr-inspector">
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

/**
 * 检视器折叠的断点。**必须与 Shell.css 里的媒体查询逐字一致**：对不上就会出现
 * 「CSS 认为还宽着、JS 认为已经窄了」的一帧 —— 一边把检视器当栏位、一边当浮层。
 * `states.test.ts` 会核对这个字符串确实出现在样式表里。
 */
export const INSPECTOR_COLLAPSE_QUERY = "(width < 1180px)";

/** App 持有的界面状态：两个折叠开关 + 窄窗口下的前后台。 */
export type ShellLayout = {
  listOpen: boolean;
  inspectorOpen: boolean;
  pane: "list" | "read";
};

export type ShellProps = {
  top: ReactNode;
  nav: ReactNode;
  list: ReactNode;
  spine: ReactNode;
  read: ReactNode;
  inspector: ReactNode;
  status: ReactNode;
  layout: ShellLayout;
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
  top,
  nav,
  list,
  spine,
  read,
  inspector,
  status,
  layout,
  onToggleInspector,
}: ShellProps) {
  // 窄窗口下检视器退化成图标条：**展开与否只由用户点击决定**（默认折叠）。
  // 宽窗口沿用 App 给的偏好（默认展开）。这一条以前写反过 —— 见 Shell.css 里的注。
  const narrow = useMediaQuery(INSPECTOR_COLLAPSE_QUERY);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const inspectorShown = narrow ? overlayOpen : layout.inspectorOpen;

  const toggleInspector = () => {
    if (narrow) {
      setOverlayOpen((open) => !open);
    } else {
      onToggleInspector();
    }
  };

  return (
    <div
      className="lr-shell"
      data-inspector={inspectorShown ? "open" : "closed"}
      data-list={layout.listOpen ? "open" : "closed"}
      data-pane={layout.pane}
    >
      <div className="lr-shell__top">{top}</div>
      <div className="lr-shell__nav">{nav}</div>
      <div className="lr-shell__list">{list}</div>
      <div className="lr-shell__spine">{spine}</div>
      <div className="lr-shell__read">{read}</div>
      <div className="lr-shell__inspector">
        {/* 图标条：只在窄窗口出现（Shell.css 的 <1180 媒体查询）。 */}
        <div className="lr-rail">
          <Button aria-label="检视器" onClick={toggleInspector} variant="quiet">
            <PanelIcon />
          </Button>
        </div>
        {inspector}
      </div>
      <footer className="lr-statusbar">
        <div className="lr-statusbar__slot">{status}</div>
      </footer>
    </div>
  );
}
