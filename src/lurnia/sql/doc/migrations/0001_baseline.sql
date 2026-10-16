-- SPDX-FileCopyrightText: 2026 HanYang06
-- SPDX-License-Identifier: Apache-2.0
-- 迁移：doc 0 -> 1（文档主表与修订，路线 114）。
--
-- 只有**早于本版本**的库需要跑这里；全新安装直接走 tables/ 快照。
-- 约定（storage.md §五）：一个新版本只允许**追加**一个新的 NNNN_*.sql，不许改老文件；
-- 顺手把 tables/ 里对应的快照改成新形状 —— 两者的一致性由 tests/test_ddl.py 与
-- script/audit.py 的 schema_drift 钉住，写歪了会红。
--
-- 刻意不写 IF NOT EXISTS：迁移按版本只会跑一次，加上它只会把「迁移写错了」
-- 从报错变成静默通过。

CREATE TABLE doc (
    id           TEXT PRIMARY KEY,
    doc_type     TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    body         TEXT NOT NULL,
    body_version INTEGER NOT NULL,
    revision     INTEGER NOT NULL DEFAULT 0,
    created_wall TEXT NOT NULL,
    updated_wall TEXT NOT NULL
);

CREATE TABLE doc_revision (
    doc_id       TEXT NOT NULL,
    revision     INTEGER NOT NULL,
    body         TEXT NOT NULL,
    created_wall TEXT NOT NULL,
    cause        TEXT,
    PRIMARY KEY (doc_id, revision)
);
