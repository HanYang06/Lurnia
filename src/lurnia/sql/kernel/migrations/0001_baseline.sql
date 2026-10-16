-- SPDX-FileCopyrightText: 2026 HanYang06
-- SPDX-License-Identifier: Apache-2.0
--
-- 迁移：kernel 0 -> 1（基线）。
--
-- 只有**早于本版本**的库需要跑这里。全新安装直接走 tables/ 快照，本文件对
-- 它没有意义 —— 这就是"迁移链是历史、快照是现状"的分工。
--
-- 约定：一个新版本只允许**追加**一个新的 NNNN_*.sql，不许改老文件。
-- 顺手把 tables/ 里对应的快照改成新形状，两者的一致性由 tests/test_ddl.py
-- 钉住，写歪了会红。
--
-- 这里刻意不写 IF NOT EXISTS：迁移按版本只会跑一次，加上它只会把
-- "迁移写错了" 从报错变成静默通过。

CREATE TABLE event_log (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    id           TEXT    NOT NULL UNIQUE,
    topic        TEXT    NOT NULL,
    subject_id   TEXT    NOT NULL,
    subject_kind TEXT    NOT NULL,
    cause        TEXT,
    ts_wall      TEXT    NOT NULL,
    ts_mono      INTEGER NOT NULL,
    payload      TEXT    NOT NULL,
    version      INTEGER NOT NULL
);

CREATE INDEX idx_event_log_topic ON event_log (topic);
