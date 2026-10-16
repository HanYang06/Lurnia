# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""组件的组合根：把文档类型接到文档服务上。

口径见 [editor.md §3](../../../docs/design/editor.md)。**它在任何组件之外**，
所以它能同时 import 两个组件 —— I1 禁止的是组件**之间**互相 import
（`script/audit.py` 的 `component_roots()` 只认带 `__init__.py` 的组件目录）。
这就是「注册一个类型不需要 note 认识 doc」的办法：接线由装配台做。

`sidecar.serve()` 装配完核心后调用 :func:`install`，和 `assemble()` 一样是启动路径。
"""

from __future__ import annotations

import json
from importlib import resources
from typing import TYPE_CHECKING, Any

from lurnia.components.doc.registry import DocType, Registry
from lurnia.components.doc.store import DocStore
from lurnia.components.note import type as note_type

if TYPE_CHECKING:
    from lurnia.assembly import Core

#: `note` 类型的 schema 资源：随包分发（packaging 冻结只收包内的东西）。
NOTE_PACKAGE = "lurnia.components.note"
NOTE_SCHEMA = ("schema", "note.schema.json")


def load_schema(package: str, parts: tuple[str, ...]) -> dict[str, Any]:
    """从包内读一份 schema 资源。**不走 `__file__` 拼路径**（冻结后会失效）。"""
    text = resources.files(package).joinpath(*parts).read_text(encoding="utf-8")
    loaded: dict[str, Any] = json.loads(text)
    return loaded


def builtin_registry() -> Registry:
    """内置的文档类型。加一种编辑器 = 在这里多注册一个类型。"""
    registry = Registry()
    registry.register(
        DocType(
            name="note",
            schema=load_schema(NOTE_PACKAGE, NOTE_SCHEMA),
            extract_text=note_type.extract_text,
            capabilities=note_type.CAPABILITIES,
        )
    )
    return registry


def install(core: Core) -> DocStore:
    """装组件：建表、编 schema、注册能力。失败就是启动失败，不静默降级。"""
    store = DocStore(core, builtin_registry())
    store.ensure_schema()
    store.prepare()
    store.provide()
    return store


__all__ = ["builtin_registry", "install", "load_schema"]
