-- SPDX-FileCopyrightText: 2026 HanYang06
-- SPDX-License-Identifier: Apache-2.0
-- 表：annotation —— 批注（路线 112）。口径见 docs/design/editor.md §十一。
--
-- 批注是**文档外**的实体：不经撤销回退、不随文档复制而复制、可跨多个修订存活。
-- anchor 是三段式锚点的 JSON（§五）：{block_id, offset, length, quote, prefix, suffix}。
-- status ∈ active / orphaned / resolved —— **没有 deleted**：删除是真删行，
-- 重定位失败只是 orphaned，绝不静默丢弃。

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
