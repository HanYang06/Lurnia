<!-- SPDX-FileCopyrightText: 2026 HanYang06 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# AGENTS.md

Instructions for AI agents and human contributors working on this repository.

## 1. Project Overview

**Lurnia** is a personal knowledge and project platform built as a desktop APP: a Python core packaged with Tauri, with the UI running in the Tauri WebView. Users double-click and it works — the APP never opens a browser, starts an outward-facing service, or reaches the network on its own (invariant I9; the Python core runs as a Tauri-managed sidecar, so "spawns its own core" is internal implementation, not an unauthorized action — see [`docs/design/packaging.md`](docs/design/packaging.md)).

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
2. Items come from the capability pool, which is the `## 路线增量` section of `docs/roadmap/1.x-开发.md`; do not invent scope outside it.
3. New capabilities must map to a design document before implementation; design lives in `docs/design/`.
4. Do not edit versioning semantics (`0.MINOR.PATCH`) without reading `docs/design/versioning.md` first. The project does not commit to a 1.0 — this is a current-state choice, not a permanent promise.
5. Validate any roadmap edit with `uv run python script/roadmap.py` — it checks the item cards, route IDs, nesting, and that parent checkboxes agree with their children.

## 4. Toolchain and Commands

**Always use `uv`.** Every command that has a `uv` equivalent must be run through `uv`:

```bash
uv sync                       # install/sync dependencies (dev group)
uv sync --group tests         # also install the test group
uv run --group tests pytest   # tests
uv run ruff check .           # lint
uv run ruff format .          # format
uv run python -m mypy .       # type check
uv add <package>              # add a dependency
```

Some tools cannot be invoked via `uv run <tool>` on this machine; see §5 "Environment gotchas" for the exact working forms.

Minimize direct edits to `pyproject.toml`. Dependency changes go through `uv add` / `uv remove` so that `uv.lock` stays consistent. Check current status with `uv sync --dry-run` — as of 2026-10-14 it reports everything in sync, so the older "lockfile is out of sync" note in `docs/design/README.md` § "工程侧待办" is stale.

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

**Quality gates (all must pass before merge).** Run them exactly as written — the `uv run <tool>` shorthand does not work for every tool in this environment (see "Environment gotchas" below):

```bash
uv run ruff check .                          # lint
uv run ruff format --check .                 # format check
uv run python -m mypy .                      # type check (strict)
uv run --group tests pytest --cov            # tests + coverage gate
uv run python script/audit.py                # architecture invariants (I1/I2/I3/I4/I7/I9)
uv run python script/roadmap.py              # roadmap conformance
uv run python script/check_secrets.py        # obvious committed secrets
```

`.pre-commit-config.yaml` mirrors these locally. Install once with
`uv run python -m pre_commit install --install-hooks`, then `git commit` runs them.
Keep the two lists in step when adding a gate.

If a gate fails, fix it; do not skip or weaken a gate to get a change through.

**Frontend gates.** The UI is a pnpm project of its own under `app/`; run these from `app/`:

```bash
pnpm check:spdx     # SPDX headers (plain node script, no dependencies)
pnpm lint:js        # ESLint: type-aware + react-hooks + jsx-a11y + token discipline
pnpm lint:css       # stylelint: colour literals only in src/styles/tokens.css
pnpm format:check   # prettier
pnpm typecheck      # tsc --noEmit (strict)
pnpm test           # vitest: token layer bound to docs/design/ui.md, contrast recomputed
pnpm build          # tsc + vite build
pnpm gate           # all of the above, in order
```

They live in three places and must stay in step: this list, `.pre-commit-config.yaml`
(SPDX / eslint / stylelint / prettier) and `.github/workflows/ci.yml` (all of them — the
tests and the production build run in CI only, exactly like pytest).

Two of these are more than lint rules, and both were reverse-verified:

- **`app/src/styles/tokens.test.ts` binds the token layer to the design document.** It reads
  `docs/design/ui.md` and compares every token in §2.3/§2.4/§2.5/§4.1/§4.4 cell by cell,
  checks that the document's `oklch()` and hex forms agree with each other, and
  **recomputes** the §7.1 targets and the §7.2 contrast table. A token value that drifts from
  the design document fails the build. Verified by perturbation: changing `--lr-text-faint`
  from L 0.6 to 0.5 turns both the §7.1 target test and the §7.2 comparison red.
- **Colour literals are mechanically confined to `src/styles/tokens.css`** — ui.md §八 calls
  this "the only mechanical way to keep the two themes equal". stylelint bans hex/rgb/oklch
  in every other stylesheet; ESLint bans hex literals in TS/TSX.

The work is written straight through, so **the tests carry the weight** and the gates are deliberately strict:

- **Coverage is a hard gate**, not a report: `[tool.coverage.report] fail_under = 90`. The run fails when coverage drops. `[tool.coverage.run] patch = ["subprocess"]` is on because the config layer can only be exercised in a subprocess (OnConf's engine is a process singleton) — without it `conf.py` reports 0% and the number means less than it says.
- **mypy is `strict`** over `src`, `tests` and `script`.
- **ruff's rule set is explicit** in `[tool.ruff.lint]`, not left to defaults. Chinese full-width punctuation (`RUF001/2/3`) is ignored on purpose: the docs and comments are written in Chinese and full-width punctuation is correct there.
- **Every invariant is an executable test.** `tests/test_invariants.py` realizes I1–I9; the static half delegates to `script/audit.py`, which is also runnable on its own. Rule detectors are themselves tested with fixtures that *must* trip them — a green audit proves nothing otherwise.
- **A gate that has never been seen to fail is not known to work.** Every frontend gate was reverse-verified by perturbing the thing it guards. That is how the SPDX check was caught passing a deleted header: the first version tested "the first 5 lines contain the marker string", and `app/scripts/check-spdx.mjs`'s own doc comment quotes both markers — so it vouched for itself. It now matches the *shape* of the header line (marker immediately after the comment opener, whole line). Delete a header and it exits 1.
- **Line endings are normalized by `.gitattributes`, not by each contributor's `core.autocrlf`.** Without it, a machine with `autocrlf=true` checks out CRLF while `.editorconfig` declares LF, and every line-ending-aware hook and diff churns.
- **Secret scanning in the pre-commit hook is local and dependency-free** (`script/check_secrets.py`), *not* gitleaks: gitleaks' pre-commit wrapper builds from source and needs a Go toolchain plus the Go module proxy, which makes `pre-commit run --all-files` fail for reasons unrelated to this repository. Full scanning runs in CI.
- **Do not use shell heredocs to write source files.** Bash eats backslash escapes, so `"…;\n"` written through a heredoc turns into a literal newline inside a string literal — a syntax error that looks like a logic bug. Use the file-writing tool, or a generator script written to a file first. (This cost ~15 minutes once; the same broken channel was retried six times instead of being switched.)

**Packaging is a separate pipeline, not one of the gates above.** The desktop APP is built with **Tauri's bundler**, hosting the Python core as a **PyInstaller sidecar** — see [`docs/design/packaging.md`](docs/design/packaging.md). Never report "packaging verified" on the strength of a wheel; `uv build` produces a PyPI distribution and this project does not publish one.

```bash
uv run python script/build_sidecar.py          # build the Python sidecar + self-check
uv run python script/build_sidecar.py --check  # verify an existing artifact only
```

The script exists because three things are easy to get wrong in CI:

- **`.sql` needs explicit `--add-data`.** PyInstaller auto-collects Python modules only; data files are discovered from the source tree by the script so a new `.sql` cannot silently fall out of the build. Verified: without it the artifact raises `FileNotFoundError` **only after installation**.
- **`--paths src` is mandatory** for this src-layout package.
- **`externalBin` takes single files, not directories.** Tauri requires one binary named `<name>-<target-triple>`; the script builds both the `--onedir` layout (chosen for startup cost) and the single-file binary Tauri actually consumes, into `app/src-tauri/binaries/` (git-ignored).

**The build must prove itself.** `--self-check` runs *inside the frozen artifact* and fails the build if the DDL resources are unreadable or the migration cannot run. Reverse-verified: removing `--add-data` makes it report `ok: false` and exit 1. A green build that cannot open its own database is worse than a red one, so do not pass `--skip-check` in CI.

- **Runtime data files must live inside the Python package.** The resource loader reads `importlib.resources`, and the frozen build only ships what is inside the package: a `.sql` file placed under a repo-root directory such as `config/` is **absent from the shipped APP** and it breaks on first launch. SQL lives in `src/lurnia/sql/<schema>/{tables,migrations}/*.sql` (one home for every schema, the kernel's included). `tests/test_ddl.py` asserts the source tree contains no stray repo-root SQL.
- **Anchors in roadmap design references use raw HTML** (`<a id="r106"></a>`), not a heading, so the anchor stays stable if the heading text changes. The marker must be its own line: a trailing `{#r106}` breaks the checker's line model.

**SQL/DDL conventions** (see `docs/design/storage.md` §五): one file per migration target version, `NNNN` = target version, gapless; statements are split with `sqlite3.complete_statement` (no third-party SQL parser); migrations run one statement at a time under an explicit transaction — never `executescript`, which implicitly commits and would break I4 re-entrancy. Migration chains are keyed per schema, so two schemas may both start at version 0.

**Deprecated roadmap items** live in `## 废弃附录` (spec chapter 9): they leave the increment and version assignment, but the ID still **holds its slot** — `script/roadmap.py` counts annex IDs when checking that route IDs stay contiguous.

### Environment gotchas

- **`pytest` lives in the `tests` dependency group**, not `dev`. Plain `uv run pytest` fails with `Failed to spawn: pytest`. Use `uv run --group tests pytest` (or `uv sync --group tests` once).
- **The `.venv` console-script trampolines for `mypy` and `pre-commit` are broken** on this machine (`uv trampoline failed to canonicalize script path`). Invoke them as modules instead: `uv run python -m mypy .`, and `uv run python -m pre_commit run -a`.
- `pyproject.toml` **now carries** `[tool.ruff]`, `[tool.ruff.lint]`, `[tool.mypy]`, `[tool.pytest.ini_options]` and `[tool.coverage.*]`. Change them deliberately: the ruff `select` list and the coverage floor are the project's definition of "done".
- Scratch/throwaway files at the repo root **will break the lint and type gates** for the whole tree — `ruff check .` and `mypy .` scan everything not excluded. Keep them outside the repo or delete them before running gates.
- **OnConf ships no `py.typed` marker**, so `[tool.mypy.overrides]` silences `import-untyped` for it rather than the call site working around it. Drop the override once OnConf ships the marker (upstream is mypy-strict).
- `README.md` is a stub (see `docs/design/README.md` § "工程侧待办").
- The `pyproject.toml` / `uv.lock` state is **in sync as of 2026-10-16** (`uv lock --check` passes), contrary to the older note in `docs/design/README.md`. That older note was wrong in both halves: the lock was never out of sync — `dependencies` had been written into `[build-system]` (PEP 518 only reads `requires` / `build-backend`), so `uv` consistently saw no such dependency. Re-check with `uv lock --check` before adding one.

## 6. Agent Conduct

Rules for how an agent works here. They exist because the scarce resources are the maintainer's time and the agent's context — not the agent's curiosity.

Normative verbs: **must** (required), **should** (recommended), **may** (permitted), **can** (possible).

### 6.1 Answer first

- An agent **must** answer the question it was asked before it investigates anything else. If the answer is already in context or in the agent's own knowledge, it **must** answer in that turn.
- An agent **must not** treat "understanding the whole project" as a precondition for speaking. Reporting is not a reward for finishing a survey.
- An agent **must not** go dark. When work genuinely spans more than a couple of steps, it **should** post a one-line plan at the start and a one-line note at each milestone.

### 6.2 Exploration budget

Investigation is allowed when a specific missing fact blocks the next step. It is not allowed as background curiosity.

- Before a wide sweep — whole-tree listing, recursive search, reading a dependency's source, browsing the upstream GitHub repo — an agent **must** be able to name the fact it needs and what changes if that fact turns out otherwise.
- An agent **must not** scan these paths unless the task is explicitly about them: `.venv/`, `.git/` internals, `.mypy_cache/`, `.ruff_cache/`, `__pycache__/`, `node_modules/`, and the source of third-party packages.
- An agent **must not** take "one more look" after it already has what it needs. That extra look is the behaviour this section exists to stop.
- An agent **should** read the specific file it needs rather than its whole directory, and **must not** re-read, re-search, or re-derive a fact already in context.

### 6.3 Ambiguity

- If a request is genuinely ambiguous, an agent **should** ask one short question and then wait, rather than explore in order to guess the intent.
- If the agent is unsure of a fact, it **must** still answer, marking the assumption and how to check it. Silence is not a substitute for an uncertain answer.

### 6.4 Reporting shape

- The first line **must** be the result: the answer, or what changed and where.
- A report **should** separate what was verified from what was assumed.
- Adjacent problems **may** be mentioned; they **must not** be silently fixed as part of the requested change.

### 6.5 Writing UI in this repository

The UI has three core principles, stated by the maintainer and **normative**:
**留白（whitespace）、精简（minimal）、非必要不动（do not add what is not needed）**.
They live in [`docs/design/ui.md` §1.0](docs/design/ui.md), which ranks them above the rest of
that document. Read them before touching anything under `app/`.

They exist because the failure mode of an agent writing UI is always the same: **adding**.
A box to look complete, a sentence to look thorough, an animation to look polished. So:

- **A pixel that can be deleted without losing information or hierarchy must be deleted.**
- **A sentence that can be deleted while leaving the path walkable must be deleted.**
- Symbols over text. Structure over symbols. Whitespace over structure.
- Do not add borders, shadows, animations or ornament to a region that is not carrying
  information. State changes (hover / press / disabled) are not ornament; decoration is.
- When unsure whether something is needed, leave it out and say so — the maintainer will ask
  for it if they want it.

This applies to the agent's own inventions too: the empty-state essays, the panel title plates
and the status-bar toggles were all written by an agent, and all three have since been removed
under this rule. Do not reintroduce them.

### 6.6 Stop rule

- When the requested deliverable exists and the quality gates in §5 pass, the agent **must** stop. "While I was in there" refactors are out of scope unless asked for.
