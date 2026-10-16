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

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from lurnia.components.doc.model import DocumentError

#: 一步文档格式迁移：吃老正文，吐**下一个版本**的正文（`version` 必须 +1）。
Migration = Callable[[Mapping[str, Any]], Mapping[str, Any]]


class RegistryError(Exception):
    """注册表错误：重名注册、迁移链断链、或不认识的类型名。都是启动期错误。"""


@dataclass(frozen=True, slots=True)
class DocType:
    """一个文档类型：数据 + 三个纯函数（§3.2 的扩展点契约）。

    * `extract_text`：文档 → 纯文本（标题派生，将来的 FTS）；
    * `extract_refs`：文档 → 引用集 `(目标文档 id, 来源块 id)`（反链）；
    * `migrations`：文档格式迁移链，`{起始版本: 迁移函数}`。
    """

    name: str
    schema: Mapping[str, Any]
    extract_text: Callable[[Mapping[str, Any]], str]
    extract_refs: Callable[[Mapping[str, Any]], Iterable[tuple[str, str | None]]]
    capabilities: frozenset[str] = field(default_factory=frozenset[str])
    migrations: Mapping[int, Migration] = field(default_factory=dict)

    @property
    def version(self) -> int:
        return current_version(self)


class Registry:
    """进程内注册表。重复注册是启动期错误（同 ``Bus.provide`` 的口径）。"""

    def __init__(self) -> None:
        self._types: dict[str, DocType] = {}

    def register(self, doc_type: DocType) -> None:
        if doc_type.name in self._types:
            msg = f"文档类型 {doc_type.name!r} 已注册，重复注册"
            raise RegistryError(msg)
        if doc_type.schema.get("doc_type") != doc_type.name:
            msg = (
                f"注册名 {doc_type.name!r} 与 schema 里的 doc_type "
                f"{doc_type.schema.get('doc_type')!r} 不一致"
            )
            raise RegistryError(msg)
        check_chain(doc_type)
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


def current_version(doc_type: DocType) -> int:
    """这个类型的**当前**文档格式版本（不变量 I4：正文自带 `version`）。"""
    version = doc_type.schema.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        msg = (
            f"文档类型 {doc_type.name!r} 的 schema.version 必须是 ≥1 的整数："
            f"{version!r}"
        )
        raise RegistryError(msg)
    return version


def check_chain(doc_type: DocType) -> None:
    """迁移链必须**连续**且刚好走到当前版本（I4 的 conformance 靠它成立）。"""
    current = current_version(doc_type)
    steps = sorted(doc_type.migrations)
    if not steps:
        return  # 只有当前一个版本：没有链要校验
    expected = list(range(steps[0], current))
    if steps != expected:
        msg = (
            f"文档类型 {doc_type.name!r} 的迁移链不连续：有 {steps}，"
            f"应当是 {expected}（一步步走到当前版本 {current}）"
        )
        raise RegistryError(msg)


def migrate(
    doc_type: DocType, body: Mapping[str, Any]
) -> tuple[Mapping[str, Any], int]:
    """把老正文迁到当前版本，返回 `(正文, 迁移前版本)`。

    * 已经是当前版本 → 原样返回，`from_version == current`；
    * 版本比当前还新 → `DocumentError`（跨边界翻成 `Err(INVALID)`）；
    * 链上有洞 → `RegistryError`（那是装配的错，不是数据的错）。
    """
    current = current_version(doc_type)
    version = body.get("version")
    if version == current:
        return body, current
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        msg = f"文档的 version 必须是 ≥1 的整数：{version!r}"
        raise DocumentError(msg)
    if version > current:
        msg = f"文档版本 {version} 比这个类型认得的 {current} 还新，拒绝打开"
        raise DocumentError(msg)
    migrated = body
    for step in range(version, current):
        function = doc_type.migrations.get(step)
        if function is None:
            msg = f"文档类型 {doc_type.name!r} 缺少 {step} → {step + 1} 的迁移"
            raise RegistryError(msg)
        migrated = function(migrated)
        if migrated.get("version") != step + 1:
            msg = (
                f"文档类型 {doc_type.name!r} 的 {step} → {step + 1} 迁移没有把"
                f" version 改成 {step + 1}：{migrated.get('version')!r}"
            )
            raise RegistryError(msg)
    return migrated, version


__all__ = [
    "DocType",
    "Migration",
    "Registry",
    "RegistryError",
    "check_chain",
    "current_version",
    "migrate",
]
