// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 存取层的门禁（路线 109 的通道那一半）。
 *
 * **为什么测试重心不在 happy path。** 这一层存在的理由就是「内核递过来的东西不可信」，
 * 而不可信的地方很少以崩溃的形式出现：少一个字段是 `undefined` 悄悄进了渲染层，
 * `revision` 变成字符串是把 `"4" + 1` 写进下一次请求。所以下面大半在打**形状不对**
 * 的路径 —— `ok: null`、缺字段、类型错、回复根本不是对象、调用本身被拒。
 *
 * 另有两条容易**静默**失效的东西，各有一条专门的测试：
 *
 * - 能力名逐字是 `doc.get` / `doc.save`：写错不会报错，只会永远收不到回复；
 * - `doc.save` 的 `body` 是 **JSON 文本**而不是对象（§3.3「不 re-dump」）。
 *
 * 内核用 mock 顶替：`callKernel()` 是前端与内核之间**唯一**的那条边，把它换掉之后，
 * 这一层的行为不需要装配内核、也不需要宿主就能完整观测。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { callKernel } = vi.hoisted(() => ({
  callKernel: vi.fn<(capability: string, request: unknown) => Promise<unknown>>(),
}));

// `vi.mock` 的工厂会被提升到 import 之上，所以只能引用 `vi.hoisted` 里的东西。
vi.mock("../kernel", () => ({ callKernel }));

import { loadNote, saveNote, type NoteError } from "./notes";

/** 一份形状正确的 `doc.get` 回复，字段照 store.py 的 `_get()`。 */
const GET_OK = {
  doc_id: "0199a2",
  doc_type: "note",
  title: "标题",
  body: { doc_type: "note", version: 1, content: [] },
  body_version: 1,
  revision: 3,
};

/** 一份形状正确的 `doc.save` 回复，字段照 store.py 的 `_save()`。 */
const SAVE_OK = { doc_id: "0199a2", revision: 4, commit: true };

/** 保存请求里那个 wire 形状的正文。 */
const WIRE_BODY = { doc_type: "note", version: 1, content: [] };

function expectOk<T>(result: { ok: T } | { err: NoteError }): T {
  if ("err" in result) {
    throw new Error(`期望成功，却失败：${result.err.kind} / ${result.err.message}`);
  }
  return result.ok;
}

function expectErr(result: { ok: unknown } | { err: NoteError }): NoteError {
  if ("err" in result) return result.err;
  throw new Error("期望失败，却成功了");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 最后一次调用的请求体；断言用，所以形状不对就直接把测试打红。 */
function sentRequest(): Record<string, unknown> {
  // 不用 `Array.prototype.at`：tsconfig 的 lib 停在 ES2020，它要到 ES2022 才有。
  const calls = callKernel.mock.calls;
  if (calls.length === 0) throw new Error("还没有发生过调用");
  const call = calls[calls.length - 1];
  const request: unknown = call[1];
  if (!isRecord(request)) throw new Error("请求不是对象");
  return request;
}

/** 发生过调用的能力名，按顺序。 */
function capabilities(): string[] {
  return callKernel.mock.calls.map(([capability]) => capability);
}

beforeEach(() => {
  callKernel.mockReset();
});

describe("loadNote：把 doc.get 的回复收窄成 LoadedNote", () => {
  it("字段逐个映射（snake_case → camelCase），body 原样带出", async () => {
    callKernel.mockResolvedValue({ ok: { ...GET_OK } });
    const note = expectOk(await loadNote("0199a2"));
    expect(note).toEqual({
      docId: "0199a2",
      docType: "note",
      title: "标题",
      body: { doc_type: "note", version: 1, content: [] },
      bodyVersion: 1,
      revision: 3,
    });
    // 没迁移过就不能凭空多出这个键（`migratedFrom: undefined` 与「没有」在
    // 调用方那里是两回事：前者会被 `in` 判成有）。
    expect(note).not.toHaveProperty("migratedFrom");
  });

  it("migrated_from 出现时带成 migratedFrom —— 0 也算出现（§4.4）", async () => {
    callKernel.mockResolvedValue({ ok: { ...GET_OK, migrated_from: 0 } });
    expect(expectOk(await loadNote("0199a2")).migratedFrom).toBe(0);
  });

  it("body 是字符串时也接（换个实现/版本，文本原样转出来）", async () => {
    callKernel.mockResolvedValue({
      ok: { ...GET_OK, body: JSON.stringify(WIRE_BODY) },
    });
    expect(expectOk(await loadNote("0199a2")).body).toEqual(WIRE_BODY);
  });

  it("内核的错误原样带出 kind / message / retryable", async () => {
    callKernel.mockResolvedValue({
      err: { kind: "not_found", message: "没有这篇文档：nope", retryable: false },
    });
    expect(expectErr(await loadNote("nope"))).toEqual({
      kind: "not_found",
      message: "没有这篇文档：nope",
      retryable: false,
    });
  });
});

describe("形状不对时回显式的 invalid，不崩也不漏 undefined", () => {
  const BROKEN_OKS: [label: string, ok: unknown][] = [
    ["ok 是 null", null],
    ["ok 不是对象", "0199a2"],
    ["ok 少了 title", { ...GET_OK, title: undefined }],
    ["revision 是字符串", { ...GET_OK, revision: "3" }],
    ["body_version 是小数", { ...GET_OK, body_version: 1.5 }],
    ["body 是数字", { ...GET_OK, body: 7 }],
    ["body 是解不出的字符串", { ...GET_OK, body: "{不是 JSON" }],
    ["body 字符串解出来不是对象", { ...GET_OK, body: "[1,2,3]" }],
    ["migrated_from 不是整数", { ...GET_OK, migrated_from: "0" }],
  ];

  for (const [label, ok] of BROKEN_OKS) {
    it(`doc.get：${label} → invalid`, async () => {
      callKernel.mockResolvedValue({ ok });
      const error = expectErr(await loadNote("0199a2"));
      expect(error.kind).toBe("invalid");
      expect(error.retryable).toBe(false);
      expect(error.message.length).toBeGreaterThan(0);
    });
  }

  it("回复既没有 ok 也没有 err → invalid", async () => {
    callKernel.mockResolvedValue({});
    expect(expectErr(await loadNote("0199a2")).kind).toBe("invalid");
  });

  it("回复根本不是对象 → invalid", async () => {
    callKernel.mockResolvedValue(null);
    expect(expectErr(await loadNote("0199a2")).kind).toBe("invalid");
  });

  it("内核错误自己缺字段（retryable 丢了）→ invalid，不让 undefined 溜过去", async () => {
    callKernel.mockResolvedValue({ err: { kind: "conflict", message: "撞了" } });
    expect(expectErr(await loadNote("0199a2")).kind).toBe("invalid");
  });

  it("调用被拒（宿主没接上）→ unavailable 且可重试", async () => {
    callKernel.mockRejectedValue(new Error("宿主没接上"));
    const error = expectErr(await loadNote("0199a2"));
    expect(error).toEqual({
      kind: "unavailable",
      message: "宿主没接上",
      retryable: true,
    });
  });
});

describe("saveNote：发出去的请求", () => {
  it("body 是 JSON 文本；base_revision / commit 原样透传", async () => {
    callKernel.mockResolvedValue({ ok: { ...SAVE_OK } });
    const saved = expectOk(
      await saveNote({
        docId: "0199a2",
        body: WIRE_BODY,
        baseRevision: 3,
        commit: true,
      }),
    );
    expect(saved).toEqual({ docId: "0199a2", revision: 4, commit: true });
    expect(sentRequest()).toEqual({
      doc_id: "0199a2",
      body: JSON.stringify(WIRE_BODY),
      base_revision: 3,
      commit: true,
    });
    expect(typeof sentRequest().body).toBe("string");
  });

  it("没给 title 时请求里**没有** title 这个键（给了空串才算给了）", async () => {
    callKernel.mockResolvedValue({ ok: { ...SAVE_OK } });
    await saveNote({
      docId: "0199a2",
      body: WIRE_BODY,
      baseRevision: 0,
      commit: false,
    });
    expect(sentRequest()).not.toHaveProperty("title");
    expect(sentRequest()).toEqual({
      doc_id: "0199a2",
      body: JSON.stringify(WIRE_BODY),
      base_revision: 0,
      commit: false,
    });
  });

  it("给了 title 就原样透传（由内核去截断）", async () => {
    callKernel.mockResolvedValue({ ok: { ...SAVE_OK } });
    await saveNote({
      docId: "0199a2",
      body: WIRE_BODY,
      baseRevision: 3,
      commit: true,
      title: "自定义标题",
    });
    expect(sentRequest()).toHaveProperty("title", "自定义标题");
  });

  it("调用方手里已经是 JSON 文本时不再 stringify 一次（否则库里会多一层引号）", async () => {
    callKernel.mockResolvedValue({ ok: { ...SAVE_OK } });
    const text = JSON.stringify(WIRE_BODY);
    // 自动落盘（commit: false）也是同一条路：新建时 base_revision 是 0。
    await saveNote({ docId: "0199a2", body: text, baseRevision: 0, commit: false });
    expect(sentRequest().body).toBe(text);
  });

  it("序列化不了的对象回 invalid，不抛（循环引用）", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const error = expectErr(
      await saveNote({
        docId: "0199a2",
        body: circular,
        baseRevision: 0,
        commit: false,
      }),
    );
    expect(error.kind).toBe("invalid");
    expect(callKernel).not.toHaveBeenCalled();
  });

  it("内核的 Err(CONFLICT) 原样带出 —— 重取还是覆盖是调用方的事", async () => {
    callKernel.mockResolvedValue({
      err: { kind: "conflict", message: "文档已到 revision 3", retryable: false },
    });
    const error = expectErr(
      await saveNote({
        docId: "0199a2",
        body: WIRE_BODY,
        baseRevision: 2,
        commit: true,
      }),
    );
    expect(error.kind).toBe("conflict");
    expect(error.message).toBe("文档已到 revision 3");
  });
});

describe("saveNote：回复的形状不对时回显式 err", () => {
  const BROKEN_OKS: [label: string, ok: unknown][] = [
    ["ok 是 null", null],
    ["revision 是字符串", { ...SAVE_OK, revision: "4" }],
    ["revision 是小数", { ...SAVE_OK, revision: 4.5 }],
    ["commit 是字符串", { ...SAVE_OK, commit: "true" }],
    ["少了 revision", { doc_id: "0199a2", commit: true }],
  ];

  for (const [label, ok] of BROKEN_OKS) {
    it(`${label} → invalid`, async () => {
      callKernel.mockResolvedValue({ ok });
      const error = expectErr(
        await saveNote({
          docId: "0199a2",
          body: WIRE_BODY,
          baseRevision: 3,
          commit: true,
        }),
      );
      expect(error.kind).toBe("invalid");
      expect(error.retryable).toBe(false);
    });
  }
});

describe("能力名逐字是内核的那两个（写错只会静默失联）", () => {
  it('loadNote 调用的是 "doc.get"', async () => {
    callKernel.mockResolvedValue({ ok: { ...GET_OK } });
    await loadNote("0199a2");
    expect(callKernel).toHaveBeenCalledWith("doc.get", { doc_id: "0199a2" });
    expect(capabilities()).toEqual(["doc.get"]);
  });

  it('saveNote 调用的是 "doc.save"', async () => {
    callKernel.mockResolvedValue({ ok: { ...SAVE_OK } });
    await saveNote({ docId: "0199a2", body: WIRE_BODY, baseRevision: 3, commit: true });
    expect(callKernel).toHaveBeenCalledWith("doc.save", {
      doc_id: "0199a2",
      body: JSON.stringify(WIRE_BODY),
      base_revision: 3,
      commit: true,
    });
    expect(capabilities()).toEqual(["doc.save"]);
  });
});

describe("一次完整往返（不需要宿主）", () => {
  it("loadNote 拿到的 body / revision 直接喂回 saveNote，两次的能力名与字段都对得上", async () => {
    callKernel.mockResolvedValueOnce({ ok: { ...GET_OK } });
    const loaded = expectOk(await loadNote("0199a2"));

    callKernel.mockResolvedValueOnce({ ok: { ...SAVE_OK } });
    const saved = expectOk(
      await saveNote({
        docId: loaded.docId,
        body: loaded.body,
        baseRevision: loaded.revision,
        commit: true,
      }),
    );

    expect(saved).toEqual({ docId: "0199a2", revision: 4, commit: true });
    expect(capabilities()).toEqual(["doc.get", "doc.save"]);
    expect(callKernel.mock.calls[1][1]).toEqual({
      doc_id: "0199a2",
      body: JSON.stringify(GET_OK.body),
      base_revision: 3,
      commit: true,
    });
  });
});
