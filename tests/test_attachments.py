# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""附件库测试：内容是地址、去重、引用计数回收、原子落盘（路线 107）。

口径见 docs/design/storage.md §四。这里刻意把「失败路径」也打穿：半截文件、
丢本体、行没落成这三件事才是这套东西存在的理由。
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from pathlib import Path

import pytest

from lurnia.core.storage import (
    BLOB_THRESHOLD,
    AttachmentError,
    AttachmentStore,
    Database,
    StorageError,
    fits_in_database,
    open_db,
    suffix_of,
)

DATA = b"\x89PNG\r\n\x1a\nnot-really-a-png"
OTHER = b"a different body entirely"


@pytest.fixture
def db(tmp_path: Path) -> Iterator[Database]:
    database = open_db(tmp_path / "lurnia.db")
    yield database
    database.close()


@pytest.fixture
def store(tmp_path: Path, db: Database) -> AttachmentStore:
    return AttachmentStore(tmp_path / "attachments", db)


def _files(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*") if p.is_file())


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --------------------------------------------------------------------------
# the 100KB line
# --------------------------------------------------------------------------


def test_fits_in_database_is_inclusive_at_the_threshold() -> None:
    assert fits_in_database(b"")
    assert fits_in_database(b"x" * BLOB_THRESHOLD)
    assert not fits_in_database(b"x" * (BLOB_THRESHOLD + 1))


def test_threshold_is_the_documented_hundred_kilobytes() -> None:
    assert BLOB_THRESHOLD == 100 * 1024


# --------------------------------------------------------------------------
# suffixes
# --------------------------------------------------------------------------


def test_suffix_of_keeps_a_sane_extension() -> None:
    assert suffix_of("photo.PNG") == ".png"
    assert suffix_of("archive.tar.gz") == ".gz"


def test_suffix_of_drops_anything_untrusted() -> None:
    assert suffix_of("README") == ""
    assert suffix_of("") == ""
    assert suffix_of("weird.<script>") == ""
    assert suffix_of("long.verylongsuffix") == ""


# --------------------------------------------------------------------------
# put / get
# --------------------------------------------------------------------------


def test_put_writes_the_body_into_a_bucketed_path(store: AttachmentStore) -> None:
    attachment = store.put(DATA, name="封面.PNG")

    assert attachment.digest == _digest(DATA)
    assert attachment.size == len(DATA)
    assert attachment.mime == "image/png"
    assert attachment.name == "封面.PNG"
    assert attachment.refcount == 1

    path = store.body_path(attachment)
    assert path == store.root / attachment.digest[:2] / f"{attachment.digest}.png"
    assert path.read_bytes() == DATA


def test_bucket_directory_is_the_first_two_hash_characters(
    store: AttachmentStore,
) -> None:
    attachment = store.put(DATA, name="x.png")
    assert store.root in store.body_path(attachment).parents
    assert store.body_path(attachment).parent.name == attachment.digest[:2]


def test_get_round_trips_the_body(store: AttachmentStore) -> None:
    attachment = store.put(DATA, name="x.png")
    assert store.get(attachment.digest) == DATA


def test_put_without_a_usable_suffix_names_the_file_by_hash_alone(
    store: AttachmentStore,
) -> None:
    attachment = store.put(DATA, name="README")
    assert store.body_path(attachment).name == attachment.digest


def test_a_hostile_name_cannot_escape_the_store(store: AttachmentStore) -> None:
    attachment = store.put(DATA, name="../../evil.png")
    path = store.body_path(attachment)
    assert store.root in path.parents
    assert path.name == f"{attachment.digest}.png"


def test_unknown_mime_type_is_recorded_as_none(store: AttachmentStore) -> None:
    attachment = store.put(b"blob", name="thing.unknownext")
    assert attachment.mime is None


# --------------------------------------------------------------------------
# dedupe + reference counting
# --------------------------------------------------------------------------


def test_storing_the_same_content_twice_keeps_one_body(
    store: AttachmentStore,
) -> None:
    first = store.put(DATA, name="a.png")
    second = store.put(DATA, name="b.png")

    assert first.digest == second.digest
    assert second.refcount == 2
    assert len(_files(store.root)) == 1


def test_different_content_lands_twice(store: AttachmentStore) -> None:
    first = store.put(DATA, name="a.png")
    second = store.put(OTHER, name="b.bin")
    assert first.digest != second.digest
    assert len(_files(store.root)) == 2


def test_retain_adds_a_reference(store: AttachmentStore) -> None:
    attachment = store.put(DATA, name="a.png")
    retained = store.retain(attachment.digest)
    assert retained.refcount == 2


def test_retain_of_an_unknown_digest_is_an_error(store: AttachmentStore) -> None:
    with pytest.raises(AttachmentError, match="没有这个附件"):
        store.retain(_digest(b"never stored"))


def test_release_keeps_the_body_while_references_remain(
    store: AttachmentStore,
) -> None:
    attachment = store.put(DATA, name="a.png")
    store.retain(attachment.digest)

    assert store.release(attachment.digest) is False
    assert _files(store.root)
    found = store.find(attachment.digest)
    assert found is not None
    assert found.refcount == 1


def test_release_deletes_the_body_and_the_row_at_zero(
    store: AttachmentStore,
) -> None:
    attachment = store.put(DATA, name="a.png")

    assert store.release(attachment.digest) is True
    assert not _files(store.root)
    assert store.find(attachment.digest) is None


def test_release_of_an_unknown_digest_is_an_error(store: AttachmentStore) -> None:
    with pytest.raises(AttachmentError, match="没有这个附件"):
        store.release(_digest(b"never stored"))


def test_find_returns_none_for_an_unknown_digest(store: AttachmentStore) -> None:
    assert store.find(_digest(b"never stored")) is None


def test_error_type_is_a_storage_error() -> None:
    assert issubclass(AttachmentError, StorageError)


# --------------------------------------------------------------------------
# failure paths
# --------------------------------------------------------------------------


def test_get_reports_a_missing_body_instead_of_returning_nothing(
    store: AttachmentStore,
) -> None:
    attachment = store.put(DATA, name="a.png")
    store.body_path(attachment).unlink()

    with pytest.raises(AttachmentError, match="本体缺失"):
        store.get(attachment.digest)


def test_get_of_an_unknown_digest_is_an_error(store: AttachmentStore) -> None:
    with pytest.raises(AttachmentError, match="没有这个附件"):
        store.get(_digest(b"never stored"))


def test_put_repairs_a_row_whose_body_vanished(store: AttachmentStore) -> None:
    """A row without a body must heal on the next put, not stay broken."""
    attachment = store.put(DATA, name="a.png")
    store.body_path(attachment).unlink()
    assert store.find(attachment.digest) is not None

    again = store.put(DATA, name="a.png")

    assert store.body_path(again).read_bytes() == DATA
    assert again.refcount == 2


def test_put_removes_a_freshly_written_body_when_the_row_fails(
    store: AttachmentStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A file with no row is invisible garbage: undo it instead of leaking it."""

    def boom(*_args: object, **_kwargs: object) -> object:
        raise StorageError("行没落成")

    monkeypatch.setattr(store, "_insert", boom)
    with pytest.raises(StorageError, match="行没落成"):
        store.put(DATA, name="a.png")

    assert _files(store.root) == []


def test_put_keeps_a_preexisting_body_when_the_row_fails(
    store: AttachmentStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The undo must only remove what *this* call created.

    An orphan body (a previous crash between disk and database) must survive a
    failed insert, or the undo deletes data it never wrote.
    """
    orphan = store.path_for(_digest(DATA), suffix=".png")
    orphan.parent.mkdir(parents=True, exist_ok=True)
    orphan.write_bytes(DATA)

    def boom(*_args: object, **_kwargs: object) -> object:
        raise StorageError("行没落成")

    monkeypatch.setattr(store, "_insert", boom)
    with pytest.raises(StorageError, match="行没落成"):
        store.put(DATA, name="a.png")

    assert orphan.is_file()


def test_a_failed_replace_leaves_neither_body_nor_temp_file(
    store: AttachmentStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*_args: object, **_kwargs: object) -> None:
        raise OSError("no space left")

    monkeypatch.setattr("lurnia.core.storage.attachments.os.replace", boom)
    with pytest.raises(OSError, match="no space left"):
        store.put(DATA, name="a.png")

    assert _files(store.root) == []


def test_a_successful_put_leaves_no_temp_file(store: AttachmentStore) -> None:
    store.put(DATA, name="a.png")
    assert [p.name for p in _files(store.root)] == [f"{_digest(DATA)}.png"]
