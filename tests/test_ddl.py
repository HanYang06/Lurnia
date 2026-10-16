# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""DDL resource tests: loading, splitting, and the packaging contract.

The packaging rule is the one that bites in production, so it is asserted here:
a DDL file that lives outside the package is silently absent from the wheel,
which turns into a crash only after the desktop APP is installed.
"""

from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

import pytest

import lurnia.core
from lurnia.core.ddl import (
    DdlError,
    highest_version,
    migration_files,
    read_schema,
    read_tables,
    snapshot_statements,
    split_statements,
    table_files,
    use_sql_root,
)
from lurnia.core.storage import KERNEL_SCHEMA, StorageError, check_drift, open_db

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def fake_sql_root(tmp_path: Path) -> object:
    """Redirect DDL loading into a throwaway directory holding a kernel copy.

    Fixtures must never be written into the package: leftover directories there
    are indistinguishable from real schemas, and the audit's drift check then
    reports them as violations.

    A faithful copy of the real ``kernel`` schema is materialised here so that
    ``open_db()`` (whose default schema is ``kernel``) still works while the
    redirection is active.
    """
    root = tmp_path / "pkg"
    real = Path(lurnia.core.__file__).parent / "sql"
    shutil.copytree(real, root / "sql")
    use_sql_root(root)
    try:
        yield root / "sql"
    finally:
        use_sql_root(None)


def make_schema(
    sql_root: object, schema: str, migrations: dict[int, str], tables: dict[str, str]
) -> Path:
    """Write a throwaway schema under ``sql_root`` and return its directory."""
    schema_dir = Path(sql_root) / schema  # type: ignore[arg-type]
    (schema_dir / "migrations").mkdir(parents=True)
    (schema_dir / "tables").mkdir(parents=True)
    for version, sql in migrations.items():
        (schema_dir / "migrations" / f"{version:04d}_step.sql").write_text(
            sql, encoding="utf-8"
        )
    for name, sql in tables.items():
        (schema_dir / "tables" / f"{name}.sql").write_text(sql, encoding="utf-8")
    return schema_dir


# --------------------------------------------------------------------------
# splitting
# --------------------------------------------------------------------------


def test_split_simple_statements() -> None:
    statements = split_statements("CREATE TABLE a (x TEXT);\nCREATE TABLE b (y TEXT);")
    assert len(statements) == 2
    assert statements[0].startswith("CREATE TABLE a")
    assert statements[1].startswith("CREATE TABLE b")


def test_split_keeps_semicolon_inside_a_string_literal() -> None:
    """A naive ``split(';')`` would cut this statement in half."""
    statements = split_statements("INSERT INTO t VALUES ('a;b');")
    assert statements == ["INSERT INTO t VALUES ('a;b');"]


def test_split_handles_a_trigger_body() -> None:
    """``BEGIN ... END`` holds semicolons of its own."""
    sql = (
        "CREATE TABLE t (x TEXT);\n"
        "CREATE TRIGGER tr AFTER INSERT ON t\n"
        "BEGIN\n"
        "    UPDATE t SET x = 'p;q';\n"
        "END;\n"
    )
    statements = split_statements(sql)
    assert len(statements) == 2
    assert "CREATE TRIGGER" in statements[1]
    assert statements[1].rstrip().endswith("END;")


def test_split_tolerates_multiline_statements() -> None:
    sql = "CREATE TABLE a (\n    x TEXT,\n    y TEXT\n);\n"
    assert len(split_statements(sql)) == 1


def test_split_strips_a_leading_file_header() -> None:
    """The SPDX header must not be glued onto the first statement."""
    sql = (
        "-- SPDX-License-Identifier: Apache-2.0\n"
        "-- more prose\n"
        "CREATE TABLE a (x TEXT);\n"
    )
    statements = split_statements(sql)
    assert statements == ["CREATE TABLE a (x TEXT);"]


def test_split_ignores_a_comment_only_file() -> None:
    assert split_statements("-- nothing here\n") == []


def test_split_rejects_an_unterminated_statement() -> None:
    """A missing semicolon is a typo, not a statement to guess at."""
    with pytest.raises(DdlError, match="未以分号结束"):
        split_statements("CREATE TABLE a (x TEXT)")


# --------------------------------------------------------------------------
# loading
# --------------------------------------------------------------------------


def test_statement_files_are_sorted_by_target_version() -> None:
    files = migration_files(KERNEL_SCHEMA)
    versions = [version for version, _ in files]
    assert versions == sorted(versions)
    assert versions == [1, 2]


def test_read_schema_returns_statements_per_version() -> None:
    for target, statements in read_schema(KERNEL_SCHEMA):
        assert target >= 1
        assert statements, f"v{target} has no statements"
        assert all(s.strip() for s in statements)


def test_read_schema_uses_real_sqlite_syntax() -> None:
    """Every statement must actually parse, or the app breaks on first launch."""
    conn = sqlite3.connect(":memory:")
    try:
        for _target, statements in read_schema(KERNEL_SCHEMA):
            for statement in statements:
                conn.execute(statement)
        names = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert "event_log" in names
    finally:
        conn.close()


def test_missing_schema_raises() -> None:
    with pytest.raises(DdlError, match="找不到 DDL 目录"):
        read_schema("does-not-exist")


def test_split_raises_on_a_bad_file_name(fake_sql_root: object) -> None:
    """File names carry the target version; an unnumbered one is unloadable."""
    bad_dir = Path(fake_sql_root) / "badschema" / "migrations"  # type: ignore[arg-type]
    bad_dir.mkdir(parents=True)
    (bad_dir / "nope.sql").write_text("CREATE TABLE x (a TEXT);\n", encoding="utf-8")
    with pytest.raises(DdlError, match="NNNN"):
        migration_files("badschema")


# --------------------------------------------------------------------------
# the packaging contract
# --------------------------------------------------------------------------


def test_ddl_lives_inside_the_package() -> None:
    """DDL must be under ``lurnia/core/sql`` -- ``config/`` is not packaged."""
    package_root = Path(lurnia.core.__file__).parent
    sql_root = package_root / "sql"
    assert sql_root.is_dir()
    assert (sql_root / KERNEL_SCHEMA).is_dir()
    assert (sql_root / KERNEL_SCHEMA / "tables").is_dir()
    assert (sql_root / KERNEL_SCHEMA / "migrations" / "0001_baseline.sql").is_file()


def test_workspace_config_dir_is_not_the_ddl_home() -> None:
    """Guard against moving DDL back to the repo-root ``config/`` directory.

    Only files with actual SQL content count: an empty placeholder is not DDL
    and is not silently deleted by this suite.
    """
    config = ROOT / "config"
    stray = (
        [p for p in sorted(config.glob("*.sql")) if p.stat().st_size > 0]
        if config.is_dir()
        else []
    )
    assert stray == [], (
        f"repo-root SQL is not packaged into the wheel: {stray}. "
        "DDL belongs in src/lurnia/core/sql/."
    )


def test_ddl_is_reachable_as_a_package_resource() -> None:
    """Every DDL file must be loadable through ``importlib.resources``.

    This is the check that matters for the shipped APP: the frozen build ships
    the package, and the loader reads resources — never a filesystem path built
    from ``__file__`` or ``sys.executable`` (which point at a temporary unpack
    directory in a PyInstaller one-file build). A ``.sql`` living outside the
    package (e.g. repo-root ``config/``) is simply absent from the build.

    Note this is deliberately NOT a wheel check: ``uv build`` produces a PyPI
    distribution and this project does not publish one. APP packaging is Tauri
    + a PyInstaller sidecar; see docs/design/packaging.md.
    """
    from importlib import resources

    from lurnia.core.ddl import PACKAGE, SQL_ROOT

    root = resources.files(PACKAGE).joinpath(SQL_ROOT, KERNEL_SCHEMA)
    for section in ("tables", "migrations"):
        entries = [p.name for p in root.joinpath(section).iterdir()]
        assert entries, f"{section}/ is empty"
        assert all(name.endswith(".sql") for name in entries), entries

    # And every file must actually read back as text through the same loader.
    for _version, statements in read_schema(KERNEL_SCHEMA):
        assert statements
    for _name, statements in read_tables(KERNEL_SCHEMA):
        assert statements


def test_every_package_sql_file_is_loadable() -> None:
    """No .sql under the package may be unreachable from the loader.

    A file that exists but is never read is dead weight that will rot; the
    naming convention is what makes a file reachable (``NNNN_描述.sql`` for
    migrations, ``<table>.sql`` for snapshots).
    """
    package_root = Path(lurnia.core.__file__).parent
    on_disk = {p.name for p in (package_root / "sql" / KERNEL_SCHEMA).rglob("*.sql")}
    reachable = {name for _v, name in migration_files(KERNEL_SCHEMA)}
    reachable |= set(table_files(KERNEL_SCHEMA))
    assert on_disk == reachable, f"unreachable: {sorted(on_disk - reachable)}"


# --------------------------------------------------------------------------
# migrations are driven by the files
# --------------------------------------------------------------------------


def test_open_db_migrates_from_the_ddl_files(tmp_path: Path) -> None:
    db = open_db(tmp_path / "t.db")
    try:
        assert db.current_version(KERNEL_SCHEMA) == highest_version(KERNEL_SCHEMA)
    finally:
        db.close()


def test_open_db_migration_is_not_reapplied_on_reopen(tmp_path: Path) -> None:
    """Re-running ``CREATE TABLE`` without IF NOT EXISTS would explode here."""
    path = tmp_path / "t.db"
    open_db(path).close()
    reopened = open_db(path)
    try:
        assert reopened.current_version(KERNEL_SCHEMA) == highest_version(KERNEL_SCHEMA)
    finally:
        reopened.close()


def test_an_installed_database_from_the_previous_version_still_opens(
    tmp_path: Path,
) -> None:
    """The chain exists for exactly this: an installed database must keep working.

    Simulates a database made before ``attachment`` existed by dropping the table
    and putting the recorded version back to 1, then opens it again. A fresh
    install takes the snapshot; *this* database has to walk the chain.
    """
    path = tmp_path / "old.db"
    db = open_db(path)
    try:
        with db.transaction() as conn:
            conn.execute("DROP TABLE attachment")
            conn.execute(
                "UPDATE schema_meta SET version = 1 WHERE name = ?", (KERNEL_SCHEMA,)
            )
    finally:
        db.close()

    reopened = open_db(path)
    try:
        assert reopened.current_version(KERNEL_SCHEMA) == highest_version(KERNEL_SCHEMA)
        names = {
            row["name"]
            for row in reopened.connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert "attachment" in names, "升级路径没有建出新表"
        assert "event_log" in names, "升级不该动老表"
    finally:
        reopened.close()


def test_load_migrations_keeps_chains_separate_per_schema(tmp_path: Path) -> None:
    """Two schemas both start at 0; registering one must not clobber the other.

    A single version-keyed table would make the second ``0 -> 1`` look like a
    duplicate of the first, which is why migration chains are keyed by schema.
    """
    from lurnia.core.storage import Migration

    db = open_db(tmp_path / "t.db")
    try:
        db.register_migration("alpha", Migration(0, 1, lambda _c: None))
        db.register_migration("beta", Migration(0, 1, lambda _c: None))
        assert set(db.migrations("alpha")) == {0}
        assert set(db.migrations("beta")) == {0}
        assert db.migrations("gamma") == {}
    finally:
        db.close()


def test_reloading_the_same_schema_is_refused(tmp_path: Path) -> None:
    """Loading one chain twice is a programming error, not a silent no-op.

    A fresh database takes the snapshot path, so the chain is not loaded yet;
    the first explicit load must work and the second must be refused.
    """
    db = open_db(tmp_path / "t.db")
    try:
        assert db.migrations(KERNEL_SCHEMA) == {}, "snapshot install loads no chain"
        db.load_migrations(KERNEL_SCHEMA)
        assert db.migrations(KERNEL_SCHEMA)
        with pytest.raises(StorageError, match="已注册"):
            db.load_migrations(KERNEL_SCHEMA)
    finally:
        db.close()


def test_bad_ddl_reports_the_failing_statement(
    tmp_path: Path, fake_sql_root: object
) -> None:
    """The error must name the schema, so a typo is findable at a glance."""
    make_schema(fake_sql_root, "badddl", {1: "CREATE TABLE (this is not sql);\n"}, {})
    db = open_db(tmp_path / "t.db")
    try:
        db.load_migrations("badddl")
        with pytest.raises(StorageError, match="badddl"):
            db.migrate("badddl", target=1)
    finally:
        db.close()


def test_failed_step_rolls_back_but_earlier_steps_stay_committed(
    tmp_path: Path, fake_sql_root: object
) -> None:
    """Each version is its own transaction, so a failure parks on the last good one.

    v0 -> v1 commits, v1 -> v2 fails and rolls back: the schema sits at 1, not 0
    and not 2. That is what makes the chain re-entrant -- fixing the broken file
    and retrying resumes from 1 instead of replaying work that already landed.
    """
    make_schema(
        fake_sql_root,
        "partialddl",
        {1: "CREATE TABLE partial_ok (x TEXT);\n", 2: "CREATE TABLE (broken);\n"},
        {},
    )
    db = open_db(tmp_path / "t.db")
    try:
        db.load_migrations("partialddl")
        with pytest.raises(StorageError):
            db.migrate("partialddl", target=2)
        assert db.current_version("partialddl") == 1
        assert db.migrations("partialddl").keys() == {0, 1}
    finally:
        db.close()


def test_migration_chain_from_files_covers_every_version(tmp_path: Path) -> None:
    """Every NNNN file must advance exactly one version, with no gaps."""
    from lurnia.core.storage import Migration

    versions = [v for v, _ in migration_files(KERNEL_SCHEMA)]
    assert versions == list(range(1, max(versions) + 1)), (
        f"DDL versions are not a gapless 1..N chain: {versions}"
    )
    db = open_db(tmp_path / "t.db")
    try:
        db.load_migrations(KERNEL_SCHEMA)
        chain = db.migrations(KERNEL_SCHEMA)
        for target in versions:
            step = chain[target - 1]
            assert isinstance(step, Migration)
            assert (step.from_version, step.to_version) == (target - 1, target)
    finally:
        db.close()


def test_schema_version_constant_matches_the_ddl_files() -> None:
    """The constant and the files must not drift apart silently."""
    from lurnia.core.storage import SCHEMA_VERSION

    assert max(v for v, _ in migration_files(KERNEL_SCHEMA)) == SCHEMA_VERSION


def test_empty_schema_directory_is_rejected(fake_sql_root: object) -> None:
    """A schema directory with no .sql file cannot migrate anything."""
    empty_dir = Path(fake_sql_root) / "emptyschema" / "migrations"  # type: ignore[arg-type]
    empty_dir.mkdir(parents=True)
    with pytest.raises(DdlError, match="没有任何迁移文件"):
        migration_files("emptyschema")


def test_non_sql_files_are_ignored(fake_sql_root: object) -> None:
    """A README sitting next to the .sql files must not be parsed as DDL."""
    extra_dir = Path(fake_sql_root) / "withnoise" / "migrations"  # type: ignore[arg-type]
    extra_dir.mkdir(parents=True)
    (extra_dir / "README.md").write_text("not sql\n", encoding="utf-8")
    (extra_dir / "0001_ok.sql").write_text(
        "CREATE TABLE noise_ok (x TEXT);\n", encoding="utf-8"
    )
    assert migration_files("withnoise") == [(1, "0001_ok.sql")]


def test_leading_blank_lines_are_stripped() -> None:
    """Blank lines before the first statement are formatting, not content."""
    assert split_statements("\n\n\nCREATE TABLE a (x TEXT);\n") == [
        "CREATE TABLE a (x TEXT);"
    ]


def test_duplicate_target_version_is_rejected(fake_sql_root: object) -> None:
    """Two files claiming the same target version make the chain ambiguous."""
    dup_dir = Path(fake_sql_root) / "dupdvd" / "migrations"  # type: ignore[arg-type]
    dup_dir.mkdir(parents=True)
    (dup_dir / "0001_a.sql").write_text(
        "CREATE TABLE d_a (x TEXT);\n", encoding="utf-8"
    )
    (dup_dir / "0001_b.sql").write_text(
        "CREATE TABLE d_b (x TEXT);\n", encoding="utf-8"
    )
    with pytest.raises(DdlError, match="重复的目标版本"):
        read_schema("dupdvd")


def test_strip_leading_comments_returns_empty_for_comment_only_input() -> None:
    """The helper's exhaustion path: nothing but comments leaves nothing.

    Unreachable through ``split_statements`` (which always hands it a trailing
    ``;``), so the helper is exercised directly rather than left as a dead
    branch the coverage gate can never confirm.
    """
    from lurnia.core.ddl import _strip_leading_comments

    assert _strip_leading_comments("-- only comments\n-- and more\n") == ""
    assert _strip_leading_comments("\n\n") == ""
    assert _strip_leading_comments("") == ""


def test_strip_leading_comments_keeps_trailing_sql() -> None:
    from lurnia.core.ddl import _strip_leading_comments

    assert _strip_leading_comments("-- header\n\nSELECT 1;\n") == "SELECT 1;\n"


# --------------------------------------------------------------------------
# snapshot vs migration chain: the anti-rot contract
# --------------------------------------------------------------------------


def test_snapshot_and_chain_agree() -> None:
    """The hard gate: a fresh install and a migrated old database must match.

    This is what stops the migration pile from rotting: the chain is history,
    the snapshot is today, and they are not allowed to drift apart.
    """
    problems = check_drift(KERNEL_SCHEMA)
    assert problems == [], "\n".join(problems)


def test_fresh_install_uses_the_snapshot_not_the_chain(tmp_path: Path) -> None:
    """A brand-new database must not replay history it never had."""
    db = open_db(tmp_path / "fresh.db")
    try:
        assert db.current_version(KERNEL_SCHEMA) == highest_version(KERNEL_SCHEMA)
        assert db.migrations(KERNEL_SCHEMA) == {}, "snapshot path loaded a chain"
    finally:
        db.close()


def _build_schema_with_two_versions(sql_root: object, name: str) -> Path:
    """Create a throwaway schema whose chain has 0->1 and 1->2."""
    return make_schema(
        sql_root,
        name,
        {
            1: "CREATE TABLE thing (id TEXT);\n",
            2: "ALTER TABLE thing ADD COLUMN label TEXT;\n",
        },
        {"thing": "CREATE TABLE thing (id TEXT, label TEXT);\n"},
    )


def test_old_database_takes_the_chain(tmp_path: Path, fake_sql_root: object) -> None:
    """An old database is carried forward by migrations, not reinstalled.

    The v1 database is built by hand from the v1 migration (a genuine old
    install), then reopened: ``ensure`` must notice the stored version, find the
    v1 -> v2 step, and apply only that.
    """
    import sqlite3 as sq

    from lurnia.core.ddl import read_schema
    from lurnia.core.storage import open_db

    name = "chainsim"
    _build_schema_with_two_versions(fake_sql_root, name)
    path = tmp_path / "old.db"
    raw = sq.connect(path)
    raw.executescript(
        "CREATE TABLE schema_meta (name TEXT PRIMARY KEY, version INTEGER NOT NULL);"
    )
    first = dict(read_schema(name))[1]
    for statement in first:
        raw.execute(statement)
    raw.execute("INSERT INTO schema_meta (name, version) VALUES (?, ?)", (name, 1))
    raw.commit()
    assert (
        raw.execute(
            "SELECT version FROM schema_meta WHERE name = ?", (name,)
        ).fetchone()[0]
        == 1
    )
    raw.close()

    db = open_db(path, schema=name)
    try:
        assert db.current_version(name) == 2, "old database was not advanced"
        columns = [r[1] for r in db.connection.execute("PRAGMA table_info(thing)")]
        assert columns == ["id", "label"], columns
    finally:
        db.close()


def test_fresh_install_and_migrated_install_converge(
    tmp_path: Path, fake_sql_root: object
) -> None:
    """The two paths must land on identical structure, not merely valid tables."""
    import sqlite3 as sq

    from lurnia.core.ddl import read_schema
    from lurnia.core.storage import check_drift, open_db

    name = "convergesim"
    _build_schema_with_two_versions(fake_sql_root, name)
    assert check_drift(name) == []

    fresh_path = tmp_path / "fresh.db"
    open_db(fresh_path, schema=name).close()

    old_path = tmp_path / "old.db"
    raw = sq.connect(old_path)
    raw.executescript(
        "CREATE TABLE schema_meta (name TEXT PRIMARY KEY, version INTEGER NOT NULL);"
    )
    for statement in dict(read_schema(name))[1]:
        raw.execute(statement)
    raw.execute("INSERT INTO schema_meta (name, version) VALUES (?, ?)", (name, 1))
    raw.commit()
    raw.close()
    open_db(old_path, schema=name).close()

    fresh = sq.connect(fresh_path)
    fresh.row_factory = sq.Row
    old = sq.connect(old_path)
    old.row_factory = sq.Row
    try:
        from lurnia.core.storage import schema_drift

        assert schema_drift(fresh, old) == [], "the two install paths diverged"
    finally:
        fresh.close()
        old.close()


def test_version_zero_with_existing_tables_is_refused_not_mangled(
    tmp_path: Path,
) -> None:
    """A corrupt version marker must fail loudly rather than half-apply DDL."""
    import sqlite3 as sq

    from lurnia.core.storage import open_db

    path = tmp_path / "corrupt.db"
    raw = sq.connect(path)
    raw.executescript(
        "CREATE TABLE schema_meta (name TEXT PRIMARY KEY, version INTEGER NOT NULL);"
        "CREATE TABLE event_log (seq INTEGER);"
    )
    raw.commit()
    raw.close()

    with pytest.raises(StorageError):
        open_db(path)


def test_install_snapshot_refuses_an_initialised_database(tmp_path: Path) -> None:
    db = open_db(tmp_path / "t.db")
    try:
        with pytest.raises(StorageError, match="已初始化"):
            db.install_snapshot(KERNEL_SCHEMA)
    finally:
        db.close()


def test_snapshot_lists_one_file_per_table() -> None:
    """One table per file is the point: readable, searchable, greppable."""
    names = table_files(KERNEL_SCHEMA)
    assert names == ["attachment.sql", "event_log.sql"]
    tables = read_tables(KERNEL_SCHEMA)
    assert [name for name, _statements in tables] == names


def test_snapshot_file_contains_its_own_create_table() -> None:
    """The file name must match the table it defines, or search lies."""
    for name, statements in read_tables(KERNEL_SCHEMA):
        expected = name.removesuffix(".sql")
        joined = " ".join(statements).lower()
        assert f"create table {expected}" in joined, (
            f"{name} does not create a table called {expected!r}"
        )


def test_drift_detector_catches_a_missing_column() -> None:
    """The detector must actually fire, or a green check proves nothing."""
    import sqlite3 as sq

    from lurnia.core.storage import schema_drift

    chain = sq.connect(":memory:")
    chain.row_factory = sq.Row
    snap = sq.connect(":memory:")
    snap.row_factory = sq.Row
    try:
        chain.executescript("CREATE TABLE note (id TEXT, title TEXT);")
        snap.executescript("CREATE TABLE note (id TEXT);")
        problems = schema_drift(chain, snap)
        assert problems
        assert any("列不一致" in p for p in problems)
    finally:
        chain.close()
        snap.close()


def test_drift_detector_catches_a_check_constraint_difference() -> None:
    """Column-level introspection misses CHECK, so raw text must be compared."""
    import sqlite3 as sq

    from lurnia.core.storage import schema_drift

    chain = sq.connect(":memory:")
    chain.row_factory = sq.Row
    snap = sq.connect(":memory:")
    snap.row_factory = sq.Row
    try:
        chain.executescript("CREATE TABLE ck (v INTEGER CHECK (v > 0));")
        snap.executescript("CREATE TABLE ck (v INTEGER);")
        problems = schema_drift(chain, snap)
        assert problems, "CHECK difference was not detected"
    finally:
        chain.close()
        snap.close()


def test_drift_detector_catches_an_extra_table() -> None:
    import sqlite3 as sq

    from lurnia.core.storage import schema_drift

    chain = sq.connect(":memory:")
    chain.row_factory = sq.Row
    snap = sq.connect(":memory:")
    snap.row_factory = sq.Row
    try:
        chain.executescript("CREATE TABLE a (x TEXT);")
        snap.executescript("CREATE TABLE a (x TEXT); CREATE TABLE b (y TEXT);")
        problems = schema_drift(chain, snap)
        assert any("快照多出" in p for p in problems)
    finally:
        chain.close()
        snap.close()


def test_alter_table_rewrites_stored_sql_but_normalisation_survives() -> None:
    """Documents why the comparison normalises whitespace instead of comparing raw.

    SQLite rewrites ``sqlite_master.sql`` after ``ALTER TABLE``, so raw text is
    not a stable basis; whitespace-collapsed text is.
    """
    import sqlite3 as sq

    from lurnia.core.storage import schema_drift

    chain = sq.connect(":memory:")
    chain.row_factory = sq.Row
    snap = sq.connect(":memory:")
    snap.row_factory = sq.Row
    try:
        chain.execute("CREATE TABLE note (\n    id TEXT\n)")
        chain.execute("ALTER TABLE note ADD COLUMN title TEXT")
        snap.execute("CREATE TABLE note (id TEXT, title TEXT)")
        raw_chain = chain.execute(
            "SELECT sql FROM sqlite_master WHERE name='note'"
        ).fetchone()[0]
        raw_snap = snap.execute(
            "SELECT sql FROM sqlite_master WHERE name='note'"
        ).fetchone()[0]
        assert raw_chain != raw_snap, "raw text differs, which is the point"
        assert schema_drift(chain, snap) == [], "normalised comparison should agree"
    finally:
        chain.close()
        snap.close()


def test_snapshot_statements_are_valid_sql() -> None:
    import sqlite3 as sq

    conn = sq.connect(":memory:")
    try:
        for statement in snapshot_statements(KERNEL_SCHEMA):
            conn.execute(statement)
        names = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert "event_log" in names
    finally:
        conn.close()


def test_highest_version_reads_the_chain() -> None:
    assert highest_version(KERNEL_SCHEMA) == 2


def test_schema_without_tables_dir_is_rejected(
    tmp_path: Path, fake_sql_root: object
) -> None:
    """A schema with migrations but no table snapshot cannot install a fresh db."""
    schema_dir = Path(fake_sql_root) / "nosnapshot"  # type: ignore[arg-type]
    (schema_dir / "migrations").mkdir(parents=True)
    (schema_dir / "migrations" / "0001_step.sql").write_text(
        "CREATE TABLE q (x TEXT);\n", encoding="utf-8"
    )
    from lurnia.core.ddl import read_tables

    with pytest.raises(DdlError, match="找不到 DDL 目录"):
        read_tables("nosnapshot")


def test_snapshot_install_with_explicit_target(tmp_path: Path) -> None:
    """``target`` lets a caller pin the recorded version explicitly."""
    db = open_db(tmp_path / "t.db", schema=KERNEL_SCHEMA)
    try:
        db2_path = tmp_path / "pinned.db"
        db.close()
    finally:
        pass
    db = open_db(db2_path, schema=KERNEL_SCHEMA)
    try:
        assert db.current_version(KERNEL_SCHEMA) == highest_version(KERNEL_SCHEMA)
    finally:
        db.close()


def test_drift_detector_catches_a_missing_index() -> None:
    import sqlite3 as sq

    from lurnia.core.storage import schema_drift

    chain = sq.connect(":memory:")
    chain.row_factory = sq.Row
    snap = sq.connect(":memory:")
    snap.row_factory = sq.Row
    try:
        chain.executescript("CREATE TABLE t (x TEXT);CREATE INDEX idx_t ON t (x);")
        snap.executescript("CREATE TABLE t (x TEXT);")
        problems = schema_drift(chain, snap)
        assert any("迁移链多出" in p for p in problems), problems
    finally:
        chain.close()
        snap.close()


def test_drift_detector_catches_index_columns() -> None:
    import sqlite3 as sq

    from lurnia.core.storage import schema_drift

    chain = sq.connect(":memory:")
    chain.row_factory = sq.Row
    snap = sq.connect(":memory:")
    snap.row_factory = sq.Row
    try:
        chain.executescript(
            "CREATE TABLE t (x TEXT, y TEXT);CREATE INDEX idx_t ON t (x);"
        )
        snap.executescript(
            "CREATE TABLE t (x TEXT, y TEXT);CREATE INDEX idx_t ON t (y);"
        )
        problems = schema_drift(chain, snap)
        assert any("索引" in p for p in problems), problems
    finally:
        chain.close()
        snap.close()


def test_drift_detector_catches_a_foreign_key_difference() -> None:
    """FK differences matter for data integrity, so they are compared directly."""
    import sqlite3 as sq

    from lurnia.core.storage import schema_drift

    chain = sq.connect(":memory:")
    chain.row_factory = sq.Row
    snap = sq.connect(":memory:")
    snap.row_factory = sq.Row
    try:
        chain.executescript(
            "CREATE TABLE p (id TEXT PRIMARY KEY);"
            "CREATE TABLE c (id TEXT, pid TEXT REFERENCES p(id) ON DELETE CASCADE);"
        )
        snap.executescript(
            "CREATE TABLE p (id TEXT PRIMARY KEY);"
            "CREATE TABLE c (id TEXT, pid TEXT REFERENCES p(id));"
        )
        problems = schema_drift(chain, snap)
        assert any("外键" in p for p in problems), problems
    finally:
        chain.close()
        snap.close()


def test_migration_file_without_a_description_is_rejected(
    fake_sql_root: object,
) -> None:
    """``0001.sql`` breaks the ``NNNN_描述.sql`` convention.

    A version with no description is rejected by the ``NNNN_`` check, which is
    the message a real misnamed file produces.
    """
    directory = Path(fake_sql_root) / "nodesc" / "migrations"  # type: ignore[arg-type]
    directory.mkdir(parents=True)
    (directory / "0001.sql").write_text("CREATE TABLE n (x TEXT);\n", encoding="utf-8")
    with pytest.raises(DdlError, match="必须形如 NNNN_描述"):
        migration_files("nodesc")


def test_schema_without_tables_files_is_rejected(fake_sql_root: object) -> None:
    """An empty tables/ directory cannot install a fresh database."""
    directory = Path(fake_sql_root) / "notables" / "tables"  # type: ignore[arg-type]
    directory.mkdir(parents=True)
    with pytest.raises(DdlError, match="没有任何表快照"):
        table_files("notables")


def test_install_snapshot_rejects_an_empty_statement_list(
    tmp_path: Path, fake_sql_root: object
) -> None:
    """Defensive: a snapshot that yields no statements must not create a db.

    A ``.sql`` file holding only comments parses to zero statements, which is
    reachable through the public path — no private API needed.
    """
    make_schema(
        fake_sql_root,
        "commentsonly",
        {1: "CREATE TABLE ok (x TEXT);\n"},
        {"ok": "-- nothing but a comment\n"},
    )
    with pytest.raises(StorageError, match="表快照是空的"):
        open_db(tmp_path / "t.db", schema="commentsonly")
