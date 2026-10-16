# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""Architecture audit for Lurnia's invariants.

Each function returns a list of human-readable violations, empty when the rule
holds. They are pure static checks over a source tree, so they can run in a test
*and* as a script:

```bash
uv run python script/audit.py
```

Rules covered here (the runtime rules live in ``tests/test_invariants.py``):

* **I1** — components do not import each other;
* **I2** — a ``Decision`` value never appears in a boolean context;
* **I3** — the kernel layers are one-directional ``conf -> log -> storage -> bus``;
* **I7** — the kernel does not know the UI exists;
* **I9** — the kernel does not open browsers, servers, sockets or subprocesses.
"""

from __future__ import annotations

import ast
import pathlib
import re
import sys

LAYERS = ("conf", "log", "storage", "bus")
BASE_MODULES = ("contracts",)
KERNEL = pathlib.Path("src/lurnia")
CORE = KERNEL / "core"

# I7: the kernel must not carry UI concepts. Scanned over ``core/`` only: the
# kernel is ``src/lurnia/core/``, while ``sidecar.py`` is the *binding* layer
# that sits above it and legitimately names its host (invariant I8: the envelope
# is a kernel asset, the transport is only a binding). Keeping the scan on the
# kernel is what makes the rule meaningful — it must not quietly widen to
# "nowhere may mention the host".
KERNEL_CORE = CORE
UI_KEYWORDS = ("视图", "渲染", "按钮", "tauri", "webview", "render", "button", "dom")
# I9: APP must not act on its own
# I9: the revised rule allows the host to manage its own sidecar, but the kernel
# itself still reaches nothing. These stay banned inside src/lurnia/ — the
# sidecar host lives outside the kernel, and its allowance is explicit there.
UNAUTHORIZED_MODULES = frozenset(
    {
        "webbrowser",
        "subprocess",
        "socket",
        "socketserver",
        "http.server",
        "urllib.request",
        "urllib.error",
        "requests",
        "httpx",
        "aiohttp",
        "telebot",
        "pystray",
    }
)
# I2: names whose bare truthiness signals a three-state value being collapsed
DECISION_NAMES = frozenset({"decision", "decisions", "verdict"})


class _ImportVisitor(ast.NodeVisitor):
    """Collect ``(module, lineno)`` for every imported dotted module name."""

    def __init__(self) -> None:
        self.imports: list[tuple[str, int]] = []

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self.imports.append((alias.name, node.lineno))
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        prefix = "." * node.level
        base = node.module or ""
        head = f"{prefix}{base}" if prefix else base
        self.imports.append((head, node.lineno))
        for alias in node.names:
            joined = f"{head}.{alias.name}" if head else alias.name
            self.imports.append((joined, node.lineno))
        self.generic_visit(node)


def _parse(path: pathlib.Path) -> ast.Module | None:
    try:
        return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except SyntaxError:
        return None


def python_files(root: pathlib.Path) -> list[pathlib.Path]:
    return sorted(p for p in root.rglob("*.py") if "__pycache__" not in p.parts)


def _layer_of(path: pathlib.Path, core: pathlib.Path) -> str | None:
    try:
        rel = path.relative_to(core)
    except ValueError:
        return None
    return rel.parts[0].removesuffix(".py") if rel.parts else None


def _resolve_core_import(name: str, current: str | None) -> str | None:
    """Map an import expression to the kernel module it targets, if any."""
    if name.startswith("."):
        depth = len(name) - len(name.lstrip("."))
        rest = name.lstrip(".")
        if depth == 1:
            # `from . import x` / `from .x import y`
            head = rest.split(".")[0]
            return head or current
        return rest.split(".")[0] or None
    if name.startswith("lurnia.core."):
        return name.split(".")[2]
    if name == "lurnia.core":
        return None
    return None


def layer_violations(root: pathlib.Path = KERNEL) -> list[str]:
    """I3: a layer may only import itself, lower layers, and the shared base."""
    core = root / "core"
    violations: list[str] = []
    if not core.is_dir():
        return violations
    for path in python_files(core):
        current = _layer_of(path, core)
        if current not in LAYERS:
            continue
        allowed_rank = LAYERS.index(current)
        tree = _parse(path)
        if tree is None:
            continue
        visitor = _ImportVisitor()
        visitor.visit(tree)
        for name, lineno in visitor.imports:
            target = _resolve_core_import(name, current)
            if target is None or target in BASE_MODULES or target == current:
                continue
            if target not in LAYERS:
                continue
            if LAYERS.index(target) > allowed_rank:
                violations.append(
                    f"{path}:{lineno}: I3 {current} imports upper layer {target}"
                )
    return violations


def component_roots(root: pathlib.Path = KERNEL) -> list[pathlib.Path]:
    """Sibling packages under ``components/`` — the units of invariant I1."""
    base = root / "components"
    if not base.is_dir():
        return []
    return sorted(
        p for p in base.iterdir() if p.is_dir() and (p / "__init__.py").exists()
    )


def component_violations(root: pathlib.Path = KERNEL) -> list[str]:
    """I1: no component imports another component; cross-module goes via the bus."""
    violations: list[str] = []
    components = component_roots(root)
    names = [p.name for p in components]
    for component in components:
        for path in python_files(component):
            tree = _parse(path)
            if tree is None:
                continue
            visitor = _ImportVisitor()
            visitor.visit(tree)
            for name, lineno in visitor.imports:
                for other in names:
                    if other == component.name:
                        continue
                    if re.search(rf"(^|\.)components\.{re.escape(other)}(\.|$)", name):
                        violations.append(
                            f"{path}:{lineno}: I1 {component.name} imports {other}"
                            " — cross-module calls go through the bus"
                        )
    return violations


def _bool_context_violations(tree: ast.Module, path: pathlib.Path) -> list[str]:
    """I2: a Decision value must never be tested for its *truthiness*.

    Explicit comparison — ``decision is Decision.ALLOW`` — is the sanctioned
    form and must not be flagged; only a bare truth test is.
    """
    out: list[str] = []
    tests: list[ast.expr] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.If | ast.While | ast.IfExp):
            tests.append(node.test)
        elif isinstance(node, ast.BoolOp):
            tests.extend(node.values)
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            tests.append(node.operand)
        elif (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "bool"
            and node.args
        ):
            tests.append(node.args[0])

    for expr in tests:
        for offender, lineno in _bare_decision_tests(expr):
            out.append(
                f"{path}:{lineno}: I2 {offender!r} tested for truthiness;"
                " compare against Decision members explicitly"
            )
    return out


def _bare_decision_tests(expr: ast.expr) -> list[tuple[str, int]]:
    """Yield names that are *directly* used as a truth value, skipping comparisons."""
    if isinstance(expr, ast.Compare):
        # `decision is Decision.ALLOW` — this is the correct form
        return []
    if isinstance(expr, ast.Name):
        return [(expr.id, expr.lineno)] if expr.id.lower() in DECISION_NAMES else []
    if isinstance(expr, ast.Attribute):
        if expr.attr.lower() in DECISION_NAMES:
            return [(expr.attr, expr.lineno)]
        return []
    if isinstance(expr, ast.BoolOp):
        found: list[tuple[str, int]] = []
        for value in expr.values:
            found.extend(_bare_decision_tests(value))
        return found
    if isinstance(expr, ast.UnaryOp) and isinstance(expr.op, ast.Not):
        return _bare_decision_tests(expr.operand)
    return []


def decision_violations(root: pathlib.Path = KERNEL) -> list[str]:
    violations: list[str] = []
    for path in python_files(root):
        tree = _parse(path)
        if tree is None:
            continue
        violations.extend(_bool_context_violations(tree, path))
    return violations


def ui_violations(root: pathlib.Path = KERNEL_CORE) -> list[str]:
    """I7: the kernel must not import or mention UI concepts.

    Scanned over the kernel (``src/lurnia/core/``) rather than the whole package:
    the sidecar entry above it is a transport binding and is allowed to name its
    host. See the ``KERNEL_CORE`` comment.
    """
    violations: list[str] = []
    for path in python_files(root):
        text = path.read_text(encoding="utf-8").lower()
        for keyword in UI_KEYWORDS:
            for match in re.finditer(rf"(?<![a-z]){re.escape(keyword)}(?![a-z])", text):
                line = text.count("\n", 0, match.start()) + 1
                violations.append(f"{path}:{line}: I7 UI concept {keyword!r}")
    return violations


def unauthorized_violations(root: pathlib.Path = KERNEL) -> list[str]:
    """I9: no browser, server, socket or subprocess reachable from the kernel."""
    violations: list[str] = []
    for path in python_files(root):
        tree = _parse(path)
        if tree is None:
            continue
        visitor = _ImportVisitor()
        visitor.visit(tree)
        for name, lineno in visitor.imports:
            for forbidden in UNAUTHORIZED_MODULES:
                if name == forbidden or name.startswith(f"{forbidden}."):
                    violations.append(f"{path}:{lineno}: I9 kernel imports {name!r}")
    return violations


def schema_locations(
    root: pathlib.Path | None = None,
) -> list[tuple[str, str, pathlib.Path]]:
    """每个 DDL 根：``(schema, 包名, 目录)``。

    两处都算：内核自己的 ``core/sql/*``，以及组件包里的 ``components/<组件>/sql/*``
    （[storage.md §五](../../docs/design/storage.md)：业务 schema 归组件包）。
    只扫前者，新根下的 schema 就会**逃过 I4 的一致性检查** —— 那正是这条检查存在的理由。

    ``root`` 默认取模块级的 ``KERNEL``，**在调用时解析**：默认参数会在定义时绑定，
    那样测试就没法把审计指向一棵临时树（这里踩过一次）。
    """
    base = KERNEL if root is None else root
    found: list[tuple[str, str, pathlib.Path]] = []
    core_sql = base / "core" / "sql"
    if core_sql.is_dir():
        found += [
            (entry.name, "lurnia.core", entry)
            for entry in sorted(core_sql.iterdir())
            if entry.is_dir()
        ]
    components = base / "components"
    if components.is_dir():
        for component in sorted(p for p in components.iterdir() if p.is_dir()):
            sql = component / "sql"
            if not sql.is_dir():
                continue
            package = f"lurnia.components.{component.name}"
            found += [
                (entry.name, package, entry)
                for entry in sorted(sql.iterdir())
                if entry.is_dir()
            ]
    return found


def schema_drift_violations() -> list[str]:
    """The SQL snapshot and the migration chain must describe the same schema.

    I4 covers persistence versions, but not this: a fresh install (snapshot) and
    an upgraded old database (chain) are two code paths to one shape. If they
    drift, new installs and upgraded installs behave differently — the classic
    way a migration pile rots.
    """
    parent = str(KERNEL.parent)
    if parent not in sys.path:
        sys.path.insert(0, parent)
    from lurnia.core.ddl import DdlError, migration_files, register_schema
    from lurnia.core.storage import check_drift

    violations: list[str] = []
    seen: dict[str, str] = {}
    for schema, package, schema_dir in schema_locations():
        if schema in seen:
            violations.append(
                f"{schema}: 两个包都声明了这个 schema（{seen[schema]} / {package}）"
                " —— 表名与 schema_meta 会互相撞号"
            )
            continue
        seen[schema] = package
        if not (schema_dir / "migrations").is_dir():
            violations.append(f"{schema}: 缺少 migrations/ 目录")
            continue
        if not (schema_dir / "tables").is_dir():
            violations.append(f"{schema}: 缺少 tables/ 目录")
            continue
        register_schema(schema, package)
        try:
            migration_files(schema)
        except DdlError as exc:
            violations.append(f"{schema}: 迁移链是空的（{exc}）")
            continue
        violations.extend(f"{schema}: {p}" for p in check_drift(schema))
    return violations


CHECKS = {
    "I1 components do not import each other": component_violations,
    "I2 Decision is never boolean": decision_violations,
    "I3 kernel layers are one-directional": layer_violations,
    "I7 kernel does not know the UI": ui_violations,
    "I9 no unauthorized outward action": unauthorized_violations,
    "I4 SQL snapshot matches the migration chain": schema_drift_violations,
}


def main() -> int:
    failed = False
    for title, check in CHECKS.items():
        violations = check()
        status = "ok" if not violations else f"FAIL ({len(violations)})"
        print(f"{status:<12} {title}")
        for violation in violations[:20]:
            print(f"    {violation}")
        failed = failed or bool(violations)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
