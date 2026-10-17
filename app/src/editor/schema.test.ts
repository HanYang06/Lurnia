// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 编辑内核的门禁（路线 109）。这里检查的不是「函数没抛」，而是**两套模型是否真的对齐**：
 *
 * 1. **节点清单只有一个来源**（editor.md A3）。所以这里的比对是**逐格双向**的：
 *    JSON 里多了、少了、子节点对不上，任何一种都红。规格表漏一个节点不会等到运行时
 *    才发现 —— `buildNoteSchema()` 自己会抛，测试也会在这一层说出来。
 * 2. **wire 是 Python 校验器（`doc/model.py`）的硬事实**：块 id 是 32 位 hex、文本节点没有 id、
 *    文档 `content` 非空、**空段落要补一条空文本节点**（`_children` 对「允许子节点却给空列表」
 *    报「必须有子节点」）。这几条如果只写在注释里，改一次序列化就会静默失效。
 * 3. **块 id 稳定**：同一份文档连续序列化两次必须逐字节相同；新块才拿新 id。
 *    id 是批注与引用的锚点（§4.3），在这里换了 id 等于把标注丢在旧文档上。
 */

import type { Node as PMNode, Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { describe, expect, it } from "vitest";

import noteSchemaJson from "../../../src/lurnia/components/note/schema/note.schema.json";
import {
  NOTE_DOC_TYPE,
  NOTE_VERSION,
  bodyFromDoc,
  buildNoteSchema,
  docFromBody,
  ensureBlockIds,
} from "./schema";
import type { NoteBody } from "./schema";

const schema = buildNoteSchema();

const JSON_NODES: Record<string, { content?: string[]; attrs?: string[] }> =
  noteSchemaJson.nodes;
const JSON_ROOT: string[] = noteSchemaJson.root;
const JSON_MARKS: string[] = noteSchemaJson.marks;

/** PM 的节点表里必然多出来的两个：文档根与行内文本。它们不在 `nodes` 清单里。 */
const BUILT_ONLY = ["doc", "text"];

/** 32 位 hex 的样例 id：`n` 补到 32 位，形状与 `uuid.uuid7().hex` 一致。 */
function hex32(n: number): string {
  return n.toString(16).padStart(32, "0");
}

/**
 * 「这个节点允许哪些子节点」——**从装配好的 schema 反推**，不是照着 JSON 抄一遍：
 * `ContentMatch.matchType` 问的就是「这个类型能不能出现在这里」，行内文本也一样。
 */
function allowedChildren(target: Schema, name: string): Set<string> {
  const match = target.nodes[name].contentMatch;
  const out = new Set<string>();
  for (const type of Object.values(target.nodes)) {
    if (match.matchType(type)) out.add(type.name);
  }
  return out;
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${where} 不是对象`);
  }
  return value as Record<string, unknown>;
}

function nodeAt(content: unknown[], index: number): Record<string, unknown> {
  return asRecord(content[index], `content[${index}]`);
}

function idsOf(content: unknown[]): string[] {
  return content.map((entry, index) => {
    const id = asRecord(entry, `content[${index}]`).id;
    if (typeof id !== "string") throw new Error(`content[${index}] 的 id 不是字符串`);
    return id;
  });
}

function forEachNode(
  content: unknown[],
  visit: (node: Record<string, unknown>) => void,
): void {
  for (const entry of content) {
    const record = asRecord(entry, "节点");
    visit(record);
    const children = record.content;
    if (Array.isArray(children)) forEachNode(children as unknown[], visit);
  }
}

describe("schema 与 note.schema.json 逐格绑住（A3：清单只有一个来源）", () => {
  it("节点名集合逐格相等：JSON 多了或少了都要红", () => {
    expect(new Set(Object.keys(schema.nodes))).toEqual(
      new Set([...Object.keys(JSON_NODES), ...BUILT_ONLY]),
    );
  });

  it("root 集合逐格相等", () => {
    expect(allowedChildren(schema, "doc")).toEqual(new Set(JSON_ROOT));
  });

  it("marks 集合逐格相等", () => {
    expect(new Set(Object.keys(schema.marks))).toEqual(new Set(JSON_MARKS));
  });

  it("每个节点允许的子节点逐格相等", () => {
    for (const [name, spec] of Object.entries(JSON_NODES)) {
      expect(allowedChildren(schema, name), `节点 ${name} 的允许子节点`).toEqual(
        new Set(spec.content ?? []),
      );
    }
  });

  it("每个节点声明的 attrs 逐格相等（id 是通用契约，单独看）", () => {
    for (const [name, spec] of Object.entries(JSON_NODES)) {
      const declared = Object.keys(schema.nodes[name].spec.attrs ?? {}).filter(
        (attr) => attr !== "id",
      );
      expect(new Set(declared), `节点 ${name} 的 attrs`).toEqual(
        new Set(spec.attrs ?? []),
      );
    }
  });

  it("每个块节点都有 id，行内文本节点没有", () => {
    for (const name of Object.keys(JSON_NODES)) {
      expect(
        Object.keys(schema.nodes[name].spec.attrs ?? {}),
        `节点 ${name} 必须带 id（§4.3）`,
      ).toContain("id");
    }
    expect(schema.nodes.text.isText).toBe(true);
    expect(schema.nodes.text.spec.attrs ?? {}).toEqual({});
  });

  it("根只装块，不直接装行内节点", () => {
    expect(schema.nodes.doc.contentMatch.matchType(schema.nodes.text)).toBeNull();
  });

  it("文档类型与版本取自 JSON，不是另抄一份", () => {
    expect(NOTE_DOC_TYPE).toBe(noteSchemaJson.doc_type);
    expect(NOTE_VERSION).toBe(noteSchemaJson.version);
  });
});

/** 一份用满清单的正文：每种块各一个（列表与表格各两层），六种 mark 各一个。 */
function sampleBody(): NoteBody {
  const text = (value: string, marks?: unknown[]) =>
    marks ? { type: "text", text: value, marks } : { type: "text", text: value };
  const paragraph = (id: number, value: string, marks?: unknown[]) => ({
    type: "paragraph",
    id: hex32(id),
    content: [text(value, marks)],
  });

  return {
    doc_type: NOTE_DOC_TYPE,
    version: NOTE_VERSION,
    content: [
      {
        type: "heading",
        id: hex32(1),
        attrs: { level: 2 },
        content: [text("标题")],
      },
      {
        type: "paragraph",
        id: hex32(2),
        content: [
          text("粗", [{ type: "strong" }]),
          text("斜", [{ type: "em" }]),
          text("删", [{ type: "strike" }]),
          text("码", [{ type: "code" }]),
          text("亮", [{ type: "highlight" }]),
          text("链", [
            { type: "link", attrs: { href: "https://example.invalid/note" } },
          ]),
        ],
      },
      {
        type: "bullet_list",
        id: hex32(3),
        content: [
          {
            type: "list_item",
            id: hex32(4),
            content: [
              paragraph(5, "项"),
              {
                type: "bullet_list",
                id: hex32(6),
                content: [
                  {
                    type: "list_item",
                    id: hex32(7),
                    content: [paragraph(8, "子项")],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "ordered_list",
        id: hex32(9),
        content: [
          { type: "list_item", id: hex32(10), content: [paragraph(11, "第一条")] },
        ],
      },
      {
        type: "quote",
        id: hex32(12),
        content: [paragraph(13, "引文")],
      },
      {
        type: "code_block",
        id: hex32(14),
        attrs: { language: "python" },
        content: [text("print(1)")],
      },
      { type: "divider", id: hex32(15) },
      {
        type: "table",
        id: hex32(16),
        attrs: { widths: [0.4, 0.6] },
        content: [
          {
            type: "table_row",
            id: hex32(17),
            content: [
              {
                type: "table_cell",
                id: hex32(18),
                attrs: { header: true },
                content: [text("表头")],
              },
              {
                type: "table_cell",
                id: hex32(19),
                content: [text("格")],
              },
            ],
          },
        ],
      },
      {
        type: "image",
        id: hex32(20),
        attrs: { attachment_id: hex32(30), alt: "一张图" },
      },
      {
        type: "attachment",
        id: hex32(21),
        attrs: { attachment_id: hex32(31), name: "附件.txt" },
      },
      {
        type: "doc_ref",
        id: hex32(22),
        attrs: { doc_id: hex32(32), block_id: hex32(33), display: "那篇笔记" },
      },
      // 空段落：wire 上是一条空文本节点。
      {
        type: "paragraph",
        id: hex32(23),
        content: [{ type: "text", text: "" }],
      },
    ],
  };
}

function wire(partial: unknown[]): NoteBody {
  return { doc_type: NOTE_DOC_TYPE, version: NOTE_VERSION, content: partial };
}

function oneParagraph(id: string, value: string): NoteBody {
  return wire([{ type: "paragraph", id, content: [{ type: "text", text: value }] }]);
}

describe("往返：wire → PM → wire", () => {
  it("文本、marks、块 id 与 attrs 全部原样回来（键序也算，逐字节相同）", () => {
    const body = sampleBody();
    const back = bodyFromDoc(docFromBody(schema, body));
    expect(JSON.stringify(back)).toBe(JSON.stringify(body));
  });

  it("空段落写成一条空文本节点（PM 侧不存在空文本节点，这一补只在这里发生）", () => {
    const body = bodyFromDoc(docFromBody(schema, oneParagraph(hex32(1), "")));
    expect(body.content).toEqual([
      {
        type: "paragraph",
        id: hex32(1),
        content: [{ type: "text", text: "" }],
      },
    ]);
  });

  it("PM 里本来就空的段落同样补一条空文本节点", () => {
    const doc = schema.node("doc", null, schema.node("paragraph", { id: hex32(2) }));
    expect(bodyFromDoc(doc).content).toEqual([
      {
        type: "paragraph",
        id: hex32(2),
        content: [{ type: "text", text: "" }],
      },
    ]);
  });

  it("产物满足硬事实：content 非空、块 id 是 32 位 hex、文本节点没有 id", () => {
    const body = bodyFromDoc(docFromBody(schema, sampleBody()));
    expect(body.content.length).toBeGreaterThan(0);
    forEachNode(body.content, (node) => {
      if (node.type === "text") {
        expect(node.id).toBeUndefined();
        return;
      }
      expect(node.id).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  it("带横线的 UUID 不是合法块 id：读进来时换成 32 位 hex", () => {
    const uuid = "018f2b3c-4d5e-7f80-9abc-def012345678";
    const body = bodyFromDoc(docFromBody(schema, oneParagraph(uuid, "字")));
    const id = nodeAt(body.content, 0).id;
    expect(id).not.toBe(uuid);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("表外的节点与 mark 在边界被丢掉，能看懂的部分留下来", () => {
    const dropped = bodyFromDoc(
      docFromBody(
        schema,
        wire([
          { type: "paragraph", id: hex32(1), content: [{ type: "text", text: "" }] },
          { type: "canvas", id: hex32(2) },
          { type: "paragraph", id: hex32(3), content: [{ type: "text", text: "无" }] },
          {
            type: "paragraph",
            id: hex32(4),
            content: [{ type: "text", text: "留", marks: [{ type: "blink" }] }],
          },
        ]),
      ),
    );
    expect(dropped.content).toEqual([
      {
        type: "paragraph",
        id: hex32(1),
        content: [{ type: "text", text: "" }],
      },
      {
        type: "paragraph",
        id: hex32(3),
        content: [{ type: "text", text: "无" }],
      },
      {
        type: "paragraph",
        id: hex32(4),
        content: [{ type: "text", text: "留" }],
      },
    ]);
  });

  it("块没有 id 时补一个，块本身留下（缺 id 是可修的，不是不可用的）", () => {
    const out = bodyFromDoc(docFromBody(schema, wire([{ type: "divider" }])));
    expect(out.content).toHaveLength(1);
    expect(nodeAt(out.content, 0).type).toBe("divider");
    expect(nodeAt(out.content, 0).id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("body 不可用时退化成「一个空段落」，不把异常抛给 UI", () => {
    const broken: unknown[] = [
      null,
      1,
      "正文",
      {},
      { doc_type: NOTE_DOC_TYPE, version: NOTE_VERSION, content: [] },
      { doc_type: "project", version: NOTE_VERSION, content: [hex32(1)] },
      { doc_type: NOTE_DOC_TYPE, version: 99, content: [hex32(1)] },
      wire([1, "x", null]),
      wire([{ type: "canvas", id: hex32(1) }]),
    ];
    for (const body of broken) {
      const out = bodyFromDoc(docFromBody(schema, body));
      expect(out.content).toHaveLength(1);
      expect(nodeAt(out.content, 0)).toMatchObject({
        type: "paragraph",
        content: [{ type: "text", text: "" }],
      });
      expect(nodeAt(out.content, 0).id).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

describe("块 id 的稳定性（§4.3：已有块原样保留，新块才有新 id）", () => {
  it("同一份文档连续序列化两次，逐字节相同", () => {
    const doc = docFromBody(schema, sampleBody());
    expect(JSON.stringify(bodyFromDoc(doc))).toBe(JSON.stringify(bodyFromDoc(doc)));
  });

  it("回车拆段：原来那段保留 id，新的一段拿到新的 32 位 hex", () => {
    const doc = docFromBody(schema, oneParagraph(hex32(1), "abcd"));
    const state = EditorState.create({ schema, doc });
    const next = state.apply(ensureBlockIds(state.tr.split(3)));

    expect(next.doc.childCount).toBe(2);
    const ids = idsOf(bodyFromDoc(next.doc).content);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(hex32(1));
    expect(ids[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(ids[1]).not.toBe(hex32(1));
  });

  it("插入一个没有 id 的块：出口守卫当场补一个", () => {
    const doc = docFromBody(schema, oneParagraph(hex32(1), "abcd"));
    const state = EditorState.create({ schema, doc });
    const inserted = schema.node("paragraph");
    expect(inserted.attrs.id).toBeNull();

    const next = state.apply(ensureBlockIds(state.tr.insert(6, inserted)));
    expect(next.doc.childCount).toBe(2);
    const ids = idsOf(bodyFromDoc(next.doc).content);
    expect(ids[0]).toBe(hex32(1));
    expect(ids[1]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("没有改动的事务不碰 id", () => {
    const doc = docFromBody(schema, oneParagraph(hex32(1), "abcd"));
    const state = EditorState.create({ schema, doc });
    const moved = state.tr.setSelection(EditorState.create({ schema, doc }).selection);
    const next = state.apply(ensureBlockIds(moved));
    expect(bodyFromDoc(next.doc)).toEqual(oneParagraph(hex32(1), "abcd"));
  });
});

describe("schema 装配的自审", () => {
  it("装配两次得到等价的 schema（不可变，可以共用也可以各建一份）", () => {
    const other = buildNoteSchema();
    expect(Object.keys(other.nodes)).toEqual(Object.keys(schema.nodes));
    expect(Object.keys(other.marks)).toEqual(Object.keys(schema.marks));
    expect(allowedChildren(other, "quote")).toEqual(allowedChildren(schema, "quote"));
  });

  it("每个节点都能从一个合法的 wire 片段建出来（渲染规格齐全）", () => {
    const doc: PMNode = docFromBody(schema, sampleBody());
    const seen = new Set<string>();
    doc.descendants((node) => {
      seen.add(node.type.name);
      return true;
    });
    for (const name of Object.keys(JSON_NODES)) {
      expect(seen, `样例正文盖到了 ${name}`).toContain(name);
    }
    expect(seen).toContain("text");
  });
});
