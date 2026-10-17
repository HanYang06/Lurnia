// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 一篇笔记的**会话状态**：打开、编辑、落盘、提交。**这里没有 React**，只有纯函数 ——
 * 所以它能在 vitest 里直接跑，不需要渲染器；[useNote.ts](useNote.ts) 只是把它接到
 * 组件上，外加一个防抖计时器。
 *
 * 三条口径来自设计：
 *
 * 1. **两档写入**（editor.md §六 / A13、store.py 的 `_read_flags`）：自动落盘
 *    `commit: false`（只更新当前行，revision 不动），显式提交 `commit: true`（+1 并写
 *    一条 `doc_revision`）。所以 `pending` 与 `commit` 是两条不同的路，不是一个开关。
 * 2. **`base_revision` 不匹配一律 `CONFLICT`，不自动合并**（§十七）：拿到冲突就把
 *    失败**显式摆出来**，让用户决定，而不是悄悄覆盖。
 * 3. **换文档前先把未落盘的改动推下去**：编辑归编辑器自己持有，切换挂载点会把它丢掉。
 *    这一条在 `useNote` 里靠 `flush()` 落实，状态机只负责「有没有没推下去的」。
 */

import type { ListEntry } from "../shell";
import { blockId } from "./ids";
import type { NoteBody } from "./schema";

/** 自动落盘的节流窗口。设计里写的是「3 秒一次」（editor.md §3.3）。 */
export const AUTOSAVE_MS = 3000;

/** 列表条目上的标题最多留这么长；内核那边另有 TITLE_LIMIT，两者不必相等。 */
const TITLE_MAX = 32;

export type SaveState =
  /** 与服务端一致，没有未落盘的改动。 */
  | { kind: "clean" }
  /** 有改动，等防抖窗口到点。 */
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "saved" }
  /** 失败要**留住 pending**，否则这次编辑就真丢了。 */
  | { kind: "failed"; message: string };

export type NoteSessionState = {
  /**
   * 会话内的笔记列表。**内核还没有「枚举文档」的能力**（editor.md §十七 的能力表里
   * 只有 get / save），所以这里列出的是这次运行里打开或新建过的那些 —— 不是库里的
   * 全部。这是显式的缺口，不是假装列表已经通了。
   */
  entries: readonly ListEntry[];
  /** 编辑器当前挂载的文档；`null` = 还没有打开任何一篇。 */
  activeId: string | null;
  /**
   * 文档标题（`doc.get` / `doc.save` 的 `title`，**独立于正文**）。
   * 空串 = 还没起名：落库时不传这个键，让内核从正文里抽一个（store.py 的 `_title`）。
   */
  title: string;
  /** 标题改过、但正文没动：这一条也要落盘，所以「要不要保存」不能只看 `pending`。 */
  titleDirty: boolean;
  /** 编辑器**初始**正文。只决定挂载那一刻的内容，之后的编辑归编辑器自己。 */
  initialBody: NoteBody | null;
  /** 服务端已知的 revision，作为 `base_revision` 发出去。 */
  revision: number;
  /** 最近一次编辑的产物；非空 = 有没落盘的改动。 */
  pending: NoteBody | null;
  save: SaveState;
};

export type NoteSessionAction =
  | {
      type: "opened";
      note: { id: string; title: string; body: NoteBody; revision: number };
    }
  | { type: "created"; id: string }
  | { type: "edited"; body: NoteBody }
  | { type: "title-edited"; title: string }
  | { type: "save-started"; docId: string }
  | { type: "saved"; docId: string; revision: number; body: NoteBody; title: string }
  | { type: "save-failed"; docId: string; message: string }
  /** 打开失败：**不动当前这篇**，只把话说出来（点错条目不该把手里这篇关掉）。 */
  | { type: "load-failed"; message: string };

export const INITIAL_NOTE_SESSION: NoteSessionState = {
  entries: [],
  activeId: null,
  title: "",
  titleDirty: false,
  initialBody: null,
  revision: 0,
  pending: null,
  save: { kind: "clean" },
};

/**
 * 一篇空笔记的正文。
 *
 * **空段落是非法的**：校验器（`model.py` 的 `_children`）对允许子节点的类型要求
 * `content` 非空，所以这里给的是一个只有空文本节点的段落 —— 形状合法，屏幕上就是
 * 一个空段落加一个光标。
 */
export function emptyNoteBody(): NoteBody {
  return {
    doc_type: "note",
    version: 1,
    content: [
      {
        type: "paragraph",
        id: blockId(),
        content: [{ type: "text", text: "" }],
      },
    ],
  };
}

/**
 * 从正文里取一个标题（列表上显示用）：第一段非空文本，截到 32 字符。
 *
 * 内核也会这么派一份（`store._title` → 类型的 `extract_text`），但 `doc.save` 的回复
 * 只给 revision，不回标题；所以列表先用本地推出来的这一份，`doc.get` 回来时用真的。
 */
export function titleOf(body: NoteBody): string {
  const found = firstText(body.content);
  const flat = found.replace(/\s+/g, " ").trim();
  if (flat.length === 0) {
    return "新笔记";
  }
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX)}…` : flat;
}

function firstText(nodes: unknown): string {
  if (!Array.isArray(nodes)) {
    return "";
  }
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) {
      continue;
    }
    const record = node as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      if (record.text.trim().length > 0) {
        return record.text;
      }
      continue;
    }
    const deeper = firstText(record.content);
    if (deeper.length > 0) {
      return deeper;
    }
  }
  return "";
}

/**
 * 加一条 / 更新一条，**位置不动**。
 *
 * 上一版是 `filter` 掉再 push，于是**每保存一次，这条就跳到列表最底下** ——
 * 用户看到的症状是「写哪篇，哪篇就沉底」，三条笔记排了三种顺序。列表的顺序是
 * 用户的空间记忆，任何一次编辑都不该把它打乱：这里只**就地换标签**，只有新条目
 * 才追加到末尾。
 */
function upsert(entries: readonly ListEntry[], id: string, label: string): ListEntry[] {
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) {
    return [...entries, { id, label }];
  }
  if (entries[index].label === label) {
    // 标签没变就原样返回：引用相等能让 React 少一次渲染，也让「列表没变」可测。
    return entries as ListEntry[];
  }
  const next = [...entries];
  next[index] = { id, label };
  return next;
}

export function noteSessionReducer(
  state: NoteSessionState,
  action: NoteSessionAction,
): NoteSessionState {
  switch (action.type) {
    case "opened":
      return {
        entries: upsert(state.entries, action.note.id, action.note.title),
        activeId: action.note.id,
        // 标题来自 `doc.get` 的 `title`：它可能不是正文第一行（内核那边也是独立一列）。
        title: action.note.title,
        titleDirty: false,
        initialBody: action.note.body,
        revision: action.note.revision,
        pending: null,
        save: { kind: "clean" },
      };

    case "created":
      return {
        // **不往列表里加**：这篇还没入库（第一次编辑才写），列表里先不出现一个
        // 并不存在的条目。第一次保存成功时，`saved` 那一支会把它补上去。
        entries: state.entries,
        activeId: action.id,
        // 新笔记还没有名字：留空，纸上是「无标题」占位。
        title: "",
        titleDirty: false,
        initialBody: emptyNoteBody(),
        // 还没入库：base_revision 0 对内核来说就是「新建」。
        revision: 0,
        pending: null,
        save: { kind: "clean" },
      };

    case "edited":
      return { ...state, pending: action.body, save: { kind: "dirty" } };

    /*
     * 标题单独改：`pending` 保持原样（正文没动），另立一个 `titleDirty`。
     * 这两件事分开记，才能做到「只改了名字也照样存下去」—— 只看 `pending` 的话，
     * 用户改完标题停三秒，什么都不发生，而且没有任何提示。
     */
    case "title-edited":
      return {
        ...state,
        title: action.title,
        titleDirty: true,
        save: { kind: "dirty" },
      };

    case "save-started":
      return state.activeId === action.docId &&
        (state.pending !== null || state.titleDirty)
        ? { ...state, save: { kind: "saving" } }
        : state;

    case "saved": {
      // 迟到的回复属于**上一篇**：换文档之后它不该改当前这篇的状态。
      if (state.activeId !== action.docId) {
        return state;
      }
      // 引用比较是有意的：`pending` 存的就是 `edited` 带上来的那个对象，
      // 所以「落盘的是不是当前这一份」一问就知道。期间又敲过字的话，pending
      // 已经换成新对象了 —— 那就还是 dirty，不能报「已保存」。
      const current = state.pending === null || state.pending === action.body;
      return {
        ...state,
        entries: upsert(state.entries, action.docId, action.title),
        revision: action.revision,
        pending: current ? null : state.pending,
        /*
         * 标题**不跟着 action.title 走**：后者是「列表上那条标签」，用户没起名时它是
         * 从正文第一行抽的（`titleOf`）。照它回填的话，用户在正文里写第一句，
         * 标题框里就会凭空多出一个同名的标题 —— 同一句话在纸上出现两遍。
         * 标题框只认用户自己敲进去的那个值（`title-edited`）。
         */
        titleDirty: current ? false : state.titleDirty,
        save: current ? { kind: "saved" } : { kind: "dirty" },
      };
    }

    case "save-failed":
      return state.activeId === action.docId
        ? { ...state, save: { kind: "failed", message: action.message } }
        : state;

    case "load-failed":
      return { ...state, save: { kind: "failed", message: action.message } };

    default:
      return state;
  }
}

/** 有改动没落盘吗（换文档前要看这个）。 */
export function hasUnsaved(state: NoteSessionState): boolean {
  return state.pending !== null || state.titleDirty;
}
