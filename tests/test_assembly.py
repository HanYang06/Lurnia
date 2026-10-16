# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""组合根测试：装配、数据目录口径、以及 I5 在装配层的端到端落地。

`storage` 层的测试已经证明了「日志与数据同事务」这条语义；这里证的是另一件事
——**它被接上了**。装配前的 `Bus.recorded()` 是个没人挂的钩子，语义正确但生产
链路上什么都不发生。

绑定 OnConf 的装配只能放在子进程里：它的引擎是进程级单例（见
`src/lurnia/core/conf.py`），同进程内绑定第二次不可能。
"""

from __future__ import annotations

import os
import pathlib
import sqlite3
import subprocess
import sys
import textwrap
from collections.abc import Iterator

import pytest

from lurnia.assembly import (
    APP_DIR,
    ATTACHMENTS_DIR,
    DATABASE_NAME,
    Core,
    assemble,
    data_home,
    default_paths,
)
from lurnia.core.bus import MemoryTransport
from lurnia.core.contracts import (
    Command,
    Decision,
    Err,
    ErrKind,
    Guard,
    Ok,
    Subject,
    Transport,
)
from lurnia.core.storage import KERNEL_SCHEMA, SCHEMA_VERSION, open_db

ROOT = pathlib.Path(__file__).resolve().parent.parent

SUBJECT = Subject(id="local")


def _run(code: str) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, "-c", textwrap.dedent(code)],
        capture_output=True,
        check=False,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        cwd=str(ROOT),
    )


def _event_count(core: Core) -> int:
    row = core.db.connection.execute("SELECT COUNT(*) FROM event_log").fetchone()
    return int(row[0])


def _scratch_count(core: Core) -> int:
    row = core.db.connection.execute("SELECT COUNT(*) FROM scratch").fetchone()
    return int(row[0])


def _new_core(
    home: pathlib.Path,
    *,
    guard: Guard | None = None,
    transport: Transport | None = None,
) -> Core:
    """A core over a scratch database, with a table for the caller to write into."""
    db = open_db(home / DATABASE_NAME)
    db.connection.execute("CREATE TABLE scratch (n INTEGER)")
    return Core(default_paths(home), db, guard=guard, transport=transport)


def _failing_change(core: Core) -> None:
    """A change whose body raises after writing: everything must roll back."""
    with core.change("scratch.added", {"n": 1}, subject=SUBJECT) as tx:
        tx.execute("INSERT INTO scratch (n) VALUES (1)")
        raise RuntimeError("boom")


def _nested_failing_change(core: Core) -> None:
    with core.change("outer", {}, subject=SUBJECT) as outer:
        outer.execute("INSERT INTO scratch (n) VALUES (1)")
        with core.change("inner", {}, subject=SUBJECT) as inner:
            inner.execute("INSERT INTO scratch (n) VALUES (2)")
            raise RuntimeError("inner boom")


def _record_then_fail(core: Core) -> None:
    """The sink lands in the caller's transaction, so the rollback takes it too."""
    with core.change("outer", {}, subject=SUBJECT) as tx:
        core.record(core.bus.envelope("side", {}, subject=SUBJECT))
        tx.execute("INSERT INTO scratch (n) VALUES (1)")
        raise RuntimeError("rollback both")


@pytest.fixture
def core(tmp_path: pathlib.Path) -> Iterator[Core]:
    instance = _new_core(tmp_path)
    yield instance
    instance.close()


# --------------------------------------------------------------------------
# data directory
# --------------------------------------------------------------------------


def test_default_paths_keep_both_stores_under_one_home(tmp_path: pathlib.Path) -> None:
    paths = default_paths(tmp_path)
    assert paths.home == tmp_path
    assert paths.database == tmp_path / DATABASE_NAME
    assert paths.attachments == tmp_path / ATTACHMENTS_DIR


def test_default_paths_expand_a_user_home() -> None:
    expected = pathlib.Path("~/lurnia-test").expanduser()
    assert default_paths("~/lurnia-test").home == expected


def test_data_home_is_absolute_and_named_after_the_app() -> None:
    home = data_home()
    assert home.is_absolute()
    assert home.name == APP_DIR


def test_data_home_follows_appdata_on_windows(
    monkeypatch: pytest.MonkeyPatch, tmp_path: pathlib.Path
) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setenv("APPDATA", str(tmp_path))
    assert data_home() == tmp_path / APP_DIR


def test_data_home_falls_back_when_appdata_is_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.delenv("APPDATA", raising=False)
    expected = pathlib.Path.home() / "AppData" / "Roaming" / APP_DIR
    assert data_home() == expected


def test_data_home_follows_the_macos_convention(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    expected = pathlib.Path.home() / "Library" / "Application Support" / APP_DIR
    assert data_home() == expected


def test_data_home_follows_xdg_on_linux(
    monkeypatch: pytest.MonkeyPatch, tmp_path: pathlib.Path
) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    assert data_home() == tmp_path / APP_DIR


def test_data_home_falls_back_when_xdg_is_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    assert data_home() == pathlib.Path.home() / ".local" / "share" / APP_DIR


# --------------------------------------------------------------------------
# the core handles
# --------------------------------------------------------------------------


def test_core_exposes_paths_database_and_bus(tmp_path: pathlib.Path) -> None:
    db = open_db(tmp_path / DATABASE_NAME)
    core = Core(default_paths(tmp_path), db)
    try:
        assert core.paths.database == tmp_path / DATABASE_NAME
        assert core.db is db
        assert core.bus is not None
        assert core.attachments.root == tmp_path / ATTACHMENTS_DIR
    finally:
        core.close()


def test_core_close_closes_the_connection(tmp_path: pathlib.Path) -> None:
    db = open_db(tmp_path / DATABASE_NAME)
    core = Core(default_paths(tmp_path), db)
    conn = db.connection
    core.close()
    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")


def test_core_works_as_a_context_manager(tmp_path: pathlib.Path) -> None:
    db = open_db(tmp_path / DATABASE_NAME)
    conn = db.connection
    with Core(default_paths(tmp_path), db):
        pass
    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")


# --------------------------------------------------------------------------
# I5 through the assembly
# --------------------------------------------------------------------------


def test_change_records_the_event_and_the_data_together(core: Core) -> None:
    with core.change("scratch.added", {"n": 1}, subject=SUBJECT) as tx:
        tx.execute("INSERT INTO scratch (n) VALUES (1)")

    assert _event_count(core) == 1
    assert _scratch_count(core) == 1
    row = core.db.connection.execute(
        "SELECT topic, subject_id, ts_wall, seq, version FROM event_log"
    ).fetchone()
    assert row["topic"] == "scratch.added"
    assert row["subject_id"] == "local"
    assert row["ts_wall"].endswith("+00:00")
    assert row["seq"] > 0
    assert row["version"] == 1


def test_change_rolls_back_the_event_when_the_body_raises(core: Core) -> None:
    with pytest.raises(RuntimeError, match="boom"):
        _failing_change(core)

    assert _event_count(core) == 0
    assert _scratch_count(core) == 0


def test_change_can_start_again_after_a_rollback(core: Core) -> None:
    """The transaction state must be cleared on the way out, not just on success."""
    with pytest.raises(RuntimeError, match="boom"):
        _failing_change(core)

    with core.change("scratch.added", {}, subject=SUBJECT) as tx:
        tx.execute("INSERT INTO scratch (n) VALUES (2)")

    assert _event_count(core) == 1
    assert _scratch_count(core) == 1


def test_nested_change_joins_the_outer_transaction(core: Core) -> None:
    with core.change("outer", {}, subject=SUBJECT) as outer:
        outer.execute("INSERT INTO scratch (n) VALUES (1)")
        with core.change("inner", {}, subject=SUBJECT) as inner:
            inner.execute("INSERT INTO scratch (n) VALUES (2)")

    assert _event_count(core) == 2
    assert _scratch_count(core) == 2
    topics = [
        row["topic"]
        for row in core.db.connection.execute(
            "SELECT topic FROM event_log ORDER BY seq"
        )
    ]
    assert topics == ["outer", "inner"]


def test_nested_change_rolls_back_everything_when_the_inner_body_raises(
    core: Core,
) -> None:
    with pytest.raises(RuntimeError, match="inner boom"):
        _nested_failing_change(core)

    assert _event_count(core) == 0
    assert _scratch_count(core) == 0


def test_record_outside_a_change_opens_its_own_transaction(core: Core) -> None:
    core.record(core.bus.envelope("manual.topic", {"k": "v"}, subject=SUBJECT))
    assert _event_count(core) == 1
    row = core.db.connection.execute("SELECT topic FROM event_log").fetchone()
    assert row["topic"] == "manual.topic"


def test_record_joins_an_active_change(core: Core) -> None:
    """The sink must land in the caller's transaction, not in a second one."""
    with pytest.raises(RuntimeError, match="rollback both"):
        _record_then_fail(core)

    assert _event_count(core) == 0
    assert _scratch_count(core) == 0


def test_bus_recorded_hook_is_wired_to_the_database(core: Core) -> None:
    """Before assembly this hook was dangling: semantics right, nothing landed."""
    core.bus.recorded(core.bus.envelope("hooked", {}, subject=SUBJECT))
    assert _event_count(core) == 1


# --------------------------------------------------------------------------
# the bus the core hands out
# --------------------------------------------------------------------------


def test_core_emit_reaches_subscribers(core: Core) -> None:
    seen: list[str] = []
    core.bus.subscribe("t", lambda envelope: seen.append(envelope.topic))
    assert core.bus.emit("t", {}, subject=SUBJECT) == 1
    assert seen == ["t"]


def test_core_emit_with_no_listener_is_still_normal(core: Core) -> None:
    assert core.bus.emit("nobody.cares", {}, subject=SUBJECT) == 0


def test_core_invoke_without_a_provider_is_an_explicit_error(core: Core) -> None:
    reply = core.bus.invoke(Command(capability="missing", subject=SUBJECT, request={}))
    assert isinstance(reply, Err)
    assert reply.kind is ErrKind.NO_PROVIDER


def test_core_enforces_the_guard_on_the_call_plane(tmp_path: pathlib.Path) -> None:
    core = _new_core(tmp_path, guard=lambda _s, _a, _o: Decision.DENY)
    try:
        core.bus.provide("cap", lambda _c: Ok("done"))
        reply = core.bus.invoke(Command(capability="cap", subject=SUBJECT, request={}))
        assert isinstance(reply, Err)
        assert reply.kind is ErrKind.DENIED
    finally:
        core.close()


def test_core_allows_when_the_guard_says_allow(tmp_path: pathlib.Path) -> None:
    core = _new_core(tmp_path, guard=lambda _s, _a, _o: Decision.ALLOW)
    try:
        core.bus.provide("cap", lambda _c: Ok("done"))
        reply = core.bus.invoke(Command(capability="cap", subject=SUBJECT, request={}))
        assert isinstance(reply, Ok)
        assert reply.value == "done"
    finally:
        core.close()


def test_core_keeps_the_transport_it_was_given(tmp_path: pathlib.Path) -> None:
    transport = MemoryTransport()
    core = _new_core(tmp_path, transport=transport)
    try:
        assert core.bus.transport is transport
    finally:
        core.close()


# --------------------------------------------------------------------------
# assemble()
# --------------------------------------------------------------------------


def test_assemble_skips_the_config_binding_when_asked(tmp_path: pathlib.Path) -> None:
    core = assemble(tmp_path, bind_config=False)
    try:
        assert core.paths.database.is_file()
        assert core.db.current_version(KERNEL_SCHEMA) == SCHEMA_VERSION
    finally:
        core.close()


def test_assemble_wires_the_event_log_end_to_end(tmp_path: pathlib.Path) -> None:
    core = assemble(tmp_path, bind_config=False)
    try:
        with core.change("t", {"a": 1}, subject=SUBJECT) as tx:
            tx.execute("CREATE TABLE t (a INTEGER)")
        assert _event_count(core) == 1
    finally:
        core.close()


def test_assemble_keeps_the_transport_it_was_given(tmp_path: pathlib.Path) -> None:
    transport = MemoryTransport()
    core = assemble(tmp_path, bind_config=False, transport=transport)
    try:
        assert core.bus.transport is transport
    finally:
        core.close()


def test_assemble_binds_onconf_and_creates_the_database(tmp_path: pathlib.Path) -> None:
    """Runs in a subprocess: OnConf's engine cannot be rebound in-process."""
    result = _run(
        f"""
        import pathlib

        from lurnia.assembly import DATABASE_NAME, assemble
        from lurnia.core.conf import binding
        from lurnia.core.storage import KERNEL_SCHEMA, SCHEMA_VERSION

        home = pathlib.Path({str(tmp_path)!r})
        core = assemble(home)
        try:
            assert core.paths.database == home / DATABASE_NAME
            assert core.paths.database.is_file()
            assert core.db.current_version(KERNEL_SCHEMA) == SCHEMA_VERSION
        finally:
            core.close()
        assert binding().home == home.resolve(), "OnConf was not bound"
        """
    )
    assert result.returncode == 0, result.stderr


def test_assemble_uses_the_platform_default_when_home_is_omitted(
    tmp_path: pathlib.Path,
) -> None:
    result = _run(
        f"""
        import os, pathlib, sys

        sys.platform = "win32"
        os.environ["APPDATA"] = {str(tmp_path)!r}

        from lurnia.assembly import APP_DIR, assemble

        core = assemble()
        try:
            assert core.paths.home == pathlib.Path({str(tmp_path)!r}) / APP_DIR
            assert core.paths.database.is_file()
        finally:
            core.close()
        """
    )
    assert result.returncode == 0, result.stderr
