-- SPDX-FileCopyrightText: 2026 HanYang06
-- SPDX-License-Identifier: Apache-2.0
-- doc schema 的基线（目标版本 0001）。全新安装走 tables/ 快照，老库走这条链；
-- 两条路必须得到同一个形状，否则 script/audit.py 的 schema_drift 会判红。

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

CREATE TABLE IF NOT EXISTS doc_revision (
    doc_id       TEXT NOT NULL,
    revision     INTEGER NOT NULL,
    body         TEXT NOT NULL,
    created_wall TEXT NOT NULL,
    cause        TEXT,
    PRIMARY KEY (doc_id, revision)
);
