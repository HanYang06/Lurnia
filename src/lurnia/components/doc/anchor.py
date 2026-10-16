# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""三段式锚点与重定位（路线 112）。

口径见 [editor.md §五](../../../../docs/design/editor.md)。

锚点是**批注与将来的文字级权限共用的坐标**，所以它必须稳定、可序列化、可重定位：

```
anchor = { block_id, offset, length, quote, prefix, suffix }
```

* `offset` / `length` 是**块内纯文本**的偏移（不含任何标记语法）——唯一跨表示稳定的坐标；
* `quote` 是锚定原文的**开头**（上限 `QUOTE_LIMIT` 字符）。长选区只留开头，
  匹配时只比这一段，长度仍按 `length` 走；
* `prefix` / `suffix` 用于多命中时消歧。

重定位顺序固定为「快路径 → 慢路径 → orphaned」。**失败不删批注**，只是状态变
`orphaned`（§五、§十一）——静默丢弃是最不能接受的结果。
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, TypeGuard

from lurnia.components.doc.model import DocumentError

#: `quote` 的截断上限。§二十二 里这条是暂定值，改它要连着测试一起改。
QUOTE_LIMIT = 128

ACTIVE: Literal["active"] = "active"
ORPHANED: Literal["orphaned"] = "orphaned"

ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")


@dataclass(frozen=True, slots=True)
class Anchor:
    """一段被锚定的文本。构造即校验（`parse` 是唯一入口）。"""

    block_id: str
    offset: int
    length: int
    quote: str
    prefix: str = ""
    suffix: str = ""

    @classmethod
    def parse(cls, raw: Any) -> Anchor:
        """从线上形状解析。形状不对就抛 `DocumentError`（翻成 `Err(INVALID)`）。"""
        if not isinstance(raw, Mapping):
            msg = "锚点必须是一个对象"
            raise DocumentError(msg)
        block_id = raw.get("block_id")
        if not isinstance(block_id, str) or not ID_PATTERN.match(block_id):
            msg = "锚点的 block_id 必须是 32 位 hex（块节点的稳定 id，§4.3）"
            raise DocumentError(msg)
        offset = raw.get("offset")
        length = raw.get("length")
        if not _is_count(offset) or not _is_count(length):
            msg = "锚点的 offset / length 必须是非负整数"
            raise DocumentError(msg)
        quote = raw.get("quote")
        if not isinstance(quote, str) or not quote:
            msg = "锚点的 quote 必须是非空字符串"
            raise DocumentError(msg)
        if len(quote) > QUOTE_LIMIT:
            msg = f"锚点的 quote 超过 {QUOTE_LIMIT} 字符上限；长选区只留开头即可"
            raise DocumentError(msg)
        if len(quote) != min(length, QUOTE_LIMIT):
            msg = (
                f"锚点的 quote 长度与 length 不匹配："
                f"quote {len(quote)}，length {length}"
                f"（应为 {min(length, QUOTE_LIMIT)}）"
            )
            raise DocumentError(msg)
        prefix = raw.get("prefix", "")
        suffix = raw.get("suffix", "")
        if not isinstance(prefix, str) or not isinstance(suffix, str):
            msg = "锚点的 prefix / suffix 必须是字符串"
            raise DocumentError(msg)
        return cls(
            block_id=block_id,
            offset=offset,
            length=length,
            quote=quote,
            prefix=prefix,
            suffix=suffix,
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "block_id": self.block_id,
            "offset": self.offset,
            "length": self.length,
            "quote": self.quote,
            "prefix": self.prefix,
            "suffix": self.suffix,
        }


@dataclass(frozen=True, slots=True)
class Placement:
    """重定位结果：锚点当前的落点，以及它是否还有效。"""

    block_id: str
    offset: int
    length: int
    status: Literal["active", "orphaned"]


def relocate(anchor: Anchor, texts: Mapping[str, str]) -> Placement:
    """把锚点对到**当前的块文本**上。

    ``texts`` 是「块 id → 该块的纯文本」。命中即 `active`；找不到就 `orphaned`，
    并且**保留原 offset/length**，等正文改回来它还能自己恢复。
    """
    text = texts.get(anchor.block_id)
    if text is None:
        return Placement(anchor.block_id, anchor.offset, anchor.length, ORPHANED)
    if _quoted(text, anchor.offset, anchor.length) == anchor.quote:
        return Placement(anchor.block_id, anchor.offset, anchor.length, ACTIVE)
    hits = _hits(text, anchor.quote)
    if not hits:
        return Placement(anchor.block_id, anchor.offset, anchor.length, ORPHANED)
    chosen = _disambiguate(text, hits, anchor)
    if chosen is None:
        return Placement(anchor.block_id, anchor.offset, anchor.length, ORPHANED)
    length = min(anchor.length, len(text) - chosen)
    return Placement(anchor.block_id, chosen, length, ACTIVE)


def _quoted(text: str, offset: int, length: int) -> str:
    """块文本里 `[offset, offset+length)` 的开头 `QUOTE_LIMIT` 个字。"""
    return text[offset : offset + length][:QUOTE_LIMIT]


def _hits(text: str, quote: str) -> list[int]:
    hits: list[int] = []
    start = text.find(quote)
    while start != -1:
        hits.append(start)
        start = text.find(quote, start + 1)
    return hits


def _disambiguate(text: str, hits: Sequence[int], anchor: Anchor) -> int | None:
    """多命中消歧，顺序固定所以可测：

    1. 前后文能对上的候选；恰好一个 → 用它；
    2. 否则取「离原偏移最近」的候选；
    3. **两个候选与原偏移等距** → 判不出来，返回 `None`（宁可 orphaned 也不猜）。
    """
    contextual = [hit for hit in hits if _context_matches(text, hit, anchor)]
    pool = contextual or list(hits)
    if len(pool) == 1:
        return pool[0]
    distances = [abs(hit - anchor.offset) for hit in pool]
    if distances.count(min(distances)) > 1:
        return None
    return min(pool, key=lambda hit: abs(hit - anchor.offset))


def _context_matches(text: str, hit: int, anchor: Anchor) -> bool:
    before_ok = not anchor.prefix or text[
        max(0, hit - len(anchor.prefix)) : hit
    ].endswith(anchor.prefix)
    after = hit + len(anchor.quote)
    after_ok = (
        not anchor.suffix or text[after : after + len(anchor.suffix)] == anchor.suffix
    )
    return before_ok and after_ok


def _is_count(value: Any) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def block_texts(body: Mapping[str, Any]) -> dict[str, str]:
    """把文档抽成「块 id → 该块纯文本」。批注重定位与将来文字级权限都用它。

    只收**块级**节点：文本节点自己不是锚点的落点（§4.3：行内不带 id）。
    """
    texts: dict[str, str] = {}
    _walk(body.get("content"), texts)
    return texts


def _walk(node: Any, out: dict[str, str]) -> None:
    if isinstance(node, list):
        for item in node:
            _walk(item, out)
        return
    if not isinstance(node, Mapping):
        return
    if node.get("type") == "text":
        return
    block_id = node.get("id")
    if isinstance(block_id, str):
        out[block_id] = plain_text(node)
    _walk(node.get("content"), out)


def plain_text(node: Mapping[str, Any]) -> str:
    """一个块自己的纯文本（不递归进嵌套块）—— 锚点的 offset 就活在这里。"""
    chunks: list[str] = []

    def collect(item: Any) -> None:
        if isinstance(item, list):
            for child in item:
                collect(child)
            return
        if not isinstance(item, Mapping) or item.get("type") != "text":
            return
        text = item.get("text")
        if isinstance(text, str):
            chunks.append(text)

    collect(node.get("content"))
    return "".join(chunks)


__all__ = [
    "ACTIVE",
    "ORPHANED",
    "QUOTE_LIMIT",
    "Anchor",
    "Placement",
    "block_texts",
    "plain_text",
    "relocate",
]
