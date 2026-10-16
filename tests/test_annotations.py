# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""批注与锚点（路线 112；口径见 [editor.md](../../docs/design/editor.md) §五、§十一）。

这一批的核心不是"存一条批注"，而是**正文改了以后锚点还找不找得到**：

* 快路径（偏移没动）→ 慢路径（偏移飘了，按引文找）→ 多命中消歧 → `orphaned`；
* **找不到不删批注**，只是状态变 `orphaned`（§五：静默丢弃是最不能接受的结果）。
"""

from __future__ import annotations

import json
import pathlib
import uuid
from collections.abc import Iterator
from typing import Any

import pytest

from lurnia.assembly import Core, assemble
from lurnia.components import install
from lurnia.components.doc import (
    ACTIVE,
    ORPHANED,
    Anchor,
    DocumentError,
    block_texts,
    plain_text,
    relocate,
)
from lurnia.core.contracts import Command, Err, Ok, Reply, Subject

SUBJECT = Subject(id="tester")


@pytest.fixture
def core(tmp_path: pathlib.Path) -> Iterator[Core]:
    built = assemble(tmp_path, bind_config=False)
    try:
        yield built
    finally:
        built.close()


@pytest.fixture
def ready(core: Core) -> Core:
    install(core)
    return core


def _call(core: Core, capability: str, request: Any) -> Reply[Any]:
    return core.bus.invoke(
        Command(capability=capability, subject=SUBJECT, request=request)
    )


def _ok(reply: Reply[Any]) -> Any:
    assert isinstance(reply, Ok), reply
    return reply.value


def _paragraph(text: str, block_id: str | None = None) -> dict[str, Any]:
    return {
        "type": "paragraph",
        "id": block_id or uuid.uuid4().hex,
        "content": [{"type": "text", "text": text}],
    }


def _note(*blocks: dict[str, Any]) -> dict[str, Any]:
    return {"doc_type": "note", "version": 1, "content": list(blocks)}


def _save(core: Core, doc_id: str, body: dict[str, Any], **extra: Any) -> Reply[Any]:
    request: dict[str, Any] = {"doc_id": doc_id, "body": body}
    request.update(extra)
    return _call(core, "doc.save", request)


def _anchor(
    block_id: str, offset: int, length: int, quote: str, **extra: Any
) -> dict[str, Any]:
    anchor: dict[str, Any] = {
        "block_id": block_id,
        "offset": offset,
        "length": length,
        "quote": quote,
    }
    anchor.update(extra)
    return anchor


def _create(
    core: Core, doc_id: str, anchor: dict[str, Any], body: str = "这里要问一句"
) -> Reply[Any]:
    return _call(
        core,
        "doc.annotation.create",
        {"doc_id": doc_id, "anchor": anchor, "body": body},
    )


# --------------------------------------------------------------------------
# 锚点的形状（§五）
# --------------------------------------------------------------------------


def test_anchor_round_trips_through_json() -> None:
    anchor = Anchor.parse(
        {
            "block_id": "a" * 32,
            "offset": 2,
            "length": 2,
            "quote": "天气",
            "prefix": "今天",
            "suffix": "很好",
        }
    )
    assert Anchor.parse(anchor.to_json()) == anchor


@pytest.mark.parametrize(
    "raw",
    [
        "nope",
        {"block_id": "短", "offset": 0, "length": 1, "quote": "x"},
        {"block_id": "a" * 32, "offset": -1, "length": 1, "quote": "x"},
        {"block_id": "a" * 32, "offset": 0, "length": 1, "quote": ""},
        {"block_id": "a" * 32, "offset": 0, "length": 5, "quote": "长"},
        {"block_id": "a" * 32, "offset": 0, "length": 1, "quote": "x", "prefix": 1},
    ],
)
def test_anchor_parse_rejects_bad_shapes(raw: Any) -> None:
    with pytest.raises(DocumentError):
        Anchor.parse(raw)


def test_anchor_quote_is_capped_but_length_is_not() -> None:
    """长选区只留开头：quote 截到上限，length 仍是真实长度。"""
    long_text = "字" * 200
    anchor = Anchor.parse(
        {"block_id": "b" * 32, "offset": 0, "length": 200, "quote": long_text[:128]}
    )
    assert len(anchor.quote) == 128
    assert anchor.length == 200
    with pytest.raises(DocumentError, match="上限"):
        Anchor.parse(
            {"block_id": "b" * 32, "offset": 0, "length": 200, "quote": long_text}
        )


def test_block_texts_only_collects_block_level_nodes() -> None:
    inner = _paragraph("内层")
    outer = {
        "type": "quote",
        "id": "c" * 32,
        "content": [inner],
    }
    texts = block_texts(_note(outer))
    assert texts["c" * 32] == ""  # quote 自己的文本不递归进嵌套块
    assert texts[inner["id"]] == "内层"
    assert plain_text(_paragraph("甲", "d" * 32)) == "甲"


# --------------------------------------------------------------------------
# 重定位（§五：顺序固定，可测）
# --------------------------------------------------------------------------


def test_relocate_uses_the_fast_path_when_nothing_moved() -> None:
    anchor = Anchor.parse(_anchor("e" * 32, 2, 2, "天气"))
    placement = relocate(anchor, {"e" * 32: "今天天气很好"})
    assert (placement.offset, placement.status) == (2, ACTIVE)


def test_relocate_finds_the_quote_after_text_was_inserted_before_it() -> None:
    anchor = Anchor.parse(_anchor("e" * 32, 2, 2, "天气"))
    placement = relocate(anchor, {"e" * 32: "昨天的今天天气很好"})
    assert placement.offset == 5
    assert placement.status == ACTIVE


def test_relocate_disambiguates_with_context() -> None:
    """两处同样的引文，且偏移已飘走（快路径不中）：前后文能对上的那个胜出。"""
    anchor = Anchor.parse(_anchor("e" * 32, 3, 2, "天气", suffix="很好"))
    placement = relocate(anchor, {"e" * 32: "天气一般，今天天气很好"})
    assert placement.offset == 7
    assert placement.status == ACTIVE


def test_relocate_falls_back_to_the_nearest_hit() -> None:
    """前后文都对不上时按「离原偏移最近」选，不是随便选。"""
    anchor = Anchor.parse(_anchor("e" * 32, 12, 2, "天气"))
    placement = relocate(anchor, {"e" * 32: "天气" + "x" * 12 + "天气"})
    assert placement.offset == 14
    assert placement.status == ACTIVE


def test_relocate_gives_up_when_two_hits_are_equidistant() -> None:
    """判不出来就 orphaned —— 宁可待重定位，也不把批注挂到错的地方。"""
    anchor = Anchor.parse(_anchor("e" * 32, 4, 2, "天气"))
    placement = relocate(anchor, {"e" * 32: "xx天气xx天气"})
    assert placement.status == ORPHANED
    assert placement.offset == 4  # 原偏移留着，正文改回来还能自己恢复


def test_relocate_orphans_when_the_block_is_gone() -> None:
    anchor = Anchor.parse(_anchor("f" * 32, 0, 2, "天气"))
    assert relocate(anchor, {}).status == ORPHANED


def test_relocate_orphans_when_the_text_changed_too_much() -> None:
    anchor = Anchor.parse(_anchor("e" * 32, 0, 2, "天气"))
    assert relocate(anchor, {"e" * 32: "整段被重写了"}).status == ORPHANED


# --------------------------------------------------------------------------
# 批注能力（§十一）
# --------------------------------------------------------------------------


def test_creating_an_annotation_returns_an_active_status(ready: Core) -> None:
    block = _paragraph("今天天气很好")
    _save(ready, "n1", _note(block), commit=True)
    created = _ok(_create(ready, "n1", _anchor(block["id"], 2, 2, "天气")))
    assert created["status"] == ACTIVE
    listed = _ok(_call(ready, "doc.annotation.list", {"doc_id": "n1"}))
    rows = listed["annotations"]
    assert len(rows) == 1
    assert rows[0]["body"] == "这里要问一句"
    assert rows[0]["status"] == ACTIVE
    assert rows[0]["author_subject"] == "tester"  # 作者来自 Subject（I6）


def test_creating_an_annotation_on_a_missing_document_is_not_found(ready: Core) -> None:
    reply = _create(ready, "nope", _anchor("a" * 32, 0, 1, "x"))
    assert isinstance(reply, Err)
    assert reply.kind.value == "not_found"


def test_creating_an_annotation_with_a_bad_anchor_is_invalid(ready: Core) -> None:
    block = _paragraph("今天天气很好")
    _save(ready, "n1", _note(block), commit=True)
    reply = _create(
        ready, "n1", {"block_id": "短", "offset": 0, "length": 1, "quote": "x"}
    )
    assert isinstance(reply, Err)
    assert reply.kind.value == "invalid"


def test_an_annotation_on_a_vanished_block_starts_orphaned(ready: Core) -> None:
    _save(ready, "n1", _note(_paragraph("正文")), commit=True)
    created = _ok(_create(ready, "n1", _anchor("9" * 32, 0, 2, "正文")))
    assert created["status"] == ORPHANED


def test_editing_the_document_re_anchors_its_annotations(ready: Core) -> None:
    """正文前面插了字：锚点跟着走，状态仍是 active，偏移已更新。"""
    block = _paragraph("今天天气很好")
    _save(ready, "n1", _note(block), commit=True)
    created = _ok(_create(ready, "n1", _anchor(block["id"], 2, 2, "天气")))

    moved = _paragraph("昨天的今天天气很好", block["id"])
    _save(ready, "n1", _note(moved), base_revision=1)

    rows = _ok(_call(ready, "doc.annotation.list", {"doc_id": "n1"}))["annotations"]
    assert rows[0]["annotation_id"] == created["annotation_id"]
    assert rows[0]["status"] == ACTIVE
    assert rows[0]["anchor"]["offset"] == 5


def test_deleting_the_block_orphans_the_annotation_without_losing_it(
    ready: Core,
) -> None:
    block = _paragraph("今天天气很好")
    other = _paragraph("另一段")
    _save(ready, "n1", _note(other), commit=True)
    created = _ok(_create(ready, "n1", _anchor("7" * 32, 0, 2, "天气")))

    _save(ready, "n1", _note(other), base_revision=1)
    rows = _ok(_call(ready, "doc.annotation.list", {"doc_id": "n1"}))["annotations"]
    assert rows[0]["annotation_id"] == created["annotation_id"]
    assert rows[0]["status"] == ORPHANED
    assert block["id"] not in block_texts(_note(other))


def test_list_filters_by_status_and_rejects_a_bad_one(ready: Core) -> None:
    block = _paragraph("今天天气很好")
    _save(ready, "n1", _note(block), commit=True)
    _create(ready, "n1", _anchor(block["id"], 2, 2, "天气"))
    _create(ready, "n1", _anchor("8" * 32, 0, 2, "天气"))

    active = _ok(
        _call(ready, "doc.annotation.list", {"doc_id": "n1", "status": ACTIVE})
    )["annotations"]
    orphaned = _ok(
        _call(ready, "doc.annotation.list", {"doc_id": "n1", "status": ORPHANED})
    )["annotations"]
    assert len(active) == 1
    assert len(orphaned) == 1
    bad = _call(ready, "doc.annotation.list", {"doc_id": "n1", "status": "deleted"})
    assert isinstance(bad, Err)
    assert bad.kind.value == "invalid"


def test_updating_the_body_keeps_the_status(ready: Core) -> None:
    block = _paragraph("今天天气很好")
    _save(ready, "n1", _note(block), commit=True)
    created = _ok(_create(ready, "n1", _anchor(block["id"], 2, 2, "天气")))
    updated = _ok(
        _call(
            ready,
            "doc.annotation.update",
            {"annotation_id": created["annotation_id"], "body": "改成另一个问题"},
        )
    )
    assert updated["status"] == ACTIVE
    rows = _ok(_call(ready, "doc.annotation.list", {"doc_id": "n1"}))["annotations"]
    assert rows[0]["body"] == "改成另一个问题"


def test_updating_the_anchor_moves_the_annotation(ready: Core) -> None:
    block = _paragraph("今天天气很好，明天也不错")
    _save(ready, "n1", _note(block), commit=True)
    created = _ok(_create(ready, "n1", _anchor(block["id"], 2, 2, "天气")))
    moved = _ok(
        _call(
            ready,
            "doc.annotation.update",
            {
                "annotation_id": created["annotation_id"],
                "anchor": _anchor(block["id"], 7, 2, "明天"),
            },
        )
    )
    assert moved["status"] == ACTIVE
    rows = _ok(_call(ready, "doc.annotation.list", {"doc_id": "n1"}))["annotations"]
    assert rows[0]["anchor"]["quote"] == "明天"
    assert rows[0]["anchor"]["offset"] == 7


def test_update_rejects_an_empty_body(ready: Core) -> None:
    block = _paragraph("今天天气很好")
    _save(ready, "n1", _note(block), commit=True)
    created = _ok(_create(ready, "n1", _anchor(block["id"], 2, 2, "天气")))
    reply = _call(
        ready,
        "doc.annotation.update",
        {"annotation_id": created["annotation_id"], "body": "   "},
    )
    assert isinstance(reply, Err)
    assert reply.kind.value == "invalid"


def test_resolve_and_reopen(ready: Core) -> None:
    block = _paragraph("今天天气很好")
    _save(ready, "n1", _note(block), commit=True)
    created = _ok(_create(ready, "n1", _anchor(block["id"], 2, 2, "天气")))
    annotation_id = created["annotation_id"]

    resolved = _ok(
        _call(ready, "doc.annotation.resolve", {"annotation_id": annotation_id})
    )
    assert resolved["status"] == "resolved"
    reopened = _ok(
        _call(
            ready,
            "doc.annotation.resolve",
            {"annotation_id": annotation_id, "resolved": False},
        )
    )
    assert reopened["status"] == ACTIVE


def test_resolved_annotations_are_not_re_anchored(ready: Core) -> None:
    """已经收工的批注不再跟着正文漂（§十一）。"""
    block = _paragraph("今天天气很好")
    _save(ready, "n1", _note(block), commit=True)
    created = _ok(_create(ready, "n1", _anchor(block["id"], 2, 2, "天气")))
    _call(ready, "doc.annotation.resolve", {"annotation_id": created["annotation_id"]})

    _save(ready, "n1", _note(_paragraph("整段重写", block["id"])), base_revision=1)
    rows = _ok(_call(ready, "doc.annotation.list", {"doc_id": "n1"}))["annotations"]
    assert rows[0]["status"] == "resolved"
    assert rows[0]["anchor"]["offset"] == 2  # 没被动过


def test_resolve_rejects_a_missing_annotation(ready: Core) -> None:
    reply = _call(ready, "doc.annotation.resolve", {"annotation_id": "nope"})
    assert isinstance(reply, Err)
    assert reply.kind.value == "not_found"


def test_annotation_capabilities_reject_bad_requests(ready: Core) -> None:
    assert isinstance(_call(ready, "doc.annotation.list", ["x"]), Err)
    assert isinstance(_call(ready, "doc.annotation.list", {"doc_id": ""}), Err)
    assert isinstance(_call(ready, "doc.annotation.resolve", {}), Err)
    assert isinstance(_call(ready, "doc.annotation.create", {"doc_id": "n1"}), Err)
    assert isinstance(
        _call(
            ready,
            "doc.annotation.update",
            {"annotation_id": "x", "anchor": "nope"},
        ),
        Err,
    )


def test_annotation_bodies_are_stored_as_text(ready: Core) -> None:
    """批注正文是纯文本，不做富文本 —— 颜色与字号归主题（A8）。"""
    block = _paragraph("今天天气很好")
    _save(ready, "n1", _note(block), commit=True)
    _create(ready, "n1", _anchor(block["id"], 2, 2, "天气"), body="<b>加粗</b>")
    row = ready.db.connection.execute("SELECT body FROM annotation").fetchone()
    assert row[0] == "<b>加粗</b>"
    assert (
        json.loads(
            ready.db.connection.execute("SELECT anchor FROM annotation").fetchone()[0]
        )["quote"]
        == "天气"
    )
