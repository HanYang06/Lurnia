// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 文档的**可数事实**：块数与字数。属性浮层显示的就是这几个数。
 *
 * 为什么在前端数而不是问内核：`doc.get` 只回正文，没有统计字段；而正文就在手里，
 * 数一遍是 O(块数)，比多一条能力便宜。**这不是权威** —— 权威是正文本身，
 * 这里只是把它读出来给人看，所以不需要跟内核对齐任何口径。
 */

export type NoteFacts = {
  /** 块级节点数（text 不算块）。 */
  blocks: number;
  /** 非空白字符数。中文按字算，这个口径对中文文档才有意义。 */
  characters: number;
};

export function noteFacts(body: unknown): NoteFacts {
  const facts: NoteFacts = { blocks: 0, characters: 0 };
  walk(body, facts);
  return facts;
}

function walk(body: unknown, facts: NoteFacts): void {
  if (typeof body !== "object" || body === null) {
    return;
  }
  const record = body as { content?: unknown };
  walkNodes(record.content, facts);
}

function walkNodes(nodes: unknown, facts: NoteFacts): void {
  if (!Array.isArray(nodes)) {
    return;
  }
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) {
      continue;
    }
    const record = node as { type?: unknown; text?: unknown; content?: unknown };
    if (record.type === "text") {
      if (typeof record.text === "string") {
        facts.characters += record.text.replace(/\s+/g, "").length;
      }
      continue;
    }
    facts.blocks += 1;
    walkNodes(record.content, facts);
  }
}
