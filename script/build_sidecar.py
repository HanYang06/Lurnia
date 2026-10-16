# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""Build the Python core as a Tauri sidecar.

    uv run python script/build_sidecar.py            # build + self-check
    uv run python script/build_sidecar.py --clean    # remove artifacts first
    uv run python script/build_sidecar.py --check    # verify, build nothing

Why this script exists rather than a bare `pyinstaller` line in CI:

* **`.sql` is NOT collected automatically.** PyInstaller only auto-collects
  Python modules; data files need explicit ``--add-data``. Verified: without it
  the bundled app raises ``FileNotFoundError`` at runtime — i.e. it breaks only
  after installation. The data files are discovered from the source tree here, so
  adding a new ``.sql`` cannot silently fall out of the build.
* **Tauri's ``externalBin`` takes single *files*, not directories.** So
  ``--onedir`` (chosen for startup cost, see docs/design/packaging.md) cannot be
  handed to Tauri directly. This script builds ``--onedir`` for the runtime and
  then also emits the single-file binary Tauri expects, named with the target
  triple suffix Tauri requires.
* **The build must prove itself.** ``--self-check`` runs inside the frozen
  artifact and fails the build if the DDL resources or the migration no longer
  work. A green build that cannot open its own database is worse than a red one.

See docs/design/packaging.md.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
PACKAGE = SRC / "lurnia"
ENTRY = PACKAGE / "sidecar.py"
BUILD = ROOT / "build" / "sidecar"
DIST = ROOT / "dist" / "sidecar"
NAME = "lurnia-core"

# Optimise level 2 == `python -OO`: strips docstrings from the shipped bytecode.
# Comments are gone regardless (they never reach bytecode); this exists so the
# artifact is pure runtime and carries no prose.
OPTIMIZE = 2


class BuildError(Exception):
    """The sidecar build failed."""


def target_triple() -> str:
    """The host target triple, as Tauri's ``externalBin`` suffix expects."""
    for args in (["rustc", "--print", "host-tuple"], ["rustc", "-vV"]):
        try:
            proc = subprocess.run(args, capture_output=True, text=True, check=False)
        except FileNotFoundError:
            continue
        if proc.returncode != 0:
            continue
        if args[1] == "--print":
            value = proc.stdout.strip()
            if value:
                return value
        for line in proc.stdout.splitlines():
            if line.startswith("host:"):
                return line.split(":", 1)[1].strip()
    msg = (
        "无法确定目标三元组：找不到可用的 rustc。"
        "Tauri 的 externalBin 要求二进制名带 -<triple> 后缀。"
    )
    raise BuildError(msg)


def data_separator() -> str:
    """``--add-data`` uses ``:`` on POSIX and ``;`` on Windows."""
    return ";" if sys.platform == "win32" else ":"


def collect_data_files() -> list[tuple[Path, str]]:
    """Every non-Python resource the core needs at runtime.

    Discovered from the source tree rather than hard-coded: a new ``.sql`` under
    the package is picked up automatically, and a rename cannot silently drop it.
    """
    found: list[tuple[Path, str]] = []
    for path in sorted(PACKAGE.rglob("*.sql")):
        relative = path.relative_to(SRC).parent
        found.append((path, str(relative).replace("\\", "/")))
    if not found:
        msg = f"在 {PACKAGE} 下找不到任何 .sql —— 内核没有 DDL 无法建库"
        raise BuildError(msg)
    return found


def clean() -> None:
    for path in (BUILD, DIST):
        if path.exists():
            shutil.rmtree(path)
    spec = ROOT / f"{NAME}.spec"
    if spec.exists():
        spec.unlink()


def _common_args() -> list[str]:
    """Arguments every PyInstaller pass needs.

    ``--paths src`` is mandatory for a src-layout project: ``lurnia`` is not
    importable from the repo root, and without this PyInstaller fails to resolve
    the package (or worse, silently omits the modules it cannot see).
    """
    return [
        "--noconfirm",
        "--clean",
        "--paths",
        str(SRC),
        "--optimize",
        str(OPTIMIZE),
        "--name",
    ]


def build(triple: str) -> Path:
    """Run PyInstaller for both layouts and return the single-file artifact."""
    data = collect_data_files()
    args = [
        sys.executable,
        "-m",
        "PyInstaller",
        *_common_args(),
        NAME,
        "--onedir",
        "--distpath",
        str(DIST),
        "--workpath",
        str(BUILD),
        "--specpath",
        str(BUILD),
    ]
    for source, destination in data:
        args += ["--add-data", f"{source}{data_separator()}{destination}"]
    args.append(str(ENTRY))

    print(f"[build] target triple : {triple}")
    print(f"[build] data files     : {len(data)}")
    for source, destination in data:
        print(f"          {source.relative_to(ROOT)} -> {destination}")
    proc = subprocess.run(args, cwd=ROOT, check=False)
    if proc.returncode != 0:
        msg = f"PyInstaller 失败（退出码 {proc.returncode}）"
        raise BuildError(msg)

    onedir_exe = (
        DIST / NAME / f"{NAME}.exe" if sys.platform == "win32" else DIST / NAME / NAME
    )
    if not onedir_exe.is_file():
        msg = f"预期的一目录产物不存在：{onedir_exe}"
        raise BuildError(msg)

    # Tauri's externalBin wants ONE file named with the -<triple> suffix. Build
    # the single-file variant as well and place it where Tauri looks for it.
    suffix = ".exe" if sys.platform == "win32" else ""
    tauri_sidecar = dist_dir_tauri() / f"{NAME}-{triple}{suffix}"
    tauri_sidecar.parent.mkdir(parents=True, exist_ok=True)
    single = build_onefile(triple)
    shutil.copy2(single, tauri_sidecar)
    print(f"[build] tauri sidecar  : {tauri_sidecar.relative_to(ROOT)}")
    return tauri_sidecar


def build_onefile(triple: str) -> Path:
    """Second pass producing the single executable Tauri's externalBin needs."""
    data = collect_data_files()
    dist = DIST / "onefile"
    args = [
        sys.executable,
        "-m",
        "PyInstaller",
        *_common_args(),
        f"{NAME}-{triple}",
        "--onefile",
        "--distpath",
        str(dist),
        "--workpath",
        str(BUILD / "onefile"),
        "--specpath",
        str(BUILD / "onefile"),
    ]
    for source, destination in data:
        args += ["--add-data", f"{source}{data_separator()}{destination}"]
    args.append(str(ENTRY))
    proc = subprocess.run(args, cwd=ROOT, check=False)
    if proc.returncode != 0:
        msg = f"单文件构建失败（退出码 {proc.returncode}）"
        raise BuildError(msg)
    suffix = ".exe" if sys.platform == "win32" else ""
    produced = dist / f"{NAME}-{triple}{suffix}"
    if not produced.is_file():
        msg = f"预期的单文件产物不存在：{produced}"
        raise BuildError(msg)
    return produced


def dist_dir_tauri() -> Path:
    """Where Tauri resolves ``externalBin`` entries: ``src-tauri/binaries``."""
    return ROOT / "app" / "src-tauri" / "binaries"


def self_check(executable: Path) -> dict[str, object]:
    """Run ``--self-check`` inside the built artifact.

    The check happens *in the frozen process*, which is the only place the
    failure modes we care about are observable.
    """
    if not executable.is_file():
        msg = f"找不到待自检的产物：{executable}"
        raise BuildError(msg)
    proc = subprocess.run(
        [str(executable), "--self-check"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    payload: dict[str, object] = {}
    for raw in proc.stdout.splitlines():
        candidate = raw.strip()
        if candidate.startswith("{"):
            try:
                payload = json.loads(candidate)
            except json.JSONDecodeError:
                continue
    if not payload:
        msg = (
            f"自检没有输出可解析的 JSON（退出码 {proc.returncode}）\n"
            f"stdout: {proc.stdout[:400]}\nstderr: {proc.stderr[:400]}"
        )
        raise BuildError(msg)
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the Lurnia Python sidecar.")
    parser.add_argument("--clean", action="store_true", help="remove artifacts first")
    parser.add_argument(
        "--check", action="store_true", help="verify only, build nothing"
    )
    parser.add_argument(
        "--skip-check",
        action="store_true",
        help="skip the frozen self-check (not recommended; CI should never pass this)",
    )
    options = parser.parse_args(argv)

    try:
        triple = target_triple()
        suffix = ".exe" if sys.platform == "win32" else ""
        sidecar = dist_dir_tauri() / f"{NAME}-{triple}{suffix}"

        if options.check:
            if not sidecar.is_file():
                msg = f"产物不存在，无法自检：{sidecar}"
                raise BuildError(msg)
        else:
            if options.clean:
                clean()
            sidecar = build(triple)

        if options.skip_check:
            print("[check] 已跳过自检（--skip-check）")
            return 0

        result = self_check(sidecar)
        print(f"[check] frozen         : {result.get('frozen')}")
        print(f"[check] ddl migrations : {result.get('ddl_migrations')}")
        print(f"[check] ddl tables     : {result.get('ddl_tables')}")
        print(f"[check] migrated to    : {result.get('migrated_to')}")
        problems = result.get("problems") or []
        if problems or not result.get("ok"):
            for problem in problems if isinstance(problems, list) else [problems]:
                print(f"[check] FAIL: {problem}")
            msg = "冻结产物自检未通过"
            raise BuildError(msg)
        print("[check] OK — 冻结产物能读到 DDL 并完成迁移")
        return 0
    except BuildError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
