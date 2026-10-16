# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""Sidecar entry-point tests.

The build script's correctness is covered here at the level that can be tested
without a full PyInstaller run: the protocol, the self-check's failure detection,
and the build script's own resource discovery. The actual frozen build is
verified by ``script/build_sidecar.py`` itself (it runs ``--self-check`` inside
the artifact), which is the only place the packaging failure modes are visible.
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
import subprocess
import sys
from typing import Any

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD_SCRIPT = ROOT / "script" / "build_sidecar.py"


def _run_sidecar(*args: str) -> tuple[int, dict[str, object]]:
    proc = subprocess.run(
        [sys.executable, "-m", "lurnia.sidecar", *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        cwd=ROOT,
    )
    payload: dict[str, object] = {}
    for raw in proc.stdout.splitlines():
        candidate = raw.strip()
        if candidate.startswith("{"):
            payload = json.loads(candidate)
    return proc.returncode, payload


@pytest.fixture(scope="module")
def build_module() -> Any:
    spec = importlib.util.spec_from_file_location("lurnia_build_sidecar", BUILD_SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --------------------------------------------------------------------------
# protocol
# --------------------------------------------------------------------------


def test_sidecar_version_reports_protocol() -> None:
    code, payload = _run_sidecar("--version")
    assert code == 0
    assert payload["type"] == "version"
    assert payload["protocol"] == 1
    assert payload["version"]


def test_sidecar_ready_handshake_when_run_plainly() -> None:
    code, payload = _run_sidecar()
    assert code == 0
    assert payload["type"] == "ready"


def test_sidecar_rejects_unknown_flags() -> None:
    """A typo must not be silently ignored by a host-driven process."""
    code, payload = _run_sidecar("--nope")
    assert code == 2
    assert payload["type"] == "error"
    assert "--nope" in str(payload["message"])


def test_sidecar_output_is_one_json_object_per_line() -> None:
    proc = subprocess.run(
        [sys.executable, "-m", "lurnia.sidecar", "--version"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        cwd=ROOT,
    )
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    assert len(lines) == 1, "protocol is one JSON object per line"
    json.loads(lines[0])


# --------------------------------------------------------------------------
# self-check
# --------------------------------------------------------------------------


def test_self_check_passes_from_source() -> None:
    """From source the check must pass: it is the baseline for the frozen run."""
    code, payload = _run_sidecar("--self-check")
    assert code == 0, payload
    assert payload["ok"] is True
    assert payload["problems"] == []
    assert payload["frozen"] is False


def test_self_check_reports_the_ddl_it_found() -> None:
    _code, payload = _run_sidecar("--self-check")
    assert payload["ddl_migrations"] == [1]
    assert payload["ddl_tables"] == ["event_log.sql"]
    assert payload["expected_version"] == payload["migrated_to"]


def test_self_check_actually_migrates_a_database() -> None:
    """Reading the DDL is not enough; the migration must run."""
    _code, payload = _run_sidecar("--self-check")
    assert payload["migrated_to"] == 1


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
