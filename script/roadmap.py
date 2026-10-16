# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""Roadmap conformance checker for Lurnia-RS-2026.

Checks, for a roadmap file under docs/roadmap/:
  * the two required sections, in order;
  * indented unordered-list nesting (spec 3.3.4) with 4-space steps;
  * every leaf entry carries exactly the six item-card fields, in order;
  * route IDs are three digits, contiguous, non-reused, and unique;
  * item names are unique and usable as file names (spec 3.3.3b);
  * parent checkboxes equal the aggregation of their children (spec 3.3.4);
  * version assignment lists every live route ID exactly once;
  * deprecated entries stay out of the increment and out of version assignment,
    and live in the annex holding a slot (spec chapter 9).

Exit code is non-zero when any check fails.
"""

from __future__ import annotations

import pathlib
import re
import sys

CARD_FIELDS = [
    "路线ID",
    "决策状态",
    "设计关联文件",
    "分配实现版本",
    "具体实现文件",
    "关联 issues / PR",
]
STATUS = {"已定", "待裁", "未定", "未来项", "已废弃"}
ANNEX_TITLE = "## 废弃附录"
NODE = re.compile(r"^(\s*)- \[([ x])\] (.*)$")
CARD = re.compile(r"^\s*> ([^:]+): ?(.*)$")
ANNEX_ID = re.compile(r"^\s*> 路线ID: *(\d{3})\s*$")
CARD_ROW = re.compile(r"^\s*> ([^:]+): ?(.*)$", re.MULTILINE)
DESIGN_REF = re.compile(r"(\[.+\]\(.+#r\d{3}\))?$")


class Node:
    __slots__ = ("card", "checked", "children", "depth", "line", "name")

    def __init__(self, name: str, checked: bool, depth: int, line: int) -> None:
        self.name = name
        self.checked = checked
        self.depth = depth
        self.children: list[Node] = []
        self.card: dict[str, str] = {}
        self.line = line

    @property
    def is_leaf(self) -> bool:
        return not self.children


def _card_at(lines: list[str], start: int) -> tuple[dict[str, str], int]:
    """Collect the item card beginning at ``start``; return it and the next index."""
    card: dict[str, str] = {}
    j = start
    while j < len(lines):
        cm = CARD.match(lines[j])
        if cm is None:
            break
        card[cm.group(1).strip()] = cm.group(2)
        j += 1
    return card, j


def split_sections(lines: list[str]) -> tuple[list[str], list[str], list[str]]:
    """Split the file into increment, version assignment and deprecated annex.

    The annex is everything from ``## 废弃附录`` on. It is keyed by whichever
    ``##`` heading the file uses, so the annex may sit before or after 版本分配.
    """
    increment: list[str] = []
    version: list[str] = []
    annex: list[str] = []
    current: list[str] = increment
    for line in lines:
        if line.startswith("## "):
            title = line.strip()
            if title == ANNEX_TITLE:
                current = annex
            elif title == "## 版本分配":
                current = version
            else:
                current = increment
            current.append(line)
            continue
        current.append(line)
    return increment, version, annex


def annex_ids(lines: list[str]) -> list[str]:
    """Route IDs declared by the deprecated annex, in file order."""
    return [m.group(1) for line in lines if (m := ANNEX_ID.match(line))]


def parse(
    path: pathlib.Path,
) -> tuple[list[Node], list[str], list[str], list[str], list[str]]:
    lines = path.read_text(encoding="utf-8").split("\n")
    errors: list[str] = []
    increment, version_section, annex_section = split_sections(lines)

    roots: list[Node] = []
    stack: list[Node] = []
    seen_entry = False
    i = 0
    while i < len(increment):
        line = increment[i]
        if line.startswith("## "):
            seen_entry = line.strip() == "## 路线增量"
            i += 1
            continue
        if line.startswith("#"):
            i += 1
            continue

        m = NODE.match(line)
        if m and seen_entry:
            indent, mark, name = m.group(1), m.group(2), m.group(3).strip()
            if len(indent) % 4:
                errors.append(f"L{i + 1}: indent {len(indent)} is not a multiple of 4")
            depth = len(indent) // 4
            node = Node(name, mark == "x", depth, i + 1)
            while stack and stack[-1].depth >= depth:
                stack.pop()
            if stack:
                if depth != stack[-1].depth + 1:
                    errors.append(
                        f"L{i + 1}: {name!r} jumps from depth "
                        f"{stack[-1].depth} to {depth}"
                    )
                stack[-1].children.append(node)
            else:
                if depth != 0:
                    errors.append(
                        f"L{i + 1}: {name!r} starts at depth {depth}, expected 0"
                    )
                roots.append(node)
            stack.append(node)

            node.card, i = _card_at(increment, i + 1)
            continue
        i += 1

    return roots, errors, version_section, annex_section, lines


def flatten(nodes: list[Node]) -> list[Node]:
    out: list[Node] = []
    for n in nodes:
        out.append(n)
        out.extend(flatten(n.children))
    return out


def check_cards(leaves: list[Node]) -> tuple[list[str], list[str]]:
    """Rule 1: every leaf carries exactly the six card fields, in order."""
    errors: list[str] = []
    ids: list[str] = []
    for leaf in leaves:
        keys = list(leaf.card)
        if keys != CARD_FIELDS:
            errors.append(f"L{leaf.line}: {leaf.name!r} card fields -> {keys}")
            continue
        rid = leaf.card["路线ID"]
        ids.append(rid)
        if not re.fullmatch(r"\d{3}", rid):
            errors.append(f"L{leaf.line}: {leaf.name!r} route id -> {rid!r}")
        status = leaf.card["决策状态"]
        if status not in STATUS:
            errors.append(f"L{leaf.line}: {leaf.name!r} status -> {status!r}")
        elif status == "已废弃":
            errors.append(
                f"L{leaf.line}: {leaf.name!r} is deprecated but still in the increment"
                " — move it to the annex (spec 9)"
            )
    return ids, errors


def check_parents(all_nodes: list[Node], errors: list[str]) -> None:
    """Rules 2 and 3: no card on parents; parent checkbox aggregates children."""
    for n in all_nodes:
        if not n.is_leaf and n.card:
            errors.append(f"L{n.line}: parent {n.name!r} must not carry an item card")
    for n in all_nodes:
        if n.is_leaf:
            continue
        all_done = all(c.checked for c in n.children)
        if n.checked and not all_done:
            errors.append(f"L{n.line}: {n.name!r} checked but not all children are")
        if not n.checked and all_done:
            errors.append(
                f"L{n.line}: {n.name!r} all children done but parent unchecked"
            )


def check_ids(ids: list[str], annex: list[str], errors: list[str]) -> None:
    """Rule 4: contiguous, non-reused. Annex IDs hold their slot (spec 9c)."""
    taken = sorted(ids + annex)
    expected = [f"{k:03d}" for k in range(1, len(taken) + 1)]
    if taken != expected:
        errors.append(
            f"route ids not contiguous 001..{len(taken):03d}: got {len(taken)}"
        )
    if len(set(taken)) != len(taken):
        errors.append(f"route ids reused: {len(taken) - len(set(taken))} duplicate(s)")


def check_names(all_nodes: list[Node], errors: list[str]) -> None:
    """Rule 5: names unique and usable as file names (spec 3.3.3b)."""
    names = [n.name for n in all_nodes]
    for dup in sorted({x for x in names if names.count(x) > 1}):
        errors.append(f"duplicate node name: {dup!r}")
    for n in all_nodes:
        if re.search(r'[/\\:*?"<>|]', n.name):
            errors.append(f"L{n.line}: {n.name!r} is not usable as a file name")


def check_design_refs(leaves: list[Node], errors: list[str]) -> None:
    """Rule 6: design references carry the ``#r<ID>`` anchor (spec 6.3)."""
    for leaf in leaves:
        value = leaf.card.get("设计关联文件", "")
        if not DESIGN_REF.fullmatch(value):
            errors.append(f"L{leaf.line}: {leaf.name!r} design ref -> {value!r}")


def check_version_assignment(
    version_section: list[str], ids: list[str], annex: list[str], errors: list[str]
) -> None:
    """Rule 7: every live id exactly once; no deprecated id at all."""
    va_ids = re.findall(r"\b\d{3}\b", "\n".join(version_section))
    if sorted(va_ids) != sorted(ids) or len(va_ids) != len(set(va_ids)):
        errors.append(
            f"version assignment mismatch: {len(va_ids)} ids for {len(ids)} live items"
        )
    leaked = sorted(set(va_ids) & set(annex))
    if leaked:
        errors.append(f"version assignment lists deprecated ids: {' '.join(leaked)}")


def check_annex(annex: list[str], annex_section: list[str], errors: list[str]) -> None:
    """Rule 8: one deprecated card per entry, deprecated status, no duplicate."""
    if not annex:
        return
    seen: set[str] = set()
    for rid in annex:
        if rid in seen:
            errors.append(f"deprecated id {rid} appears twice in the annex")
        seen.add(rid)
    statuses = dict(CARD_ROW.findall("\n".join(annex_section)))
    if statuses.get("决策状态") != "已废弃":
        errors.append(f"annex 决策状态 -> {statuses.get('决策状态')!r}")
    for field in CARD_FIELDS:
        if field not in statuses:
            errors.append(f"annex card is missing {field!r}")
            break


def report(
    path: pathlib.Path,
    all_nodes: list[Node],
    leaves: list[Node],
    ids: list[str],
    errors: list[str],
) -> None:
    depth_max = max((n.depth for n in all_nodes), default=0)
    print(f"file        : {path}")
    print(
        f"nodes       : {len(all_nodes)} "
        f"(leaves {len(leaves)}, parents {len(all_nodes) - len(leaves)})"
    )
    print(f"max depth   : {depth_max}")
    print(f"ids         : {ids[0] if ids else '-'}..{ids[-1] if ids else '-'}")
    print(f"errors      : {len(errors)}")
    for e in errors[:20]:
        print("   ", e)


def main() -> int:
    path = pathlib.Path(
        sys.argv[1] if len(sys.argv) > 1 else "docs/roadmap/1.x-开发.md"
    )
    roots, errors, version_section, annex_section, _ = parse(path)
    all_nodes = flatten(roots)
    leaves = [n for n in all_nodes if n.is_leaf]
    annex = annex_ids(annex_section)

    ids, card_errors = check_cards(leaves)
    errors.extend(card_errors)
    check_parents(all_nodes, errors)
    check_ids(ids, annex, errors)
    check_names(all_nodes, errors)
    check_design_refs(leaves, errors)
    check_version_assignment(version_section, ids, annex, errors)
    check_annex(annex, annex_section, errors)

    report(path, all_nodes, leaves, ids, errors)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
