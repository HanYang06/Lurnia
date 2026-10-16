# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""附件库：内容是地址（路线 107）。

口径见 [storage.md §四](../../../docs/design/storage.md)。

* 文件名 = 内容哈希（sha256）+ 原名后缀；目录按哈希前两位分桶，避免单目录塞几万个文件；
* 数据库只存元数据行（`hash` / `size` / `mime` / 原名 / 引用计数），**不存本体**；
* 写入「临时文件 → `fsync` → `os.replace`」，避免半截文件；
* 回收靠引用计数：归零才真删，不做后台扫描。

**为什么附件库不参与数据库事务。** `storage.md` §六 定了：本体先落盘拿到哈希，
再写元数据行。这是**故意**和 I5 反着来的 —— 两样东西不在一个存储里，硬凑一个
事务只会得到「文件在、行不在」或者反过来。所以落盘成功而行写入失败时，把本次
**真的新建**的那份本体撤掉（否则会误删别人已经引用的同一份内容）。

**为什么不用扩展名以外的花样命名。** 名字即地址：同一份内容天然去重，改名、
换引用方都不影响它。后缀只为了让系统能看出类型，所以它来自原名且经过校验，
不可信就退化成没有后缀。
"""

from __future__ import annotations

import hashlib
import mimetypes
import os
import re
import sqlite3
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING

from lurnia.core.storage.errors import AttachmentError

if TYPE_CHECKING:
    from lurnia.core.storage import Database

# storage.md §二：100KB 是 SQLite BLOB 内外的分界，不是「允许不允许」。
BLOB_THRESHOLD = 100 * 1024

# 后缀只接受「一个点 + 1..10 位字母数字」：原名是用户给的，不能直接拼进路径。
_SUFFIX = re.compile(r"^\.[A-Za-z0-9]{1,10}$")

_SELECT_ROW = "SELECT hash, size, mime, name, refcount FROM attachment WHERE hash = ?"

__all__ = [
    "BLOB_THRESHOLD",
    "Attachment",
    "AttachmentStore",
    "fits_in_database",
    "suffix_of",
]


def fits_in_database(data: bytes) -> bool:
    """≤ 100KB 就该连本体塞进数据库；超过才落附件库（storage.md §二）。

    这是**工程口径**：超过阈值还硬塞，会把数据库页面缓存挤爆。
    """
    return len(data) <= BLOB_THRESHOLD


def suffix_of(name: str) -> str:
    """原名里可安全用作文件名后缀的部分；不可信则返回空串。"""
    candidate = PurePosixPath(name.replace("\\", "/")).suffix.lower()
    return candidate if _SUFFIX.match(candidate) else ""


@dataclass(frozen=True, slots=True)
class Attachment:
    """一条附件元数据。字段与 `attachment` 表一一对应（`digest` 即表里的 `hash`）。"""

    digest: str
    size: int
    mime: str | None
    name: str
    refcount: int


class AttachmentStore:
    """按内容哈希落文件的附件库。本体在文件系统，元数据在数据库。"""

    def __init__(self, root: str | Path, db: Database) -> None:
        self._root = Path(root).expanduser()
        self._db = db

    @property
    def root(self) -> Path:
        return self._root

    # ---- 路径 -----------------------------------------------------------

    def path_for(self, digest: str, *, suffix: str = "") -> Path:
        """本体路径：`<root>/<hash 前两位>/<hash><后缀>`。"""
        return self._root / digest[:2] / f"{digest}{suffix}"

    def body_path(self, attachment: Attachment) -> Path:
        """一条元数据对应的本体路径（后缀取自它记录的原名）。"""
        return self.path_for(attachment.digest, suffix=suffix_of(attachment.name))

    # ---- 写与读 ---------------------------------------------------------

    def put(self, data: bytes, *, name: str) -> Attachment:
        """落一份内容，返回它的元数据行。

        **同一份内容存两次只落一份本体**：第二次只是把引用计数加上去。
        行在、本体却丢了（换机器、手删）时顺手把它补回来。
        """
        digest = hashlib.sha256(data).hexdigest()
        existing = self.find(digest)
        if existing is not None:
            path = self.body_path(existing)
            if not path.is_file():
                self._write_body(path, data)
            return self.retain(digest)

        path = self.path_for(digest, suffix=suffix_of(name))
        created = self._write_body(path, data)
        try:
            return self._insert(digest, len(data), _guess_mime(name), name)
        except BaseException:
            # 行没落成 -> 不留本体；只有本次真的新建了才撤，否则会删掉别人的
            if created:
                path.unlink(missing_ok=True)
            raise

    def get(self, digest: str) -> bytes:
        """读回本体。行或本体缺一都是 `AttachmentError`，不静默给空。"""
        found = self.find(digest)
        if found is None:
            msg = f"没有这个附件：{digest}"
            raise AttachmentError(msg)
        path = self.body_path(found)
        if not path.is_file():
            msg = f"附件本体缺失：{path}"
            raise AttachmentError(msg)
        return path.read_bytes()

    def find(self, digest: str) -> Attachment | None:
        row = self._db.connection.execute(
            _SELECT_ROW,
            (digest,),
        ).fetchone()
        return _to_attachment(row) if row is not None else None

    # ---- 引用计数 -------------------------------------------------------

    def retain(self, digest: str) -> Attachment:
        """多一个引用方（去重后的那一份仍只有一份本体）。"""
        with self._db.transaction() as conn:
            cursor = conn.execute(
                "UPDATE attachment SET refcount = refcount + 1 WHERE hash = ?",
                (digest,),
            )
            if cursor.rowcount == 0:
                msg = f"没有这个附件：{digest}"
                raise AttachmentError(msg)
            row = conn.execute(
                _SELECT_ROW,
                (digest,),
            ).fetchone()
        return _to_attachment(row)

    def release(self, digest: str) -> bool:
        """少一个引用方；归零才真删。返回是否删掉了本体。

        **先删本体、再删行，都在一个事务里**：元数据是权威，绝不留一条指向
        不存在本体的行。反过来的话，删本体失败会让「引用计数已经归零」这件事
        无法回退，那份内容就再也找不回来了。事务里做文件 I/O 会多握一会儿写锁，
        本地单用户场景下可以接受。
        """
        with self._db.transaction() as conn:
            row = conn.execute(
                "SELECT name, refcount FROM attachment WHERE hash = ?", (digest,)
            ).fetchone()
            if row is None:
                msg = f"没有这个附件：{digest}"
                raise AttachmentError(msg)
            if int(row["refcount"]) > 1:
                conn.execute(
                    "UPDATE attachment SET refcount = refcount - 1 WHERE hash = ?",
                    (digest,),
                )
                return False
            self.path_for(digest, suffix=suffix_of(row["name"])).unlink(missing_ok=True)
            conn.execute("DELETE FROM attachment WHERE hash = ?", (digest,))
            return True

    # ---- 内部 -----------------------------------------------------------

    def _write_body(self, path: Path, data: bytes) -> bool:
        """原子落盘。返回是否**新建**了本体（已存在则不动它）。"""
        if path.is_file():
            return False
        path.parent.mkdir(parents=True, exist_ok=True)
        handle_fd, temp_name = tempfile.mkstemp(
            dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
        )
        temp = Path(temp_name)
        try:
            with os.fdopen(handle_fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp, path)
        except BaseException:
            temp.unlink(missing_ok=True)
            raise
        return True

    def _insert(
        self, digest: str, size: int, mime: str | None, name: str
    ) -> Attachment:
        with self._db.transaction() as conn:
            conn.execute(
                "INSERT INTO attachment (hash, size, mime, name, refcount) "
                "VALUES (?, ?, ?, ?, 1)",
                (digest, size, mime, name),
            )
        return Attachment(digest=digest, size=size, mime=mime, name=name, refcount=1)


def _guess_mime(name: str) -> str | None:
    mime, _encoding = mimetypes.guess_type(name)
    return mime


def _to_attachment(row: sqlite3.Row) -> Attachment:
    return Attachment(
        digest=row["hash"],
        size=int(row["size"]),
        mime=row["mime"],
        name=row["name"],
        refcount=int(row["refcount"]),
    )
