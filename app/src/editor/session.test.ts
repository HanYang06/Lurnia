// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 会话状态机的验收：形状、标题派生、两档写入的语义。
 *
 * 这里盯的是**静默丢数据**那一类缺陷：`saved` 之后仍然有未落盘改动却报「已保存」、
 * 换文档把 pending 丢掉、空段落序列化成非法形状。它们都不会抛异常，只会在用户那里
 * 变成「我刚写的那句没了」。
 */

import { describe, expect, it } from "vitest";

import {
  emptyNoteBody,
  hasUnsaved,
  INITIAL_NOTE_SESSION,
  noteSessionReducer,
  titleOf,
  type NoteSessionState,
} from "./session";
import type { NoteBody } from "./schema";

const HEX32 = /^[0-9a-f]{32}$/;

function paragraph(text: string): Record<string, unknown> {
  return {
    type: "paragraph",
    id: "a".repeat(32),
    content: [{ type: "text", text }],
  };
}

function bodyOf(...blocks: Record<string, unknown>[]): NoteBody {
  return { doc_type: "note", version: 1, content: blocks };
}

function edited(state: NoteSessionState, body: NoteBody): NoteSessionState {
  return noteSessionReducer(state, { type: "edited", body });
}

describe("空笔记的正文形状（内核校验器的硬要求）", () => {
  it("空段落不能是 content: []，要带一条空文本节点", () => {
    const body = emptyNoteBody();
    const [first] = body.content as Record<string, unknown>[];
    expect(first.type).toBe("paragraph");
    expect(first.content).toEqual([{ type: "text", text: "" }]);
  });

  it("每个块节点都带 32 位 hex 的 id（带横线的 UUID 内核会判非法）", () => {
    const [first] = emptyNoteBody().content as Record<string, unknown>[];
    expect(String(first.id)).toMatch(HEX32);
  });

  it("连续造两篇空笔记，块 id 不一样", () => {
    const a = emptyNoteBody().content as Record<string, unknown>[];
    const b = emptyNoteBody().content as Record<string, unknown>[];
    expect(a[0].id).not.toBe(b[0].id);
  });
});

describe("标题派生：doc.save 的回复不带标题，列表先用本地推的这份", () => {
  it("取第一段非空文本", () => {
    expect(titleOf(bodyOf(paragraph(""), paragraph("今天写了点东西")))).toBe(
      "今天写了点东西",
    );
  });

  it("空文档给「新笔记」，不留空标签", () => {
    expect(titleOf(bodyOf(paragraph("")))).toBe("新笔记");
    expect(titleOf({ doc_type: "note", version: 1, content: [] })).toBe("新笔记");
  });

  it("压掉换行与多余空白，超长截断", () => {
    expect(titleOf(bodyOf(paragraph("第一行\n\n  第二行")))).toBe("第一行 第二行");
    expect(titleOf(bodyOf(paragraph("字".repeat(50))))).toHaveLength(33);
  });
});

describe("会话状态机", () => {
  const opened = noteSessionReducer(INITIAL_NOTE_SESSION, {
    type: "opened",
    note: {
      id: "n1",
      title: "旧标题",
      body: bodyOf(paragraph("旧正文")),
      revision: 7,
    },
  });

  it("打开：进列表、base_revision 记住服务端那一版", () => {
    expect(opened.activeId).toBe("n1");
    expect(opened.revision).toBe(7);
    expect(opened.entries).toEqual([{ id: "n1", label: "旧标题" }]);
    expect(hasUnsaved(opened)).toBe(false);
  });

  it("编辑：pending 非空、状态变 dirty", () => {
    const next = edited(opened, bodyOf(paragraph("新正文")));
    expect(hasUnsaved(next)).toBe(true);
    expect(next.save).toEqual({ kind: "dirty" });
  });

  it("落盘成功且期间没再改：pending 清空、revision 前进、列表标题更新", () => {
    const editedBody = bodyOf(paragraph("新正文"));
    const dirty = edited(opened, editedBody);
    const saving = noteSessionReducer(dirty, { type: "save-started", docId: "n1" });
    const saved = noteSessionReducer(saving, {
      type: "saved",
      docId: "n1",
      revision: 8,
      body: editedBody,
      title: "新正文",
    });
    expect(hasUnsaved(saved)).toBe(false);
    expect(saved.revision).toBe(8);
    expect(saved.save).toEqual({ kind: "saved" });
    expect(saved.entries).toEqual([{ id: "n1", label: "新正文" }]);
  });

  it("落盘期间又改了一版：那次保存**不算数**，仍然是 dirty", () => {
    const first = bodyOf(paragraph("第一版"));
    const second = bodyOf(paragraph("第二版"));
    const dirty = edited(opened, first);
    // 慢的保存还在路上，用户又敲了一版：
    const dirtyAgain = edited(dirty, second);
    const saved = noteSessionReducer(dirtyAgain, {
      type: "saved",
      docId: "n1",
      revision: 8,
      body: first,
      title: "第一版",
    });
    expect(hasUnsaved(saved)).toBe(true);
    expect(saved.save).toEqual({ kind: "dirty" });
    expect(saved.pending).toBe(second);
  });

  it("失败：显式摆出来，并且**留住** pending（否则这次编辑就真丢了）", () => {
    const body = bodyOf(paragraph("写了但没存上"));
    const failed = noteSessionReducer(edited(opened, body), {
      type: "save-failed",
      docId: "n1",
      message: "文档已到 revision 8，base_revision 收到 7；先取最新再决定",
    });
    expect(failed.save).toEqual({
      kind: "failed",
      message: "文档已到 revision 8，base_revision 收到 7；先取最新再决定",
    });
    expect(failed.pending).toBe(body);
    expect(hasUnsaved(failed)).toBe(true);
  });

  it("新建：base_revision 从 0 起步，正文是合法的空段落，**列表先不加**", () => {
    const created = noteSessionReducer(INITIAL_NOTE_SESSION, {
      type: "created",
      id: "n2",
    });
    expect(created.revision).toBe(0);
    // 还没入库就不该出现在列表里 —— 列表上的条目必须对应库里真有的一篇。
    expect(created.entries).toEqual([]);
    // 空稿的形状与 emptyNoteBody() 一致（id 每次不同，所以比形状不比对象）。
    const initial = created.initialBody;
    expect(initial?.doc_type).toBe("note");
    const [draft] = initial?.content as Record<string, unknown>[];
    expect(draft.type).toBe("paragraph");
    expect(String(draft.id)).toMatch(HEX32);
    expect(draft.content).toEqual([{ type: "text", text: "" }]);

    const body = bodyOf(paragraph("第一次写下的字"));
    const saved = noteSessionReducer(
      noteSessionReducer(noteSessionReducer(created, { type: "edited", body }), {
        type: "save-started",
        docId: "n2",
      }),
      { type: "saved", docId: "n2", revision: 0, body, title: "第一次写下的字" },
    );
    expect(saved.entries).toEqual([{ id: "n2", label: "第一次写下的字" }]);
  });

  it("同一篇文档不会在列表里出现两次", () => {
    const again = noteSessionReducer(opened, {
      type: "opened",
      note: { id: "n1", title: "改了标题", body: bodyOf(paragraph("x")), revision: 9 },
    });
    expect(again.entries).toHaveLength(1);
    expect(again.entries[0]?.label).toBe("改了标题");
  });

  it("没有 pending 时 save-started 不改状态（防抖空转）", () => {
    const started = noteSessionReducer(opened, { type: "save-started", docId: "n1" });
    expect(started).toBe(opened);
  });

  it("换文档之后，上一篇迟到的回复不许动当前这篇的状态", () => {
    const body = bodyOf(paragraph("上一篇的正文"));
    const dirty = edited(opened, body);
    const switched = noteSessionReducer(dirty, {
      type: "opened",
      note: { id: "n2", title: "另一篇", body: bodyOf(paragraph("乙")), revision: 3 },
    });
    const late = noteSessionReducer(switched, {
      type: "saved",
      docId: "n1",
      revision: 8,
      body,
      title: "甲",
    });
    expect(late).toBe(switched);
    expect(late.revision).toBe(3);
  });
});

describe("标题是独立字段（第五轮：纸上的头区）", () => {
  const created = noteSessionReducer(INITIAL_NOTE_SESSION, {
    type: "created",
    id: "n3",
  });

  it("打开：标题来自 doc.get 的 title，不是从正文猜的", () => {
    const openedNote = noteSessionReducer(INITIAL_NOTE_SESSION, {
      type: "opened",
      note: {
        id: "n9",
        title: "库里那个名字",
        body: bodyOf(paragraph("正文第一行完全不一样")),
        revision: 2,
      },
    });
    expect(openedNote.title).toBe("库里那个名字");
    expect(openedNote.titleDirty).toBe(false);
  });

  it("新建：标题是空的，纸上给的是「无标题」占位，不算未落盘", () => {
    expect(created.title).toBe("");
    expect(hasUnsaved(created)).toBe(false);
  });

  it("只改标题也算未落盘 —— 否则改完名停三秒什么都不会发生", () => {
    const titled = noteSessionReducer(created, { type: "title-edited", title: "周报" });
    expect(titled.title).toBe("周报");
    expect(titled.pending).toBeNull();
    expect(hasUnsaved(titled)).toBe(true);
    expect(titled.save).toEqual({ kind: "dirty" });
  });

  it("只改标题也能进 saving（不能因为正文没动就空转）", () => {
    const titled = noteSessionReducer(created, { type: "title-edited", title: "周报" });
    const saving = noteSessionReducer(titled, { type: "save-started", docId: "n3" });
    expect(saving.save).toEqual({ kind: "saving" });
    // 正文没动的时候不该假装进了 saving（那会让状态条骗人）。
    const idle = noteSessionReducer(created, { type: "save-started", docId: "n3" });
    expect(idle).toBe(created);
  });

  it("落盘成功：titleDirty 清掉，列表用用户起的名字", () => {
    const body = bodyOf(paragraph("正文"));
    const titled = noteSessionReducer(created, { type: "title-edited", title: "周报" });
    const saved = noteSessionReducer(
      noteSessionReducer(titled, { type: "save-started", docId: "n3" }),
      { type: "saved", docId: "n3", revision: 1, body, title: "周报" },
    );
    expect(saved.titleDirty).toBe(false);
    expect(hasUnsaved(saved)).toBe(false);
    expect(saved.entries).toEqual([{ id: "n3", label: "周报" }]);
  });

  it("没起名时，正文派生出来的标签**不回填标题框**（同一句话不该在纸上出现两遍）", () => {
    const body = bodyOf(paragraph("今天写了一点东西"));
    const editedState = edited(created, body);
    const saved = noteSessionReducer(
      noteSessionReducer(editedState, { type: "save-started", docId: "n3" }),
      { type: "saved", docId: "n3", revision: 1, body, title: "今天写了一点东西" },
    );
    // 列表上有标签，标题框仍然是空的。
    expect(saved.entries).toEqual([{ id: "n3", label: "今天写了一点东西" }]);
    expect(saved.title).toBe("");
  });
});

describe("列表顺序：编辑不该改变它（实机 bug）", () => {
  // 打开两篇 → 再回到第一篇（此时 active 是「甲」，但它在列表第一位）
  const openedB = noteSessionReducer(
    noteSessionReducer(INITIAL_NOTE_SESSION, {
      type: "opened",
      note: { id: "a", title: "甲", body: bodyOf(paragraph("甲")), revision: 1 },
    }),
    {
      type: "opened",
      note: { id: "b", title: "乙", body: bodyOf(paragraph("乙")), revision: 1 },
    },
  );
  const back = noteSessionReducer(openedB, {
    type: "opened",
    note: { id: "a", title: "甲", body: bodyOf(paragraph("甲")), revision: 1 },
  });

  it("新打开的追加在末尾", () => {
    expect(openedB.entries.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("保存**正在写的那一篇**之后，它不跳到末尾（上一版的 upsert 会 push 到最后）", () => {
    const saved = noteSessionReducer(back, {
      type: "saved",
      docId: "a",
      revision: 2,
      body: bodyOf(paragraph("甲改")),
      title: "甲改",
    });
    expect(saved.entries.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(saved.entries[0]?.label).toBe("甲改");
  });

  it("标签没变时列表对象不变（引用相等，别让 React 白重渲染）", () => {
    const same = noteSessionReducer(back, {
      type: "saved",
      docId: "a",
      revision: 2,
      body: bodyOf(paragraph("甲")),
      title: "甲",
    });
    expect(same.entries).toBe(back.entries);
  });
});
