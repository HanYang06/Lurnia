# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""存储层：内核第 2 层。

不变量 I3：本层只可依赖 config、log 与契约。

口径见 [storage.md §三](../../../docs/design/storage.md)：存储层拆成两个存储 ——
结构化数据走标准库 `sqlite3`（本模块），大二进制走附件库
（[attachments.py](attachments.py)，路线 107）。

两条不变量在本层落地：

* **I4**：一切落盘结构带 `version`，且注册了 `migrate(from, to)`；
* **I5**：状态变更先写事件日志、后落数据，二者同事务。

路径**不从这里读配置**：`open_db(path)` 接显式路径，调用方（组合根）决定它在
哪。这样本层可在同进程内并排开多个库做测试，而不受 OnConf 单例绑定的限制。
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from lurnia.core.ddl import highest_version, read_schema, snapshot_statements
from lurnia.core.storage.attachments import (
    BLOB_THRESHOLD,
    Attachment,
    AttachmentStore,
    fits_in_database,
    suffix_of,
)
from lurnia.core.storage.errors import AttachmentError, StorageError

SCHEMA_VERSION = 2  # 内核 schema 当前目标版本；必须等于 DDL 文件里的最大版本
PAGE_SIZE = 8192  # storage.md §二：8192 命中 SQLite 官方建议区间
KERNEL_SCHEMA = "kernel"

# 迁移记账表本身是引导用的：读版本号之前它就得存在，所以它不能由"迁移"建立。
# 除此之外**没有业务 DDL 留在这里** —— 全部在 sql/<schema>/NNNN_*.sql。
SCHEMA_DDL = """
CREATE TABLE IF NOT EXISTS schema_meta (
    name    TEXT PRIMARY KEY,
    version INTEGER NOT NULL
);
"""

# 本层的公共面。附件库的几个名字在这里转出，调用方只认 `lurnia.core.storage`
# 一个入口。
__all__ = [
    "BLOB_THRESHOLD",
    "KERNEL_SCHEMA",
    "PAGE_SIZE",
    "SCHEMA_DDL",
    "SCHEMA_VERSION",
    "Attachment",
    "AttachmentError",
    "AttachmentStore",
    "Database",
    "Migration",
    "StorageError",
    "append_event",
    "check_drift",
    "fits_in_database",
    "open_db",
    "read_events",
    "schema_drift",
    "suffix_of",
]


@dataclass(frozen=True, slots=True)
class Migration:
    """一次 `from -> to` 迁移（不变量 I4）。"""

    from_version: int
    to_version: int
    apply: Callable[[sqlite3.Connection], None]


def _apply_statements(
    conn: sqlite3.Connection, schema: str, statements: list[str]
) -> None:
    """逐条执行 DDL。

    逐条 ``execute`` 而不是 ``executescript``：后者会先隐式 COMMIT，把一次
    迁移从"一个事务"变成"半途留下"的可能，I4 的可重入性就没了。
    """
    for statement in statements:
        try:
            conn.execute(statement)
        except sqlite3.Error as exc:
            head = statement.strip().splitlines()[0][:60]
            msg = f"{schema} 的 DDL 执行失败（{head}）：{exc}"
            raise StorageError(msg) from exc


def _ddl_applier(
    schema: str, statements: list[str]
) -> Callable[[sqlite3.Connection], None]:
    """把一批 DDL 语句包成迁移回调。"""

    def apply(conn: sqlite3.Connection) -> None:
        _apply_statements(conn, schema, statements)

    return apply


def _connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA page_size = {PAGE_SIZE}")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


class Database:
    """一个库文件的句柄。所有写入都显式走事务。"""

    def __init__(self, path: Path, conn: sqlite3.Connection) -> None:
        self._path = path
        self._conn = conn
        # 按 schema 分键：两条 schema 各自从 0 开始，共用一张表会互相撞号
        self._migrations: dict[str, dict[int, Migration]] = {}

    @property
    def path(self) -> Path:
        return self._path

    @property
    def connection(self) -> sqlite3.Connection:
        return self._conn

    def register_migration(self, schema: str, migration: Migration) -> None:
        chain = self._migrations.setdefault(schema, {})
        if migration.from_version in chain:
            msg = f"{schema} 版本 {migration.from_version} 的迁移已注册"
            raise StorageError(msg)
        if migration.to_version != migration.from_version + 1:
            msg = (
                f"迁移必须逐版本推进：{migration.from_version} -> "
                f"{migration.to_version}"
            )
            raise StorageError(msg)
        chain[migration.from_version] = migration

    def migrations(self, schema: str) -> dict[int, Migration]:
        return dict(self._migrations.get(schema, {}))

    def current_version(self, name: str) -> int:
        row = self._conn.execute(
            "SELECT version FROM schema_meta WHERE name = ?", (name,)
        ).fetchone()
        return int(row["version"]) if row else 0

    def migrate(self, name: str, target: int) -> int:
        """把 `name` 从当前版本逐级迁到 `target`（不变量 I4）。

        `target` **必须显式给**：迁移链按 schema 分键，两条链各自从 0 起步
        （[storage.md §三](../../../docs/design/storage.md)），所以不存在一个
        通用的「当前版本」默认值 —— 拿内核 schema 的版本号当默认，会把别的
        schema 也往内核的号上拽。要「迁到这个 schema 的当前版本」用
        :meth:`ensure`，它按 DDL 文件算出目标。
        """
        chain = self._migrations.get(name, {})
        version = self.current_version(name)
        if version > target:
            msg = f"{name} 版本 {version} 高于目标 {target}，拒绝降级"
            raise StorageError(msg)
        while version < target:
            migration = chain.get(version)
            if migration is None:
                msg = f"{name} 缺少 {version} -> {version + 1} 的迁移"
                raise StorageError(msg)
            with self.transaction():
                migration.apply(self._conn)
                self._conn.execute(
                    "INSERT INTO schema_meta (name, version) VALUES (?, ?) "
                    "ON CONFLICT(name) DO UPDATE SET version = excluded.version",
                    (name, migration.to_version),
                )
            version = migration.to_version
        return version

    def load_migrations(self, schema: str) -> None:
        """从包内 DDL 文件装载一条 schema 的迁移链。

        逐文件 = 逐版本；文件名里的 NNNN 就是该文件的目标版本。缺号/跳号由
        :meth:`migrate` 在运行时拦下。
        """
        for target, statements in read_schema(schema):
            self.register_migration(
                schema, Migration(target - 1, target, _ddl_applier(schema, statements))
            )

    def install_snapshot(self, schema: str, target: int | None = None) -> int:
        """**全新安装**：直接按 tables/ 快照建库，不重放历史。

        这是治"迁移垃圾堆"的那一刀：新装的库不需要知道表是怎么一步步长成
        今天这样的，它只要今天的形状。版本号直接记成当前目标版本，于是
        schema_meta 与迁移链不会脱节。
        """
        if self.current_version(schema) != 0:
            msg = f"{schema} 已初始化，不能再用快照安装"
            raise StorageError(msg)
        statements = snapshot_statements(schema)
        if not statements:
            msg = f"{schema} 的表快照是空的"
            raise StorageError(msg)
        version = target if target is not None else highest_version(schema)
        with self.transaction():
            _apply_statements(self._conn, schema, statements)
            self._conn.execute(
                "INSERT INTO schema_meta (name, version) VALUES (?, ?) "
                "ON CONFLICT(name) DO UPDATE SET version = excluded.version",
                (schema, version),
            )
        return version

    def ensure(self, schema: str) -> int:
        """把库推到 `schema` 的当前版本。

        两条路，同一个终点：

        * **空库** -> 走 `tables/` 快照（全新安装，不重放历史）；
        * **老库** -> 走 `migrations/` 链（只跑它还没跑过的那几步）。
        """
        target = highest_version(schema)
        if self.current_version(schema) == 0:
            return self.install_snapshot(schema, target)
        self.load_migrations(schema)
        return self.migrate(schema, target)

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """一个原子事务。I5 的"日志与数据同事务"就靠它。"""
        self._conn.execute("BEGIN")
        try:
            yield self._conn
        except BaseException:
            self._conn.execute("ROLLBACK")
            raise
        else:
            self._conn.execute("COMMIT")

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> Database:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def _names(conn: sqlite3.Connection) -> list[tuple[str, str]]:
    return [
        (row["type"], row["name"])
        for row in conn.execute(
            "SELECT type, name FROM sqlite_master "
            "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
        )
    ]


def _table_shape(conn: sqlite3.Connection, name: str) -> list[tuple[Any, ...]]:
    """列的形状：名字、类型、非空、默认值、主键位次。

    ``PRAGMA table_info`` 看不到 CHECK 约束，所以列级内省**有损**；这也是
    :func:`schema_drift` 还要比归一化原文的原因 —— 两者一起才够。
    """
    return [tuple(row) for row in conn.execute(f'PRAGMA table_info("{name}")')]


def _index_shape(conn: sqlite3.Connection, name: str) -> list[tuple[Any, ...]]:
    return [tuple(row) for row in conn.execute(f'PRAGMA index_info("{name}")')]


def _fk_shape(conn: sqlite3.Connection, name: str) -> list[tuple[Any, ...]]:
    return [tuple(row) for row in conn.execute(f'PRAGMA foreign_key_list("{name}")')]


def _normalize(sql: str | None) -> str:
    """折叠空白后的建表原文，用来比 CHECK / 生成列这类内省看不到的东西。

    SQLite 在 ``ALTER TABLE`` 后会重写 ``sqlite_master.sql``（实测
    ``CREATE TABLE note (id TEXT\\n, title TEXT)``），所以只有**归一化后**
    才可比；代价是列顺序敏感 —— 这正是我们要的：顺序变了就该被看见。
    """
    return "".join((sql or "").split())


def schema_drift(
    chain_conn: sqlite3.Connection, snapshot_conn: sqlite3.Connection
) -> list[str]:
    """比对**迁移链跑完**的库与**快照装出来**的库，返回它们的差异。

    这是治"迁移垃圾堆"的那道门：只要有旧库能靠迁移长大、新库能靠快照出生，
    两者就必须长得一模一样。不一致 = 有人改了快照却忘了迁移（或反过来），
    此时报错而不是让它漂。

    比较用的是结构内省 + 归一化原文，**不是**原文直接相等：``ALTER TABLE``
    会重写存储的 SQL 文本。
    """
    problems: list[str] = []

    # Keep these as ``(type, name)`` sets, not dicts: ``dict()`` on the pair list
    # silently collapses same-name objects of different types, and the key tuple
    # is the thing being iterated below.
    chain_objects = set(_names(chain_conn))
    snap_objects = set(_names(snapshot_conn))
    for key in sorted(chain_objects | snap_objects):
        if key not in chain_objects:
            problems.append(f"快照多出 {key[0]} {key[1]!r}，迁移链里没有")
            continue
        if key not in snap_objects:
            problems.append(f"迁移链多出 {key[0]} {key[1]!r}，快照里没有")
            continue

        kind, name = key
        if kind == "table":
            if _table_shape(chain_conn, name) != _table_shape(snapshot_conn, name):
                problems.append(f"表 {name!r} 的列不一致（名字/类型/非空/默认值/主键）")
            if _fk_shape(chain_conn, name) != _fk_shape(snapshot_conn, name):
                problems.append(f"表 {name!r} 的外键不一致")
        elif kind == "index":
            if _index_shape(chain_conn, name) != _index_shape(snapshot_conn, name):
                problems.append(f"索引 {name!r} 的列不一致")

        chain_sql = chain_conn.execute(
            "SELECT sql FROM sqlite_master WHERE name = ?", (name,)
        ).fetchone()
        snap_sql = snapshot_conn.execute(
            "SELECT sql FROM sqlite_master WHERE name = ?", (name,)
        ).fetchone()
        if _normalize(chain_sql[0] if chain_sql else None) != _normalize(
            snap_sql[0] if snap_sql else None
        ):
            problems.append(
                f"{kind} {name!r} 的建表语句归一化后不同（CHECK / 生成列 / 列顺序）"
            )
    return problems


def check_drift(schema: str = KERNEL_SCHEMA) -> list[str]:
    """在内存里各跑一遍两条路，比对结果。空列表 = 一致。

    由 ``tests/test_ddl.py`` 与 ``script/audit.py`` 调用，是"快照与迁移不许
    漂开"的硬门禁。
    """
    chain = sqlite3.connect(":memory:")
    chain.row_factory = sqlite3.Row
    snapshot = sqlite3.connect(":memory:")
    snapshot.row_factory = sqlite3.Row
    try:
        chain.executescript(SCHEMA_DDL)
        chain_db = Database(Path(":memory:"), chain)
        chain_db.load_migrations(schema)
        chain_db.migrate(schema, highest_version(schema))

        snapshot.executescript(SCHEMA_DDL)
        snapshot_db = Database(Path(":memory:"), snapshot)
        snapshot_db.install_snapshot(schema, highest_version(schema))

        return schema_drift(chain, snapshot)
    finally:
        chain.close()
        snapshot.close()


def open_db(path: str | Path, *, schema: str = KERNEL_SCHEMA) -> Database:
    """打开（必要时创建）一个库，并把它推到该 schema 的当前版本。

    空库走 ``tables/`` 快照（全新安装），老库走 ``migrations/`` 链（只补它
    还没跑的那几步）。DDL 全部来自包内 ``sql/<schema>/``，本函数不再内联
    任何业务 DDL。
    """
    resolved = Path(path).expanduser()
    resolved.parent.mkdir(parents=True, exist_ok=True)
    conn = _connect(resolved)
    # 引导表：读版本号之前它就得在，所以只能用 executescript 单发一次
    conn.executescript(SCHEMA_DDL)
    database = Database(resolved, conn)
    database.ensure(schema)
    return database


def append_event(
    db: Database, envelope: Any, *, tx: sqlite3.Connection | None = None
) -> int:
    """把事件封套追加进事件日志（不变量 I5 的"先写日志"）。

    传 `tx` 时可挂进调用方已有的事务，从而与数据落盘同生共死。
    """
    sql = (
        "INSERT INTO event_log "
        "(id, topic, subject_id, subject_kind, cause, ts_wall, ts_mono, "
        "payload, version) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    params = (
        envelope.id,
        envelope.topic,
        envelope.subject.id,
        envelope.subject.kind,
        envelope.cause,
        envelope.ts_wall,
        envelope.ts_mono,
        _dump_payload(envelope.payload),
        envelope.version,
    )
    if tx is not None:
        cursor = tx.execute(sql, params)
        rowid = cursor.lastrowid
        return int(rowid) if rowid is not None else -1
    with db.transaction() as conn:
        cursor = conn.execute(sql, params)
        rowid = cursor.lastrowid
    return int(rowid) if rowid is not None else -1


def read_events(db: Database, *, topic: str | None = None) -> Sequence[sqlite3.Row]:
    """按序读回事件日志。"""
    if topic is None:
        return db.connection.execute("SELECT * FROM event_log ORDER BY seq").fetchall()
    return db.connection.execute(
        "SELECT * FROM event_log WHERE topic = ? ORDER BY seq", (topic,)
    ).fetchall()


def _dump_payload(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)
