-- SPDX-FileCopyrightText: 2026 HanYang06
-- SPDX-License-Identifier: Apache-2.0
-- 修订快照（路线 114）：**只在显式提交时**写一行（editor.md §六 的两档写入）。
-- 保留策略、差异呈现、回退口径归路线 025，不在这张表的职责里。

CREATE TABLE IF NOT EXISTS doc_revision (
    doc_id       TEXT NOT NULL,
    revision     INTEGER NOT NULL,
    body         TEXT NOT NULL,
    created_wall TEXT NOT NULL,
    cause        TEXT,
    PRIMARY KEY (doc_id, revision)
);
