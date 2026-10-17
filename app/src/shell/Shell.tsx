// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 五区外壳（ui.md §3.1）。这一段是**布局**，不含业务：五个区都以插槽传入，
 * 谁来填由 App 决定；折叠/前后台状态也由 App 持有，Shell 只把它们写成 `data-*`，
 * 让 CSS 去决定长什么样。
 *
 * | 区 | 宽度 | 可折叠 |
 * | --- | --- | --- |
 * | 顶栏（也是窗口标题栏） | 48px | 否 |
 * | 导航条 | 56px | 否 |
 * | 列表栏 | 242px / 收起后 32px 窄条 | 是 |
 * | 读面 | 弹性，正文 `58ch` | — |
 * | 状态条 | 28px | 否 |
 *
 * **没有右侧栏**（本轮批注 2，2026-10-17）：编辑器页面不存在「右侧栏」这个概念。
 * 检视器那一列连同窄窗口下的 40px 图标条一起撤掉了 —— 右边一栏要么抢正文的宽度，
 * 要么在窗口一窄就变成一条只能点开浮层的图标条，两种形态都不好用。
 *
 * **顶栏就是窗口标题栏**（2026-10-17 第三轮）：系统装饰撤掉之后，logo、搜索、账户位
 * 与最小化/最大化/关闭收在同一条 48px 里（Tauri 的 `decorations: false`）。
 * 空白处挂 `data-tauri-drag-region`，所以顶栏同时也是拖窗口的把手。
 *
 * **列表栏收起之后必须收得回来**：收起钮跟着栏一起消失，于是这个动作变成单向的 ——
 * 实测就是这么撞上的。所以收起时那一格留下 32px 的窄条，里面只有一颗展开钮。
 *
 * 收窄行为（§3.3）**全在 CSS 里**，不靠 JS 读窗口宽度：**先收列表栏，最后才动读面**。
 * JS 只表达一件 CSS 表达不了的事 —— `< 820px` 时「列表 / 读面」谁在前台。
 */

import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { Button, Input } from "../components";
import { BrandLockup } from "./brand";
import { CollapseIcon, ExpandIcon, LockIcon, PlusIcon } from "./icons";
import { WindowControls } from "./WindowControls";
import "./Shell.css";

export type NavModule = {
  id: string;
  label: string;
  icon: ReactNode;
};

/**
 * 顶栏上的**上层浮层**（工具 / 属性）。它不是又一列：点开是一块浮在内容上的面板，
 * 关掉就什么都不占。`disabled` 表达「这一刻没什么可看的」（比如还没打开任何文档），
 * 比点开一个空面板诚实。
 *
 * **它们为什么在顶栏而不在导航条**（第四轮）：这两个动作是**对当前这份文档**的，
 * 和窗口/账户是同一层的东西；导航条上是「去哪个模块」，混在一起语义就糊了。
 * 放到顶栏右端之后，那一侧也不再空得发慌（原先账户位与窗口控制之间是一大片留白）。
 */
export type TopPanel = {
  id: string;
  label: string;
  icon: ReactNode;
  content: ReactNode;
  disabled?: boolean;
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
 * 一颗带浮层的顶栏钮。浮层**从按钮下面展开**（`inset-block-start: 100%`），
 * 所以它不需要测量坐标；关闭有三条路：再点一次、按 Esc、点到别处。
 */
export function TopPanelButton({ panel }: { panel: TopPanel }) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && !hostRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  return (
    <span className="lr-topbar__panel-host" ref={hostRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={panel.label}
        className="lr-topbar__panel-button"
        disabled={panel.disabled}
        onClick={() => {
          setOpen((current) => !current);
        }}
        title={panel.label}
        type="button"
      >
        <span aria-hidden="true" className="lr-nav__icon">
          {panel.icon}
        </span>
      </button>
      {open && (
        <div aria-label={panel.label} className="lr-panel" role="dialog">
          {panel.content}
        </div>
      )}
    </span>
  );
}

/**
 * 顶栏（§3.1 2026-10-17 新增）：**logo 在左、搜索居中、动作与窗口控制收在右**。
 *
 * 它**不承载模块切换** —— 那是左侧图标栏的事。搜索居中是因为它是这个界面的第一动作：
 * 打开 APP 先找东西，而不是先选模块。
 *
 * 三个格子分别是「品牌 / 搜索 / 动作」：`1fr auto 1fr` 让搜索永远在正中间，
 * 右边多放几个按钮也不会把它带偏。空白处是**拖窗口**的把手（Tauri 的 drag region）。
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
    <header className="lr-topbar" data-tauri-drag-region>
      <div className="lr-topbar__brand" data-tauri-drag-region>
        <BrandLockup size={26} />
      </div>
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
      <div className="lr-topbar__action">
        {action}
        <WindowControls />
      </div>
    </header>
  );
}

export type ListEntry = {
  id: string;
  label: string;
  /** 改不了的条目标一把小锁（权限判定的结果）。**不标「暂时没做」**，那是禁用态的事。 */
  locked?: boolean;
};

/**
 * 列表栏：当前模块的条目集合；选中项是填充抬一级 ＋ 文字加重（§3.1、§4.2）。
 *
 * **没有标题**（§3.1 2026-10-17）：区里挂一个标题只是让空面板证明自己存在。
 * `label` 只给读屏用。
 *
 * 头行左边是**新建长条**（第三轮：它该在顶上、要能显示快捷键、悬停就有反馈），
 * 右边是收起钮。条目区的空白处**双击也是新建** —— 和 VS Code 里双击打开东西一个手感。
 */
export function ListPane({
  label,
  entries,
  active,
  onSelect,
  onCollapse,
  onCreate,
  createKeys,
  empty,
}: {
  label: string;
  entries: readonly ListEntry[];
  active: string | null;
  onSelect: (id: string) => void;
  onCollapse: () => void;
  /** 这个模块能新建东西时才传（笔记模块传的是 `doc.save` 那条路）。 */
  onCreate?: () => void;
  /** 长条右端的快捷键提示，例如 `Ctrl + N`（只显示，不绑定）。 */
  createKeys?: string;
  /** 只在**用户搜索没命中**这类反馈场合给一句；没有内容时留白（§1.0）。 */
  empty?: string;
}) {
  // 双击条目区 = 新建。**只认落在空白处的那一下**：双击到按钮上就不该顺手再建一篇。
  const onDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (!onCreate) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest("button")) {
      return;
    }
    onCreate();
  };

  return (
    <div aria-label={label} className="lr-list" role="group">
      {/*
       * 头行**只有收起钮**（2026-10-17 第七轮）。它原先和「新建」挤在同一行，于是新建
       * 只能占剩下的宽度（少 39px），而下面每一条都是整栏宽 —— 上下两个胶囊右缘不齐。
       * 现在收起钮独占上面一行、靠右，新建胶囊吃满整栏，与条目对齐。
       */}
      <div className="lr-list__head">
        <button
          aria-label="收起列表"
          className="lr-list__collapse"
          onClick={onCollapse}
          title="收起列表"
          type="button"
        >
          <CollapseIcon />
        </button>
      </div>
      {onCreate && (
        <div className="lr-list__create-row">
          <button
            className="lr-list__create"
            onClick={onCreate}
            title="新建"
            type="button"
          >
            {/*
             * 图标与文字是一组（第五轮）：悬停时**整组往左挪一点**，给右端的键位让位置。
             * 分开挪会变成两段错位，所以它们必须包在同一个盒子里 —— 那个盒子才是
             * `translateX` 的对象。
             */}
            <span className="lr-list__create-main">
              <span aria-hidden="true" className="lr-list__create-icon">
                <PlusIcon />
              </span>
              <span className="lr-list__create-label">新建</span>
            </span>
            {createKeys && (
              /*
               * 键位绝对定位贴右端、悬停才淡入（第五轮）。它不参与居中，所以静止时
               * 「＋ 新建」是**正中**的；悬停时那一组左移 24px 让位，键位淡入 ——
               * 不压字、不推挤，也没有多余的位移（只有这一次、而且是必要的）。
               */
              <span aria-hidden="true" className="lr-list__create-keys">
                {createKeys}
              </span>
            )}
          </button>
        </div>
      )}
      <div className="lr-list__body" onDoubleClick={onDoubleClick}>
        {entries.length === 0 ? (
          empty && <p className="lr-list__empty">{empty}</p>
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
                  <span className="lr-list__item-label">{entry.label}</span>
                  {entry.locked && (
                    <span aria-label="只读" className="lr-list__lock" role="img">
                      <LockIcon />
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
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
 * 读面：正文限制 58ch，窗口拉宽时**留白增长，行宽不增长**（§3.1）。
 *
 * **没有头部**（2026-10-17）：标题与那条分隔线都被撤了 —— 谁不知道自己在编辑笔记？
 * 编辑器最珍贵的一片区域就是顶部，写东西习惯从上往下写，不能拿标题牌和横线压住它。
 * 窄窗口下的返回按钮改为浮在左上角，仍然只占它自己那一小块。
 */
export function ReadPane({
  onBack,
  children,
}: {
  onBack?: () => void;
  children: ReactNode;
}) {
  return (
    <section aria-label="读面" className="lr-read">
      {onBack && (
        <div className="lr-read__back">
          <Button onClick={onBack} variant="quiet">
            列表
          </Button>
        </div>
      )}
      <div className="lr-read__body">{children}</div>
    </section>
  );
}

/** App 持有的界面状态：列表栏的折叠开关 + 窄窗口下的前后台。 */
export type ShellLayout = {
  listOpen: boolean;
  pane: "list" | "read";
};

export type ShellProps = {
  top: ReactNode;
  nav: ReactNode;
  list: ReactNode;
  read: ReactNode;
  status: ReactNode;
  layout: ShellLayout;
  onExpandList: () => void;
};

/**
 * 外壳本体。
 *
 * 列表栏收起时**不留列**（第四轮）：留一列 32px 的窄条等于「为了一个按钮多出一列」，
 * 屏幕上很丑。改成在正文左上角**浮出一颗小箭头**（不占版心宽度），
 * 另外点当前模块的图标、或者 `Ctrl+B` 也能把它叫回来。
 */
export function Shell({
  top,
  nav,
  list,
  read,
  status,
  layout,
  onExpandList,
}: ShellProps) {
  return (
    <div
      className="lr-shell"
      data-list={layout.listOpen ? "open" : "closed"}
      data-pane={layout.pane}
    >
      <div className="lr-shell__top">{top}</div>
      <div className="lr-shell__nav">{nav}</div>
      <div className="lr-shell__list">{list}</div>
      <div className="lr-shell__read">
        {!layout.listOpen && (
          <button
            aria-label="展开列表"
            className="lr-shell__expand"
            onClick={onExpandList}
            title="展开列表"
            type="button"
          >
            <ExpandIcon />
          </button>
        )}
        {read}
      </div>
      <footer className="lr-statusbar">
        <div className="lr-statusbar__slot">{status}</div>
      </footer>
    </div>
  );
}
