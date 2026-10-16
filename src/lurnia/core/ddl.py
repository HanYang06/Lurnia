# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""DDL 资源：把 SQL 从 Python 里搬出来，放进包内的 .sql 文件。

口径见 [storage.md §五](../../../docs/design/storage.md)。

一个 schema 分两半，各司其职：

| 目录 | 是什么 | 谁需要它 |
| --- | --- | --- |
| ``tables/`` | **当前形状的快照**，一个表一个文件 | 全新安装；写代码时查表结构 |
| ``migrations/`` | **历史**，``NNNN`` = 目标版本，只增不改 | 早于该版本的旧库 |

**为什么必须是包内。** APP 是打包分发的（宿主 + PyInstaller sidecar），而 PyInstaller
只收包内的东西：仓库根的 `config/` 与任何仓根 `.sql` **不在产物里**，放仓根等于
"开发时能跑、装完就炸"。这不是 wheel 论证 —— `uv build` 产出的是发 PyPI 用的分发物，
本项目不发 PyPI，口径见 [storage.md §五](../../../docs/design/storage.md) 的更正。

**包内哪一处**（[storage.md §五](../../../docs/design/storage.md)）：内核 schema 在
`core/sql/kernel/`（`event_log` / `attachment` 本就是内核层的表）；
**业务 schema 归组件包**，放 `components/<组件名>/sql/<schema>/`。写死的 `PACKAGE`
根在出现第一个业务 schema 时要换成「schema → 包」的解析 —— 设计已定、代码待补。

**为什么自己切分语句。** `sqlite3.complete_statement` 是标准库自带的，
它认得字符串字面量里的分号和 `BEGIN ... END` 触发器体，所以不需要引第三方
SQL 解析器，也不需要把每个文件限成一条语句。
"""

from __future__ import annotations

import sqlite3
from importlib import resources
from pathlib import PurePosixPath
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterator

PACKAGE = "lurnia.core"
SQL_ROOT = "sql"
TABLES = "tables"
MIGRATIONS = "migrations"

# Overridable so tests can point at a throwaway directory. Writing fixtures into
# the real package leaves empty directories behind and pollutes the shipped
# tree — which the audit's schema-drift check then reports as a real problem.
_override: object | None = None


def use_sql_root(root: object | None) -> None:
    """Point DDL loading at ``root`` (a ``Traversable``); ``None`` restores it."""
    global _override  # noqa: PLW0603 - single module-level redirection point
    _override = root


def sql_root(schema: str | None = None) -> object:
    """DDL 的家：**schema 注册在哪个包就是哪个包**。

    测试可以用 ``use_sql_root`` 整体覆盖。
    """
    if _override is not None:
        return _override
    return resources.files(schema_package(schema) if schema else PACKAGE)


class DdlError(Exception):
    """DDL 资源的加载或解析失败。"""


#: schema -> 包名。内核 schema 缺省在 `lurnia.core`；**业务 schema 由组件自己注册**
#: （storage.md §五）：`register_schema("doc", "lurnia.components.doc")`。
_registry: dict[str, str] = {}


def register_schema(schema: str, package: str) -> None:
    """声明一个 schema 的 DDL 住在哪个包里。

    同一个 schema 名不能在两个包里各有一份 —— 表名在库里是全局的，
    `schema_meta` 也按名字记账，重名会在升级时互相撞号。
    """
    existing = _registry.get(schema)
    if existing is not None and existing != package:
        msg = f"schema {schema!r} 已注册在 {existing}，不能改注册到 {package}"
        raise DdlError(msg)
    _registry[schema] = package


def schema_package(schema: str) -> str:
    """这个 schema 的 DDL 在哪个包里。没注册过就按内核包找。"""
    return _registry.get(schema, PACKAGE)


def registered_schemas() -> dict[str, str]:
    return dict(_registry)


def _files(schema: str, section: str) -> Iterator[tuple[str, object]]:
    package = schema_package(schema)
    root = sql_root(schema).joinpath(SQL_ROOT, schema, section)  # type: ignore[attr-defined]
    if not root.is_dir():
        msg = f"找不到 DDL 目录：{package}/{SQL_ROOT}/{schema}/{section}"
        raise DdlError(msg)
    for entry in sorted(root.iterdir(), key=lambda p: p.name):
        if entry.name.endswith(".sql"):
            yield entry.name, entry


def _versioned_stem(name: str, schema: str, section: str) -> tuple[int, str]:
    """Parse ``NNNN_描述.sql`` into ``(目标版本, 描述)``.

    ``partition`` splits on the first underscore, so a missing description
    yields an empty tail; both halves are rejected here because both are
    convention violations, and one message is clearer than two.
    """
    stem = PurePosixPath(name).stem
    head, _sep, tail = stem.partition("_")
    if not head.isdigit() or not tail:
        msg = f"DDL 文件名必须形如 NNNN_描述.sql：{schema}/{section}/{name}"
        raise DdlError(msg)
    return int(head), tail


def migration_files(schema: str) -> list[tuple[int, str]]:
    """列出一个 schema 的 ``(目标版本, 资源名)``，按版本升序。

    ``NNNN`` 是该文件对应的**迁移目标版本**。缺号/跳号由 :meth:`migrate`
    在运行时拦下。
    """
    found: list[tuple[int, str]] = []
    seen: dict[int, str] = {}
    for name, _entry in _files(schema, MIGRATIONS):
        version, _ = _versioned_stem(name, schema, MIGRATIONS)
        if version in seen:
            msg = f"{schema} 有重复的目标版本 {version:04d}：{seen[version]} 与 {name}"
            raise DdlError(msg)
        seen[version] = name
        found.append((version, name))
    if not found:
        msg = f"{schema} 没有任何迁移文件"
        raise DdlError(msg)
    return sorted(found)


def table_files(schema: str) -> list[str]:
    """列出一个 schema 的快照文件（一个表一个文件），按名字升序。"""
    names = [name for name, _entry in _files(schema, TABLES)]
    if not names:
        msg = f"{schema} 没有任何表快照"
        raise DdlError(msg)
    return names


def _is_effectively_empty(text: str) -> bool:
    """True when the leftover is only whitespace and ``--`` comments."""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("--"):
            return False
    return True


def _strip_leading_comments(text: str) -> str:
    """Drop leading ``--`` comment lines so a file header is not glued to SQL."""
    lines = text.splitlines(keepends=True)
    index = 0
    for line in lines:
        if line.strip().startswith("--") or not line.strip():
            index += 1
        else:
            break
    return "".join(lines[index:])


def split_statements(sql: str) -> list[str]:
    """按 SQLite 自己的词法切分语句。

    只在 ``;`` 处试探 ``complete_statement``，因此字符串里的分号与
    ``BEGIN ... END`` 里的分号都不会被误切。
    """
    statements: list[str] = []
    buffer = ""
    for char in sql:
        buffer += char
        if char == ";" and sqlite3.complete_statement(buffer):
            statements.append(_strip_leading_comments(buffer).strip())
            buffer = ""
    leftover = buffer.strip()
    if leftover and not _is_effectively_empty(leftover):
        msg = f"DDL 尾部有未以分号结束的内容：{leftover[:60]!r}"
        raise DdlError(msg)
    return [s for s in statements if s]


def read_schema(schema: str) -> list[tuple[int, list[str]]]:
    """读出一个 schema 的**迁移链**：``(目标版本, 语句列表)``，按版本升序。"""
    out: list[tuple[int, list[str]]] = []
    for version, name in migration_files(schema):
        text = (
            sql_root(schema)  # type: ignore[attr-defined]
            .joinpath(SQL_ROOT, schema, MIGRATIONS, name)
            .read_text(encoding="utf-8")
        )
        out.append((version, split_statements(text)))
    return out


def read_tables(schema: str) -> list[tuple[str, list[str]]]:
    """读出一个 schema 的**表快照**：``(文件名, 语句列表)``，按名字升序。"""
    out: list[tuple[str, list[str]]] = []
    for name in table_files(schema):
        text = (
            sql_root(schema)  # type: ignore[attr-defined]
            .joinpath(SQL_ROOT, schema, TABLES, name)
            .read_text(encoding="utf-8")
        )
        out.append((name, split_statements(text)))
    return out


def snapshot_statements(schema: str) -> list[str]:
    """全部表快照的语句，展平成一个列表，供全新安装一次跑完。"""
    out: list[str] = []
    for _name, statements in read_tables(schema):
        out.extend(statements)
    return out


def highest_version(schema: str) -> int:
    """迁移链的最高目标版本，即这个 schema 的当前版本。"""
    return max(version for version, _ in migration_files(schema))
