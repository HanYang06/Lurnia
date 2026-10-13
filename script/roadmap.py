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
  * version assignment lists every route ID exactly once.

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
NODE = re.compile(r"^(\s*)- \[([ x])\] (.*)$")
CARD = re.compile(r"^\s*> ([^:]+): ?(.*)$")


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


def parse(path: pathlib.Path) -> tuple[list[Node], list[str], list[str]]:
    lines = path.read_text(encoding="utf-8").split("\n")
    errors: list[str] = []

    roots: list[Node] = []
    stack: list[Node] = []
    seen_entry = False
    version_section: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("## "):
            if line.strip() == "## 版本分配":
                version_section = lines[i:]
                break
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
                        f"L{i + 1}: {name!r} jumps from depth {stack[-1].depth} to {depth}"
                    )
                stack[-1].children.append(node)
            else:
                if depth != 0:
                    errors.append(
                        f"L{i + 1}: {name!r} starts at depth {depth}, expected 0"
                    )
                roots.append(node)
            stack.append(node)

            # collect the card belonging to this node, if any
            j = i + 1
            while j < len(lines):
                cm = CARD.match(lines[j])
                if cm is None:
                    break
                node.card[cm.group(1).strip()] = cm.group(2)
                j += 1
            i = j
            continue
        i += 1

    return roots, errors, version_section


def flatten(nodes: list[Node]) -> list[Node]:
    out: list[Node] = []
    for n in nodes:
        out.append(n)
        out.extend(flatten(n.children))
    return out


def main() -> int:
    path = pathlib.Path(
        sys.argv[1] if len(sys.argv) > 1 else "docs/roadmap/1.x-开发.md"
    )
    roots, errors, version_section = parse(path)
    all_nodes = flatten(roots)
    leaves = [n for n in all_nodes if n.is_leaf]

    # 1. every leaf has the six card fields, in order and complete
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
        if leaf.card["决策状态"] not in STATUS:
            errors.append(
                f"L{leaf.line}: {leaf.name!r} status -> {leaf.card['决策状态']!r}"
            )

    # 2. parents must not carry a card
    for n in all_nodes:
        if not n.is_leaf and n.card:
            errors.append(f"L{n.line}: parent {n.name!r} must not carry an item card")

    # 3. parent checkbox == aggregation of children
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

    # 4. ids contiguous and unique
    expected = [f"{k:03d}" for k in range(1, len(leaves) + 1)]
    if sorted(ids) != expected:
        errors.append(
            f"route ids not contiguous 001..{len(leaves):03d}: got {len(ids)}"
        )

    # 5. names unique and file-name safe
    names = [n.name for n in all_nodes]
    for dup in sorted({x for x in names if names.count(x) > 1}):
        errors.append(f"duplicate node name: {dup!r}")
    for n in all_nodes:
        if re.search(r'[/\\:*?"<>|]', n.name):
            errors.append(f"L{n.line}: {n.name!r} is not usable as a file name")

    # 6. design reference format
    ref = re.compile(r"(\[.+\]\(.+#r\d{3}\))?$")
    for leaf in leaves:
        value = leaf.card.get("设计关联文件", "")
        if not ref.fullmatch(value):
            errors.append(f"L{leaf.line}: {leaf.name!r} design ref -> {value!r}")

    # 7. version assignment completeness
    va_ids = re.findall(r"\b\d{3}\b", "\n".join(version_section))
    if sorted(va_ids) != expected:
        errors.append(
            f"version assignment mismatch: {len(va_ids)} ids for {len(leaves)} leaves"
        )

    depth_max = max((n.depth for n in all_nodes), default=0)
    print(f"file        : {path}")
    print(
        f"nodes       : {len(all_nodes)} (leaves {len(leaves)}, parents {len(all_nodes) - len(leaves)})"
    )
    print(f"max depth   : {depth_max}")
    print(f"ids         : {ids[0] if ids else '-'}..{ids[-1] if ids else '-'}")
    print(f"errors      : {len(errors)}")
    for e in errors[:20]:
        print("   ", e)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
