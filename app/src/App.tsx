// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * Lurnia 的界面外壳（路线 095）与它上面挂着的那些面板。
 *
 * 这一版**刻意没有业务**：笔记 / 项目 / 权限 / AI 四个模块都只有空态，因为对应的
 * 内核能力还没接。真正有的是三样东西 —— 内核状态、事件流（路线 009 / 105 的验收物），
 * 以及一条能跑通的主题切换。空态写成「为什么是空的」，不拿假数据撑场面。
 *
 * 布局本身在 [shell/Shell.tsx](shell/Shell.tsx)；这里只负责给五个区准备内容，
 * 并持有界面状态（当前模块、选中条目、列表栏的折叠开关、窄窗口下的前后台）。
 *
 * **没有右侧栏**（本轮批注 2）：原先挂在检视器里的内核事实挪进了「设置 → 关于」。
 */

import { useEffect, useState, type ChangeEvent } from "react";

import { NoteEditor } from "./editor/Editor";
import { noteFacts } from "./editor/facts";
import { saveLabel } from "./editor/labels";
import { useNote } from "./editor/useNote";
import { Gallery } from "./panels/Gallery";
import { Select, StateBadge, type Decision, type SelectOption } from "./components";
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
  ListPane,
  NavRail,
  TopBar,
  NoteIcon,
  PermissionIcon,
  ProjectIcon,
  ReadPane,
  SettingsIcon,
  Shell,
  ShelfIcon,
  ToolIcon,
  TopPanelButton,
  UserIcon,
  Welcome,
  type ListEntry,
  type NavModule,
  type ShellLayout,
  type Shortcut,
  type TopPanel,
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
 * 快捷键表。**一份定义，两处用**：欢迎面显示它，App 的键盘处理按它绑定 ——
 * 两处各写一遍的话，改了键位而没改显示（或反过来）不会有任何报错。
 */
const SHORTCUTS: readonly Shortcut[] = [
  { label: "新建", keys: ["Ctrl", "N"] },
  { label: "提交修订", keys: ["Ctrl", "S"] },
  { label: "搜索", keys: ["Ctrl", "K"] },
  { label: "列表栏", keys: ["Ctrl", "B"] },
];

/** 新建长条右端那颗提示：与 `SHORTCUTS` 里同一条，按标签找。 */
const CREATE_KEYS = SHORTCUTS.find((item) => item.label === "新建")?.keys.join(" + ");

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
    listOpen: true,
    pane: "read",
  });
  // 笔记的会话：打开 / 新建 / 自动落盘 / 提交（editor.md §六、§8.1）。
  const note = useNote();

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
    /*
     * 点**当前**模块的图标 = 收/放列表栏（第四轮）。列表栏收起之后没有别的列可以承载
     * 一个「展开」按钮（留一列很难看），所以这条动作必须有个顺手的地方 —— VS Code
     * 的活动栏就是同一个习惯。
     */
    if (id === module) {
      setLayout((current) => ({ ...current, listOpen: !current.listOpen }));
      return;
    }
    setModule(id);
    setEntry(id === "settings" ? "appearance" : null);
    // 换模块时把列表栏打开：切过去却看不到内容，会像是没切成功。
    setLayout((current) => ({ ...current, listOpen: true }));
  };

  const isNotes = module === "notes";
  const { create: createNote, open: openNote } = note;

  /*
   * 全局快捷键。只认 Ctrl/Cmd，且不抢输入框里的组合（在搜索框里按 Ctrl+N 也还是新建，
   * 那是用户的意图）。`Ctrl+S` 在 useNote 里 —— 它要拿到的状态更细。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "b") {
        event.preventDefault();
        setLayout((current) => ({ ...current, listOpen: !current.listOpen }));
        return;
      }
      if (key === "n" && isNotes) {
        event.preventDefault();
        createNote();
        return;
      }
      if (key === "k") {
        const field = document.querySelector<HTMLInputElement>('input[type="search"]');
        if (field) {
          event.preventDefault();
          field.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [createNote, isNotes]);

  const selectEntry = (id: string) => {
    setEntry(id);
    setLayout((current) => ({ ...current, pane: "read" }));
    // 笔记条目就是文档：点它就去 `doc.get` 取那篇（其余模块的条目还是纯界面状态）。
    if (isNotes) {
      note.open(id);
    }
  };

  const isSettings = module === "settings";
  const copy = MODULE_COPY[module] ?? SETTINGS_COPY;

  // 顶栏搜索是这个界面的第一动作：它过滤当前列表（还没有跨模块搜索的接口）。
  const keyword = query.trim().toLowerCase();
  const allEntries = isNotes ? note.state.entries : isSettings ? SETTINGS_ENTRIES : [];
  const entries =
    keyword.length === 0
      ? allEntries
      : allEntries.filter((item) => item.label.toLowerCase().includes(keyword));

  // 状态条上的落盘状态：只有笔记模块有（它是持久状态，§3.1）。
  const noteStatus = isNotes ? saveLabel(note.state.save) : null;

  // 属性浮层显示的三个数：都从手里的正文数出来（见 editor/facts.ts）。
  const facts = noteFacts(note.state.pending ?? note.state.initialBody);
  const hasDocument = note.state.activeId !== null;

  /*
   * 顶栏右端的两个浮层（第四轮从导航条挪过来）。它们**不占栏位**：点开浮在内容上，
   * 关掉什么都不剩。没有打开的文档时两颗钮都禁用 —— 比点开一个空面板诚实。
   */
  const topPanels: readonly TopPanel[] = [
    {
      id: "tools",
      label: "工具",
      icon: <ToolIcon />,
      disabled: !hasDocument,
      content: (
        <div className="lr-panel__body">
          <p className="lr-panel__title">这份文档</p>
          <button className="lr-panel__action" onClick={note.commit} type="button">
            <span>提交修订</span>
            <span className="lr-panel__keys">Ctrl + S</span>
          </button>
          <button
            className="lr-panel__action"
            // 有没落盘的改动时不给重新载入：那等于把刚写的字丢掉。
            disabled={note.state.pending !== null}
            onClick={() => {
              if (note.state.activeId !== null) {
                openNote(note.state.activeId);
              }
            }}
            type="button"
          >
            <span>重新载入</span>
          </button>
        </div>
      ),
    },
    {
      id: "properties",
      label: "属性",
      icon: <ShelfIcon />,
      disabled: !hasDocument,
      content: (
        <div className="lr-panel__body">
          <p className="lr-panel__title">这份文档</p>
          <dl className="facts">
            <div>
              <dt>修订</dt>
              <dd>r{note.state.revision}</dd>
            </div>
            <div>
              <dt>块</dt>
              <dd>{facts.blocks}</dd>
            </div>
            <div>
              <dt>字数</dt>
              <dd>{facts.characters}</dd>
            </div>
            <div>
              <dt>文档 id</dt>
              <dd>{note.state.activeId}</dd>
            </div>
          </dl>
        </div>
      ),
    },
  ];

  // 版本时间线（§3.2）的数据源是 doc 能力的版本链，还没接 —— 空态是诚实的。
  // 「关于」页里的三态说明：给 StateBadge 一个真实用处，也顺便把 I2 摆在界面上。
  const decisions: readonly Decision[] = ["allow", "deny", "uncertain"];

  // 读面的内容由选中的条目决定。函数声明会提升，所以 renderRead 写在 return 之后；
  // 这里先取一次，让下面的 JSX 里只有一个名字。
  const readBody = renderRead();

  return (
    <Shell
      layout={layout}
      list={
        <ListPane
          active={isNotes ? note.state.activeId : entry}
          empty={keyword.length > 0 ? "没有匹配的条目。" : undefined}
          entries={entries}
          label={isSettings ? "设置" : copy.title}
          onCollapse={() => {
            setLayout((current) => ({ ...current, listOpen: false }));
          }}
          createKeys={isNotes ? CREATE_KEYS : undefined}
          onCreate={isNotes ? createNote : undefined}
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
      onExpandList={() => {
        setLayout((current) => ({ ...current, listOpen: true }));
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
            <>
              <button
                aria-label="账户"
                className="lr-avatar"
                title="账户 —— 身份来自内核的 Subject（I6）"
                type="button"
              >
                <UserIcon />
              </button>
              {topPanels.map((panel) => (
                <TopPanelButton key={panel.id} panel={panel} />
              ))}
            </>
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
          {isNotes && noteStatus !== null && (
            <span className="status__note" data-bad={noteStatus.bad}>
              {noteStatus.text}
            </span>
          )}
        </>
      }
    />
  );

  function renderRead() {
    /*
     * 笔记模块：读面就是**编辑面**（editor.md §8.1）—— 没有「编辑模式 / 预览模式」
     * 的切换，也没有标题牌与分隔线（§3.1 批注 2），打开就能写。
     * `key` 挂在文档 id 上：换一篇 = 重新挂载，编辑器自己持有的正文跟着换掉。
     */
    if (isNotes) {
      const { activeId, initialBody } = note.state;
      /*
       * 什么都没打开时不是「一片空白」，而是**欢迎面**（学 VS Code 的空编辑器）：
       * 大 logo + 几条快捷键，双击这一片就新建。空白什么都不说的话，用户只知道
       * 「这里不能写」，不知道「怎么让它能写」。
       */
      if (activeId === null || initialBody === null) {
        return <Welcome onNew={createNote} shortcuts={SHORTCUTS} />;
      }
      return (
        <NoteEditor
          body={initialBody}
          key={activeId}
          onChange={note.onEdit}
          onTitleChange={note.setTitle}
          title={note.state.title}
        />
      );
    }

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
          {/*
           * 内核事实原先挂在右侧栏的检视器里。右侧栏撤掉之后它们在这里（本轮批注 2）：
           * 「这个 APP 跑的是哪一版核心、数据落在哪」本来就属于「关于」。
           */}
          {ready ? (
            <dl className="facts">
              <div>
                <dt>核心版本</dt>
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
