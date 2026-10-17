# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""A tiny, dependency-free secret check for the pre-commit hook.

This is deliberately *not* a gitleaks replacement. gitleaks' own pre-commit
wrapper builds from source and needs a Go toolchain plus access to the Go module
proxy, which made ``pre-commit run --all-files`` fail for reasons unrelated to
this repository. Full scanning runs in CI; this catches the obvious mistake
before a commit leaves the machine.

Exits non-zero and prints every hit, so the commit is stopped with a reason.
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys

# Patterns that are almost always a real leak. Kept narrow on purpose: a noisy
# check gets disabled, and a disabled check protects nothing.
PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("AWS access key id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    ("GitHub fine-grained token", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{22,}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("OpenAI-style key", re.compile(r"\bsk-[A-Za-z0-9]{32,}\b")),
    (
        "PyPI upload token",
        re.compile(r"\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{40,}\b"),
    ),
    (
        "JSON web token",
        re.compile(
            r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"
        ),
    ),
)

# Files that legitimately contain high-entropy or example strings.
SKIP_NAMES = frozenset({"uv.lock", "pnpm-lock.yaml", "Cargo.lock", "package-lock.json"})
SKIP_SUFFIXES = (
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".icns",
    ".exe",
    ".dll",
)


def tracked_files() -> list[pathlib.Path]:
    """Files git knows about, so build output and caches are not scanned.

    ``--others --exclude-standard`` includes untracked files that are not
    ignored. Without it the check would skip brand-new files — which is exactly
    where a freshly pasted credential is most likely to be sitting.
    """
    proc = subprocess.run(
        [  # noqa: S607 - `git` is resolved from PATH by design
            "git",
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
        capture_output=True,
        check=False,
        shell=False,
    )
    if proc.returncode != 0:
        return []
    names = proc.stdout.decode("utf-8", errors="replace").split("\0")
    return [pathlib.Path(name) for name in names if name]


def scan(path: pathlib.Path) -> list[str]:
    if path.name in SKIP_NAMES or path.suffix.lower() in SKIP_SUFFIXES:
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError, UnicodeDecodeError:
        return []
    hits: list[str] = []
    for label, pattern in PATTERNS:
        for match in pattern.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            hits.append(f"{path}:{line}: possible {label}")
    return hits


def main() -> int:
    files = tracked_files()
    if not files:
        print("check_secrets: no tracked files found (not a git checkout?)")
        return 0
    hits: list[str] = []
    for path in files:
        hits.extend(scan(path))
    if hits:
        print("check_secrets: refusing to continue — possible secrets found:")
        for hit in hits:
            print(f"  {hit}")
        print(
            "\nIf this is a false positive, narrow the pattern in"
            " script/check_secrets.py."
        )
        return 1
    print(f"check_secrets: clean ({len(files)} files scanned)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
