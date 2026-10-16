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
from collections.abc import Iterator
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
    Registry,
    RegistryError,
    compile_schema,
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
    doc_type = DocType(name="note", schema=TINY_SCHEMA, extract_text=lambda _b: "")
    registry.register(doc_type)
    with pytest.raises(RegistryError, match="已注册"):
        registry.register(doc_type)


def test_an_unknown_type_is_rejected() -> None:
    with pytest.raises(RegistryError, match="没有注册过"):
        Registry().get("nope")


def test_names_and_capabilities_come_from_registration() -> None:
    registry = Registry()
    registry.register(
        DocType(
            name="canvas",
            schema=TINY_SCHEMA,
            extract_text=lambda _b: "",
            capabilities=frozenset({"ref"}),
        )
    )
    assert registry.names() == ("canvas",)
    assert registry.capabilities("canvas") == frozenset({"ref"})


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
    assert core.db.current_version(SCHEMA) == 1
    assert core.bus.provided("doc.get")
    assert core.bus.provided("doc.save")


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
