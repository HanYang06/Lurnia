# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""组合根：把内核四层装成一台能跑的核心。

口径见 [composition.md](../../docs/design/composition.md)。

本模块**不属于**内核四层，刻意放在 `core/` 之外：四层是零件（`config → log →
storage → bus` 单向，不变量 I3），组合根是装配台，它必须依赖全部四层。放进
`core/` 会让 I3 的检查要么被破、要么被放宽成白名单。

它只管三件事：

1. **数据落点** —— 决定库文件与附件库在哪，绝不由 `__file__` /
   `sys.executable` 推导（冻结后它们指向临时解包目录，见 `packaging.md` §六）；
2. **接线** —— 把 `Bus` 的事件日志钩子接到 `append_event`。不变量 **I5** 的语义
   在 `storage` 层已被测试证明，但证明过不等于接上了；这里才是生产链路；
3. **`change()`** —— 让调用方的数据写入与事件日志**同事务**，一起成或一起不成。

它不做：不碰 UI、不开端口、不拉进程（不变量 I9）；不自动落每一次广播
（`bus.md` §五）；不替组件声明配置键。
"""

from __future__ import annotations

import os
import sqlite3
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from lurnia.core import conf, log
from lurnia.core.bus import Bus
from lurnia.core.storage import AttachmentStore, Database, append_event, open_db

if TYPE_CHECKING:
    from lurnia.core.contracts import EventEnvelope, Guard, Subject, Transport

APP_DIR = "Lurnia"
DATABASE_NAME = "lurnia.db"
ATTACHMENTS_DIR = "attachments"

__all__ = [
    "APP_DIR",
    "ATTACHMENTS_DIR",
    "DATABASE_NAME",
    "Core",
    "Paths",
    "assemble",
    "data_home",
    "default_paths",
]


@dataclass(frozen=True, slots=True)
class Paths:
    """一台核心的数据落点。三个路径同源，用户可整体备份、整体搬走。"""

    home: Path
    database: Path
    attachments: Path


def data_home() -> Path:
    """平台默认数据目录（`packaging.md` §六）。

    **不能**由 `__file__` / `sys.executable` 推导：PyInstaller 冻结后它们指向
    临时解包目录，不是安装目录，更不是用户数据目录。
    """
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        root = Path(appdata) if appdata else Path.home() / "AppData" / "Roaming"
    elif sys.platform == "darwin":
        root = Path.home() / "Library" / "Application Support"
    else:
        xdg = os.environ.get("XDG_DATA_HOME")
        root = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return root / APP_DIR


def default_paths(home: str | Path) -> Paths:
    """一个 home 下的三个落点：库、附件库，以及 home 自己。"""
    resolved = Path(home).expanduser()
    return Paths(
        home=resolved,
        database=resolved / DATABASE_NAME,
        attachments=resolved / ATTACHMENTS_DIR,
    )


class _TransactionState(threading.local):
    """当前线程正在写的事务。

    I5 的「日志与数据同事务」靠它：`record()` 在事务里就并入该事务，在事务外
    就自开一个。用 thread-local 是因为同一进程里可能有多个线程各写各的库事务。
    """

    tx: sqlite3.Connection | None

    def __init__(self) -> None:
        self.tx = None


class Core:
    """一台装好的核心：数据落点 + 数据库 + 附件库 + 总线。

    直接构造用于已有数据库句柄的场合；正常入口是 :func:`assemble`。
    """

    def __init__(
        self,
        paths: Paths,
        db: Database,
        *,
        guard: Guard | None = None,
        transport: Transport | None = None,
    ) -> None:
        self._paths = paths
        self._db = db
        self._state = _TransactionState()
        self._bus = Bus(guard=guard, transport=transport, event_log=self.record)
        self._attachments = AttachmentStore(paths.attachments, db)

    @property
    def paths(self) -> Paths:
        return self._paths

    @property
    def db(self) -> Database:
        return self._db

    @property
    def bus(self) -> Bus:
        return self._bus

    @property
    def attachments(self) -> AttachmentStore:
        return self._attachments

    # ---- 事件日志落点（I5） ---------------------------------------------

    def record(self, envelope: EventEnvelope) -> None:
        """事件日志落点：有活动事务就并入，没有就自开一个。

        这是挂给 `Bus` 的钩子，也可以直接调用（例如转发已有封套时）。
        """
        append_event(self._db, envelope, tx=self._state.tx)

    @contextmanager
    def change(
        self,
        topic: str,
        payload: dict[str, Any],
        *,
        subject: Subject,
        cause: str | None = None,
    ) -> Iterator[sqlite3.Connection]:
        """一次状态变更：**先写事件日志，后落数据，二者同事务**（不变量 I5）。

        用法::

            with core.change("note.created", {"id": note_id}, subject=sub) as tx:
                tx.execute("INSERT INTO note (id) VALUES (?)", (note_id,))

        封套由内核构造（不变量 I8），`seq` 与时间戳不劳调用方。嵌套调用并入外层
        事务——内外层要么一起成，要么一起不成，不重开 `BEGIN`。
        """
        envelope = self._bus.envelope(topic, payload, subject=subject, cause=cause)
        active = self._state.tx
        if active is not None:
            append_event(self._db, envelope, tx=active)
            yield active
            return
        with self._db.transaction() as conn:
            self._state.tx = conn
            try:
                self.record(envelope)
                yield conn
            finally:
                self._state.tx = None

    # ---- 生命周期 -------------------------------------------------------

    def close(self) -> None:
        self._db.close()

    def __enter__(self) -> Core:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def assemble(
    home: str | Path | None = None,
    *,
    bind_config: bool = True,
    guard: Guard | None = None,
    transport: Transport | None = None,
) -> Core:
    """把四层装成一台核心。

    :param home: 数据目录；`None` 用平台默认（:func:`data_home`）。
    :param bind_config: 是否绑定 OnConf。它的引擎是**进程级单例**、绑定后不能改绑
        （`conf.py`），所以进程里已经绑过的场合传 `False`，只装其余部分。

    日志与配置的**进程级**设定不在这里展开成参数：记录器用内核默认（INFO /
    stderr），OnConf 用自己的默认。宿主若要额外配置，在装配前后各自调用
    `log.configure()`，或传 `bind_config=False` 自己绑。
    """
    paths = default_paths(data_home() if home is None else home)
    if bind_config:
        conf.configure(paths.home)
    log.configure()
    return Core(paths, open_db(paths.database), guard=guard, transport=transport)
