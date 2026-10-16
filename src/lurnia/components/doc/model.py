# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""文档校验：把声明式 schema **编译**成一次树走查（路线 108）。

口径见 [editor.md §3.3](../../../../docs/design/editor.md)：
**不用通用 JSON Schema 引擎**。
那是纯 Python 逐节点解释，常数大一个量级；这里在装配时把 schema 编成查表结构
（`Compiled`），运行期只做一次线性走查。

校验的边界（§4.2）：**节点类型与标记的清单是封闭的**，表外的输入一律拒收。
未知的 `attrs` 键不拒 —— 属性是各类型自己的事，拒绝它只会把向前兼容也拒掉。
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

#: 块 id 的形状：`uuid.uuid7().hex`（§4.3），32 位小写 hex。
ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")


class DocumentError(Exception):
    """文档不符合 schema。跨边界时翻成 `Err(INVALID)`，绝不落库。"""


@dataclass(frozen=True, slots=True)
class Compiled:
    """编好的校验计划：运行期只查表，不再解释 schema。"""

    doc_type: str
    version: int
    root: frozenset[str]
    allowed: Mapping[str, frozenset[str]]
    marks: frozenset[str]


def compile_schema(schema: Mapping[str, Any]) -> Compiled:
    """把 schema 资源编译成校验计划。schema 本身坏了就是启动期错误。"""
    try:
        doc_type = schema["doc_type"]
        version = schema["version"]
        root = schema["root"]
        nodes = schema["nodes"]
        marks = schema["marks"]
    except KeyError as exc:
        msg = f"schema 资源缺字段：{exc}"
        raise DocumentError(msg) from exc
    if not isinstance(doc_type, str) or not isinstance(version, int):
        msg = "schema 的 doc_type 必须是字符串、version 必须是整数"
        raise DocumentError(msg)
    allowed: dict[str, frozenset[str]] = {}
    for name, spec in nodes.items():
        if not isinstance(spec, Mapping):
            msg = f"schema 里 {name!r} 的定义必须是对象"
            raise DocumentError(msg)
        allowed[str(name)] = frozenset(str(child) for child in spec.get("content", []))
    return Compiled(
        doc_type=doc_type,
        version=version,
        root=frozenset(str(child) for child in root),
        allowed=allowed,
        marks=frozenset(str(mark) for mark in marks),
    )


def validate(compiled: Compiled, body: Any) -> None:
    """校验一份文档。不通过就抛 `DocumentError`（调用方翻成 `Err(INVALID)`）。"""
    if not isinstance(body, Mapping):
        msg = "文档必须是一个 JSON 对象"
        raise DocumentError(msg)
    if body.get("doc_type") != compiled.doc_type:
        msg = f"文档类型不是 {compiled.doc_type!r}：{body.get('doc_type')!r}"
        raise DocumentError(msg)
    if body.get("version") != compiled.version:
        msg = (
            f"文档格式版本不认识：{body.get('version')!r}"
            f"（这个类型只认 {compiled.version}，老文档要先走迁移链）"
        )
        raise DocumentError(msg)
    content = body.get("content")
    if not isinstance(content, list) or not content:
        msg = "文档的 content 必须是非空列表"
        raise DocumentError(msg)
    _walk(compiled, content, compiled.root, "content")


def _walk(
    compiled: Compiled,
    children: Sequence[Any],
    allowed: frozenset[str],
    path: str,
) -> None:
    for index, node in enumerate(children):
        where = f"{path}[{index}]"
        if not isinstance(node, Mapping):
            msg = f"{where} 必须是对象"
            raise DocumentError(msg)
        kind = node.get("type")
        if not isinstance(kind, str):
            msg = f"{where} 缺少 type"
            raise DocumentError(msg)
        if kind == "text":
            if "text" not in allowed:
                msg = f"{where} 的文本节点不允许出现在这个位置"
                raise DocumentError(msg)
            _text(compiled, node, where)
            continue
        if kind not in compiled.allowed:
            msg = f"{where} 的节点类型 {kind!r} 不在 schema 的节点清单里"
            raise DocumentError(msg)
        if kind not in allowed:
            msg = f"{where} 的节点类型 {kind!r} 不允许出现在这个位置"
            raise DocumentError(msg)
        node_id = node.get("id")
        if not isinstance(node_id, str) or not ID_PATTERN.match(node_id):
            msg = f"{where} 的块 id 不是 32 位 hex（块节点必须带稳定 id，§4.3）"
            raise DocumentError(msg)
        _children(compiled, node, where, compiled.allowed[kind])


def _children(
    compiled: Compiled,
    node: Mapping[str, Any],
    where: str,
    allowed: frozenset[str],
) -> None:
    kids = node.get("content", [])
    if not isinstance(kids, list):
        msg = f"{where} 的 content 必须是列表"
        raise DocumentError(msg)
    if kids:
        _walk(compiled, kids, allowed, f"{where}.content")
    elif allowed:
        msg = f"{where} 的 {node.get('type')!r} 必须有子节点"
        raise DocumentError(msg)


def _text(compiled: Compiled, node: Mapping[str, Any], where: str) -> None:
    if not isinstance(node.get("text"), str):
        msg = f"{where} 是文本节点，text 必须是字符串"
        raise DocumentError(msg)
    marks = node.get("marks", [])
    if not isinstance(marks, list):
        msg = f"{where} 的 marks 必须是列表"
        raise DocumentError(msg)
    for mark in marks:
        if not isinstance(mark, Mapping) or mark.get("type") not in compiled.marks:
            msg = f"{where} 带了不在 schema 里的标记：{mark!r}"
            raise DocumentError(msg)


__all__ = ["Compiled", "DocumentError", "compile_schema", "validate"]
