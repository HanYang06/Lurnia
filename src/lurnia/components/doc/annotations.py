# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""批注（路线 112；口径见 [editor.md §十一](../../../../docs/design/editor.md)）。

批注是**文档外**的实体，所以它：

* **不经撤销回退**（撤销一次编辑不会撤销一条批注）；
* **不随文档复制而复制**；
* **可跨多个修订存活**，正文改了就在保存事务里重新定位（§五）。

`status` 只有三个：`active` / `orphaned` / `resolved`。**没有 deleted** ——
删除是真删行，重定位失败只是 `orphaned`，绝不静默丢弃。
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping
from time import time_ns
from typing import TYPE_CHECKING, Any, Literal

from lurnia.components.doc.anchor import (
    ACTIVE,
    ORPHANED,
    Anchor,
    Placement,
    block_texts,
    relocate,
)
from lurnia.components.doc.model import DocumentError
from lurnia.core.contracts import Command, Err, ErrKind, Ok, Reply, wall_clock

if TYPE_CHECKING:
    import sqlite3

    from lurnia.assembly import Core

LIST = "doc.annotation.list"
CREATE = "doc.annotation.create"
UPDATE = "doc.annotation.update"
RESOLVE = "doc.annotation.resolve"

RESOLVED: Literal["resolved"] = "resolved"
STATUSES = frozenset({ACTIVE, ORPHANED, RESOLVED})

_SELECT = (
    "SELECT id, anchor, body, status, author_subject, created_wall, updated_wall"
    " FROM annotation WHERE doc_id = ?"
)


class AnnotationStore:
    """批注的增改查，以及「正文改了以后重新对锚点」。"""

    def __init__(self, core: Core) -> None:
        self._core = core

    def provide(self) -> None:
        self._core.bus.provide(LIST, self._list)
        self._core.bus.provide(CREATE, self._create)
        self._core.bus.provide(UPDATE, self._update)
        self._core.bus.provide(RESOLVE, self._resolve)

    # ---- 写入（在保存事务里调用） ---------------------------------------

    def reanchor(
        self,
        tx: sqlite3.Connection,
        doc_id: str,
        texts: Mapping[str, str],
    ) -> int:
        """正文变了：把这篇文档的批注重新对一遍，返回处理条数。

        `resolved` 的不动（用户已经收工了，锚点飘了也不影响它）。
        """
        rows = tx.execute(
            "SELECT id, anchor, status FROM annotation WHERE doc_id = ?", (doc_id,)
        ).fetchall()
        if not rows:
            return 0
        now = wall_clock(time_ns())
        for row in rows:
            if row[2] == RESOLVED:
                continue
            stored = json.loads(row[1])
            placement = relocate(Anchor.parse(stored), texts)
            tx.execute(
                "UPDATE annotation SET anchor = ?, status = ?, updated_wall = ?"
                " WHERE id = ?",
                (_store_anchor(stored, placement), placement.status, now, row[0]),
            )
        return len(rows)

    # ---- 能力 -----------------------------------------------------------

    def _list(self, command: Command[Any]) -> Reply[Any]:
        doc_id = _doc_id(command.request)
        if isinstance(doc_id, Err):
            return doc_id
        wanted = _status_filter(command.request)
        if isinstance(wanted, Err):
            return wanted
        rows = self._core.db.connection.execute(
            _SELECT + " ORDER BY created_wall, id", (doc_id,)
        ).fetchall()
        return Ok(
            {
                "doc_id": doc_id,
                "annotations": [
                    _reply_row(row)
                    for row in rows
                    if wanted is None or row[3] == wanted
                ],
            }
        )

    def _create(self, command: Command[Any]) -> Reply[Any]:
        request = command.request
        doc_id = _doc_id(request)
        if isinstance(doc_id, Err):
            return doc_id
        if not isinstance(request, Mapping):
            return Err(ErrKind.INVALID, "doc.annotation.create 的 request 必须是对象")
        try:
            anchor = Anchor.parse(request.get("anchor"))
        except DocumentError as exc:
            return Err(ErrKind.INVALID, str(exc))
        body = _body(request.get("body"))
        if isinstance(body, Err):
            return body
        texts = self._block_texts(doc_id)
        if texts is None:
            return Err(ErrKind.NOT_FOUND, f"没有这篇文档：{doc_id}")
        placement = relocate(anchor, texts)
        annotation_id = uuid.uuid7().hex
        now = wall_clock(time_ns())
        with self._core.change(
            "doc.annotation.created",
            {"doc_id": doc_id, "annotation_id": annotation_id},
            subject=command.subject,
        ) as tx:
            tx.execute(
                "INSERT INTO annotation (id, doc_id, anchor, body, status,"
                " author_subject, created_wall, updated_wall)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    annotation_id,
                    doc_id,
                    _store_anchor(anchor, placement),
                    body,
                    placement.status,
                    command.subject.id,
                    now,
                    now,
                ),
            )
        return Ok({"annotation_id": annotation_id, "status": placement.status})

    def _update(self, command: Command[Any]) -> Reply[Any]:
        request = command.request
        annotation_id = _annotation_id(request)
        if isinstance(annotation_id, Err):
            return annotation_id
        row = self._row(annotation_id)
        if row is None:
            return Err(ErrKind.NOT_FOUND, f"没有这条批注：{annotation_id}")
        doc_id = row[0]
        try:
            anchor = Anchor.parse(request["anchor"]) if "anchor" in request else None
        except DocumentError as exc:
            return Err(ErrKind.INVALID, str(exc))
        body: str | Err | None = None
        if "body" in request:
            body = _body(request.get("body"))
            if isinstance(body, Err):
                return body
        status = row[2]
        stored = row[1]
        if anchor is not None:
            texts = self._block_texts(doc_id)
            if texts is None:
                return Err(ErrKind.NOT_FOUND, f"批注指向的文档没了：{doc_id}")
            placement = relocate(anchor, texts)
            status = placement.status
            stored = _store_anchor(anchor, placement)
        now = wall_clock(time_ns())
        with self._core.change(
            "doc.annotation.updated",
            {"doc_id": doc_id, "annotation_id": annotation_id},
            subject=command.subject,
        ) as tx:
            tx.execute(
                "UPDATE annotation SET anchor = ?, body = ?, status = ?,"
                " updated_wall = ? WHERE id = ?",
                (
                    stored,
                    body if body is not None else row[3],
                    status,
                    now,
                    annotation_id,
                ),
            )
        return Ok({"annotation_id": annotation_id, "status": status})

    def _resolve(self, command: Command[Any]) -> Reply[Any]:
        request = command.request
        annotation_id = _annotation_id(request)
        if isinstance(annotation_id, Err):
            return annotation_id
        rows = self._core.db.connection.execute(
            "SELECT doc_id, anchor FROM annotation WHERE id = ?", (annotation_id,)
        ).fetchone()
        if rows is None:
            return Err(ErrKind.NOT_FOUND, f"没有这条批注：{annotation_id}")
        resolved = (
            request.get("resolved", True) if isinstance(request, Mapping) else True
        )
        if not isinstance(resolved, bool):
            return Err(ErrKind.INVALID, "resolved 必须是布尔值")
        doc_id = rows[0]
        stored = rows[1]
        if resolved:
            status: str = RESOLVED
        else:
            texts = self._block_texts(doc_id)
            if texts is None:
                return Err(ErrKind.NOT_FOUND, f"批注指向的文档没了：{doc_id}")
            placement = relocate(Anchor.parse(json.loads(stored)), texts)
            status = placement.status
            stored = _store_anchor(json.loads(stored), placement)
        now = wall_clock(time_ns())
        with self._core.change(
            "doc.annotation.resolved" if resolved else "doc.annotation.reopened",
            {"doc_id": doc_id, "annotation_id": annotation_id},
            subject=command.subject,
        ) as tx:
            tx.execute(
                "UPDATE annotation SET status = ?, anchor = ?, updated_wall = ?"
                " WHERE id = ?",
                (status, stored, now, annotation_id),
            )
        return Ok({"annotation_id": annotation_id, "status": status})

    # ---- 内部 -----------------------------------------------------------

    def _row(self, annotation_id: str) -> Any:
        return self._core.db.connection.execute(
            "SELECT doc_id, anchor, status, body FROM annotation WHERE id = ?",
            (annotation_id,),
        ).fetchone()

    def _block_texts(self, doc_id: str) -> dict[str, str] | None:
        row = self._core.db.connection.execute(
            "SELECT body FROM doc WHERE id = ?", (doc_id,)
        ).fetchone()
        if row is None:
            return None
        return block_texts(json.loads(row[0]))


def _store_anchor(anchor: Any, placement: Placement) -> str:
    """把原锚点与新的落点合成存库形状：`quote`/前后文保持不变，偏移跟着走。"""
    source = anchor.to_json() if isinstance(anchor, Anchor) else dict(anchor)
    source["offset"] = placement.offset
    source["length"] = placement.length
    return json.dumps(source, ensure_ascii=False, sort_keys=True)


def _doc_id(request: Any) -> str | Err:
    if not isinstance(request, Mapping):
        return Err(ErrKind.INVALID, "request 必须是对象")
    doc_id = request.get("doc_id")
    if not isinstance(doc_id, str) or not doc_id:
        return Err(ErrKind.INVALID, "需要非空的 doc_id 字符串")
    return doc_id


def _annotation_id(request: Any) -> str | Err:
    if not isinstance(request, Mapping):
        return Err(ErrKind.INVALID, "request 必须是对象")
    annotation_id = request.get("annotation_id")
    if not isinstance(annotation_id, str) or not annotation_id:
        return Err(ErrKind.INVALID, "需要非空的 annotation_id 字符串")
    return annotation_id


def _body(value: Any) -> str | Err:
    if not isinstance(value, str) or not value.strip():
        return Err(ErrKind.INVALID, "批注正文必须是非空字符串")
    return value


def _status_filter(request: Any) -> str | Err | None:
    if not isinstance(request, Mapping) or "status" not in request:
        return None
    status: str = request["status"]
    if status not in STATUSES:
        return Err(ErrKind.INVALID, f"status 只能是 {sorted(STATUSES)} 之一")
    return status


def _reply_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "annotation_id": row[0],
        "anchor": json.loads(row[1]),
        "body": row[2],
        "status": row[3],
        "author_subject": row[4],
        "created_wall": row[5],
        "updated_wall": row[6],
    }


__all__ = [
    "CREATE",
    "LIST",
    "RESOLVE",
    "RESOLVED",
    "STATUSES",
    "UPDATE",
    "AnnotationStore",
]
