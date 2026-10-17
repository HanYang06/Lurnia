<!-- SPDX-FileCopyrightText: 2026 HanYang06 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Contributing to Lurnia

Thanks for taking a look. This file is the short version; the normative rules
live in [`AGENTS.md`](AGENTS.md), which both humans and agents follow.

## The order of authority is Roadmap > Design > Code

This is not decoration — it is how the project stays coherent:

1. **Roadmap** ([`docs/roadmap/1.x-开发.md`](docs/roadmap/1.x-开发.md)) — what the
   project may contain. Items are parallel; there are no dependencies between
   them. Format is fixed by [`Lurnia-RS-2026.md`](Lurnia-RS-2026.md).
2. **Design** ([`docs/design/`](docs/design/)) — how each item is decided. The
   `设计关联文件` field is the only proof an item *has* a design; code does not
   count.
3. **Code** — the implementation, which follows the two above.

So: a capability that is not in the roadmap, or has no design document, is not
ready to be written. Add it to the roadmap and write the design first.

## Setup

Requires **Python >= 3.14** and [`uv`](https://docs.astral.sh/uv/).

```bash
uv sync --all-groups      # install everything (dev + tests)
```

### The gates

All of these must pass. Run them exactly as written — some tools cannot be
invoked via the `uv run <tool>` shorthand in every environment.

```bash
uv run ruff check .                          # lint
uv run ruff format --check .                 # format check
uv run python -m mypy .                      # type check (strict)
uv run --group tests pytest --cov            # tests + coverage gate
uv run python script/audit.py                # invariants I1/I2/I3/I4/I7/I9
uv run python script/roadmap.py              # roadmap conformance
uv run python script/check_secrets.py        # obvious committed secrets
```

These are mirrored as git hooks, so a failure is caught before the push rather
than after it:

```bash
uv run python -m pre_commit install --install-hooks   # once
uv run python -m pre_commit run --all-files           # run them by hand
```

**Coverage is a hard gate**, not a report: `fail_under = 90` in
`pyproject.toml`. The run fails when coverage drops. Do not lower the floor to
get a change through; add the test.

**A local gotcha, not a project problem:** if `uv run` fails with
`failed to remove ... ruff.exe: 拒绝访问`, the VS Code Ruff extension is holding
the binary (it runs `ruff.exe server`; killing it just respawns it). Use
`uv run --no-sync ...` for that invocation.

**Line endings** are normalized by `.gitattributes` (`eol=lf`), so a Windows
`core.autocrlf=true` setting will not churn the tree. If your checkout already
has CRLF, re-checkout the file after pulling this configuration.

### Packaging (separate from the gates)

The desktop APP is Tauri hosting the Python core as a PyInstaller sidecar:

```bash
uv run python script/build_sidecar.py          # build + self-check inside the artifact
uv run python script/build_sidecar.py --check  # verify an existing artifact
```

`uv build` is **not** the APP build — it produces a PyPI wheel and this project
does not publish one. See [`docs/design/packaging.md`](docs/design/packaging.md).

## Changing an invariant

The nine invariants in [`docs/design/invariants.md`](docs/design/invariants.md)
are hard, and **each one must be realized as an executable test**, not a sentence
in a document. If your change touches one:

- update its test in [`tests/test_invariants.py`](tests/test_invariants.py), and
- if the rule's *meaning* changes, say so explicitly in the design doc with the
  date and the reason — do not widen a rule silently to make a change fit.

A useful pattern this repository relies on: **every rule detector is itself
tested with a fixture that must trip it.** A green audit proves nothing
otherwise.

## Deprecating a roadmap item

Per [`Lurnia-RS-2026.md`](Lurnia-RS-2026.md) chapter 9: a deprecated item leaves
`## 路线增量` and version assignment, and moves to `## 废弃附录` — but **its route
ID still holds its slot** (no reuse, no gap). `script/roadmap.py` enforces this.

## Commits

Conventional Commits. Chinese subjects are fine. Keep the subject about *what
changed*; put the *why* in the body when it is not obvious.

## Reporting

- Security problems: **privately**, see [`SECURITY.md`](SECURITY.md).
- Everything else: an issue. If you are proposing a capability, check the
  roadmap first — it may already be there, or deliberately absent.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
