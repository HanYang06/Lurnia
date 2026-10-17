# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""`note` 文档类型：文本编辑器的那一半（路线 108 / 109）。

**它不认识文档服务**：这里只有 schema 资源、一个抽取器和一份能力声明，
接线由 [lurnia.components](..) 这个组合根做。这样两个组件之间没有 import
（不变量 I1），而"加一种编辑器"仍然只是加一个注册项。
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

#: 这个类型声明自己支持哪些能力（§3.2 第 4 条）。宿主据此决定工具栏显示什么，
#: **不得对 doc_type 做 switch**。
CAPABILITIES = frozenset({"table", "annotation", "highlight", "ref"})


def extract_text(body: Mapping[str, Any]) -> str:
    """把文档抽成纯文本：标题派生用它，将来的 FTS 也用它（§3.2 第 3 条）。"""
    chunks: list[str] = []
    _collect(body.get("content"), chunks)
    return " ".join(chunks).strip()


def extract_refs(body: Mapping[str, Any]) -> list[tuple[str, str | None]]:
    """文档里的引用集：`(目标文档 id, 来源块 id)`，给反链索引（§十、§3.2 第 3 条）。"""
    out: list[tuple[str, str | None]] = []
    _refs(body.get("content"), out)
    return out


def _refs(node: Any, out: list[tuple[str, str | None]]) -> None:
    if isinstance(node, list):
        for item in node:
            _refs(item, out)
        return
    if not isinstance(node, Mapping):
        return
    if node.get("type") == "doc_ref":
        attrs = node.get("attrs")
        target = attrs.get("doc_id") if isinstance(attrs, Mapping) else None
        if isinstance(target, str) and target:
            block_id = node.get("id")
            out.append((target, block_id if isinstance(block_id, str) else None))
        return
    _refs(node.get("content"), out)


def _collect(node: Any, out: list[str]) -> None:
    if isinstance(node, list):
        for item in node:
            _collect(item, out)
        return
    if not isinstance(node, Mapping):
        return
    if node.get("type") == "text":
        text = node.get("text")
        if isinstance(text, str):
            out.append(text)
        return
    _collect(node.get("content"), out)


__all__ = ["CAPABILITIES", "extract_refs", "extract_text"]
