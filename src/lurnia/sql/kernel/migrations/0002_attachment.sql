-- SPDX-FileCopyrightText: 2026 HanYang06
-- SPDX-License-Identifier: Apache-2.0
--
-- 迁移：kernel 1 -> 2（附件库元数据，路线 107）。
--
-- 只有**早于本版本**的库需要跑这里；全新安装直接走 tables/ 快照，本文件对它
-- 没有意义 —— 这就是"迁移链是历史、快照是现状"的分工。
--
-- 约定：一个新版本只允许**追加**一个新的 NNNN_*.sql，不许改老文件。顺手把
-- tables/ 里对应的快照改成新形状，两者的一致性由 tests/test_ddl.py 与
-- script/audit.py 钉住，写歪了会红。
--
-- 这里刻意不写 IF NOT EXISTS：迁移按版本只会跑一次，加上它只会把"迁移写错了"
-- 从报错变成静默通过。

CREATE TABLE attachment (
    hash     TEXT    PRIMARY KEY,
    size     INTEGER NOT NULL,
    mime     TEXT,
    name     TEXT    NOT NULL,
    refcount INTEGER NOT NULL
);
