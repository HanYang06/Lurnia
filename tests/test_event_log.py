# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""事件日志轮转测试（路线 004，口径见 docs/design/event-log.md）。

最要紧的一条是**不丢也不重**：归档里的 + 库里剩下的 = 原来的全集。其次是失败
方向 —— 归档没落成就不许删行，删行没成就得把刚写的归档撤回去。
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest

from lurnia.core.contracts import EventEnvelope, Subject, wall_clock
from lurnia.core.storage import (
    Database,
    Rotation,
    StorageError,
    append_event,
    open_db,
    read_events,
    rotate_event_log,
)

SUBJECT = Subject(id="local")
ARCHIVE_NAME = "event-log-000000000001-000000000003.jsonl"


@pytest.fixture
def db(tmp_path: Path) -> Iterator[Database]:
    database = open_db(tmp_path / "lurnia.db")
    yield database
    database.close()


def _seed(db: Database, count: int) -> None:
    """Append `count` events. ``seq`` is the log's own rowid, so it is not set here."""
    for index in range(count):
        append_event(
            db,
            EventEnvelope(
                topic=f"t.{index}",
                subject=SUBJECT,
                payload={"i": index},
                ts_wall=wall_clock(index),
                ts_mono=index,
            ),
        )


def _topics(db: Database) -> list[str]:
    return [row["topic"] for row in read_events(db)]


# --------------------------------------------------------------------------
# the main path
# --------------------------------------------------------------------------


def test_rotation_archives_the_oldest_and_keeps_the_newest(
    db: Database, tmp_path: Path
) -> None:
    _seed(db, 5)
    result = rotate_event_log(db, tmp_path / "deep" / "archive", keep=2)

    assert result.archived == 3
    assert result.remaining == 2
    assert result.path is not None
    assert result.path.name == ARCHIVE_NAME
    assert result.path.parent.is_dir(), "归档目录要按需建出来"
    assert _topics(db) == ["t.3", "t.4"]


def test_rotation_loses_and_duplicates_nothing(db: Database, tmp_path: Path) -> None:
    _seed(db, 5)
    before = [(row["seq"], row["id"], row["topic"]) for row in read_events(db)]

    result = rotate_event_log(db, tmp_path / "archive", keep=2)

    assert result.path is not None
    archived = [
        json.loads(line)
        for line in result.path.read_text(encoding="utf-8").splitlines()
    ]
    after = [(row["seq"], row["id"], row["topic"]) for row in read_events(db)]
    assert [entry["id"] for entry in archived] == [row[1] for row in before[:3]]
    assert after == before[3:]
    assert len(archived) + len(after) == len(before)


def test_archive_keeps_every_field_of_the_original_row(
    db: Database, tmp_path: Path
) -> None:
    """The archive is the envelope's own wire form — nothing is re-invented."""
    _seed(db, 3)
    rows = list(read_events(db))

    result = rotate_event_log(db, tmp_path / "archive", keep=1)

    assert result.path is not None
    envelopes = [
        EventEnvelope.from_wire(line) for line in result.path.read_bytes().splitlines()
    ]
    assert len(envelopes) == 2
    for row, envelope in zip(rows[:2], envelopes, strict=True):
        assert envelope.id == row["id"]
        assert envelope.topic == row["topic"]
        assert envelope.subject.id == row["subject_id"]
        assert envelope.subject.kind == row["subject_kind"]
        assert envelope.cause == row["cause"]
        assert envelope.ts_wall == row["ts_wall"]
        assert envelope.ts_mono == row["ts_mono"]
        assert envelope.version == row["version"]
        assert envelope.seq == row["seq"]
        assert envelope.payload == json.loads(row["payload"])


# --------------------------------------------------------------------------
# nothing to do
# --------------------------------------------------------------------------


@pytest.mark.parametrize("keep", [3, 99])
def test_rotation_is_a_noop_when_keep_covers_the_log(
    db: Database, tmp_path: Path, keep: int
) -> None:
    _seed(db, 3)
    archive = tmp_path / "archive"

    assert rotate_event_log(db, archive, keep=keep) == Rotation(0, 3, None)
    assert not archive.exists(), "没得归档就不该建目录、更不该落空文件"
    assert len(_topics(db)) == 3


def test_keep_zero_archives_everything(db: Database, tmp_path: Path) -> None:
    _seed(db, 2)
    result = rotate_event_log(db, tmp_path / "archive", keep=0)
    assert result.archived == 2
    assert result.remaining == 0
    assert read_events(db) == []


def test_a_negative_keep_is_a_usage_error(db: Database, tmp_path: Path) -> None:
    _seed(db, 1)
    with pytest.raises(StorageError, match="负数"):
        rotate_event_log(db, tmp_path / "archive", keep=-1)


# --------------------------------------------------------------------------
# failure paths: never lose a row
# --------------------------------------------------------------------------


def test_rotation_refuses_to_overwrite_an_existing_archive(
    db: Database, tmp_path: Path
) -> None:
    """Same name = last run deleted nothing; overwriting would hide that."""
    _seed(db, 5)
    archive = tmp_path / "archive"
    archive.mkdir(parents=True)
    existing = archive / ARCHIVE_NAME
    existing.write_bytes(b"already here\n")

    with pytest.raises(StorageError, match="拒绝覆盖"):
        rotate_event_log(db, archive, keep=2)

    assert len(_topics(db)) == 5, "归档没写成，就一行都不许删"
    assert existing.read_bytes() == b"already here\n"


def test_a_failed_archive_write_deletes_nothing(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(db, 5)

    def boom(*_args: object, **_kwargs: object) -> bool:
        raise OSError("disk full")

    monkeypatch.setattr("lurnia.core.storage.write_atomic", boom)
    with pytest.raises(OSError, match="disk full"):
        rotate_event_log(db, tmp_path / "archive", keep=2)

    assert len(_topics(db)) == 5


def test_a_failed_delete_takes_the_fresh_archive_back_with_it(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Otherwise the retry would trip over the archive it never managed to use."""
    _seed(db, 5)

    def boom(*_args: object, **_kwargs: object) -> object:
        raise StorageError("delete failed")

    monkeypatch.setattr(db, "transaction", boom)
    with pytest.raises(StorageError, match="delete failed"):
        rotate_event_log(db, tmp_path / "archive", keep=2)

    assert _topics(db) == ["t.0", "t.1", "t.2", "t.3", "t.4"]
    assert list((tmp_path / "archive").glob("*.jsonl")) == []


def test_an_empty_log_rotates_to_nothing(db: Database, tmp_path: Path) -> None:
    assert rotate_event_log(db, tmp_path / "archive", keep=0) == Rotation(0, 0, None)
