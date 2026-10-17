// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 编辑内核的 schema（路线 109）。口径：
 * [editor.md](../../../docs/design/editor.md) §4.2 的节点清单、§4.3 的块身份、§十九 的 A10，
 * 以及 A3「schema 是单一来源」。
 *
 * **节点清单只有一个来源**：`src/lurnia/components/note/schema/note.schema.json`
 * —— Python 校验器读的那一份。这里在**运行期**把它读进来，节点名、每类允许的子节点、
 * marks 全部由它生成；只有「怎么落成 DOM、attr 的默认值是什么」这类渲染细节写在
 * `NODE_RENDER` / `MARK_RENDER` 里，而且两张表的完整性由模块自己在装配时断言
 * （JSON 加了节点而这里没跟上会当场抛，不是少一个节点悄悄跑）。
 *
 * 为什么不在构建期生成一份 TS：生成物会进仓库，改了 JSON 忘了重新生成就漂了。
 * 运行期 import 的代价只有一次 schema 装配。
 *
 * wire 形状的硬事实来自 `doc/model.py`，写错就是 `Err(INVALID)`：
 *
 * 1. 块节点必须带 `id`，形状 `^[0-9a-f]{32}$`（带横线的 UUID 会被判非法）；文本节点没有 id。
 * 2. 文档 `content` 必须非空；**空段落非法**（`_children` 对「允许子节点却给空列表」报错），
 *    所以空段落要序列化成一条空文本节点。
 * 3. ProseMirror 不允许存在空文本节点（`Empty text nodes are not allowed`），
 *    于是「Python 侧要的空文本」与「PM 侧不许的空文本」这两端都在这个文件里闭合：
 *    读进来时丢掉，写出去时补上。
 * 4. `attrs` 只放 JSON 声明过的键（外加块 id）；未知键丢掉，与 Python 侧「未知 attrs 不拒」
 *    相比更严一点，但不会更松。
 */

import { Schema } from "prosemirror-model";
import type {
  DOMOutputSpec,
  Mark,
  MarkSpec,
  Node as PMNode,
  NodeSpec,
  TagParseRule,
} from "prosemirror-model";
import type { Transaction } from "prosemirror-state";

import noteSchemaJson from "../../../src/lurnia/components/note/schema/note.schema.json";
import { blockId } from "./ids";

// --- schema 资源：JSON 的形状（Python 的 `compile_schema` 认同一份） ----------

type JsonNode = { content?: string[]; attrs?: string[] };

type JsonSchema = {
  doc_type: string;
  version: number;
  root: string[];
  nodes: Record<string, JsonNode>;
  marks: string[];
};

/** 规格表里的 attr：名字由 JSON 定，默认值在这里定。 */
type AttrSpecMap = Record<string, { default?: unknown }>;

/** JSON 形状的节点（PM 的 `nodeFromJSON` 吃的就是它）。 */
type WireJson = Record<string, unknown>;

const SOURCE: JsonSchema = noteSchemaJson;

/** wire 顶层：`{ doc_type, version, content }`。名字与版本也取自 JSON，不另抄一份。 */
export const NOTE_DOC_TYPE: string = SOURCE.doc_type;
export const NOTE_VERSION: number = SOURCE.version;

/** 已校验过的正文。`JSON.stringify` 之后可以直接交给 `doc.save`。 */
export type NoteBody = { doc_type: string; version: number; content: unknown[] };

/** 块 id 的形状：`uuid.uuid7().hex`（`model.py` 的 `ID_PATTERN`）。 */
const ID_PATTERN = /^[0-9a-f]{32}$/;

function isBlockId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/**
 * `node.attrs` 在 ProseMirror 的类型里是 `{[name: string]: any}`。这里把参数的类型写成
 * `Record<string, unknown>`，值就沿着 `unknown` 走 —— 断言能省则省，`any` 也不会扩散
 * （strictTypeChecked 会一路报 unsafe-*）。
 */
function rawAttrs(node: {
  readonly attrs: Record<string, unknown>;
}): Record<string, unknown> {
  return node.attrs;
}

function declaredAttrs(spec: { readonly attrs?: AttrSpecMap | null }): AttrSpecMap {
  return spec.attrs ?? {};
}

function attrString(node: PMNode, name: string): string {
  const value = rawAttrs(node)[name];
  return typeof value === "string" ? value : "";
}

function attrFlag(node: PMNode, name: string): boolean {
  return rawAttrs(node)[name] === true;
}

/** 标题级别：JSON 只说有 `level` 这个 attr，1–3 是 editor.md §4.2 的约束。 */
function headingLevel(node: PMNode): number {
  const value = rawAttrs(node).level;
  return typeof value === "number" && value >= 1 && value <= 3 ? value : 1;
}

// --- 渲染规格表：JSON 说结构，这里说怎么落成 DOM -----------------------------

type NodeRender = {
  /** JSON 声明过的 attr → 默认值（名字集合与 JSON 双向绑住，装配时断言）。 */
  attrs?: Record<string, unknown>;
  toDOM: (node: PMNode) => DOMOutputSpec;
  parseDOM?: TagParseRule[];
  /** 叶子块：整体选中，内部不可编辑。 */
  atom?: boolean;
  /** 语义上的代码：解析与粘贴时空白按 pre 处理。 */
  code?: boolean;
  defining?: boolean;
};

/**
 * 原子块（image / attachment / doc_ref）的 DOM：一个 `div` + 一句说明。
 *
 * **绝不带 `src`**：I9 不许渲染过程发起任何对外动作，远程图片就是一次网络请求。
 * 本体怎么取是附件通道的事（后续路线），这里只落一个可被引用、可被选中的占位。
 */
function atomDom(
  kind: string,
  extra: Record<string, string>,
  label: string,
): DOMOutputSpec {
  return ["div", { class: "lr-editor__atom", "data-atom": kind, ...extra }, label];
}

const NODE_RENDER: Record<string, NodeRender | undefined> = {
  paragraph: { toDOM: () => ["p", 0], parseDOM: [{ tag: "p" }] },

  heading: {
    attrs: { level: 1 },
    toDOM: (node) => [`h${headingLevel(node)}`, 0],
    parseDOM: [
      { tag: "h1", attrs: { level: 1 } },
      { tag: "h2", attrs: { level: 2 } },
      { tag: "h3", attrs: { level: 3 } },
    ],
  },

  bullet_list: { toDOM: () => ["ul", 0], parseDOM: [{ tag: "ul" }] },
  ordered_list: { toDOM: () => ["ol", 0], parseDOM: [{ tag: "ol" }] },
  list_item: {
    toDOM: () => ["li", 0],
    parseDOM: [{ tag: "li" }],
    defining: true,
  },
  quote: {
    toDOM: () => ["blockquote", 0],
    parseDOM: [{ tag: "blockquote" }],
    defining: true,
  },

  code_block: {
    attrs: { language: null },
    toDOM: () => ["pre", ["code", 0]],
    parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
    code: true,
  },

  divider: { toDOM: () => ["hr"], parseDOM: [{ tag: "hr" }], atom: true },

  table: {
    attrs: { widths: null },
    toDOM: () => ["table", ["tbody", 0]],
    parseDOM: [{ tag: "table" }],
  },
  table_row: { toDOM: () => ["tr", 0], parseDOM: [{ tag: "tr" }] },
  table_cell: {
    attrs: { header: false },
    toDOM: (node) => [attrFlag(node, "header") ? "th" : "td", 0],
    parseDOM: [
      { tag: "th", attrs: { header: true } },
      { tag: "td", attrs: { header: false } },
    ],
  },

  image: {
    attrs: { attachment_id: null, alt: null },
    atom: true,
    toDOM: (node) =>
      atomDom(
        "image",
        { "data-attachment-id": attrString(node, "attachment_id") },
        attrString(node, "alt") || attrString(node, "attachment_id") || "图片",
      ),
    parseDOM: [
      {
        tag: "div[data-atom='image']",
        getAttrs: (dom) => ({
          attachment_id: dom.getAttribute("data-attachment-id"),
        }),
      },
    ],
  },

  attachment: {
    attrs: { attachment_id: null, name: null },
    atom: true,
    toDOM: (node) =>
      atomDom(
        "attachment",
        { "data-attachment-id": attrString(node, "attachment_id") },
        attrString(node, "name") || attrString(node, "attachment_id") || "附件",
      ),
    parseDOM: [
      {
        tag: "div[data-atom='attachment']",
        getAttrs: (dom) => ({
          attachment_id: dom.getAttribute("data-attachment-id"),
          name: dom.textContent,
        }),
      },
    ],
  },

  doc_ref: {
    attrs: { doc_id: null, block_id: null, display: null },
    atom: true,
    toDOM: (node) =>
      atomDom(
        "doc_ref",
        {
          "data-doc-id": attrString(node, "doc_id"),
          "data-block-id": attrString(node, "block_id"),
        },
        attrString(node, "display") || attrString(node, "doc_id") || "引用",
      ),
    parseDOM: [
      {
        tag: "div[data-atom='doc_ref']",
        getAttrs: (dom) => ({
          doc_id: dom.getAttribute("data-doc-id"),
          block_id: dom.getAttribute("data-block-id"),
          display: dom.textContent,
        }),
      },
    ],
  },
};

/**
 * marks 的渲染规格。JSON 只声明**名字**（`["strong", "em", …]`），attr 是渲染细节：
 *
 * * `link` 必须带 `href`，否则这个标记没有任何可表达的东西；Python 的 `_text` 只查
 *   `mark.type` 在不在白名单里，不查 attrs，所以 wire 上多一个 `href` 是合法的。
 * * `highlight` 只落一个 `<mark>`，底色归样式表（ui.md §八：颜色只能走令牌）。
 */
const MARK_RENDER: Record<string, MarkSpec | undefined> = {
  strong: {
    toDOM: () => ["strong", 0],
    parseDOM: [{ tag: "strong" }, { tag: "b" }],
  },
  em: {
    toDOM: () => ["em", 0],
    parseDOM: [{ tag: "em" }, { tag: "i" }],
  },
  strike: {
    toDOM: () => ["s", 0],
    parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }],
  },
  code: {
    toDOM: () => ["code", 0],
    parseDOM: [{ tag: "code" }],
  },
  link: {
    attrs: { href: { default: null } },
    toDOM: (mark) => {
      const href = rawAttrs(mark).href;
      return ["a", { href: typeof href === "string" ? href : null }, 0];
    },
    parseDOM: [
      {
        tag: "a[href]",
        getAttrs: (dom) => ({ href: dom.getAttribute("href") }),
      },
    ],
  },
  highlight: {
    toDOM: () => ["mark", 0],
    parseDOM: [{ tag: "mark" }],
  },
};

// --- 由 JSON 生成内容表达式 ---------------------------------------------------

/**
 * 内容表达式由 JSON 的 `content` 列表机械生成，规则只有三条：
 * 允许子节点为空 → 叶子；恰好是 `text` → `text*`；其余 → `(a | b)+`。
 *
 * `text` 用 `*` 而不是一个 `text`：段落里必须能并存多个带不同 marks 的文本节点。
 * `+` 而不是 `*`：Python 侧的 `content` 必须非空，表达式与它对齐后，
 * 「有没有子节点」在两边是同一个问题。
 */
function contentExpression(name: string, children: string[]): string | undefined {
  if (children.length === 0) return undefined;
  if (children.includes("text")) {
    if (children.length > 1) {
      throw new Error(
        `note.schema.json：${name} 的 content 同时含 text 与块节点，ProseMirror 没有这种内容表达式`,
      );
    }
    return "text*";
  }
  return `(${children.join(" | ")})+`;
}

/** 节点规格：attr 名字与子节点来自 JSON，其余来自 `NODE_RENDER`。 */
function nodeSpecFor(name: string, json: JsonNode): NodeSpec {
  const render = NODE_RENDER[name];
  if (!render) {
    throw new Error(`note.schema.json 里的节点 ${name} 没有渲染规格（NODE_RENDER）`);
  }
  const { attrs: defaults = {}, ...visual } = render;
  const declared = json.attrs ?? [];
  for (const attr of declared) {
    if (!Object.keys(defaults).includes(attr)) {
      throw new Error(`节点 ${name} 的 attr ${attr} 在 NODE_RENDER 里没有默认值`);
    }
  }
  for (const attr of Object.keys(defaults)) {
    if (!declared.includes(attr)) {
      throw new Error(`NODE_RENDER.${name} 的 attr ${attr} 不在 note.schema.json 里`);
    }
  }
  const attrs: Record<string, { default: unknown }> = { id: { default: null } };
  for (const attr of declared) {
    attrs[attr] = { default: defaults[attr] };
  }
  return { content: contentExpression(name, json.content ?? []), attrs, ...visual };
}

/**
 * 装配 schema。每次调用都新建一份（`Schema` 不可变，共用一份也成立；
 * 新建只是让这个签名名副其实）。
 *
 * `id` 是**每个块节点都有**的 attr，不写在 JSON 里 —— 它不是 note 类型特有的东西，
 * 而是 §4.3 的通用契约（任何文档类型的块都有身份）。文本节点没有 id，所以它只在
 * 节点表里，不在 marks 表里。
 */
export function buildNoteSchema(): Schema {
  const nodes: Record<string, NodeSpec> = {};
  for (const [name, json] of Object.entries(SOURCE.nodes)) {
    nodes[name] = nodeSpecFor(name, json);
  }
  // ProseMirror 要求节点表里有一个名为 text 的条目，行内内容由它承担。
  nodes.text = { group: "inline" };
  nodes.doc = { content: contentExpression("doc", SOURCE.root) };

  const marks: Record<string, MarkSpec> = {};
  for (const name of SOURCE.marks) {
    const render = MARK_RENDER[name];
    if (!render) {
      throw new Error(`note.schema.json 里的 mark ${name} 没有渲染规格（MARK_RENDER）`);
    }
    marks[name] = render;
  }

  return new Schema({ nodes, marks });
}

// --- wire → ProseMirror ------------------------------------------------------

/**
 * 边界清洗（§4.2 的清单是封闭的）：不认识的节点类型与 mark 一律丢掉，不静默保留。
 * 空文本节点在这里丢掉 —— ProseMirror 根本不允许它存在。
 */
function sanitizeNode(schema: Schema, raw: unknown): WireJson | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string") return null;
  if (type === "text") return sanitizeText(schema, record);
  if (!(type in schema.nodes)) return null;

  const attrs: Record<string, unknown> = {
    id: isBlockId(record.id) ? record.id : blockId(),
  };
  copyDeclaredAttrs(schema.nodes[type].spec, record.attrs, attrs);

  const out: WireJson = { type, attrs };
  const children = sanitizeChildren(schema, record.content);
  if (children) out.content = children;
  return out;
}

function sanitizeText(
  schema: Schema,
  record: Record<string, unknown>,
): WireJson | null {
  const text = record.text;
  if (typeof text !== "string" || text.length === 0) return null;
  const out: WireJson = { type: "text", text };
  const marks = sanitizeMarks(schema, record.marks);
  if (marks.length > 0) out.marks = marks;
  return out;
}

function sanitizeMarks(schema: Schema, raw: unknown): WireJson[] {
  if (!isUnknownArray(raw)) return [];
  const out: WireJson[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const type = record.type;
    if (typeof type !== "string" || !(type in schema.marks)) continue;
    const mark: WireJson = { type };
    if (typeof record.attrs === "object" && record.attrs !== null) {
      mark.attrs = record.attrs;
    }
    out.push(mark);
  }
  return out;
}

function sanitizeChildren(schema: Schema, raw: unknown): WireJson[] | null {
  if (!isUnknownArray(raw)) return null;
  const out: WireJson[] = [];
  for (const entry of raw) {
    const clean = sanitizeNode(schema, entry);
    if (clean) out.push(clean);
  }
  return out.length > 0 ? out : null;
}

/** 只把 JSON 声明过的 attrs 带进去；未声明的键丢掉（块 id 单独处理，见上）。 */
function copyDeclaredAttrs(
  spec: { readonly attrs?: AttrSpecMap | null },
  raw: unknown,
  target: Record<string, unknown>,
): void {
  if (typeof raw !== "object" || raw === null) return;
  const source = raw as Record<string, unknown>;
  for (const name of Object.keys(declaredAttrs(spec))) {
    if (name === "id") continue;
    if (name in source) target[name] = source[name];
  }
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * wire → PM doc。**任何输入都不把异常抛给 UI**：坏块丢掉，全坏就退化成「一个空段落」。
 *
 * 丢块而不是丢整篇，是因为「库里每一行都通过校验」（§4.4），坏块只可能来自手写 JSON
 * 或将来某个不兼容的版本 —— 那种情况下能打开的部分仍然值得打开。
 */
export function docFromBody(schema: Schema, body: unknown): PMNode {
  const content = readContent(body);
  if (!content) return emptyDoc(schema);

  const docType = schema.nodes.doc;
  const blocks: PMNode[] = [];
  for (const raw of content) {
    const clean = sanitizeNode(schema, raw);
    if (!clean) continue;
    try {
      const node = schema.nodeFromJSON(clean);
      if (docType.contentMatch.matchType(node.type)) blocks.push(node);
    } catch {
      // 单个块解不出来就丢掉它，剩下的照常打开。
    }
  }

  if (blocks.length === 0) return emptyDoc(schema);
  try {
    return schema.node("doc", null, blocks);
  } catch {
    return emptyDoc(schema);
  }
}

/**
 * 读出 wire 的 `content`。`doc_type` / `version` 不认识就不解析 —— 老版本要走迁移链
 * （Python 侧的事），前端硬猜只会把内容猜坏。
 */
function readContent(body: unknown): unknown[] | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (record.doc_type !== NOTE_DOC_TYPE) return null;
  if (record.version !== NOTE_VERSION) return null;
  const content = record.content;
  if (!isUnknownArray(content) || content.length === 0) return null;
  return content;
}

// --- ProseMirror → wire ------------------------------------------------------

/** 空段落：wire 上是 `{type:"paragraph", id, content:[{type:"text",text:""}]}`。 */
function emptyParagraph(schema: Schema): PMNode {
  return schema.node("paragraph", { id: blockId() });
}

function emptyDoc(schema: Schema): PMNode {
  return schema.node("doc", null, emptyParagraph(schema));
}

/**
 * PM doc → wire。同一个 doc 连续序列化两次得到**逐字节相同**的结果：序列化只读不写，
 * 不产生随机值 —— 唯一的例外是「块根本没有 id」这种不正常输入，那时补一个
 * （正常路径上 id 由 `docFromBody` 与 `ensureBlockIds` 建立，见下）。
 */
export function bodyFromDoc(doc: PMNode): NoteBody {
  const blocks: WireJson[] = [];
  doc.forEach((node) => {
    blocks.push(serializeNode(node));
  });
  if (blocks.length === 0) blocks.push(serializeNode(emptyParagraph(doc.type.schema)));
  return { doc_type: NOTE_DOC_TYPE, version: NOTE_VERSION, content: blocks };
}

function serializeNode(node: PMNode): WireJson {
  if (node.isText) {
    const text: WireJson = { type: "text", text: node.text ?? "" };
    const marks = serializeMarks(node.marks);
    if (marks.length > 0) text.marks = marks;
    return text;
  }

  const wire: WireJson = { type: node.type.name, id: nodeId(node) };
  const attrs = serializeAttrs(node);
  if (Object.keys(attrs).length > 0) wire.attrs = attrs;
  const children = serializeChildren(node);
  if (children) wire.content = children;
  return wire;
}

/**
 * 块 id：已建立的不动，缺的/形状不对的补一个新的。
 *
 * 正常情况下这里不会补 —— 编辑器在事务出口由 `ensureBlockIds` 保证不变量，
 * `docFromBody` 也保证读进来的每个块都有 id。补只是让「手工构造的 doc」也写得出合法 wire。
 */
function nodeId(node: PMNode): string {
  const value = rawAttrs(node).id;
  return isBlockId(value) ? value : blockId();
}

/** 与默认值相同的 attr 不写进 wire：wire 只留差异，且 round-trip 仍然稳定。 */
function serializeAttrs(node: PMNode): Record<string, unknown> {
  const spec = declaredAttrs(node.type.spec);
  const values = rawAttrs(node);
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(spec)) {
    if (name === "id") continue; // 块 id 走 wire 的顶层字段
    const value = values[name];
    if (value === undefined) continue;
    if (sameValue(value, spec[name].default)) continue;
    out[name] = value;
  }
  return out;
}

function serializeMarks(marks: readonly Mark[]): WireJson[] {
  return marks.map((mark) => {
    const spec = declaredAttrs(mark.type.spec);
    const values = rawAttrs(mark);
    const out: WireJson = { type: mark.type.name };
    const attrs: Record<string, unknown> = {};
    for (const name of Object.keys(spec)) {
      const value = values[name];
      if (value === undefined) continue;
      if (sameValue(value, spec[name].default)) continue;
      attrs[name] = value;
    }
    if (Object.keys(attrs).length > 0) out.attrs = attrs;
    return out;
  });
}

/**
 * 子节点。空段落要**补一条空文本节点**：Python 侧「允许子节点却给空 content」是非法的
 * （`model.py` 的 `_children`），而 ProseMirror 里的空段落恰恰就是空 content ——
 * 这一补就是两个模型之间的唯一转换，写在序列化这一处，读回来时再丢掉。
 */
function serializeChildren(node: PMNode): WireJson[] | null {
  if (node.isLeaf) return null;
  const out: WireJson[] = [];
  node.forEach((child) => {
    out.push(serializeNode(child));
  });
  if (out.length > 0) return out;
  return node.type.inlineContent ? [{ type: "text", text: "" }] : null;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

// --- 块 id 的守卫 ------------------------------------------------------------

/**
 * 把缺 id / id 非法 / id 重复的块补成新的 32 位 hex。已有块的 id **原样保留**。
 *
 * 为什么不在「插入时生成」：块来自回车拆段、粘贴、撤销重做、将来的块命令，
 * 路径太多，每条路径各写一遍就一定会漏一条。放在**事务的出口**统一保证不变量，
 * 每个事务只走查一次；走查与 `onChange` 的序列化同阶（都是 O(块数)），
 * 所以它不是新的瓶颈。将来预算吃紧时，按事务的插入区间收窄即可。
 *
 * 重复的处理顺序是文档序：先出现的保留原 id，后出现的换新。回车拆段正是这个形状
 * （拆出来的第二半继承了第一半的 attrs），复制粘贴也是（副本在原文之后）。
 * 副本落在原文**之前**的粘贴会把 id 留给副本 —— 这一条已知，改它要按事务的
 * 插入区间判断，属于粘贴路线（§十五）的事。
 */
export function ensureBlockIds(tr: Transaction): Transaction {
  if (!tr.docChanged) return tr;

  const seen = new Set<string>();
  const fixes: { pos: number; attrs: Record<string, unknown> }[] = [];
  tr.doc.descendants((node, pos) => {
    if (node.isText) return false;
    const attrs = rawAttrs(node);
    const current = attrs.id;
    if (isBlockId(current) && !seen.has(current)) {
      seen.add(current);
      return true;
    }
    const next: Record<string, unknown> = { ...attrs, id: blockId() };
    const assigned = next.id;
    if (typeof assigned === "string") seen.add(assigned);
    fixes.push({ pos, attrs: next });
    return true;
  });

  // 先收集再改：改的是 attr 不是节点尺寸，所以收集到的位置在修改后仍然有效。
  for (const fix of fixes) tr.setNodeMarkup(fix.pos, undefined, fix.attrs);
  return tr;
}
