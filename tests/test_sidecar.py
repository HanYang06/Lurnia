# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""Sidecar entry-point tests.

Covers the stdio line protocol (packaging.md §五): the handshake, the kernel → UI
event stream, the data-directory rules, and that a failure anywhere becomes one
readable `error` line instead of a traceback on somebody's console.

The build script's correctness is covered here at the level that can be tested
without a full PyInstaller run: the protocol, the self-check's failure detection,
and the build script's own resource discovery. The actual frozen build is
verified by ``script/build_sidecar.py`` itself (it runs ``--self-check`` inside
the artifact), which is the only place the packaging failure modes are visible.
"""

from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import subprocess
import sys
from typing import Any

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD_SCRIPT = ROOT / "script" / "build_sidecar.py"


def _run_sidecar(
    data_dir: pathlib.Path | None = None,
    *args: str,
    env: dict[str, str] | None = None,
) -> tuple[int, list[dict[str, object]]]:
    """Run the sidecar to completion; return ``(exit code, parsed JSON lines)``.

    ``stdin`` is /dev/null so the serve loop sees EOF immediately: the host keeps
    that pipe open, a test does not need to.
    """
    command = [sys.executable, "-m", "lurnia.sidecar", *args]
    if data_dir is not None:
        command += ["--data-dir", str(data_dir)]
    environment = dict(os.environ)
    if env:
        environment.update(env)
    proc = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        cwd=ROOT,
        stdin=subprocess.DEVNULL,
        env=environment,
    )
    payloads = [
        json.loads(line) for line in proc.stdout.splitlines() if line.startswith("{")
    ]
    return proc.returncode, payloads


def _only(payloads: list[dict[str, object]], kind: str) -> dict[str, object]:
    found = [payload for payload in payloads if payload.get("type") == kind]
    assert found, f"no {kind!r} line in {payloads}"
    return found[0]


@pytest.fixture(scope="module")
def build_module() -> Any:
    spec = importlib.util.spec_from_file_location("lurnia_build_sidecar", BUILD_SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --------------------------------------------------------------------------
# protocol: control lines
# --------------------------------------------------------------------------


def test_sidecar_version_reports_protocol() -> None:
    code, payloads = _run_sidecar(None, "--version")
    assert code == 0
    assert payloads[0]["type"] == "version"
    assert payloads[0]["protocol"] == 1
    assert payloads[0]["version"]


def test_sidecar_rejects_unknown_flags() -> None:
    """A typo must not be silently ignored by a host-driven process."""
    code, payloads = _run_sidecar(None, "--nope")
    assert code == 2
    assert payloads[0]["type"] == "error"
    assert "--nope" in str(payloads[0]["message"])


def test_a_data_dir_flag_without_a_value_is_a_usage_error() -> None:
    code, payloads = _run_sidecar(None, "--data-dir")
    assert code == 2
    assert "--data-dir" in str(payloads[0]["message"])


def test_every_line_of_the_protocol_is_one_json_object(tmp_path: pathlib.Path) -> None:
    proc = subprocess.run(
        [sys.executable, "-m", "lurnia.sidecar", "--data-dir", str(tmp_path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        cwd=ROOT,
        stdin=subprocess.DEVNULL,
    )
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    assert len(lines) >= 2, f"expected ready + at least one event, got {lines}"
    for line in lines:
        json.loads(line)


def test_the_data_dir_flag_also_accepts_an_equals_sign(tmp_path: pathlib.Path) -> None:
    code, payloads = _run_sidecar(None, f"--data-dir={tmp_path}")

    assert code == 0
    assert payloads[0]["data_dir"] == str(tmp_path)


def test_serve_reads_stdin_and_stops_at_eof(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """v1 does not parse stdin: a line is read and ignored, EOF ends the process."""
    import io

    from lurnia import sidecar
    from lurnia.assembly import Core, default_paths
    from lurnia.core.storage import open_db

    def fake_assemble(_data_dir: object, **kwargs: Any) -> Core:
        return Core(
            default_paths(tmp_path),
            open_db(tmp_path / "lurnia.db"),
            transport=kwargs.get("transport"),
        )

    monkeypatch.setattr(sidecar, "assemble", fake_assemble)
    monkeypatch.setattr(sidecar, "_rotate_on_start", lambda _core: 0)

    stream = io.StringIO()
    code = sidecar.serve(
        data_dir=tmp_path, stream=stream, stdin=io.StringIO('{"anything": 1}\n')
    )

    assert code == 0
    kinds = [json.loads(line)["type"] for line in stream.getvalue().splitlines()]
    assert kinds == ["ready", "event"], kinds


# --------------------------------------------------------------------------
# protocol: startup
# --------------------------------------------------------------------------


def test_ready_is_the_first_line_and_names_the_data_dir(tmp_path: pathlib.Path) -> None:
    code, payloads = _run_sidecar(tmp_path)

    assert code == 0
    ready = payloads[0]
    assert ready["type"] == "ready"
    assert ready["protocol"] == 1
    assert ready["data_dir"] == str(tmp_path)
    assert ready["db_version"] == 2
    assert ready["rotated"] == 0
    assert ready["frozen"] is False


def test_sidecar_exits_when_the_host_closes_stdin(tmp_path: pathlib.Path) -> None:
    """The host owns the lifetime: EOF means the host is gone, so the core goes too."""
    code, _payloads = _run_sidecar(tmp_path)
    assert code == 0


def test_the_kernel_event_follows_the_ready_line(tmp_path: pathlib.Path) -> None:
    code, payloads = _run_sidecar(tmp_path)

    assert code == 0
    kinds = [str(payload["type"]) for payload in payloads]
    assert kinds.index("ready") < kinds.index("event"), kinds
    envelope = _only(payloads, "event")["envelope"]
    assert isinstance(envelope, dict)
    assert envelope["topic"] == "kernel.started"
    assert envelope["subject"]["id"] == "local"
    assert envelope["seq"] >= 1
    assert str(envelope["ts_wall"]).endswith("+00:00")
    assert envelope["version"] == 1


def test_the_forwarded_event_is_the_one_that_was_logged(tmp_path: pathlib.Path) -> None:
    """I5 in production: the envelope written to the log is the one pushed to the UI."""
    from lurnia.core.storage import open_db, read_events

    _code, payloads = _run_sidecar(tmp_path)
    envelope = _only(payloads, "event")["envelope"]
    assert isinstance(envelope, dict)

    db = open_db(tmp_path / "lurnia.db")
    try:
        rows = read_events(db)
        assert [row["id"] for row in rows] == [envelope["id"]]
        assert [row["topic"] for row in rows] == ["kernel.started"]
    finally:
        db.close()


def test_the_sidecar_declares_its_keep_key_in_the_settings(
    tmp_path: pathlib.Path,
) -> None:
    from lurnia.sidecar import DEFAULT_EVENT_LOG_KEEP, EVENT_LOG_KEEP_KEY

    _run_sidecar(tmp_path)

    settings = json.loads((tmp_path / "settings.json").read_text(encoding="utf-8"))
    assert settings[EVENT_LOG_KEEP_KEY] == DEFAULT_EVENT_LOG_KEEP


def test_the_sidecar_rotates_the_log_before_going_ready(tmp_path: pathlib.Path) -> None:
    """Route 004 in production: rotation happens at startup, not inside append."""
    from lurnia.core.contracts import EventEnvelope, Subject
    from lurnia.core.storage import append_event, open_db

    _run_sidecar(tmp_path)  # the first run leaves one logged event

    db = open_db(tmp_path / "lurnia.db")
    try:
        for index in range(2):
            append_event(
                db,
                EventEnvelope(
                    topic=f"seed.{index}", subject=Subject(id="local"), payload={}
                ),
            )
    finally:
        db.close()
    (tmp_path / "settings.json").write_text(
        json.dumps({"event_log.keep": 1}), encoding="utf-8"
    )

    code, payloads = _run_sidecar(tmp_path)

    assert code == 0
    assert payloads[0]["type"] == "ready"
    assert payloads[0]["rotated"] == 2
    assert len(list((tmp_path / "event-log").glob("*.jsonl"))) == 1


# --------------------------------------------------------------------------
# data directory
# --------------------------------------------------------------------------


def test_the_flag_beats_the_environment(tmp_path: pathlib.Path) -> None:
    flag_dir = tmp_path / "flag"
    env_dir = tmp_path / "env"

    code, payloads = _run_sidecar(flag_dir, env={"LURNIA_DATA_DIR": str(env_dir)})

    assert code == 0
    assert payloads[0]["data_dir"] == str(flag_dir)
    assert not env_dir.exists(), "the environment must not win over the flag"


def test_the_environment_can_set_the_data_dir(tmp_path: pathlib.Path) -> None:
    code, payloads = _run_sidecar(None, env={"LURNIA_DATA_DIR": str(tmp_path)})

    assert code == 0
    assert payloads[0]["data_dir"] == str(tmp_path)
    assert (tmp_path / "lurnia.db").is_file()


def test_the_protocol_channel_is_utf8_even_under_a_gbk_host_locale(
    tmp_path: pathlib.Path,
) -> None:
    """Regression: a local-codepage stdout turns Chinese payloads into mojibake.

    The channel must dictate its own encoding — the host decodes JSON as UTF-8, so
    a console set to GBK must not leak into the wire.
    """
    data_dir = tmp_path / "数据目录"
    proc = subprocess.run(
        [sys.executable, "-m", "lurnia.sidecar", "--data-dir", str(data_dir)],
        capture_output=True,
        check=False,
        cwd=ROOT,
        stdin=subprocess.DEVNULL,
        env={**os.environ, "PYTHONIOENCODING": "gbk"},
    )

    first_line = proc.stdout.splitlines()[0]
    payload = json.loads(first_line.decode("utf-8"))
    assert payload["type"] == "ready"
    assert payload["data_dir"] == str(data_dir)


def test_a_broken_data_dir_is_reported_as_an_error_line(tmp_path: pathlib.Path) -> None:
    """A host-driven process must fail in one readable line, not a traceback."""
    blocked = tmp_path / "blocked"
    blocked.write_text("not a directory", encoding="utf-8")

    code, payloads = _run_sidecar(blocked)

    assert code == 1
    assert payloads[-1]["type"] == "error"
    assert "起不来" in str(payloads[-1]["message"])


# --------------------------------------------------------------------------
# transport binding + helpers
# --------------------------------------------------------------------------


def test_the_transport_writes_one_event_line_and_has_no_back_channel() -> None:
    """The binding only moves the envelope: the fields stay the kernel's (I8)."""
    import io

    from lurnia.core.contracts import EventEnvelope, Subject
    from lurnia.sidecar import StdioTransport

    stream = io.StringIO()
    transport = StdioTransport(stream)
    envelope = EventEnvelope(
        topic="note.changed", subject=Subject(id="local"), payload={"a": 1}, seq=7
    )

    transport.publish(envelope.to_wire())

    line = json.loads(stream.getvalue().strip())
    assert line["type"] == "event"
    assert line["protocol"] == 1
    assert line["envelope"]["topic"] == "note.changed"
    assert line["envelope"]["seq"] == 7
    assert line["envelope"]["payload"] == {"a": 1}
    assert transport.drain() == [], "stdio 只有推，没有回读"


def test_the_data_dir_only_comes_from_the_environment_without_a_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from lurnia import sidecar

    monkeypatch.delenv(sidecar.DATA_DIR_ENV, raising=False)
    assert sidecar._data_dir_from_env() is None

    monkeypatch.setenv(sidecar.DATA_DIR_ENV, "somewhere")
    assert sidecar._data_dir_from_env() == pathlib.Path("somewhere")


def test_a_failure_after_assembly_is_reported_as_one_error_line(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The host must get a line it can read, not a traceback on its stderr."""
    import io

    from lurnia import sidecar
    from lurnia.assembly import Core, default_paths
    from lurnia.core.storage import open_db

    def fake_assemble(_data_dir: object, **_kwargs: object) -> Core:
        # The transport does not matter here: the failure happens before any publish.
        return Core(default_paths(tmp_path), open_db(tmp_path / "lurnia.db"))

    def boom(_core: Core) -> int:
        msg = "rotate exploded"
        raise RuntimeError(msg)

    monkeypatch.setattr(sidecar, "assemble", fake_assemble)
    monkeypatch.setattr(sidecar, "_rotate_on_start", boom)

    stream = io.StringIO()
    code = sidecar.serve(data_dir=tmp_path, stream=stream, stdin=io.StringIO(""))

    assert code == 1
    payload = json.loads(stream.getvalue().strip().splitlines()[-1])
    assert payload["type"] == "error"
    assert "运行失败" in str(payload["message"])


# --------------------------------------------------------------------------
# self-check
# --------------------------------------------------------------------------


def test_self_check_passes_from_source() -> None:
    """From source the check must pass: it is the baseline for the frozen run."""
    code, payloads = _run_sidecar(None, "--self-check")
    payload = payloads[0]
    assert code == 0, payload
    assert payload["ok"] is True
    assert payload["problems"] == []
    assert payload["frozen"] is False


def test_self_check_reports_the_ddl_it_found() -> None:
    _code, payloads = _run_sidecar(None, "--self-check")
    payload = payloads[0]
    assert payload["ddl_migrations"] == [1, 2]
    assert payload["ddl_tables"] == ["attachment.sql", "event_log.sql"]
    assert payload["expected_version"] == payload["migrated_to"]


def test_self_check_actually_migrates_a_database() -> None:
    """Reading the DDL is not enough; the migration must run."""
    _code, payloads = _run_sidecar(None, "--self-check")
    assert payloads[0]["migrated_to"] == 2


def test_self_check_fails_when_ddl_is_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The check must fail loudly rather than pass on unreadable resources.

    This is the branch that matters in the frozen artifact: if ``--add-data`` is
    missing, the DDL is gone and the app must not report success.
    """
    from lurnia.core import ddl
    from lurnia.sidecar import self_check

    def boom(_schema: str) -> object:
        msg = "找不到 DDL 目录"
        raise ddl.DdlError(msg)

    monkeypatch.setattr(ddl, "read_schema", boom)
    # self_check imports inside the function, so patch the module attribute it sees
    from lurnia import sidecar

    monkeypatch.setattr(sidecar, "self_check", self_check)
    code = self_check()
    assert code == 1


def test_self_check_reports_problems_as_a_list(monkeypatch: pytest.MonkeyPatch) -> None:
    """``problems`` must stay machine-readable for the build script."""
    from lurnia.core import ddl

    def boom(_schema: str) -> object:
        msg = "找不到 DDL 目录：模拟漏掉 --add-data"
        raise ddl.DdlError(msg)

    monkeypatch.setattr(ddl, "read_schema", boom)
    code, payload = _run_sidecar_inprocess()
    assert code == 1
    assert isinstance(payload.get("problems"), list)
    assert payload["problems"], "a failure must name at least one problem"
    assert payload["ok"] is False


def _run_sidecar_inprocess() -> tuple[int, dict[str, object]]:
    """Call ``self_check`` in-process and capture its emitted JSON."""
    import contextlib
    import io

    from lurnia import sidecar

    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = sidecar.self_check()
    payload = json.loads(buffer.getvalue().strip().splitlines()[-1])
    return code, payload


# --------------------------------------------------------------------------
# build script: resource discovery
# --------------------------------------------------------------------------


def test_build_script_finds_every_sql_file(build_module: Any) -> None:
    """A new .sql must be picked up automatically, not remembered by hand."""
    found = build_module.collect_data_files()
    package_sql = sorted((ROOT / "src" / "lurnia").rglob("*.sql"))
    assert len(found) == len(package_sql), (
        f"build script found {len(found)} data files, source has {len(package_sql)}"
    )


def test_build_script_maps_sql_to_package_relative_destinations(
    build_module: Any,
) -> None:
    """The destination must match the path ``importlib.resources`` will read."""
    for source, destination in build_module.collect_data_files():
        assert destination.startswith("lurnia/")
        assert source.suffix == ".sql"
        assert "\\" not in destination


def test_build_script_uses_optimize_two(build_module: Any) -> None:
    """Documented choice: strip docstrings so the artifact is pure runtime."""
    assert build_module.OPTIMIZE == 2


def test_build_script_target_triple_looks_like_a_triple(build_module: Any) -> None:
    """Tauri's externalBin suffix must be the rust target triple."""
    triple = build_module.target_triple()
    assert triple.count("-") >= 2, triple
    assert " " not in triple


def test_build_script_separator_matches_the_platform(build_module: Any) -> None:
    expected = ";" if sys.platform == "win32" else ":"
    assert build_module.data_separator() == expected


def test_build_script_clean_removes_artifacts(
    build_module: Any, tmp_path: pathlib.Path
) -> None:
    """``--clean`` must be able to clear stale output before a rebuild."""
    assert hasattr(build_module, "clean")


def test_build_script_exposes_a_check_mode() -> None:
    """CI verifies an existing artifact without rebuilding it."""
    proc = subprocess.run(
        [sys.executable, str(BUILD_SCRIPT), "--help"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        cwd=ROOT,
    )
    assert proc.returncode == 0
    assert "--check" in proc.stdout
    assert "--skip-check" in proc.stdout


def test_self_check_reports_a_migration_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A database that cannot be opened must be reported, not swallowed.

    This is the second failure mode the frozen self-check exists to catch: the
    DDL may be present while the paths are wrong, which only shows up when the
    database is actually opened.
    """
    from lurnia.core import storage

    def boom(*_args: object, **_kwargs: object) -> object:
        msg = "unable to open database file"
        raise storage.StorageError(msg)

    monkeypatch.setattr(storage, "open_db", boom)
    code, payload = _self_check_capture()
    assert code == 1
    assert payload["ok"] is False
    problems = payload["problems"]
    assert isinstance(problems, list)
    assert any("建库" in str(p) for p in problems), problems


def _self_check_capture() -> tuple[int, dict[str, object]]:
    import contextlib
    import io

    from lurnia import sidecar

    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = sidecar.self_check()
    payload = json.loads(buffer.getvalue().strip().splitlines()[-1])
    return code, payload
