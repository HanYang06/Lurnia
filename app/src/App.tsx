// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * Lurnia 的界面外壳（路线 095）与它上面挂着的那些面板。
 *
 * 这一版**刻意没有业务**：笔记 / 项目 / 权限 / AI 四个模块都只有空态，因为对应的
 * 内核能力还没接。真正有的是三样东西 —— 内核状态、事件流（路线 009 / 105 的验收物），
 * 以及一条能跑通的主题切换。空态写成「为什么是空的」，不拿假数据撑场面。
 *
 * 布局本身在 [shell/Shell.tsx](shell/Shell.tsx)；这里只负责给六个区准备内容，
 * 并持有界面状态（当前模块、选中条目、两个折叠开关、窄窗口下的前后台）。
 */

import { useEffect, useState, type ChangeEvent } from "react";

import { Gallery } from "./panels/Gallery";
import {
  Select,
  StateBadge,
  Tag,
  type Decision,
  type SelectOption,
} from "./components";
import {
  onKernelEvent,
  onKernelReady,
  onKernelStopped,
  type Envelope,
  type Ready,
  type Stopped,
} from "./kernel";
import {
  AiIcon,
  Inspector,
  ListPane,
  NavRail,
  TopBar,
  NoteIcon,
  PermissionIcon,
  ProjectIcon,
  ReadPane,
  SettingsIcon,
  Shell,
  UserIcon,
  type ListEntry,
  type NavModule,
  type ShellLayout,
} from "./shell";
import {
  THEME_CHOICES,
  currentChoice,
  isThemeChoice,
  setThemeChoice,
  type ThemeChoice,
} from "./theme";
import "./App.css";

/** 界面上只留最近这么多条，别让一个长跑的核心把内存撑起来。 */
const MAX_ROWS = 50;

const MODULES: readonly NavModule[] = [
  { id: "notes", label: "笔记", icon: <NoteIcon /> },
  { id: "projects", label: "项目", icon: <ProjectIcon /> },
  { id: "permissions", label: "权限", icon: <PermissionIcon /> },
  { id: "ai", label: "AI", icon: <AiIcon /> },
];

const SETTINGS: NavModule = { id: "settings", label: "设置", icon: <SettingsIcon /> };

/**
 * 模块名与它们的空态文案。三段分开写是有意的：**为什么空**与**将来长出什么**
 * 是两件事，混成一句就变成了一行灰字 —— 那看起来像是界面坏了。
 */
const MODULE_COPY: Record<string, { title: string; short: string }> = {
  notes: { title: "笔记", short: "等内核把文档的读接口露出来。" },
  projects: { title: "项目", short: "等项目与文档的归属接口。" },
  permissions: { title: "权限", short: "等权限判定的数据源。" },
  ai: { title: "AI", short: "还没做。按 I9，对外动作都得由用户显式发起。" },
};

const SETTINGS_COPY = { title: "设置", short: "主题切换在「外观」里。" };

const SETTINGS_ENTRIES: readonly ListEntry[] = [
  { id: "appearance", label: "外观" },
  { id: "gallery", label: "组件" },
  { id: "events", label: "事件日志" },
  { id: "about", label: "关于" },
];

const THEME_LABELS: Record<ThemeChoice, string> = {
  system: "跟随系统",
  dark: "深色",
  light: "浅色",
};

const THEME_OPTIONS: readonly SelectOption[] = THEME_CHOICES.map((choice) => ({
  value: choice,
  label: THEME_LABELS[choice],
}));

function App() {
  const [ready, setReady] = useState<Ready | null>(null);
  const [stopped, setStopped] = useState<Stopped | null>(null);
  const [events, setEvents] = useState<Envelope[]>([]);
  const [theme, setTheme] = useState<ThemeChoice>(currentChoice);
  const [module, setModule] = useState("notes");
  const [query, setQuery] = useState("");
  const [entry, setEntry] = useState<string | null>(null);
  const [layout, setLayout] = useState<ShellLayout>({
    inspectorOpen: true,
    listOpen: true,
    pane: "read",
  });

  useEffect(() => {
    // 订阅是异步拿到的句柄：卸载时如果还没拿到，拿到后立刻退订，
    // 否则 React 严格模式下的双挂载会留下两条活的监听。
    let disposed = false;
    const unlisten: (() => void)[] = [];
    const keep = (off: () => void) => {
      if (disposed) {
        off();
      } else {
        unlisten.push(off);
      }
    };

    void onKernelReady(setReady).then(keep);
    void onKernelStopped(setStopped).then(keep);
    void onKernelEvent((envelope) => {
      setEvents((current) => [envelope, ...current].slice(0, MAX_ROWS));
    }).then(keep);

    return () => {
      disposed = true;
      for (const off of unlisten) {
        off();
      }
    };
  }, []);

  const onThemeChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next: unknown = event.target.value;
    if (isThemeChoice(next)) {
      setThemeChoice(next);
      setTheme(next);
    }
  };

  const selectModule = (id: string) => {
    setModule(id);
    setEntry(id === "settings" ? "appearance" : null);
  };

  const selectEntry = (id: string) => {
    setEntry(id);
    setLayout((current) => ({ ...current, pane: "read" }));
  };

  const isSettings = module === "settings";
  const copy = MODULE_COPY[module] ?? SETTINGS_COPY;

  // 顶栏搜索是这个界面的第一动作：它过滤当前列表（还没有跨模块搜索的接口）。
  const keyword = query.trim().toLowerCase();
  const allEntries = isSettings ? SETTINGS_ENTRIES : [];
  const entries =
    keyword.length === 0
      ? allEntries
      : allEntries.filter((item) => item.label.toLowerCase().includes(keyword));

  // 版本时间线（§3.2）的数据源是 doc 能力的版本链，还没接 —— 空态是诚实的。
  // 「关于」页里的三态说明：给 StateBadge 一个真实用处，也顺便把 I2 摆在界面上。
  const decisions: readonly Decision[] = ["allow", "deny", "uncertain"];

  // 读面的内容由选中的条目决定。函数声明会提升，所以 renderRead 写在 return 之后；
  // 这里先取一次，让下面的 JSX 里只有一个名字。
  const readBody = renderRead();

  return (
    <Shell
      inspector={
        <Inspector label="内核">
          {ready ? (
            <dl className="facts">
              <div>
                <dt>版本</dt>
                <dd>{ready.version}</dd>
              </div>
              <div>
                <dt>数据库版本</dt>
                <dd>v{ready.db_version}</dd>
              </div>
              <div>
                <dt>启动时归档</dt>
                <dd>{ready.rotated} 条</dd>
              </div>
              <div>
                <dt>数据目录</dt>
                <dd title={ready.data_dir}>{ready.data_dir}</dd>
              </div>
            </dl>
          ) : (
            <p className="note">{stopped ? "核心没起来" : "等核心就绪…"}</p>
          )}
          <p className="note">
            <Tag>本地</Tag>
          </p>
        </Inspector>
      }
      layout={layout}
      list={
        <ListPane
          active={entry}
          empty={keyword.length > 0 ? "没有匹配的条目。" : undefined}
          createHint="还没有文档写入接口（doc 能力未接）"
          entries={entries}
          label={isSettings ? "设置" : copy.title}
          onCollapse={() => {
            setLayout((current) => ({ ...current, listOpen: false }));
          }}
          onSelect={selectEntry}
        />
      }
      nav={
        <NavRail
          active={module}
          modules={MODULES}
          onSelect={selectModule}
          settings={SETTINGS}
        />
      }
      onToggleInspector={() => {
        setLayout((current) => ({
          ...current,
          inspectorOpen: !current.inspectorOpen,
        }));
      }}
      read={
        <ReadPane
          onBack={() => {
            setLayout((current) => ({ ...current, pane: "list" }));
          }}
        >
          {readBody}
        </ReadPane>
      }
      top={
        <TopBar
          action={
            <button
              aria-label="账户"
              className="lr-avatar"
              title="账户 —— 身份来自内核的 Subject（I6）"
              type="button"
            >
              <UserIcon />
            </button>
          }
          onQueryChange={setQuery}
          query={query}
        />
      }
      status={
        <>
          <span className="status__dot" data-state={kernelState(ready, stopped)} />
          <span>{kernelLabel(ready, stopped)}</span>
          <span>事件 {events.length}</span>
        </>
      }
    />
  );

  function renderRead() {
    if (entry === "appearance") {
      return (
        <div className="stack">
          <Select
            label="主题"
            onChange={onThemeChange}
            options={THEME_OPTIONS}
            value={theme}
          />
          <p className="note">
            默认跟随系统，也可以锁定深色或浅色。切换是<strong>瞬时</strong>的 ——
            全屏渐变会让人短暂失去方向感，所以不做（ui.md §五）。
          </p>
          <p className="note">
            颜色全部来自语义令牌，深浅两套的令牌名逐字相同，所以组件里没有
            「现在是深是浅」这种分支。
          </p>
        </div>
      );
    }

    if (entry === "gallery") {
      return <Gallery />;
    }

    if (entry === "events") {
      return (
        <div className="stack">
          <p className="note">
            内核广播平面推过来的封套，最新的在最上面。这一页是路线 009 / 105 的验收物：
            它证明通道是通的，不是证明业务做完了。
          </p>
          {events.length === 0 ? (
            <p className="note">
              {ready ? "核心起来了，还没有事件。" : "等核心就绪。"}
            </p>
          ) : (
            <ol className="events">
              {events.map((envelope) => (
                <li key={envelope.id}>
                  <div className="events__head">
                    <span className="events__seq">#{envelope.seq}</span>
                    <span className="events__topic">{envelope.topic}</span>
                    <span className="events__who">{envelope.subject.id}</span>
                    <time className="events__when">{envelope.ts_wall}</time>
                  </div>
                  <code className="events__payload">
                    {JSON.stringify(envelope.payload)}
                  </code>
                </li>
              ))}
            </ol>
          )}
        </div>
      );
    }

    if (entry === "about") {
      return (
        <div className="stack">
          <p className="note">
            Lurnia 是一个桌面 APP：Python 核心作为 sidecar 由 Tauri 宿主拉起，界面跑在
            WebView 里。它不开浏览器、不起服务、不自己联网。
          </p>
          {stopped && (
            <p className="note note--bad">
              ✗ {stopped.message ?? `核心退出，退出码 ${stopped.code ?? "未知"}`}
            </p>
          )}
          <h2 className="heading">判定的三种结果</h2>
          <p className="note">
            内核的判定是<strong>三态</strong>
            ，不是布尔。三者在界面上同级：同样的明度与彩度，
            只有色相不同，并且各自带形状与文字 —— 颜色不单独承载语义（ui.md §2.5）。
          </p>
          <ul className="decisions">
            {decisions.map((decision) => (
              <li key={decision}>
                <StateBadge decision={decision} />
              </li>
            ))}
          </ul>
        </div>
      );
    }

    // 搜索没命中是**用户动作的反馈**，给一句；没有内容时什么都不写（§1.0 留白）。
    if (keyword.length > 0) {
      return <p className="note">没有匹配的条目。</p>;
    }
    return null;
  }
}

function kernelState(ready: Ready | null, stopped: Stopped | null): string {
  if (stopped) {
    return "down";
  }
  return ready ? "up" : "wait";
}

function kernelLabel(ready: Ready | null, stopped: Stopped | null): string {
  if (stopped) {
    return "核心已退出";
  }
  return ready ? "核心已就绪" : "等待核心…";
}

export default App;
