// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 笔记的存取层：把内核的两条能力 `doc.get` / `doc.save` 包成类型安全的函数
 * （editor.md §十七 的能力表，路线 109 的通道那一半）。
 *
 * **为什么要有这一层。** `callKernel()` 的回复是 `Reply = {ok: unknown} | {err: KernelError}`
 * —— `ok` 之所以是 `unknown`，是因为这条边界就是进程边界（内核在 sidecar 里），
 * 对面递过来的只是序列化过的字节。收窄若留给每个渲染组件各做一遍，`as` 会像杂草
 * 一样长满界面层；收窄只该发生**一次**，就发生在这里。请求与回复的字段以
 * `src/lurnia/components/doc/store.py` 为准，不从别处猜。
 *
 * **失败只有一种形状**（bus.md §四）：回 `{err}`，不抛异常。内核给的 `kind` /
 * `message` / `retryable` 原样带出 —— `CONFLICT` 之后是重取还是覆盖，是调用方的决定，
 * 这里不替它猜。形状对不上（宿主转发坏了、协议错位）时给一个 `kind: "invalid"` 的
 * **本地**错误：让 `undefined` 漏进渲染层，只会变成更难查的空白界面。
 *
 * **能力名逐字是 `doc.get` / `doc.save`**（store.py 的 `GET_CAPABILITY` /
 * `SAVE_CAPABILITY`）。名字写错不会报错，只会安静地收不到回复 —— 所以测试里有一条
 * 专门钉住这两个字面量。
 */

import { callKernel } from "../kernel";

/** 内核给的能力名。**不许**从别处拼：拼错的表现是静默失联，不是报错。 */
const GET_CAPABILITY = "doc.get";
const SAVE_CAPABILITY = "doc.save";

/** 本地形状错误用的 `kind`，与内核 `ErrKind.INVALID` 同名同义。 */
const INVALID_KIND = "invalid";
/** 调用本身没走通（宿主转发失败、事件通道没装上）。与 `kernel.ts` 的兜底同名。 */
const UNAVAILABLE_KIND = "unavailable";

export type NoteError = { kind: string; message: string; retryable: boolean };

export type LoadedNote = {
  docId: string;
  docType: string;
  title: string;
  /** wire 形状的对象（`{doc_type, version, content}`）；这一层不解释它的内容。 */
  body: unknown;
  bodyVersion: number;
  revision: number;
  /**
   * 读时迁移发生过的旧版本号（§4.4）：库里还是老格式时才有。
   * 出现它意味着**下一次保存**才把正文写回当前版本。
   */
  migratedFrom?: number;
};

export type SavedNote = { docId: string; revision: number; commit: boolean };

/** 本层内部把「取回了 ok」与「内核/形状失败了」合成一种形状，出口再拆开。 */
type Outcome = { ok: unknown } | { err: NoteError };

function err(kind: string, message: string, retryable: boolean): { err: NoteError } {
  return { err: { kind, message, retryable } };
}

/** 形状不对：本地判定，`retryable` 为假（同一份字节再发一次还是同一份字节）。 */
function invalid(message: string): { err: NoteError } {
  return err(INVALID_KIND, message, false);
}

/** 通道没走通：可能只是核心还没起来，所以是**可重试**的。 */
function unavailable(error: unknown): { err: NoteError } {
  return err(UNAVAILABLE_KIND, describe(error), true);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "未知错误";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * 内核的错误也过一遍收窄再带出去。
 *
 * 不是为了改它，而是为了**保证** `NoteError` 的三个字段真的在：内核错误在上一次
 * 序列化里丢了字段时，`retryable` 会变成 `undefined`，然后 `if (e.retryable)`
 * 静默走 else —— 这种错比「报不出来」更难查。
 */
function readKernelError(value: unknown): NoteError | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  const message = value.message;
  const retryable = value.retryable;
  if (typeof kind !== "string" || typeof message !== "string") return null;
  if (typeof retryable !== "boolean") return null;
  return { kind, message, retryable };
}

/**
 * `doc.get` 的 `body`。
 *
 * store.py 的 `_decode_row()` 已经 `json.loads` 过，所以正常路径拿到的是**对象**；
 * 但同一份协议换个实现或换个版本，把文本原样转出来也说得通，于是字符串也接
 * —— 解一次，解不出对象才算形状不对。
 */
function readBody(raw: unknown): Outcome {
  if (isRecord(raw)) return { ok: raw };
  if (typeof raw !== "string") {
    return invalid("doc.get 的 body 既不是对象也不是 JSON 文本");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid("doc.get 的 body 不是合法 JSON");
  }
  if (!isRecord(parsed)) return invalid("doc.get 的 body 不是 JSON 对象");
  return { ok: parsed };
}

function readLoaded(raw: unknown): { ok: LoadedNote } | { err: NoteError } {
  if (!isRecord(raw)) return invalid("doc.get 的 ok 不是对象");
  const docId = asString(raw.doc_id);
  const docType = asString(raw.doc_type);
  const title = asString(raw.title);
  const bodyVersion = asInteger(raw.body_version);
  const revision = asInteger(raw.revision);
  if (
    docId === null ||
    docType === null ||
    title === null ||
    bodyVersion === null ||
    revision === null
  ) {
    return invalid("doc.get 的 ok 缺少字段或字段类型不对");
  }
  const decoded = readBody(raw.body);
  if ("err" in decoded) return decoded;
  const note: LoadedNote = {
    docId,
    docType,
    title,
    body: decoded.ok,
    bodyVersion,
    revision,
  };
  const migrated = raw.migrated_from;
  if (migrated !== undefined && migrated !== null) {
    const from = asInteger(migrated);
    if (from === null) return invalid("doc.get 的 migrated_from 不是整数");
    note.migratedFrom = from;
  }
  return { ok: note };
}

function readSaved(raw: unknown): { ok: SavedNote } | { err: NoteError } {
  if (!isRecord(raw)) return invalid("doc.save 的 ok 不是对象");
  const docId = asString(raw.doc_id);
  const revision = asInteger(raw.revision);
  const commit = raw.commit;
  if (docId === null || revision === null || typeof commit !== "boolean") {
    return invalid("doc.save 的 ok 缺少字段或字段类型不对");
  }
  return { ok: { docId, revision, commit } };
}

/**
 * 把 `body` 变成 wire 上的 **JSON 文本**。
 *
 * 「不 re-dump」（§3.3 第 2 条）说的是内核拿到文本后原样入库；文本由谁生成？
 * 由这里 —— 于是「对象 → 文本」的转换在整个前端只有这一处。
 *
 * 已经是字符串时**原样发出**：调用方可能正拿着上一次 `doc.get` 转出来的文本，
 * 而再 `stringify` 一次会把库里的正文写成「带引号的 JSON 字符串」，那是静默的数据
 * 损坏。序列化本身失败（循环引用、`BigInt`）也只回错误，不抛。
 */
function toText(body: unknown): { ok: string } | { err: NoteError } {
  if (typeof body === "string") return { ok: body };
  try {
    return { ok: JSON.stringify(body) };
  } catch (error) {
    return invalid(`doc.save 的 body 无法序列化成 JSON：${describe(error)}`);
  }
}

/**
 * 调用一次内核能力，并把回复收成 `Outcome`。
 *
 * `callKernel()` 自己承诺不抛，但它内部要先把事件通道装上（`wireReplies`），
 * 那一步是会失败的 —— 所以这里也兜一层，让「不抛异常」是这层的**性质**，
 * 而不是对另一个函数的信任。
 */
async function askKernel(capability: string, request: unknown): Promise<Outcome> {
  let reply: unknown;
  try {
    reply = await callKernel(capability, request);
  } catch (error) {
    return unavailable(error);
  }
  if (!isRecord(reply)) return invalid(`${capability} 的回复不是对象`);
  if ("err" in reply) {
    const kernelError = readKernelError(reply.err);
    return kernelError === null
      ? invalid(`${capability} 的 err 形状不对`)
      : { err: kernelError };
  }
  if (!("ok" in reply)) return invalid(`${capability} 的回复既没有 ok 也没有 err`);
  return { ok: reply.ok };
}

/**
 * 读一篇文档：`doc.get` `{doc_id}` → `{doc_id, doc_type, title, body, body_version, revision}`
 * （另有可选的 `migrated_from`）。
 */
export async function loadNote(
  docId: string,
): Promise<{ ok: LoadedNote } | { err: NoteError }> {
  const outcome = await askKernel(GET_CAPABILITY, { doc_id: docId });
  if ("err" in outcome) return outcome;
  return readLoaded(outcome.ok);
}

/**
 * 写一篇文档：`doc.save` `{doc_id, body, base_revision, commit, title?}`
 * → `{doc_id, revision, commit}`。
 *
 * 三条语义照 store.py 的 `_save` / `_read_flags` 原样透传，这里不加策略：
 *
 * - `baseRevision` 与库里的不一致 → 内核回 `Err(CONFLICT)`，**不自动合并**；
 * - `commit: false`（自动落盘）只更新当前行，`revision` 不动；`true` 才 +1 并留一版；
 * - `doc_id` 不存在且 `baseRevision: 0` 时是**新建**（`doc.save` 就是 upsert）。
 */
export async function saveNote(request: {
  docId: string;
  body: unknown;
  baseRevision: number;
  commit: boolean;
  title?: string;
}): Promise<{ ok: SavedNote } | { err: NoteError }> {
  const text = toText(request.body);
  if ("err" in text) return text;
  const sent: Record<string, unknown> = {
    doc_id: request.docId,
    body: text.ok,
    base_revision: request.baseRevision,
    commit: request.commit,
  };
  // 不给 title 就**不放这个键**：store.py 的 `_title()` 靠「有没有」决定
  // 要不要从正文里抽一个（§3.2 第 3 条），放一个 undefined 进去等于替调用方做决定。
  if (request.title !== undefined) sent.title = request.title;
  const outcome = await askKernel(SAVE_CAPABILITY, sent);
  if ("err" in outcome) return outcome;
  return readSaved(outcome.ok);
}
