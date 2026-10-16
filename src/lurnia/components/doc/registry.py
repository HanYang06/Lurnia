# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""文档类型注册表（路线 108）。

口径见 [editor.md §3.2](../../../../docs/design/editor.md)：一个文档类型只交
「节点 schema + 抽取器 + 能力声明」，**不交落盘实现** —— 存储只有一套（§十七）。
所以本文件里没有任何数据库代码，它是纯注册表。

**刻意不是全局单例**：由组合根（`lurnia.components`）构造并交给文档服务。
进程级单例是 `conf.py` 已经吃过一次的亏，不重复。
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any


class RegistryError(Exception):
    """注册表错误：重名注册、或不认识的类型名。都是启动期错误。"""


@dataclass(frozen=True, slots=True)
class DocType:
    """一个文档类型：数据 + 两个纯函数，仅此而已。"""

    name: str
    schema: Mapping[str, Any]
    extract_text: Callable[[Mapping[str, Any]], str]
    capabilities: frozenset[str] = field(default_factory=frozenset[str])


class Registry:
    """进程内注册表。重复注册是启动期错误（同 ``Bus.provide`` 的口径）。"""

    def __init__(self) -> None:
        self._types: dict[str, DocType] = {}

    def register(self, doc_type: DocType) -> None:
        if doc_type.name in self._types:
            msg = f"文档类型 {doc_type.name!r} 已注册，重复注册"
            raise RegistryError(msg)
        self._types[doc_type.name] = doc_type

    def get(self, name: str) -> DocType:
        try:
            return self._types[name]
        except KeyError:
            msg = f"没有注册过的文档类型：{name!r}"
            raise RegistryError(msg) from None

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._types))

    def capabilities(self, name: str) -> frozenset[str]:
        return self.get(name).capabilities


__all__ = ["DocType", "Registry", "RegistryError"]
