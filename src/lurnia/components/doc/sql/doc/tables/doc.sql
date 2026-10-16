-- SPDX-FileCopyrightText: 2026 HanYang06
-- SPDX-License-Identifier: Apache-2.0
-- 文档主表（路线 114）。口径见 docs/design/editor.md §十七。
--
-- 只有 doc_type 与 title 是列：类型特有的东西一律进 body 的 JSON，
-- 所以「加一种编辑器」不改这张表（storage.md §八）。
-- body 存的**就是**编辑器发来的 JSON 文本（校验通过后原样入库，不 re-dump）。

CREATE TABLE IF NOT EXISTS doc (
    id           TEXT PRIMARY KEY,
    doc_type     TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    body         TEXT NOT NULL,
    body_version INTEGER NOT NULL,
    revision     INTEGER NOT NULL DEFAULT 0,
    created_wall TEXT NOT NULL,
    updated_wall TEXT NOT NULL
);
