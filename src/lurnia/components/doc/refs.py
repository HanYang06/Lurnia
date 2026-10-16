# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""引用索引与反链（路线 111）。

口径见 [editor.md §十](../../../../docs/design/editor.md)。

三条口径：

* **只做一层反链**，不做传递闭包（A→B→C 不会让 A 出现在 C 的反链里）；
* 索引**只在某一篇的引用集变化时**更新（§3.3 第 4 条），不是每次保存都重写；
* **悬空引用显式呈现**（`exists: false`），不静默消失、也不降级成普通文本。
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import TYPE_CHECKING, Any

from lurnia.core.contracts import Command, Err, ErrKind, Ok, Reply

if TYPE_CHECKING:
    import sqlite3

    from lurnia.assembly import Core

BACKLINKS = "doc.refs.backlinks"
OUTGOING = "doc.refs.outgoing"


class RefIndex:
    """引用索引：跨类型可用（按 `doc_id` 寻址，不认「笔记」）。"""

    def __init__(self, core: Core) -> None:
        self._core = core

    def provide(self) -> None:
        self._core.bus.provide(BACKLINKS, self._backlinks)
        self._core.bus.provide(OUTGOING, self._outgoing)

    # ---- 写入（在保存事务里调用） ---------------------------------------

    def replace(
        self,
        tx: sqlite3.Connection,
        doc_id: str,
        refs: Iterable[tuple[str, str | None]],
    ) -> bool:
        """把这篇文档的引用集换成 `refs`（`(目标文档, 来源块 id)`）。

        集合没变就**不写库**，返回 `False`。空块 id 存成空串：列是 NOT NULL，
        而「引用不在任何一个块里」是合法状态（将来的图形态文档就这样）。
        """
        wanted = {(block_id or "", target_id) for target_id, block_id in refs}
        current = {
            (row[0], row[1])
            for row in tx.execute(
                "SELECT source_block_id, target_doc_id FROM doc_ref_index"
                " WHERE source_doc_id = ?",
                (doc_id,),
            )
        }
        if wanted == current:
            return False
        tx.execute("DELETE FROM doc_ref_index WHERE source_doc_id = ?", (doc_id,))
        tx.executemany(
            "INSERT INTO doc_ref_index (target_doc_id, source_doc_id, source_block_id)"
            " VALUES (?, ?, ?)",
            [(target_id, doc_id, block_id) for block_id, target_id in sorted(wanted)],
        )
        return True

    # ---- 能力 -----------------------------------------------------------

    def _backlinks(self, command: Command[Any]) -> Reply[Any]:
        """谁引用了我（一层）。来源文档已删的行不出现。"""
        doc_id = _identifier(command.request)
        if isinstance(doc_id, Err):
            return doc_id
        rows = self._core.db.connection.execute(
            "SELECT i.source_doc_id, i.source_block_id, d.doc_type, d.title"
            " FROM doc_ref_index AS i JOIN doc AS d ON d.id = i.source_doc_id"
            " WHERE i.target_doc_id = ?"
            " ORDER BY i.source_doc_id, i.source_block_id",
            (doc_id,),
        ).fetchall()
        return Ok(
            {
                "doc_id": doc_id,
                "backlinks": [
                    {
                        "source_doc_id": row[0],
                        "source_block_id": row[1],
                        "source_doc_type": row[2],
                        "title": row[3],
                    }
                    for row in rows
                ],
            }
        )

    def _outgoing(self, command: Command[Any]) -> Reply[Any]:
        """我引用了谁，以及**哪些已经悬空**。"""
        doc_id = _identifier(command.request)
        if isinstance(doc_id, Err):
            return doc_id
        rows = self._core.db.connection.execute(
            "SELECT i.target_doc_id, i.source_block_id, d.id, d.title"
            " FROM doc_ref_index AS i LEFT JOIN doc AS d ON d.id = i.target_doc_id"
            " WHERE i.source_doc_id = ?"
            " ORDER BY i.source_block_id, i.target_doc_id",
            (doc_id,),
        ).fetchall()
        return Ok(
            {
                "doc_id": doc_id,
                "refs": [
                    {
                        "target_doc_id": row[0],
                        "source_block_id": row[1],
                        "exists": row[2] is not None,
                        "title": row[3] or "",
                    }
                    for row in rows
                ],
            }
        )


def _identifier(request: Any) -> str | Err:
    if not isinstance(request, Mapping):
        return Err(ErrKind.INVALID, "request 必须是对象")
    doc_id = request.get("doc_id")
    if not isinstance(doc_id, str) or not doc_id:
        return Err(ErrKind.INVALID, "需要非空的 doc_id 字符串")
    return doc_id


__all__ = ["BACKLINKS", "OUTGOING", "RefIndex"]
