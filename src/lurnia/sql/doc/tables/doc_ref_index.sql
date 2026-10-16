-- SPDX-FileCopyrightText: 2026 HanYang06
-- SPDX-License-Identifier: Apache-2.0
-- 表：doc_ref_index —— 引用与反链（路线 111）。口径见 docs/design/editor.md §十。
--
-- 按 doc_id 寻址，不认「笔记」：画布与设计器照样能用。
-- 只做**一层**反链，不做传递闭包；索引只在某一篇的引用集变化时才重写。
-- 悬空引用不进这张表处理：查的时候 LEFT JOIN doc，缺失就是 exists=false（显式呈现）。

CREATE TABLE doc_ref_index (
    target_doc_id   TEXT NOT NULL,
    source_doc_id   TEXT NOT NULL,
    source_block_id TEXT NOT NULL,
    PRIMARY KEY (source_doc_id, source_block_id, target_doc_id)
);

CREATE INDEX idx_doc_ref_index_target ON doc_ref_index (target_doc_id);
