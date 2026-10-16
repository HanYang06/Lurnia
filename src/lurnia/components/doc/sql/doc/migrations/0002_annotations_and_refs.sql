-- SPDX-FileCopyrightText: 2026 HanYang06
-- SPDX-License-Identifier: Apache-2.0
-- 迁移：doc 1 -> 2（批注与引用索引，路线 111 / 112）。
--
-- 这两张表由不同的条目引入，但对库来说是同一次结构变更 —— 一个版本一个文件，
-- 不为了「条目边界」把版本号切碎（storage.md §五：NNNN 是目标版本，逐文件 +1）。

CREATE TABLE annotation (
    id             TEXT PRIMARY KEY,
    doc_id         TEXT NOT NULL,
    anchor         TEXT NOT NULL,
    body           TEXT NOT NULL,
    status         TEXT NOT NULL,
    author_subject TEXT NOT NULL,
    created_wall   TEXT NOT NULL,
    updated_wall   TEXT NOT NULL
);

CREATE INDEX idx_annotation_doc ON annotation (doc_id);

CREATE TABLE doc_ref_index (
    target_doc_id   TEXT NOT NULL,
    source_doc_id   TEXT NOT NULL,
    source_block_id TEXT NOT NULL,
    PRIMARY KEY (source_doc_id, source_block_id, target_doc_id)
);

CREATE INDEX idx_doc_ref_index_target ON doc_ref_index (target_doc_id);
