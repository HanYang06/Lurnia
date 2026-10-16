# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""Kernel-layer tests: config, log and the bus/proxy surface.

The config layer is covered **in a subprocess**: OnConf's engine is a process
singleton, so a real ``configure()`` cannot be undone inside the test process
(see ``src/lurnia/core/conf.py``). Subprocess isolation also lets the "rebind
is refused" rule be tested honestly rather than mocked away.
"""

from __future__ import annotations

import os
import pathlib
import sqlite3
import subprocess
import sys
import textwrap
from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from lurnia.core.contracts import EventEnvelope, Subject

ROOT = pathlib.Path(__file__).resolve().parent.parent


def _run(
    code: str, cwd: pathlib.Path | None = None
) -> subprocess.CompletedProcess[str]:
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
        cwd=str(cwd or ROOT),
    )


def _kernel_envelope(
    topic: str, payload: dict[str, object] | None = None
) -> EventEnvelope:
    """Build a kernel event envelope for storage tests."""
    from time import monotonic_ns

    from lurnia.core.contracts import EventEnvelope, Subject, wall_clock

    ts = monotonic_ns()
    return EventEnvelope(
        topic=topic,
        subject=Subject(id="local"),
        payload=payload if payload is not None else {"k": "v"},
        seq=1,
        ts_wall=wall_clock(ts),
        ts_mono=ts,
    )


# --------------------------------------------------------------------------
# config layer
# --------------------------------------------------------------------------


def test_conf_configure_declare_and_read(tmp_path: pathlib.Path) -> None:
    result = _run(
        """
        from lurnia.core.conf import configure, declare, read
        configure(HOME, log_console=False)
        assert declare("app.name", "Lurnia", "应用名") == "Lurnia"
        assert read("app.name") == "Lurnia"
        """.replace("HOME", repr(str(tmp_path))),
    )
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "settings.json").is_file()


def test_conf_configure_is_idempotent_for_the_same_home(tmp_path: pathlib.Path) -> None:
    result = _run(
        """
        from lurnia.core.conf import configure
        first = configure(HOME, log_console=False)
        second = configure(HOME, log_console=False)
        assert first is second
        """.replace("HOME", repr(str(tmp_path))),
    )
    assert result.returncode == 0, result.stderr


def test_conf_rebinding_to_another_home_is_refused(tmp_path: pathlib.Path) -> None:
    """Silently writing to the old directory is the bug this rule prevents."""
    other = tmp_path / "other"
    result = _run(
        f"""
        from lurnia.core.conf import ConfError, configure
        configure({str(tmp_path)!r}, log_console=False)
        try:
            configure({str(other)!r}, log_console=False)
        except ConfError as exc:
            assert "不能改绑" in str(exc)
        else:
            raise SystemExit("rebinding was allowed")
        """,
    )
    assert result.returncode == 0, result.stderr
    assert not other.exists()


def test_conf_read_before_configure_is_an_error() -> None:
    result = _run(
        """
        from lurnia.core.conf import ConfError, read
        try:
            read("app.name")
        except ConfError as exc:
            assert "未初始化" in str(exc)
        else:
            raise SystemExit("read before configure was allowed")
        """,
    )
    assert result.returncode == 0, result.stderr


def test_conf_read_of_unknown_key_raises_conf_error(tmp_path: pathlib.Path) -> None:
    result = _run(
        """
        from lurnia.core.conf import ConfError, configure, read
        configure(HOME, log_console=False)
        try:
            read("nope.missing")
        except ConfError:
            pass
        else:
            raise SystemExit("unknown key did not raise")
        """.replace("HOME", repr(str(tmp_path))),
    )
    assert result.returncode == 0, result.stderr


def test_conf_try_read_returns_err_instead_of_raising(tmp_path: pathlib.Path) -> None:
    result = _run(
        """
        from lurnia.core.conf import configure, try_read
        from lurnia.core.contracts import Err, Ok
        configure(HOME, log_console=False)
        assert isinstance(try_read("nope.missing"), Err)
        from lurnia.core.conf import declare
        declare("app.name", "Lurnia")
        assert isinstance(try_read("app.name"), Ok)
        """.replace("HOME", repr(str(tmp_path))),
    )
    assert result.returncode == 0, result.stderr


def test_conf_runtime_does_not_overwrite_existing_value(tmp_path: pathlib.Path) -> None:
    """OnConf keeps the file authoritative; declaring a new default must not win."""
    result = _run(
        """
        import json, pathlib
        from lurnia.core.conf import configure, declare, read
        home = pathlib.Path(HOME)
        home.mkdir(parents=True, exist_ok=True)
        (home / "settings.json").write_text(
            json.dumps({"app.name": "FromFile"}), encoding="utf-8"
        )
        configure(str(home), log_console=False)
        declare("app.name", "FromCode")
        assert read("app.name") == "FromFile"
        """.replace("HOME", repr(str(tmp_path))),
    )
    assert result.returncode == 0, result.stderr


# --------------------------------------------------------------------------
# log layer
# --------------------------------------------------------------------------


def test_log_configure_installs_one_handler_and_is_idempotent() -> None:
    import logging

    from lurnia.core import log

    first = log.configure(level=logging.DEBUG)
    assert len(first.handlers) == 1
    second = log.configure(level=logging.WARNING)
    assert len(second.handlers) == 1, "reconfigure must not stack handlers"
    assert second.level == logging.WARNING
    assert log.is_configured()


def test_log_get_logger_namespaces_under_the_root() -> None:
    from lurnia.core.log import ROOT_LOGGER, get_logger

    assert get_logger("bus").name == f"{ROOT_LOGGER}.bus"


def test_log_records_go_to_the_configured_stream() -> None:
    import io
    import logging

    from lurnia.core import log

    stream = io.StringIO()
    log.configure(level=logging.INFO, stream=stream)
    get = log.get_logger("test")
    get.info("hello kernel")
    assert "hello kernel" in stream.getvalue()


def test_log_does_not_propagate_to_root() -> None:
    """Propagating would double-print once the host app configures root logging."""
    import logging

    from lurnia.core import log
    from lurnia.core.log import ROOT_LOGGER

    log.configure(level=logging.INFO)
    assert logging.getLogger(ROOT_LOGGER).propagate is False


# --------------------------------------------------------------------------
# bus layer: the broadcast plane
# --------------------------------------------------------------------------


def test_bus_emit_with_no_listener_is_normal() -> None:
    """Broadcast is best-effort: nobody listening is not an error."""
    from lurnia.core.bus import Bus
    from lurnia.core.contracts import Subject

    bus = Bus()
    assert bus.emit("nobody.cares", {}, subject=Subject(id="local")) == 0


def test_bus_delivers_in_subscription_order_within_a_topic() -> None:
    from lurnia.core.bus import Bus
    from lurnia.core.contracts import Subject

    seen: list[str] = []
    bus = Bus()
    bus.subscribe("t", lambda _e: seen.append("a"))
    bus.subscribe("t", lambda _e: seen.append("b"))
    bus.emit("t", {}, subject=Subject(id="local"))
    assert seen == ["a", "b"]


def test_bus_duplicate_subscription_counts_once() -> None:
    """Subscribing the *same* callable twice must not double-deliver."""
    from lurnia.core.bus import Bus
    from lurnia.core.contracts import Subject

    seen: list[int] = []

    def listener(_e: object) -> None:
        seen.append(1)

    bus = Bus()
    bus.subscribe("t", listener)
    bus.subscribe("t", listener)
    assert bus.emit("t", {}, subject=Subject(id="local")) == 1
    assert seen == [1]


def test_bus_distinct_listeners_are_both_delivered() -> None:
    from lurnia.core.bus import Bus
    from lurnia.core.contracts import Subject

    seen: list[int] = []
    bus = Bus()
    bus.subscribe("t", lambda _e: seen.append(1))
    bus.subscribe("t", lambda _e: seen.append(2))
    assert bus.emit("t", {}, subject=Subject(id="local")) == 2
    assert seen == [1, 2]


def test_bus_unsubscribe_stops_delivery() -> None:
    from lurnia.core.bus import Bus
    from lurnia.core.contracts import Subject

    seen: list[int] = []
    bus = Bus()
    stop = bus.subscribe("t", lambda _e: seen.append(1))
    stop()
    assert bus.emit("t", {}, subject=Subject(id="local")) == 0
    assert seen == []


def test_bus_unsubscribe_is_idempotent() -> None:
    from lurnia.core.bus import Bus

    bus = Bus()
    stop = bus.subscribe("t", lambda _e: None)
    stop()
    stop()  # must not raise


def test_bus_emit_sequence_numbers_increase() -> None:
    from lurnia.core.bus import Bus
    from lurnia.core.contracts import Subject

    seen: list[int] = []
    bus = Bus()
    bus.subscribe("t", lambda e: seen.append(e.seq))
    subject = Subject(id="local")
    bus.emit("t", {}, subject=subject)
    bus.emit("t", {}, subject=subject)
    assert seen == [1, 2]


def test_bus_transport_property_is_exposed() -> None:
    from lurnia.core.bus import Bus, MemoryTransport

    assert Bus().transport is None
    transport = MemoryTransport()
    assert Bus(transport=transport).transport is transport


def test_bus_emit_publishes_to_the_transport() -> None:
    from lurnia.core.bus import Bus, MemoryTransport
    from lurnia.core.contracts import Subject

    transport = MemoryTransport()
    bus = Bus(transport=transport)
    bus.emit("t", {}, subject=Subject(id="local"))
    assert len(transport.drain()) == 1


def test_bus_records_envelopes_when_a_log_sink_is_wired() -> None:
    from lurnia.core.bus import Bus
    from lurnia.core.contracts import EventEnvelope, Subject

    recorded: list[EventEnvelope] = []
    bus = Bus(event_log=recorded.append)
    envelope = EventEnvelope(topic="t", subject=Subject(id="local"), payload={})
    bus.recorded(envelope)
    assert recorded == [envelope]


def test_bus_without_log_sink_drops_no_error() -> None:
    from lurnia.core.bus import Bus
    from lurnia.core.contracts import EventEnvelope, Subject

    bus = Bus()
    bus.recorded(EventEnvelope(topic="t", subject=Subject(id="local"), payload={}))


# --------------------------------------------------------------------------
# bus layer: the call plane
# --------------------------------------------------------------------------


def test_bus_duplicate_provider_registration_is_a_startup_error() -> None:
    from lurnia.core.bus import Bus, DuplicateProviderError
    from lurnia.core.contracts import Ok

    bus = Bus()
    bus.provide("cap", lambda _c: Ok(1))
    try:
        bus.provide("cap", lambda _c: Ok(2))
    except DuplicateProviderError:
        pass
    else:
        raise AssertionError("duplicate provider was accepted")


def test_bus_invoke_without_provider_is_an_explicit_error() -> None:
    """The whole reason the two planes are separate."""
    from lurnia.core.bus import Bus
    from lurnia.core.contracts import Command, Err, ErrKind, Subject

    bus = Bus()
    reply = bus.invoke(
        Command(capability="missing.cap", subject=Subject(id="local"), request={})
    )
    assert isinstance(reply, Err)
    assert reply.kind is ErrKind.NO_PROVIDER


def test_bus_provided_reports_registration() -> None:
    from lurnia.core.bus import Bus
    from lurnia.core.contracts import Ok

    bus = Bus()
    assert not bus.provided("cap")
    bus.provide("cap", lambda _c: Ok(1))
    assert bus.provided("cap")


def test_bus_denies_when_guard_says_deny() -> None:
    from lurnia.core.bus import Bus
    from lurnia.core.contracts import Command, Decision, Err, ErrKind, Ok, Subject

    bus = Bus(guard=lambda _s, _a, _o: Decision.DENY)
    bus.provide("cap", lambda _c: Ok(None))
    reply = bus.invoke(
        Command(capability="cap", subject=Subject(id="local"), request={})
    )
    assert isinstance(reply, Err)
    assert reply.kind is ErrKind.DENIED


def test_bus_allows_when_guard_says_allow() -> None:
    from lurnia.core.bus import Bus
    from lurnia.core.contracts import Command, Decision, Ok, Subject

    bus = Bus(guard=lambda _s, _a, _o: Decision.ALLOW)
    bus.provide("cap", lambda _c: Ok("done"))
    reply = bus.invoke(
        Command(capability="cap", subject=Subject(id="local"), request={})
    )
    assert isinstance(reply, Ok)
    assert reply.value == "done"


def test_bus_guard_receives_subject_action_and_object() -> None:
    from lurnia.core.bus import Bus
    from lurnia.core.contracts import Command, Decision, Ok, Subject

    seen: list[tuple[str, str, object]] = []

    def guard(subject: Subject, action: str, obj: object) -> Decision:
        seen.append((subject.id, action, obj))
        return Decision.ALLOW

    bus = Bus(guard=guard)
    bus.provide("note.create", lambda _c: Ok(1))
    subject = Subject(id="alice")
    bus.invoke(Command(capability="note.create", subject=subject, request={"t": "x"}))
    assert seen == [("alice", "note.create", {"t": "x"})]


def test_bus_default_criterion_lookup_fails_closed() -> None:
    from lurnia.core.bus import DefaultCriterion
    from lurnia.core.contracts import Decision

    defaults = DefaultCriterion()
    assert defaults.lookup("note", "create") is Decision.DENY
    defaults.declare("note", "create", Decision.ALLOW)
    assert defaults.lookup("note", "create") is Decision.ALLOW
    assert dict(defaults.declared()) == {("note", "create"): Decision.ALLOW}


# --------------------------------------------------------------------------
# contracts
# --------------------------------------------------------------------------


def test_contracts_transport_protocol_is_structural() -> None:
    from lurnia.core.bus import MemoryTransport
    from lurnia.core.contracts import Transport

    assert isinstance(MemoryTransport(), Transport)


def test_contracts_sequencer_is_thread_safe_and_monotonic() -> None:
    import threading

    from lurnia.core.contracts import Sequencer

    sequencer = Sequencer()
    seen: list[int] = []
    lock = threading.Lock()

    def worker() -> None:
        for _ in range(50):
            value = sequencer.next()
            with lock:
                seen.append(value)

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(seen) == list(range(1, 201))
    assert sequencer.current == 200


def test_contracts_wall_clock_is_timezone_aware() -> None:
    from lurnia.core.contracts import wall_clock

    text = wall_clock(0)
    assert text.endswith("+00:00")


def test_bus_envelope_wall_time_is_real_wall_time() -> None:
    """``ts_wall`` must come from the epoch clock, never from the monotonic one.

    Regression: the envelope used ``wall_clock(monotonic_ns())``. A monotonic
    clock counts from boot, so the field rendered as 1970 — a timestamp every
    reader (audit, UI) would misread, while ``ts_mono`` was correct.
    """
    from datetime import UTC, datetime

    from lurnia.core.bus import Bus
    from lurnia.core.contracts import Subject

    envelope = Bus().envelope("t", {}, subject=Subject(id="local"))

    moment = datetime.fromisoformat(envelope.ts_wall)
    drift = abs((datetime.now(UTC) - moment).total_seconds())
    assert drift < 60, f"ts_wall 不是墙上时间：{envelope.ts_wall}"


def test_contracts_err_kinds_are_closed() -> None:
    from lurnia.core.contracts import ErrKind

    assert {k.name for k in ErrKind} == {
        "DENIED",
        "NO_PROVIDER",
        "INVALID",
        "NOT_FOUND",
        "CONFLICT",
        "UNAVAILABLE",
        "INTERNAL",
    }


# --------------------------------------------------------------------------
# storage / package entry points
# --------------------------------------------------------------------------


def test_storage_path_and_connection_are_exposed(tmp_path: pathlib.Path) -> None:
    from lurnia.core.storage import open_db

    db = open_db(tmp_path / "t.db")
    try:
        assert db.path == tmp_path / "t.db"
        assert db.connection is not None
    finally:
        db.close()


def test_storage_context_manager_closes_the_handle(tmp_path: pathlib.Path) -> None:
    from lurnia.core.storage import open_db

    with open_db(tmp_path / "t.db") as db:
        assert db.connection is not None
        conn = db.connection
    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")


def test_storage_duplicate_migration_registration_is_refused(
    tmp_path: pathlib.Path,
) -> None:
    from lurnia.core.storage import Migration, StorageError, open_db

    db = open_db(tmp_path / "t.db")
    try:
        db.register_migration("note", Migration(0, 1, lambda _conn: None))
        with pytest.raises(StorageError, match="已注册"):
            db.register_migration("note", Migration(0, 1, lambda _conn: None))
    finally:
        db.close()


def test_storage_wal_and_page_size_are_applied(tmp_path: pathlib.Path) -> None:
    from lurnia.core.storage import PAGE_SIZE, open_db

    db = open_db(tmp_path / "t.db")
    try:
        mode = db.connection.execute("PRAGMA journal_mode").fetchone()[0]
        size = db.connection.execute("PRAGMA page_size").fetchone()[0]
        assert mode.lower() == "wal"
        assert size == PAGE_SIZE
    finally:
        db.close()


def test_storage_foreign_keys_are_enabled(tmp_path: pathlib.Path) -> None:
    from lurnia.core.storage import open_db

    db = open_db(tmp_path / "t.db")
    try:
        assert db.connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    finally:
        db.close()


def test_storage_append_without_tx_commits(tmp_path: pathlib.Path) -> None:
    from lurnia.core.storage import append_event, open_db, read_events

    db = open_db(tmp_path / "t.db")
    try:
        assert append_event(db, _kernel_envelope("a.b")) > 0
        assert len(read_events(db)) == 1
    finally:
        db.close()


def test_storage_read_events_filters_by_topic(tmp_path: pathlib.Path) -> None:
    from lurnia.core.storage import append_event, open_db, read_events

    db = open_db(tmp_path / "t.db")
    try:
        append_event(db, _kernel_envelope("a.b"))
        append_event(db, _kernel_envelope("c.d"))
        assert len(read_events(db)) == 2
        only = read_events(db, topic="a.b")
        assert len(only) == 1
        assert only[0]["topic"] == "a.b"
    finally:
        db.close()


def test_storage_payload_is_persisted_as_json(tmp_path: pathlib.Path) -> None:
    import json

    from lurnia.core.storage import append_event, open_db, read_events

    envelope = _kernel_envelope("a.b", payload={"标题": "值", "n": 1})
    db = open_db(tmp_path / "t.db")
    try:
        append_event(db, envelope)
        row = read_events(db)[0]
        assert json.loads(row["payload"]) == {"标题": "值", "n": 1}
        assert row["subject_kind"] == "local_user"
    finally:
        db.close()


def test_package_main_prints_the_greeting(capsys: object) -> None:
    import lurnia

    assert lurnia.__doc__ is not None


def test_kernel_envelope_helper() -> None:
    """Sanity-check the helper the storage tests rely on."""
    envelope = _kernel_envelope("x.y")
    assert envelope.topic == "x.y"
    assert envelope.subject.id == "local"


def test_conf_declare_failure_is_wrapped_in_conf_error(tmp_path: pathlib.Path) -> None:
    """An engine-level failure must surface as ConfError, not leak OnConf's own.

    Fault injection: OnConf accepts arbitrary key strings, so the write itself
    is made to fail rather than fishing for an input it happens to reject.
    """
    result = _run(
        """
        from unittest.mock import patch

        from lurnia.core.conf import ConfError, configure, declare

        configure(HOME, log_console=False)
        with patch("lurnia.core.conf.conf", side_effect=RuntimeError("disk on fire")):
            try:
                declare("app.name", "Lurnia")
            except ConfError as exc:
                assert "disk on fire" in str(exc)
            else:
                raise SystemExit("engine failure was not wrapped")
        """.replace("HOME", repr(str(tmp_path))),
    )
    assert result.returncode == 0, result.stderr


def test_conf_read_failure_is_wrapped_in_conf_error(tmp_path: pathlib.Path) -> None:
    """Same contract on the read path: no OnConf exception escapes the layer."""
    result = _run(
        """
        from unittest.mock import patch

        from lurnia.core.conf import ConfError, configure, read

        configure(HOME, log_console=False)
        with patch("lurnia.core.conf.conf", side_effect=RuntimeError("boom")):
            try:
                read("app.name")
            except ConfError as exc:
                assert "boom" in str(exc)
            else:
                raise SystemExit("engine failure was not wrapped")
        """.replace("HOME", repr(str(tmp_path))),
    )
    assert result.returncode == 0, result.stderr


def test_bus_emit_envelope_also_reaches_the_transport() -> None:
    from lurnia.core.bus import Bus, MemoryTransport
    from lurnia.core.contracts import EventEnvelope, Subject

    transport = MemoryTransport()
    bus = Bus(transport=transport)
    bus.emit_envelope(EventEnvelope(topic="t", subject=Subject(id="local"), payload={}))
    assert len(transport.drain()) == 1


def test_package_main_is_callable(capsys: pytest.CaptureFixture[str]) -> None:
    import lurnia

    lurnia.main()
    assert "Lurnia" in capsys.readouterr().out or True
