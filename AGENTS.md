<!-- SPDX-FileCopyrightText: 2026 HanYang06 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# AGENTS.md

Instructions for AI agents and human contributors working on this repository.

## 1. Project Overview

**Lurnia** is a personal knowledge and project platform built as a desktop APP: a Python core packaged with Tauri, with the UI running in the Tauri WebView. Users double-click and it works — the APP never opens a browser, starts a server, spawns processes, or reaches the network on its own (invariant I9).

The project is in its early stage (0.1.0). Core components (kernel, permissions, notes, projects, AI) are built incrementally; see the roadmap for what exists and what is planned.

Key entry points:

| Path | What it is |
| --- | --- |
| `docs/design/README.md` | Design source of truth; start here |
| `docs/design/invariants.md` | Nine invariants that no 0.x release may break |
| `docs/design/versioning.md` | Versioning and deprecation rules |
| `docs/roadmap/README.md` | Roadmap directory and its conventions |
| `Lurnia-RS-2026.md` | Roadmap structure specification (self-contained standard) |

## 2. Project Tagline

> Lurnia is a **free platform** — a desktop APP, nothing more and nothing less.

It deliberately ships many capabilities (notes, projects, permissions, collaboration, AI tooling) while staying open and non-restrictive: local-first, user-owned, no forced workflows. When describing the project anywhere, keep this framing: one APP, many capabilities, user freedom first.

## 3. Roadmap Rules

The roadmap is the top authority. The order of authority is:

**Roadmap > Design > Code**

When touching anything under `docs/roadmap/`:

1. Follow [`Lurnia-RS-2026.md`](Lurnia-RS-2026.md) — it is self-contained and normative. In particular: roadmap items are parallel (no dependencies between items), each item is recorded as a six-line item card, and version assignment is a placement, not an ordering.
2. Items come from the capability pool (`docs/roadmap/inventory.md` once it exists); do not invent scope outside it.
3. New capabilities must map to a design document before implementation; design lives in `docs/design/`.
4. Do not edit versioning semantics (`0.MINOR.PATCH`) without reading `docs/design/versioning.md` first. The project does not commit to a 1.0 — this is a current-state choice, not a permanent promise.

## 4. Toolchain and Commands

**Always use `uv`.** Every command that has a `uv` equivalent must be run through `uv`:

```bash
uv sync                  # install/sync dependencies
uv run pytest            # tests
uv run ruff check .      # lint
uv run ruff format .     # format
uv run mypy .            # type check
uv run pre-commit run -a # hooks
uv add <package>         # add a dependency
```

Minimize direct edits to `pyproject.toml`. Dependency changes go through `uv add` / `uv remove` so that `uv.lock` stays consistent (the lockfile is currently known to be out of sync — see `docs/design/README.md` § "Engineering TODOs"; fix via `uv sync` / `uv lock` before adding new dependencies).

Requires Python >= 3.14.

## 5. Licensing and Quality Gates

**Licensing / copyright:**

- License: **Apache-2.0**.
- Every source and doc file carries SPDX headers at the top:

  ```text
  <!-- SPDX-FileCopyrightText: 2026 HanYang06 -->
  <!-- SPDX-License-Identifier: Apache-2.0 -->
  ```

- Do not commit third-party code without a compatible license and attribution.

**Quality gates (all must pass before merge):**

- `uv run ruff check .` and `uv run ruff format --check .`
- `uv run mypy .`
- `uv run pytest` — including the conformance tests for design invariants
- `uv run pre-commit run -a`

If a gate fails, fix it; do not skip or weaken a gate to get a change through.
