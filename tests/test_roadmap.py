# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""Conformance tests for the roadmap checker against Lurnia-RS-2026.

The checker is a script, not a package module, so it is imported by path. Each
test writes a tiny roadmap into ``tmp_path`` and runs the checker on it, which
keeps the assertions independent of how many items the real roadmap holds.
"""

from __future__ import annotations

import importlib.util
import os
import pathlib
import re
import subprocess
import sys
from typing import cast

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHECKER = ROOT / "script" / "roadmap.py"
REAL_ROADMAP = ROOT / "docs" / "roadmap" / "1.x-开发.md"


def _child_env() -> dict[str, str]:
    """Pin the child's stdio encoding so its Chinese output round-trips."""
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    return env


CARD = """> 路线ID: {rid}
> 决策状态: {status}
> 设计关联文件: {design}
> 分配实现版本: {version}
> 具体实现文件: {impl}
> 关联 issues / PR:"""


def card(
    rid: str,
    status: str = "未定",
    design: str = "",
    version: str = "1.x",
    impl: str = "内核层未建立",
) -> str:
    return CARD.format(
        rid=rid, status=status, design=design, version=version, impl=impl
    )


def build(
    *,
    entries: list[tuple[str, str]],
    annex: str = "",
    version_ids: list[str] | None = None,
    parent: str = "存储组件",
) -> str:
    """Assemble a minimal roadmap whose single parent holds ``entries``."""
    children = "".join(
        f"        - [ ] {name}\n"
        + "\n".join(f"          {line}" for line in card_text.splitlines())
        + "\n"
        for name, card_text in entries
    )
    ids = version_ids if version_ids is not None else [rid for rid, _ in entries]
    text = (
        "# 路线图\n\n"
        "## 路线增量\n\n"
        f"- [ ] 内核层\n    - [ ] {parent}\n{children}"
        "\n## 版本分配\n\n### 1.x（未落定路线）\n\n" + " ".join(ids) + "\n"
    )
    return text + annex


def run(tmp_path: pathlib.Path, text: str) -> subprocess.CompletedProcess[str]:
    path = tmp_path / "roadmap.md"
    path.write_text(text, encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(CHECKER), str(path)],
        capture_output=True,
        check=False,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=_child_env(),
    )


def annex_entry(rid: str, status: str = "已废弃") -> str:
    anchor = f"附录-{rid}"
    return (
        "\n## 废弃附录\n\n"
        "| 废弃 ID | 附录 |\n| --- | --- |\n"
        f"| {rid} | [附录 {rid}](#{anchor}) |\n\n"
        f'<a id="{anchor}"></a>\n\n'
        f"### 附录 {rid}\n\n{card(rid, status=status)}\n"
    )


@pytest.fixture(scope="module")
def design_ref_pattern() -> re.Pattern[str]:
    """The design-reference regex actually used by the checker."""
    spec = importlib.util.spec_from_file_location("lurnia_roadmap", CHECKER)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return cast("re.Pattern[str]", module.DESIGN_REF)


def test_real_roadmap_passes() -> None:
    """The checked-in roadmap must satisfy the spec (this is the merge gate)."""
    result = subprocess.run(
        [sys.executable, str(CHECKER)],
        capture_output=True,
        check=False,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=_child_env(),
        cwd=ROOT,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_real_roadmap_keeps_deprecated_id_out_of_version_assignment() -> None:
    """Spec 9c: 005 sits in the annex, not under a version."""
    text = REAL_ROADMAP.read_text(encoding="utf-8")
    assert "## 废弃附录" in text
    version_block = text.split("## 版本分配")[1].split("## 废弃附录")[0]
    assert "005" not in version_block


def test_annex_holds_a_slot(tmp_path: pathlib.Path) -> None:
    """Spec 9c: the deprecated ID keeps its slot, so live IDs stay contiguous."""
    text = build(
        entries=[("001", card("001")), ("003", card("003"))],
        annex=annex_entry("002"),
        version_ids=["001", "003"],
    )
    result = run(tmp_path, text)
    assert result.returncode == 0, result.stdout


def test_annex_removes_the_id_from_version_assignment(tmp_path: pathlib.Path) -> None:
    """A deprecated ID must not be listed under a version (spec 9c)."""
    text = build(
        entries=[("001", card("001")), ("003", card("003"))],
        annex=annex_entry("002"),
        version_ids=["001", "002", "003"],
    )
    result = run(tmp_path, text)
    assert result.returncode == 1
    assert "deprecated ids" in result.stdout


def test_deprecated_status_in_increment_is_rejected(tmp_path: pathlib.Path) -> None:
    """Spec 7.1: deprecated entries do not belong in the increment."""
    text = build(entries=[("001", card("001", status="已废弃"))])
    result = run(tmp_path, text)
    assert result.returncode == 1
    assert "move it to the annex" in result.stdout


def test_gap_without_annex_is_rejected(tmp_path: pathlib.Path) -> None:
    """A hole in the sequence is only legal when the annex explains it."""
    text = build(entries=[("001", card("001")), ("003", card("003"))])
    result = run(tmp_path, text)
    assert result.returncode == 1
    assert "not contiguous" in result.stdout


def test_annex_must_be_deprecated(tmp_path: pathlib.Path) -> None:
    text = build(
        entries=[("001", card("001")), ("003", card("003"))],
        annex=annex_entry("002", status="未定"),
        version_ids=["001", "003"],
    )
    result = run(tmp_path, text)
    assert result.returncode == 1
    assert "annex 决策状态" in result.stdout


def test_parent_checkbox_must_aggregate(tmp_path: pathlib.Path) -> None:
    text = build(entries=[("001", card("001"))]).replace(
        "- [ ] 存储组件", "- [x] 存储组件"
    )
    result = run(tmp_path, text)
    assert result.returncode == 1
    assert "checked but not all children are" in result.stdout


def test_design_reference_requires_anchor(design_ref_pattern: re.Pattern[str]) -> None:
    """Spec 6.3: a design reference must carry the ``#r<ID>`` anchor."""
    ref = design_ref_pattern
    assert ref.fullmatch("[storage.md §001](../d/s.md)") is None
    assert ref.fullmatch("[storage.md §001](../d/s.md#r001)") is not None
    assert ref.fullmatch("") is not None  # no design yet is allowed


def test_design_reference_anchor_is_accepted(tmp_path: pathlib.Path) -> None:
    text = build(
        entries=[("001", card("001", design="[storage.md §001](../design/s.md#r001)"))]
    )
    result = run(tmp_path, text)
    assert result.returncode == 0, result.stdout
