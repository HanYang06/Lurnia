-- SPDX-FileCopyrightText: 2026 HanYang06
-- SPDX-License-Identifier: Apache-2.0
--
-- 表：attachment —— 附件库的**元数据**（路线 107）。
--
-- 本体按内容哈希落在文件系统，数据库只留这一行：hash / size / mime / 原名 /
-- 引用计数（docs/design/storage.md §四）。引用计数归零才真删本体，所以不需要
-- 后台扫描。
--
-- 本文件是**当前形状的快照**：一个表一个文件，直接读它就知道这张表现在长什么
-- 样，不必顺着迁移链脑内重放。

CREATE TABLE attachment (
    hash     TEXT    PRIMARY KEY,
    size     INTEGER NOT NULL,
    mime     TEXT,
    name     TEXT    NOT NULL,
    refcount INTEGER NOT NULL
);
