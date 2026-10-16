# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""文档组件（路线 108 / 114）的测试。

口径见 [editor.md](../../docs/design/editor.md)：注册表（§3.2）、单遍校验（§3.3、§四）、
两档写入与提交点（§六）、存储形状（§十七）。
"""

from __future__ import annotations

import json
import pathlib
import uuid
from collections.abc import Iterator, Mapping
from typing import Any

import pytest

from lurnia.assembly import Core, assemble
from lurnia.components import builtin_registry, install, load_schema
from lurnia.components.doc import (
    MAX_BODY_BYTES,
    SCHEMA,
    DocStore,
    DocType,
    DocumentError,
    RefIndex,
    Registry,
    RegistryError,
    compile_schema,
    migrate,
    validate,
)
from lurnia.components.note import type as note_type
from lurnia.core.bus import DuplicateProviderError
from lurnia.core.contracts import Command, Err, Ok, Reply, Subject

SUBJECT = Subject(id="tester")

TINY_SCHEMA: dict[str, Any] = {
    "doc_type": "t",
    "version": 1,
    "root": ["box"],
    "nodes": {"box": {"content": ["text"]}},
    "marks": ["strong"],
}


def _type(
    name: str = "t",
    *,
    schema: dict[str, Any] | None = None,
    capabilities: frozenset[str] = frozenset(),
    migrations: Mapping[int, Any] | None = None,
) -> DocType:
    """一个最小文档类型。注册名必须与 schema 里的 doc_type 一致。"""
    return DocType(
        name=name,
        schema=TINY_SCHEMA if schema is None else schema,
        extract_text=lambda _body: "",
        extract_refs=lambda _body: [],
        capabilities=capabilities,
        migrations=dict(migrations or {}),
    )


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------


@pytest.fixture
def core(tmp_path: pathlib.Path) -> Iterator[Core]:
    """一台真核心，但**不绑 OnConf**：它是进程单例，同进程重绑会报错（conf.py）。"""
    built = assemble(tmp_path, bind_config=False)
    try:
        yield built
    finally:
        built.close()


@pytest.fixture
def store(core: Core) -> DocStore:
    return install(core)


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def _call(core: Core, capability: str, request: Any) -> Reply[Any]:
    return core.bus.invoke(
        Command(capability=capability, subject=SUBJECT, request=request)
    )


def _ok(reply: Reply[Any]) -> Any:
    assert isinstance(reply, Ok), reply
    return reply.value


def _bad(reply: Reply[Any]) -> Err:
    assert isinstance(reply, Err), reply
    return reply


def _paragraph(text: str = "正文") -> dict[str, Any]:
    return {
        "type": "paragraph",
        "id": uuid.uuid4().hex,
        "content": [{"type": "text", "text": text}],
    }


def _note(*blocks: dict[str, Any], version: int = 1) -> dict[str, Any]:
    return {
        "doc_type": "note",
        "version": version,
        "content": list(blocks) if blocks else [_paragraph()],
    }


def _save_body(core: Core, body: Any, **extra: Any) -> Reply[Any]:
    request: dict[str, Any] = {"doc_id": "n1", "body": body, "base_revision": 0}
    request.update(extra)
    return _call(core, "doc.save", request)


# --------------------------------------------------------------------------
# 注册表（§3.2）
# --------------------------------------------------------------------------


def test_a_duplicate_type_name_is_a_startup_error() -> None:
    registry = Registry()
    doc_type = _type()
    registry.register(doc_type)
    with pytest.raises(RegistryError, match="已注册"):
        registry.register(doc_type)


def test_a_registration_name_must_match_the_schema() -> None:
    """注册名与 schema 里的 doc_type 不一致 = 早晚对不上账，启动期就拦。"""
    with pytest.raises(RegistryError, match="不一致"):
        Registry().register(_type("canvas"))


def test_an_unknown_type_is_rejected() -> None:
    with pytest.raises(RegistryError, match="没有注册过"):
        Registry().get("nope")


def test_names_and_capabilities_come_from_registration() -> None:
    registry = Registry()
    registry.register(_type(capabilities=frozenset({"ref"})))
    assert registry.names() == ("t",)
    assert registry.capabilities("t") == frozenset({"ref"})


# --------------------------------------------------------------------------
# 单遍校验（§3.3 / §四）
# --------------------------------------------------------------------------


def test_compile_rejects_a_schema_missing_fields() -> None:
    with pytest.raises(DocumentError, match="缺字段"):
        compile_schema({"doc_type": "t", "version": 1})


def test_compile_rejects_a_bad_doc_type_or_version() -> None:
    broken = dict(TINY_SCHEMA, doc_type=1)
    with pytest.raises(DocumentError, match="必须是字符串"):
        compile_schema(broken)


def test_compile_rejects_a_non_object_node_definition() -> None:
    broken = dict(TINY_SCHEMA, nodes={"box": 1})
    with pytest.raises(DocumentError, match="必须是对象"):
        compile_schema(broken)


def test_validate_rejects_a_non_object_body() -> None:
    with pytest.raises(DocumentError, match="JSON 对象"):
        validate(compile_schema(TINY_SCHEMA), ["nope"])


def test_validate_rejects_a_wrong_doc_type() -> None:
    body = {"doc_type": "other", "version": 1, "content": []}
    with pytest.raises(DocumentError, match="文档类型不是"):
        validate(compile_schema(TINY_SCHEMA), body)


def test_validate_rejects_an_unknown_version() -> None:
    body = {"doc_type": "t", "version": 2, "content": [{"type": "box"}]}
    with pytest.raises(DocumentError, match="格式版本不认识"):
        validate(compile_schema(TINY_SCHEMA), body)


def test_validate_rejects_empty_content() -> None:
    body = {"doc_type": "t", "version": 1, "content": []}
    with pytest.raises(DocumentError, match="非空列表"):
        validate(compile_schema(TINY_SCHEMA), body)


def test_validate_rejects_a_non_object_child() -> None:
    body = {"doc_type": "t", "version": 1, "content": ["nope"]}
    with pytest.raises(DocumentError, match="必须是对象"):
        validate(compile_schema(TINY_SCHEMA), body)


def test_validate_rejects_a_child_without_a_type() -> None:
    body = {"doc_type": "t", "version": 1, "content": [{"id": "0" * 32}]}
    with pytest.raises(DocumentError, match="缺少 type"):
        validate(compile_schema(TINY_SCHEMA), body)


def test_validate_rejects_an_unknown_node_type() -> None:
    body = {
        "doc_type": "t",
        "version": 1,
        "content": [{"type": "video", "id": "0" * 32}],
    }
    with pytest.raises(DocumentError, match="不在 schema 的节点清单里"):
        validate(compile_schema(TINY_SCHEMA), body)


def test_validate_rejects_a_node_in_the_wrong_position() -> None:
    body = {
        "doc_type": "t",
        "version": 1,
        "content": [{"type": "text", "text": "x"}],
    }
    with pytest.raises(DocumentError, match="文本节点不允许出现"):
        validate(compile_schema(TINY_SCHEMA), body)


def test_validate_rejects_a_block_in_the_wrong_position() -> None:
    body = {
        "doc_type": "t",
        "version": 1,
        "content": [
            {
                "type": "box",
                "id": "0" * 32,
                "content": [
                    {
                        "type": "box",
                        "id": "1" * 32,
                        "content": [{"type": "text", "text": "太深了"}],
                    }
                ],
            }
        ],
    }
    with pytest.raises(DocumentError, match="不允许出现在这个位置"):
        validate(compile_schema(TINY_SCHEMA), body)


def test_validate_rejects_a_block_without_a_stable_id() -> None:
    body = {"doc_type": "t", "version": 1, "content": [{"type": "box"}]}
    with pytest.raises(DocumentError, match="32 位 hex"):
        validate(compile_schema(TINY_SCHEMA), body)


def test_validate_rejects_a_node_that_must_have_children() -> None:
    body = {"doc_type": "t", "version": 1, "content": [{"type": "box", "id": "0" * 32}]}
    with pytest.raises(DocumentError, match="必须有子节点"):
        validate(compile_schema(TINY_SCHEMA), body)


def test_validate_rejects_a_non_list_content() -> None:
    body = {
        "doc_type": "t",
        "version": 1,
        "content": [{"type": "box", "id": "0" * 32, "content": "nope"}],
    }
    with pytest.raises(DocumentError, match="content 必须是列表"):
        validate(compile_schema(TINY_SCHEMA), body)


def test_validate_rejects_text_without_text() -> None:
    body = {
        "doc_type": "t",
        "version": 1,
        "content": [{"type": "box", "id": "0" * 32, "content": [{"type": "text"}]}],
    }
    with pytest.raises(DocumentError, match="text 必须是字符串"):
        validate(compile_schema(TINY_SCHEMA), body)


def test_validate_rejects_non_list_marks() -> None:
    body = {
        "doc_type": "t",
        "version": 1,
        "content": [
            {
                "type": "box",
                "id": "0" * 32,
                "content": [{"type": "text", "text": "x", "marks": "strong"}],
            }
        ],
    }
    with pytest.raises(DocumentError, match="marks 必须是列表"):
        validate(compile_schema(TINY_SCHEMA), body)


def test_validate_rejects_marks_outside_the_schema() -> None:
    body = {
        "doc_type": "t",
        "version": 1,
        "content": [
            {
                "type": "box",
                "id": "0" * 32,
                "content": [{"type": "text", "text": "x", "marks": [{"type": "em"}]}],
            }
        ],
    }
    with pytest.raises(DocumentError, match="不在 schema 里的标记"):
        validate(compile_schema(TINY_SCHEMA), body)


def test_validate_accepts_a_marked_up_note() -> None:
    """happy path：嵌套列表、表格、行内标记都过。"""
    compiled = compile_schema(
        load_schema("lurnia.components.note", ("schema", "note.schema.json"))
    )
    body = _note(
        _paragraph("第一段"),
        {
            "type": "table",
            "id": uuid.uuid4().hex,
            "content": [
                {
                    "type": "table_row",
                    "id": uuid.uuid4().hex,
                    "content": [
                        {
                            "type": "table_cell",
                            "id": uuid.uuid4().hex,
                            "attrs": {"header": True},
                            "content": [
                                {
                                    "type": "text",
                                    "text": "表头",
                                    "marks": [{"type": "strong"}],
                                }
                            ],
                        }
                    ],
                }
            ],
        },
        {
            "type": "bullet_list",
            "id": uuid.uuid4().hex,
            "content": [
                {
                    "type": "list_item",
                    "id": uuid.uuid4().hex,
                    "content": [_paragraph("列表项")],
                }
            ],
        },
    )
    validate(compiled, body)  # 不抛就是过


# --------------------------------------------------------------------------
# 组合根（§3.1：加一种编辑器 = 注册一个类型）
# --------------------------------------------------------------------------


def test_load_schema_reads_the_packaged_resource() -> None:
    schema = load_schema("lurnia.components.note", ("schema", "note.schema.json"))
    assert schema["doc_type"] == "note"
    assert "table_cell" in schema["nodes"]


def test_builtin_registry_has_the_note_type_and_its_capabilities() -> None:
    registry = builtin_registry()
    assert registry.names() == ("note",)
    assert registry.capabilities("note") == note_type.CAPABILITIES


def test_extract_text_walks_the_tree_and_ignores_non_text() -> None:
    body = _note(
        _paragraph("甲"),
        {"type": "divider", "id": uuid.uuid4().hex},
        _paragraph("乙"),
    )
    assert note_type.extract_text(body) == "甲 乙"
    assert note_type.extract_text({}) == ""
    # 形状不对的节点不该把抽取器带崩：它只捞字符串
    assert note_type.extract_text({"content": [{"type": "text", "text": 5}]}) == ""
    assert note_type.extract_text({"content": "nope"}) == ""


def test_install_creates_the_tables_and_provides_the_capabilities(core: Core) -> None:
    install(core)
    assert core.db.current_version(SCHEMA) == 2
    assert core.bus.provided("doc.get")
    assert core.bus.provided("doc.save")
    assert core.bus.provided("doc.refs.backlinks")
    assert core.bus.provided("doc.annotation.create")


def test_installing_twice_is_not_silently_accepted(core: Core) -> None:
    install(core)
    with pytest.raises(DuplicateProviderError):
        install(core)


# --------------------------------------------------------------------------
# 读（§十七）
# --------------------------------------------------------------------------


def test_get_rejects_a_non_object_request(core: Core) -> None:
    install(core)
    assert _bad(_call(core, "doc.get", ["nope"])).kind.value == "invalid"


def test_get_rejects_a_missing_doc_id(core: Core) -> None:
    install(core)
    assert _bad(_call(core, "doc.get", {"doc_id": ""})).kind.value == "invalid"


def test_get_reports_not_found(core: Core) -> None:
    install(core)
    assert _bad(_call(core, "doc.get", {"doc_id": "nope"})).kind.value == "not_found"


# --------------------------------------------------------------------------
# 写（§六 两档写入、§十七）
# --------------------------------------------------------------------------


def test_save_stores_the_exact_json_text_it_was_given(core: Core) -> None:
    """§3.3 第 2 条：不 re-dump —— 存进去的和校验过的必须是同一份。"""
    install(core)
    body = (
        '{"version":1,   "doc_type":"note","content":['
        + json.dumps(_paragraph())
        + "]}"
    )
    reply = _save_body(core, body, commit=True)
    assert _ok(reply)["revision"] == 1
    row = core.db.connection.execute("SELECT body FROM doc WHERE id = 'n1'").fetchone()
    assert row[0] == body


def test_save_accepts_a_mapping_body(core: Core) -> None:
    install(core)
    assert _ok(_save_body(core, _note()))["revision"] == 0


def test_save_rejects_invalid_json(core: Core) -> None:
    install(core)
    assert _bad(_save_body(core, "{not json")).kind.value == "invalid"


def test_save_rejects_a_body_that_is_neither_text_nor_object(core: Core) -> None:
    install(core)
    assert _bad(_save_body(core, 42)).kind.value == "invalid"


def test_save_rejects_a_non_object_request(core: Core) -> None:
    install(core)
    assert _bad(_call(core, "doc.save", "nope")).kind.value == "invalid"


def test_save_rejects_a_missing_doc_id(core: Core) -> None:
    install(core)
    assert _bad(_call(core, "doc.save", {"body": _note()})).kind.value == "invalid"


def test_save_rejects_a_document_without_doc_type(core: Core) -> None:
    install(core)
    body = {"version": 1, "content": [_paragraph()]}
    assert _bad(_save_body(core, body)).kind.value == "invalid"


def test_save_rejects_an_unregistered_doc_type(core: Core) -> None:
    install(core)
    body = dict(_note(), doc_type="canvas")
    reply = _bad(_save_body(core, body))
    assert reply.kind.value == "invalid"
    assert "canvas" in reply.message


def test_save_rejects_a_document_that_fails_the_schema(core: Core) -> None:
    """§4.4：非法文档在边界被拒，**不落库**。"""
    install(core)
    reply = _bad(_save_body(core, _note(version=2)))
    assert reply.kind.value == "invalid"
    rows = core.db.connection.execute("SELECT count(*) FROM doc").fetchone()
    assert rows[0] == 0


def test_save_reports_unavailable_when_the_type_was_not_prepared(core: Core) -> None:
    """装配漏了 `prepare()` 是内核的错，不是调用方的错 —— 所以是 unavailable。"""
    registry = builtin_registry()
    doc_store = DocStore(core, registry)
    doc_store.ensure_schema()
    doc_store.provide()  # 故意不 prepare()
    assert _bad(_save_body(core, _note())).kind.value == "unavailable"


def test_save_rejects_an_oversized_document(core: Core) -> None:
    doc_store = DocStore(core, builtin_registry(), max_body_bytes=16)
    doc_store.ensure_schema()
    doc_store.prepare()
    doc_store.provide()
    assert _bad(_save_body(core, _note())).kind.value == "invalid"
    assert MAX_BODY_BYTES > 16


@pytest.mark.parametrize("base", [True, 1.5, "0"])
def test_save_rejects_a_non_integer_base_revision(core: Core, base: Any) -> None:
    install(core)
    assert _bad(_save_body(core, _note(), base_revision=base)).kind.value == "invalid"


def test_save_rejects_a_negative_base_revision(core: Core) -> None:
    install(core)
    assert _bad(_save_body(core, _note(), base_revision=-1)).kind.value == "invalid"


def test_save_rejects_a_non_boolean_commit(core: Core) -> None:
    install(core)
    assert _bad(_save_body(core, _note(), commit="yes")).kind.value == "invalid"


def test_auto_save_updates_the_row_without_producing_a_revision(core: Core) -> None:
    """A13：库不因节流膨胀 —— 自动落盘不产生修订行。"""
    install(core)
    assert _ok(_save_body(core, _note()))["revision"] == 0
    assert _ok(_save_body(core, _note(), base_revision=0))["revision"] == 0
    rows = core.db.connection.execute("SELECT count(*) FROM doc_revision").fetchone()
    assert rows[0] == 0


def test_commit_produces_a_revision_row(core: Core) -> None:
    install(core)
    assert _ok(_save_body(core, _note(), commit=True))["revision"] == 1
    first = _ok(_save_body(core, _note(), base_revision=1, commit=True))
    assert first["revision"] == 2
    rows = core.db.connection.execute(
        "SELECT revision FROM doc_revision ORDER BY revision"
    ).fetchall()
    assert [row[0] for row in rows] == [1, 2]


def test_creating_a_missing_document_with_a_nonzero_base_conflicts(core: Core) -> None:
    install(core)
    assert _bad(_save_body(core, _note(), base_revision=3)).kind.value == "conflict"


def test_a_stale_base_revision_conflicts(core: Core) -> None:
    install(core)
    _save_body(core, _note(), commit=True)
    reply = _bad(_save_body(core, _note(), base_revision=0))
    assert reply.kind.value == "conflict"
    assert "revision 1" in reply.message


def test_every_write_lands_an_event_first(core: Core) -> None:
    """I5：写入与事件同事务，事件先落。"""
    install(core)
    _save_body(core, _note(), commit=True)
    rows = core.db.connection.execute(
        "SELECT topic, subject_id FROM event_log ORDER BY seq"
    ).fetchall()
    assert [row[0] for row in rows] == ["doc.saved"]
    assert rows[0][1] == "tester"


def test_the_title_is_derived_from_the_body_unless_given(core: Core) -> None:
    install(core)
    _save_body(core, _note(_paragraph("  派生的标题  ")), commit=True)
    assert _ok(_call(core, "doc.get", {"doc_id": "n1"}))["title"] == "派生的标题"
    _save_body(core, _note(_paragraph("别的")), base_revision=1, title="  显式标题 ")
    assert _ok(_call(core, "doc.get", {"doc_id": "n1"}))["title"] == "显式标题"


def test_get_returns_what_save_wrote(core: Core) -> None:
    install(core)
    body = _note(_paragraph("往返"))
    _save_body(core, body, commit=True)
    got = _ok(_call(core, "doc.get", {"doc_id": "n1"}))
    assert got["body"] == body
    assert got["doc_type"] == "note"
    assert got["body_version"] == 1
    assert got["revision"] == 1


# --------------------------------------------------------------------------
# 108：文档格式版本与迁移链（§4.4，不变量 I4）
# --------------------------------------------------------------------------


def _v2_schema() -> dict[str, Any]:
    """一个「版本 2」的测试类型：节点与 TINY_SCHEMA 相同，只是版本号更高。"""
    return {
        "doc_type": "t",
        "version": 2,
        "root": ["box"],
        "nodes": {"box": {"content": ["text"]}},
        "marks": ["strong"],
    }


def _bump(body: Mapping[str, Any]) -> Mapping[str, Any]:
    """一步迁移：版本 +1，并在正文里留个痕，证明它真的跑过。"""
    moved = dict(body)
    moved["version"] = int(body["version"]) + 1
    return moved


def test_a_migration_chain_with_a_hole_is_rejected() -> None:
    with pytest.raises(RegistryError, match="不连续"):
        Registry().register(_type(schema=_v2_schema(), migrations={0: _bump}))


def test_a_schema_version_below_one_is_rejected() -> None:
    with pytest.raises(RegistryError, match="≥1"):
        Registry().register(_type(schema=dict(TINY_SCHEMA, version=0)))


def test_migrate_walks_every_step_to_the_current_version() -> None:
    schema = dict(_v2_schema(), version=3)
    doc_type = _type(schema=schema, migrations={1: _bump, 2: _bump})
    migrated, from_version = migrate(doc_type, {"doc_type": "t", "version": 1})
    assert migrated["version"] == 3
    assert from_version == 1


def test_migrate_returns_the_same_body_when_it_is_current() -> None:
    body = {"doc_type": "t", "version": 1}
    migrated, from_version = migrate(_type(), body)
    assert migrated == body
    assert from_version == 1


def test_migrate_refuses_a_newer_document() -> None:
    with pytest.raises(DocumentError, match="还新"):
        migrate(_type(), {"doc_type": "t", "version": 2})


def test_migrate_rejects_a_non_integer_version() -> None:
    with pytest.raises(DocumentError, match="≥1 的整数"):
        migrate(_type(), {"doc_type": "t", "version": "1"})


def test_migrate_reports_a_missing_step() -> None:
    """链只从 2 起步，却拿来一份版本 1 的正文 —— 是装配的错，不是数据的错。"""
    doc_type = _type(schema=dict(_v2_schema(), version=3), migrations={2: _bump})
    with pytest.raises(RegistryError, match="缺少"):
        migrate(doc_type, {"doc_type": "t", "version": 1})


def test_migrate_rejects_a_step_that_forgets_to_bump_the_version() -> None:
    doc_type = _type(schema=_v2_schema(), migrations={1: dict})
    with pytest.raises(RegistryError, match="没有把"):
        migrate(doc_type, {"doc_type": "t", "version": 1})


def _custom_store(core: Core, registry: Registry) -> DocStore:
    store = DocStore(core, registry)
    store.ensure_schema()
    store.prepare()
    store.provide()
    return store


def _old_body(version: int) -> dict[str, Any]:
    """一份**格式合法**的老正文：迁移前也得过 schema，不然测不出迁移本身。"""
    return {
        "doc_type": "t",
        "version": version,
        "content": [
            {"type": "box", "id": "a" * 32, "content": [{"type": "text", "text": "老"}]}
        ],
    }


def _store_old_row(core: Core, doc_id: str, body: Any, version: int = 1) -> None:
    """绕过 doc.save，直接塞一份老格式的正文进库（模拟升级前存下的文档）。"""
    core.db.connection.execute(
        "INSERT INTO doc (id, doc_type, title, body, body_version, revision,"
        " created_wall, updated_wall) VALUES (?, 't', '老文档', ?, ?, 1, '', '')",
        (doc_id, body if isinstance(body, str) else json.dumps(body), version),
    )


def test_get_migrates_an_old_document_on_read(core: Core) -> None:
    registry = Registry()
    registry.register(_type(schema=_v2_schema(), migrations={1: _bump}))
    _custom_store(core, registry)
    _store_old_row(core, "old", _old_body(1))

    got = _ok(_call(core, "doc.get", {"doc_id": "old"}))
    assert got["body"]["version"] == 2
    assert got["migrated_from"] == 1
    assert got["body_version"] == 2
    # 迁移是读时发生的：库里还是老格式，下次保存才写回当前版本
    row = core.db.connection.execute(
        "SELECT body_version FROM doc WHERE id = 'old'"
    ).fetchone()
    assert row[0] == 1


def test_get_does_not_report_a_migration_when_none_happened(core: Core) -> None:
    install(core)
    body = _note()
    _save_body(core, body, commit=True)
    assert "migrated_from" not in _ok(_call(core, "doc.get", {"doc_id": "n1"}))


def test_get_rejects_a_corrupt_stored_body(core: Core) -> None:
    install(core)
    _store_old_row(core, "broken", "[不是对象]", version=1)
    reply = _call(core, "doc.get", {"doc_id": "broken"})
    assert isinstance(reply, Err)
    assert reply.kind.value == "invalid"


def test_get_rejects_a_migration_that_produces_an_invalid_body(core: Core) -> None:
    """迁移写歪了要当场报：不能把不合法正文交给前端。"""

    def broken(body: Mapping[str, Any]) -> Mapping[str, Any]:
        return {"doc_type": "t", "version": 2, "content": "不是列表"}

    registry = Registry()
    registry.register(_type(schema=_v2_schema(), migrations={1: broken}))
    _custom_store(core, registry)
    _store_old_row(core, "old", _old_body(1))

    reply = _call(core, "doc.get", {"doc_id": "old"})
    assert isinstance(reply, Err)
    assert reply.kind.value == "invalid"
    assert "迁移后的正文不合法" in reply.message


def test_save_refuses_an_old_format_body(core: Core) -> None:
    registry = Registry()
    registry.register(_type(schema=_v2_schema(), migrations={1: _bump}))
    _custom_store(core, registry)
    reply = _save_body(core, {"doc_type": "t", "version": 1, "content": []})
    assert isinstance(reply, Err)
    assert reply.kind.value == "invalid"
    assert "迁移" in reply.message


# --------------------------------------------------------------------------
# 111：引用与反链（§十）
# --------------------------------------------------------------------------


def _ref_block(target: str, block_id: str | None = None) -> dict[str, Any]:
    return {
        "type": "doc_ref",
        "id": block_id or uuid.uuid4().hex,
        "attrs": {"doc_id": target, "display": "title"},
    }


def _backlinks(core: Core, doc_id: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = _ok(
        _call(core, "doc.refs.backlinks", {"doc_id": doc_id})
    )["backlinks"]
    return rows


def _outgoing(core: Core, doc_id: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = _ok(
        _call(core, "doc.refs.outgoing", {"doc_id": doc_id})
    )["refs"]
    return rows


def test_a_saved_reference_shows_up_as_a_backlink(core: Core) -> None:
    install(core)
    _save_body(core, _note(_paragraph("被引用")))
    core.db.connection.execute(
        "UPDATE doc SET id = 'target' WHERE id = 'n1'"
    )  # 简化：不重开一篇，直接改名
    block = _ref_block("target")
    _save_body(core, _note(block))

    backlinks = _backlinks(core, "target")
    assert [(row["source_doc_id"], row["source_block_id"]) for row in backlinks] == [
        ("n1", block["id"])
    ]
    assert backlinks[0]["source_doc_type"] == "note"


def test_removing_the_reference_removes_the_backlink(core: Core) -> None:
    install(core)
    _save_body(core, _note(_paragraph("被引用")))
    core.db.connection.execute("UPDATE doc SET id = 'target' WHERE id = 'n1'")
    _save_body(core, _note(_ref_block("target")))
    assert len(_backlinks(core, "target")) == 1

    _save_body(core, _note(_paragraph("不引用了")), base_revision=0)
    assert _backlinks(core, "target") == []
    assert _outgoing(core, "n1") == []


def test_backlinks_skip_sources_that_no_longer_exist(core: Core) -> None:
    install(core)
    _save_body(core, _note(_paragraph("被引用")))
    core.db.connection.execute("UPDATE doc SET id = 'target' WHERE id = 'n1'")
    _save_body(core, _note(_ref_block("target")))
    core.db.connection.execute("DELETE FROM doc WHERE id = 'n1'")

    assert _backlinks(core, "target") == []


def test_backlinks_are_one_level_only(core: Core) -> None:
    """A→B→C：C 的反链里只有 B，没有 A（§十：不做传递闭包）。"""
    install(core)
    for doc_id, target in (("c", None), ("b", "c"), ("a", "b")):
        body = (
            _note(_paragraph(doc_id)) if target is None else _note(_ref_block(target))
        )
        _call(core, "doc.save", {"doc_id": doc_id, "body": body})

    assert [row["source_doc_id"] for row in _backlinks(core, "c")] == ["b"]
    assert [row["source_doc_id"] for row in _backlinks(core, "b")] == ["a"]


def test_outgoing_refs_report_dangling_targets(core: Core) -> None:
    install(core)
    _save_body(core, _note(_ref_block("missing")))
    refs = _outgoing(core, "n1")
    assert refs[0]["target_doc_id"] == "missing"
    assert refs[0]["exists"] is False
    assert refs[0]["title"] == ""


def test_outgoing_refs_report_existing_targets(core: Core) -> None:
    install(core)
    _call(core, "doc.save", {"doc_id": "target", "body": _note(_paragraph("在的"))})
    _save_body(core, _note(_ref_block("target")))
    refs = _outgoing(core, "n1")
    assert refs[0]["exists"] is True
    assert refs[0]["title"] == "在的"


def test_ref_capabilities_reject_bad_requests(core: Core) -> None:
    install(core)
    assert isinstance(_call(core, "doc.refs.backlinks", ["x"]), Err)
    assert isinstance(_call(core, "doc.refs.backlinks", {"doc_id": ""}), Err)
    assert isinstance(_call(core, "doc.refs.outgoing", {}), Err)


def test_the_ref_index_is_only_rewritten_when_the_set_changes(core: Core) -> None:
    install(core)
    index = RefIndex(core)
    with core.db.transaction() as tx:
        assert index.replace(tx, "n1", [("t1", "b1")]) is True
        assert index.replace(tx, "n1", [("t1", "b1")]) is False
        assert index.replace(tx, "n1", [("t1", "b1"), ("t2", None)]) is True
    rows = core.db.connection.execute(
        "SELECT target_doc_id, source_block_id FROM doc_ref_index"
        " ORDER BY target_doc_id"
    ).fetchall()
    assert [tuple(row) for row in rows] == [("t1", "b1"), ("t2", "")]


def test_note_extract_refs_reads_doc_ref_nodes() -> None:
    block = _ref_block("other")
    assert note_type.extract_refs(_note(block, _paragraph("正文"))) == [
        ("other", block["id"])
    ]
    assert note_type.extract_refs(_note(_paragraph("没有引用"))) == []
    # 没有 doc_id 的引用节点不算引用（校验器会先拦，这里也不该凭空造一条）
    assert (
        note_type.extract_refs({"content": [{"type": "doc_ref", "id": "a" * 32}]}) == []
    )
