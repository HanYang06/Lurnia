# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""文档服务：一套存储，多种编辑器（路线 114）。

口径见 [editor.md §十七](../../../../docs/design/editor.md)：

* 表里只有 `doc_type` 与 `title` 是列，类型特有的东西一律进 `body` 的 JSON ——
  所以「加一种编辑器」不改库；
* 写入分两档（§六）：自动落盘只更新当前行，**只有显式提交才产生修订**；
* I5：写入走 `core.change()`，事件日志与数据同事务。

**这里没有 FTS。** 实测（2026-10-17）：FTS5 默认分词器把整段中文当一个 token，
中文查询返回 0 条；`trigram` 可用但两字词仍搜不到。中文分词口径没定之前不上 FTS ——
先上就会"装完才发现搜不到"。
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from time import time_ns
from typing import TYPE_CHECKING, Any

from lurnia.components.doc.model import (
    Compiled,
    DocumentError,
    compile_schema,
    validate,
)
from lurnia.components.doc.registry import DocType, Registry, RegistryError
from lurnia.core.contracts import Command, Err, ErrKind, Ok, Reply, wall_clock
from lurnia.core.ddl import register_schema

if TYPE_CHECKING:
    from lurnia.assembly import Core

#: 业务 schema 名。DDL 在 `components/doc/sql/doc/`（storage.md §五）。
SCHEMA = "doc"
#: 这份 DDL 住在哪个包 —— **组件自己声明**，内核不需要认识业务名。
PACKAGE = __package__ or "lurnia.components.doc"
#: 单文档硬上限（§十七）。超了显式报错，不悄悄截断。
MAX_BODY_BYTES = 8 * 1024 * 1024
TITLE_LIMIT = 80

GET_CAPABILITY = "doc.get"
SAVE_CAPABILITY = "doc.save"
SAVED_TOPIC = "doc.saved"

_SELECT = "SELECT doc_type, title, body, body_version, revision FROM doc WHERE id = ?"


@dataclass(frozen=True, slots=True)
class _Body:
    """已校验过的正文：库里的文本 + 解出来的对象 + 类型与它的抽取结果。"""

    text: str
    body: Mapping[str, Any]
    doc_type: str
    version: int
    extract_text: str


@dataclass(frozen=True, slots=True)
class _Save:
    """已校验过的保存请求。"""

    doc_id: str
    doc_type: str
    version: int
    text: str
    body: Mapping[str, Any]
    title: str
    base_revision: int
    commit: bool


class DocStore:
    """文档读写 + 校验 + 提交点。能力注册在总线上，组件之间不互相 import（I1）。"""

    def __init__(
        self,
        core: Core,
        registry: Registry,
        *,
        max_body_bytes: int = MAX_BODY_BYTES,
    ) -> None:
        self._core = core
        self._registry = registry
        self._max_body_bytes = max_body_bytes
        self._compiled: dict[str, Compiled] = {}

    # ---- 装配 -----------------------------------------------------------

    def ensure_schema(self) -> None:
        """声明 DDL 的家，再把库推到 `doc` schema 的当前版本。

        先 `register_schema`：不声明的话 `ddl` 会去内核包里找 `sql/doc/`，
        报的错还是「找不到 DDL 目录」——这个坑在第一次装配时就踩到过。
        """
        register_schema(SCHEMA, PACKAGE)
        self._core.db.ensure(SCHEMA)

    def prepare(self) -> None:
        """装配时把每个类型的 schema 编译一次（§3.3：不在保存路径上解释 schema）。"""
        for name in self._registry.names():
            self._compiled[name] = compile_schema(self._registry.get(name).schema)

    def provide(self) -> None:
        """注册能力。每条能力恰好一个提供者，重复注册由总线拦下。"""
        self._core.bus.provide(GET_CAPABILITY, self._get)
        self._core.bus.provide(SAVE_CAPABILITY, self._save)

    # ---- 能力：读 -------------------------------------------------------

    def _get(self, command: Command[Any]) -> Reply[Any]:
        request = command.request
        if not isinstance(request, Mapping):
            return Err(ErrKind.INVALID, "doc.get 的 request 必须是对象")
        doc_id = _identifier(request.get("doc_id"))
        if doc_id is None:
            return Err(ErrKind.INVALID, "doc.get 需要非空的 doc_id 字符串")
        row = self._core.db.connection.execute(_SELECT, (doc_id,)).fetchone()
        if row is None:
            return Err(ErrKind.NOT_FOUND, f"没有这篇文档：{doc_id}")
        return Ok(
            {
                "doc_id": doc_id,
                "doc_type": row[0],
                "title": row[1],
                "body": json.loads(row[2]),
                "body_version": row[3],
                "revision": row[4],
            }
        )

    # ---- 能力：写 -------------------------------------------------------

    def _save(self, command: Command[Any]) -> Reply[Any]:
        parsed = self._parse_save(command)
        if isinstance(parsed, Err):
            return parsed

        current = self._revision_of(parsed.doc_id)
        if current is None:
            if parsed.base_revision != 0:
                return Err(
                    ErrKind.CONFLICT,
                    "文档还不存在，base_revision 应当是 0，"
                    f"收到 {parsed.base_revision}",
                )
            revision = 1 if parsed.commit else 0
        else:
            if parsed.base_revision != current:
                return Err(
                    ErrKind.CONFLICT,
                    f"文档已到 revision {current}，"
                    f"base_revision 收到 {parsed.base_revision}；先取最新再决定",
                )
            revision = current + 1 if parsed.commit else current

        now = wall_clock(time_ns())
        payload = {
            "doc_id": parsed.doc_id,
            "doc_type": parsed.doc_type,
            "revision": revision,
            "commit": parsed.commit,
        }
        with self._core.change(SAVED_TOPIC, payload, subject=command.subject) as tx:
            if current is None:
                tx.execute(
                    "INSERT INTO doc (id, doc_type, title, body, body_version,"
                    " revision, created_wall, updated_wall)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        parsed.doc_id,
                        parsed.doc_type,
                        parsed.title,
                        parsed.text,
                        parsed.version,
                        revision,
                        now,
                        now,
                    ),
                )
            else:
                tx.execute(
                    "UPDATE doc SET doc_type = ?, title = ?, body = ?,"
                    " body_version = ?, revision = ?, updated_wall = ? WHERE id = ?",
                    (
                        parsed.doc_type,
                        parsed.title,
                        parsed.text,
                        parsed.version,
                        revision,
                        now,
                        parsed.doc_id,
                    ),
                )
            if parsed.commit:
                tx.execute(
                    "INSERT INTO doc_revision (doc_id, revision, body,"
                    " created_wall, cause) VALUES (?, ?, ?, ?, ?)",
                    (parsed.doc_id, revision, parsed.text, now, command.id),
                )
        return Ok(
            {"doc_id": parsed.doc_id, "revision": revision, "commit": parsed.commit}
        )

    # ---- 内部 -----------------------------------------------------------

    def _parse_save(self, command: Command[Any]) -> _Save | Err:
        request = command.request
        if not isinstance(request, Mapping):
            return Err(ErrKind.INVALID, "doc.save 的 request 必须是对象")
        doc_id = _identifier(request.get("doc_id"))
        if doc_id is None:
            return Err(ErrKind.INVALID, "doc.save 需要非空的 doc_id 字符串")

        parsed = self._read_body(request.get("body"))
        if isinstance(parsed, Err):
            return parsed
        flags = _read_flags(request)
        if isinstance(flags, Err):
            return flags
        base_revision, commit = flags

        return _Save(
            doc_id=doc_id,
            doc_type=parsed.doc_type,
            version=parsed.version,
            text=parsed.text,
            body=parsed.body,
            title=self._title(request, parsed.extract_text),
            base_revision=base_revision,
            commit=commit,
        )

    def _read_body(self, raw: Any) -> _Body | Err:
        """解码、限长、找类型、走 schema。四种失败各有各的 `ErrKind`。"""
        decoded = _decode(raw)
        if isinstance(decoded, Err):
            return decoded
        text, body = decoded
        if len(text.encode("utf-8")) > self._max_body_bytes:
            return Err(
                ErrKind.INVALID,
                f"文档超过单篇上限 {self._max_body_bytes} 字节；请拆分文档",
            )
        registered = self._registered_type(body)
        if isinstance(registered, Err):
            return registered
        compiled = self._compiled.get(registered.name)
        if compiled is None:  # 装配时没编过：是装配漏了，不是调用方的问题
            return Err(ErrKind.UNAVAILABLE, f"文档类型 {registered.name!r} 没有准备好")
        try:
            validate(compiled, body)
        except DocumentError as exc:
            return Err(ErrKind.INVALID, str(exc))
        return _Body(
            text=text,
            body=body,
            doc_type=registered.name,
            version=int(body["version"]),
            extract_text=registered.extract_text(body),
        )

    def _registered_type(self, body: Any) -> DocType | Err:
        doc_type = body.get("doc_type") if isinstance(body, Mapping) else None
        if not isinstance(doc_type, str):
            return Err(ErrKind.INVALID, "文档缺少 doc_type")
        try:
            return self._registry.get(doc_type)
        except RegistryError as exc:
            return Err(ErrKind.INVALID, str(exc))

    def _revision_of(self, doc_id: str) -> int | None:
        row = self._core.db.connection.execute(
            "SELECT revision FROM doc WHERE id = ?", (doc_id,)
        ).fetchone()
        if row is None:
            return None
        return int(row[0])

    @staticmethod
    def _title(request: Mapping[str, Any], extracted: str) -> str:
        explicit = request.get("title")
        if isinstance(explicit, str) and explicit.strip():
            return explicit.strip()[:TITLE_LIMIT]
        first = extracted.strip().splitlines()[0] if extracted.strip() else ""
        return first[:TITLE_LIMIT]


def _identifier(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _decode(raw: Any) -> tuple[str, Any] | Err:
    """把 `body` 解成 `(JSON 文本, 对象)`。

    文本是**原样**保留的：前端发来的就是入库的那一份，不 re-dump（§3.3 第 2 条）。
    只有调用方直接给了对象（程序化调用）时才 `dumps` 一次。
    """
    if isinstance(raw, str):
        try:
            return raw, json.loads(raw)
        except json.JSONDecodeError as exc:
            return Err(ErrKind.INVALID, f"doc.save 的 body 不是合法 JSON：{exc}")
    if isinstance(raw, Mapping):
        return json.dumps(raw, ensure_ascii=False, separators=(",", ":")), raw
    return Err(ErrKind.INVALID, "doc.save 的 body 必须是 JSON 文本或对象")


def _read_flags(request: Mapping[str, Any]) -> tuple[int, bool] | Err:
    """`base_revision` 与 `commit`。`commit` 缺省为假 = 自动落盘（§六）。"""
    base_revision = request.get("base_revision", 0)
    if not isinstance(base_revision, int) or isinstance(base_revision, bool):
        return Err(ErrKind.INVALID, "base_revision 必须是整数")
    if base_revision < 0:
        return Err(ErrKind.INVALID, "base_revision 不能是负数")
    commit = request.get("commit", False)
    if not isinstance(commit, bool):
        return Err(ErrKind.INVALID, "commit 必须是布尔值")
    return base_revision, commit


__all__ = ["MAX_BODY_BYTES", "SCHEMA", "DocStore"]
