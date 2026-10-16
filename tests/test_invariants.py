# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""Executable conformance tests for the nine invariants.

``docs/design/invariants.md`` requires every invariant to be realized as an
executable test, not a sentence in a document. This module is that realization.

Static rules (I1, I2, I3, I7, I9) are delegated to :mod:`script.audit`, which is
also runnable as ``uv run python script/audit.py``. Runtime rules (I1, I2, I4,
I5, I6, I8, I9) are exercised against the real kernel modules below.
"""

from __future__ import annotations

import ast
import importlib.util
import inspect
import pathlib
import sqlite3
import subprocess
import sys
import types
from typing import TYPE_CHECKING, Any

import pytest

if TYPE_CHECKING:
    from lurnia.core.contracts import Command, EventEnvelope, Ok

ROOT = pathlib.Path(__file__).resolve().parent.parent
KERNEL = ROOT / "src" / "lurnia"
AUDIT_PATH = ROOT / "script" / "audit.py"


def _load(name: str, path: pathlib.Path) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def audit() -> Any:
    """The audit module, loaded by path (it is a script, not a package)."""
    return _load("lurnia_audit", AUDIT_PATH)


# --------------------------------------------------------------------------
# I1 — modules do not depend on each other
# --------------------------------------------------------------------------


def test_i1_no_cross_component_imports(audit: Any) -> None:
    assert audit.component_violations() == []


def test_i1_detector_catches_a_cross_component_import(
    audit: Any, tmp_path: pathlib.Path
) -> None:
    """The rule must actually fire, otherwise a green audit proves nothing."""
    root = tmp_path / "src" / "lurnia"
    for name, body in (
        ("notes", "from lurnia.components.projects import thing\n"),
        ("projects", "x = 1\n"),
    ):
        directory = root / "components" / name
        directory.mkdir(parents=True)
        (directory / "__init__.py").write_text(body, encoding="utf-8")
    violations = audit.component_violations(root)
    assert any("I1" in v and "notes" in v and "projects" in v for v in violations)


def test_i1_bus_proxy_counts_cross_module_calls() -> None:
    """The monitoring plane only tells the truth if every call goes through it."""
    from lurnia.core.bus import Bus
    from lurnia.core.contracts import Command, Ok, Subject

    bus = Bus()
    bus.provide("note.create", lambda _cmd: Ok(1))
    subject = Subject(id="local")
    assert bus.call_count == 0
    bus.invoke(Command(capability="note.create", subject=subject, request={}))
    assert bus.call_count == 1


# --------------------------------------------------------------------------
# I2 — one guard entry point, three states never collapsed to bool
# --------------------------------------------------------------------------


def test_i2_decision_is_not_boolean() -> None:
    from lurnia.core.contracts import Decision

    # Explicitly raising beats relying on default object truthiness: without
    # this, `if decision:` is True even for DENY.
    with pytest.raises(TypeError):
        bool(Decision.DENY)
    with pytest.raises(TypeError):
        bool(Decision.ALLOW)
    with pytest.raises(TypeError):
        bool(Decision.UNCERTAIN)
    assert Decision.DENY.__bool__ is not None


def test_i2_decision_members_are_not_int_enum() -> None:
    """An IntEnum whose DENY were 0 would make ``if decision:`` silently pass."""
    import enum

    from lurnia.core.contracts import Decision

    assert not issubclass(Decision, enum.IntEnum)
    assert not issubclass(Decision, enum.IntFlag)
    assert {d.name for d in Decision} == {"ALLOW", "DENY", "UNCERTAIN"}


def test_i2_detector_flags_a_bare_decision_test(audit: Any) -> None:
    tree = ast.parse("if decision:\n    pass\n")
    violations = audit._bool_context_violations(tree, pathlib.Path("x.py"))
    assert violations
    assert "I2" in violations[0]


def test_i2_detector_allows_explicit_comparison(audit: Any) -> None:
    """``decision is Decision.ALLOW`` is the sanctioned form."""
    tree = ast.parse("if decision is Decision.ALLOW:\n    pass\n")
    assert audit._bool_context_violations(tree, pathlib.Path("x.py")) == []


def test_i2_uncertain_falls_to_declared_default() -> None:
    from lurnia.core.bus import Bus, DefaultCriterion
    from lurnia.core.contracts import Command, Decision, Ok, Subject

    defaults = DefaultCriterion()
    defaults.declare("note", "create", Decision.ALLOW)
    bus = Bus(
        guard=lambda _s, _a, _o: Decision.UNCERTAIN,
        defaults=defaults,
    )
    bus.provide("note.create", lambda _cmd: Ok("created"))
    reply = bus.invoke(
        Command(capability="note.create", subject=Subject(id="local"), request={})
    )
    assert isinstance(reply, Ok)


def test_i2_uncertain_without_declaration_fails_closed() -> None:
    from lurnia.core.bus import Bus
    from lurnia.core.contracts import Command, Decision, Err, ErrKind, Ok, Subject

    bus = Bus(guard=lambda _s, _a, _o: Decision.UNCERTAIN)
    bus.provide("note.create", lambda _cmd: Ok("created"))
    reply = bus.invoke(
        Command(capability="note.create", subject=Subject(id="local"), request={})
    )
    assert isinstance(reply, Err)
    assert reply.kind is ErrKind.DENIED


def test_i2_default_criterion_rejects_uncertain_declaration() -> None:
    from lurnia.core.bus import DefaultCriterion
    from lurnia.core.contracts import Decision

    with pytest.raises(ValueError, match="默认值只能是"):
        DefaultCriterion().declare("note", "create", Decision.UNCERTAIN)


# --------------------------------------------------------------------------
# I3 — the four kernel layers are one-directional
# --------------------------------------------------------------------------


def test_i3_layers_are_one_directional(audit: Any) -> None:
    assert audit.layer_violations() == []


def test_i3_detector_catches_an_upward_import(
    audit: Any, tmp_path: pathlib.Path
) -> None:
    core = tmp_path / "src" / "lurnia" / "core"
    core.mkdir(parents=True)
    (core / "conf.py").write_text("from lurnia.core.bus import Bus\n", encoding="utf-8")
    violations = audit.layer_violations(tmp_path / "src" / "lurnia")
    assert any("I3" in v and "conf" in v and "bus" in v for v in violations)


def test_i3_contracts_is_not_a_layer() -> None:
    """The shared base may be used by every layer."""
    from lurnia.core import contracts  # noqa: F401


# --------------------------------------------------------------------------
# I4 — persisted structures carry a version and a migrate path
# --------------------------------------------------------------------------


def _create_note_table(conn: sqlite3.Connection) -> None:
    conn.execute("CREATE TABLE note (id TEXT)")


def _add_note_title(conn: sqlite3.Connection) -> None:
    conn.execute("ALTER TABLE note ADD COLUMN title TEXT")


def test_i4_migration_reaches_current_version(tmp_path: pathlib.Path) -> None:
    """A registered chain walks from its lowest version to its current one."""
    from lurnia.core.storage import Migration, open_db

    db = open_db(tmp_path / "t.db")
    try:
        db.register_migration("note", Migration(0, 1, _create_note_table))
        db.register_migration("note", Migration(1, 2, _add_note_title))
        assert db.current_version("note") == 0
        assert db.migrate("note", target=2) == 2
        assert db.current_version("note") == 2
        columns = [
            row[1]
            for row in db.connection.execute("PRAGMA table_info(note)").fetchall()
        ]
        assert "title" in columns, "每一步迁移都必须真的跑过"
    finally:
        db.close()


def test_i4_migration_is_idempotent(tmp_path: pathlib.Path) -> None:
    from lurnia.core.storage import Migration, open_db

    calls: list[int] = []
    db = open_db(tmp_path / "t.db")
    try:
        db.register_migration(
            "note",
            Migration(0, 1, lambda _conn: calls.append(1)),
        )
        db.migrate("note", target=1)
        db.migrate("note", target=1)
        assert calls == [1]
    finally:
        db.close()


def test_i4_missing_migration_is_an_error(tmp_path: pathlib.Path) -> None:
    from lurnia.core.storage import StorageError, open_db

    db = open_db(tmp_path / "t.db")
    try:
        with pytest.raises(StorageError, match="缺少"):
            db.migrate("note", target=1)
    finally:
        db.close()


def test_i4_non_consecutive_migration_is_rejected(tmp_path: pathlib.Path) -> None:
    from lurnia.core.storage import Migration, StorageError, open_db

    db = open_db(tmp_path / "t.db")
    try:
        with pytest.raises(StorageError, match="逐版本"):
            db.register_migration("note", Migration(0, 2, lambda _conn: None))
    finally:
        db.close()


def test_i4_downgrade_is_refused(tmp_path: pathlib.Path) -> None:
    from lurnia.core.storage import Migration, StorageError, open_db

    db = open_db(tmp_path / "t.db")
    try:
        db.register_migration("note", Migration(0, 1, lambda _conn: None))
        db.migrate("note", target=1)
        with pytest.raises(StorageError, match="拒绝降级"):
            db.migrate("note", target=0)
    finally:
        db.close()


# --------------------------------------------------------------------------
# I5 — event log is written before data, in one transaction
# --------------------------------------------------------------------------


def _envelope(topic: str = "note.created") -> EventEnvelope:
    from time import monotonic_ns

    from lurnia.core.contracts import EventEnvelope, Subject, wall_clock

    ts = monotonic_ns()
    return EventEnvelope(
        topic=topic,
        subject=Subject(id="local"),
        payload={"title": "t"},
        seq=1,
        ts_wall=wall_clock(ts),
        ts_mono=ts,
    )


def test_i5_event_and_data_commit_together(tmp_path: pathlib.Path) -> None:
    from lurnia.core.storage import append_event, open_db, read_events

    db = open_db(tmp_path / "t.db")
    try:
        with db.transaction() as conn:
            append_event(db, _envelope(), tx=conn)
            conn.execute("CREATE TABLE IF NOT EXISTS note (id TEXT)")
            conn.execute("INSERT INTO note VALUES ('n1')")
        assert len(read_events(db)) == 1
    finally:
        db.close()


def test_i5_crash_before_commit_leaves_no_event(tmp_path: pathlib.Path) -> None:
    """Fault injection: raise after the log append but before data lands."""
    from lurnia.core.storage import append_event, open_db, read_events

    def crash(conn: sqlite3.Connection) -> None:
        append_event(db, _envelope(), tx=conn)
        msg = "crash before data lands"
        raise RuntimeError(msg)

    db = open_db(tmp_path / "t.db")
    try:
        with (
            pytest.raises(RuntimeError, match="crash before data"),
            db.transaction() as conn,
        ):
            crash(conn)
        assert list(read_events(db)) == []
    finally:
        db.close()


def test_i5_event_survives_when_data_lands(tmp_path: pathlib.Path) -> None:
    """The positive half: after a clean commit the event is definitely there."""
    from lurnia.core.storage import append_event, open_db, read_events

    db = open_db(tmp_path / "t.db")
    try:
        with db.transaction() as conn:
            append_event(db, _envelope(), tx=conn)
            conn.execute("CREATE TABLE IF NOT EXISTS note (id TEXT)")
        events = read_events(db)
        assert len(events) == 1
        assert events[0]["topic"] == "note.created"
    finally:
        db.close()


# --------------------------------------------------------------------------
# I6 — every cross-module call carries a Subject
# --------------------------------------------------------------------------


def test_i6_command_requires_subject() -> None:
    from lurnia.core.contracts import Command

    with pytest.raises(TypeError):
        Command(capability="note.create", request={})  # type: ignore[call-arg]


def test_i6_envelope_requires_subject() -> None:
    from lurnia.core.contracts import EventEnvelope

    with pytest.raises(TypeError):
        EventEnvelope(topic="t", payload={})  # type: ignore[call-arg]


def test_i6_subject_travels_with_the_call() -> None:
    from lurnia.core.bus import Bus
    from lurnia.core.contracts import Command, Ok, Subject

    seen: list[Subject] = []

    def provider(cmd: Command[Any]) -> Ok[None]:
        seen.append(cmd.subject)
        return Ok(None)

    bus = Bus()
    bus.provide("note.create", provider)
    subject = Subject(id="local_user:1")
    bus.invoke(Command(capability="note.create", subject=subject, request={}))
    assert seen == [subject]


# --------------------------------------------------------------------------
# I7 — the kernel does not know the UI exists
# --------------------------------------------------------------------------


def test_i7_kernel_has_no_ui_concepts(audit: Any) -> None:
    """The kernel (``src/lurnia/core``) must not mention the UI at all."""
    assert audit.ui_violations() == []


def test_i7_detector_catches_a_ui_concept(audit: Any, tmp_path: pathlib.Path) -> None:
    core = tmp_path / "core"
    core.mkdir(parents=True)
    (core / "thing.py").write_text("# 渲染一张视图\n", encoding="utf-8")
    violations = audit.ui_violations(core)
    assert len(violations) >= 2


def audit_module() -> types.ModuleType:
    """The audit script loaded by path (it is a script, not a package module)."""
    return _load("lurnia_audit_scope", AUDIT_PATH)


def test_i7_scope_is_the_kernel_not_the_whole_package() -> None:
    """The scan stops at ``core/``; the sidecar binding may name its host.

    This is the boundary, and it is deliberate: invariant I8 says the envelope is
    a kernel asset while the transport is only a binding, so the binding layer
    naming its host is correct. Widening the rule to "nothing may mention the
    host" would make I7 mean something it does not.
    """
    module = audit_module()
    assert module.ui_violations.__defaults__ == (module.KERNEL_CORE,)
    assert module.KERNEL_CORE.name == "core"


# --------------------------------------------------------------------------
# I8 — the envelope belongs to the kernel; transport is only a binding
# --------------------------------------------------------------------------


def test_i8_envelope_round_trips_through_the_wire() -> None:
    from lurnia.core.contracts import EventEnvelope

    original = _envelope()
    restored = EventEnvelope.from_wire(original.to_wire())
    assert restored.id == original.id
    assert restored.topic == original.topic
    assert restored.subject == original.subject
    assert restored.payload == original.payload
    assert restored.version == original.version


def test_i8_protocol_tests_pass_on_a_second_transport() -> None:
    """Swap the transport; the envelope contract must be unaffected."""
    from lurnia.core.bus import Bus, MemoryTransport
    from lurnia.core.contracts import EventEnvelope, Subject

    transport = MemoryTransport()
    bus = Bus(transport=transport)
    subject = Subject(id="local")
    bus.emit("note.changed", {"id": "n1"}, subject=subject)

    drained = transport.drain()
    assert len(drained) == 1
    restored = EventEnvelope.from_wire(drained[0])
    assert restored.topic == "note.changed"
    assert restored.subject == subject


def test_i8_forwarding_does_not_renumber() -> None:
    from lurnia.core.bus import Bus

    received: list[EventEnvelope] = []
    bus = Bus()
    bus.subscribe("note.changed", received.append)
    envelope = _envelope("note.changed")
    bus.emit_envelope(envelope)
    assert received
    assert received[0].seq == envelope.seq


# --------------------------------------------------------------------------
# I9 — the APP performs no unauthorized outward action
# --------------------------------------------------------------------------


def test_i9_kernel_reaches_nothing_outward(audit: Any) -> None:
    assert audit.unauthorized_violations() == []


def test_i9_detector_catches_a_subprocess_import(
    audit: Any, tmp_path: pathlib.Path
) -> None:
    root = tmp_path / "src" / "lurnia"
    core = root / "core"
    core.mkdir(parents=True)
    (core / "bad.py").write_text("import subprocess\n", encoding="utf-8")
    violations = audit.unauthorized_violations(root)
    assert any("I9" in v and "subprocess" in v for v in violations)


def test_i9_importing_the_kernel_opens_no_listening_socket() -> None:
    """Importing the whole kernel must not create a socket (invariant I9).

    ``socket.socket`` is booby-trapped for the duration of the import: creating
    one fails the test rather than merely being noticed afterwards.
    """
    code = (
        "import socket, sys\n"
        "def _forbidden(*a, **k):\n"
        "    raise AssertionError('kernel created a socket during import')\n"
        "socket.socket = _forbidden\n"
        "socket.create_connection = _forbidden\n"
        "socket.create_server = _forbidden\n"
        "import lurnia.core.bus, lurnia.core.conf\n"
        "import lurnia.core.log, lurnia.core.storage\n"
        "sys.exit(0)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        check=False,
        cwd=ROOT,
    )
    assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")


def test_i9_kernel_import_does_not_spawn_a_process() -> None:
    """Import closure purity: no subprocess module in the kernel's import graph."""
    for path in KERNEL.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert "import subprocess" not in text
        assert "os.system" not in text
        assert "os.popen" not in text


def test_i9_kernel_never_calls_webbrowser() -> None:
    assert "webbrowser" not in inspect.getsource(
        sys.modules["lurnia.core.bus"]
        if "lurnia.core.bus" in sys.modules
        else __import__("lurnia.core.bus", fromlist=["bus"])
    )
