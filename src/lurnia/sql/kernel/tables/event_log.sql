-- SPDX-FileCopyrightText: 2026 HanYang06
-- SPDX-License-Identifier: Apache-2.0
--
-- 表：event_log —— 事件日志（不变量 I5 的"先写日志"落点）。
--
-- 本文件是**当前形状的快照**：一个表一个文件，直接读它就知道这张表现在长
-- 什么样，不必顺着迁移链脑内重放。口径见 docs/design/storage.md §五。

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
