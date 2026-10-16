<!-- SPDX-FileCopyrightText: 2026 HanYang06 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

Thanks for the pull request. Before it can land:

- [ ] `uv run ruff check .` passes
- [ ] `uv run ruff format --check .` passes
- [ ] `uv run python -m mypy .` passes (strict)
- [ ] `uv run --group tests pytest --cov` passes, coverage floor intact (`fail_under = 90`)
- [ ] `uv run python script/audit.py` passes
- [ ] `uv run python script/roadmap.py` passes (if the roadmap changed)

And the parts a script cannot check:

- [ ] **If this touches an invariant**, its executable test in `tests/test_invariants.py` was updated. If the invariant's *meaning* changed, the design doc says so with a date and a reason — it was not widened silently.
- [ ] **If this adds a capability**, it is in the roadmap and has a design document. `设计关联文件` on the roadmap item points at it.
- [ ] **If a persisted format changed**, there is a migration and the snapshot/migration drift check still passes (`script/audit.py` I4).
- [ ] **If a data file was added** (e.g. a `.sql`), it lives inside the Python package — a file outside it is absent from the shipped APP.
- [ ] No "while I was in there" refactors outside the stated scope.

Closes #
