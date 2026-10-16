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


__all__ = ["CAPABILITIES", "extract_text"]
