<!-- SPDX-FileCopyrightText: 2026 HanYang06 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# 路线图

本目录遵循 [Lurnia-RS-2026 路线图结构规范](https://github.com/HanYang06/Lurnia/blob/main/Lurnia-RS-2026.md)。

## 文件

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| [1.x-开发.md](1.x-开发.md) | 路线图文件 | 1.x 开发线 |

## 说明

`1.x-开发.md` 为 1.x 版本线，含 `## 路线增量`、`## 版本分配` 与 `## 废弃附录` 三块。路线ID `001`–`120`（其中 `005` 已废弃），按「层 → 模块 → 子模块 → 条目」以缩进无序列表嵌套；层、模块、子模块只写名字与勾选框，条目另附六行卡片。

父项的勾选框由子项汇总：子项全部收口后父项方可收口（规范 3.3.4）。该一致性由 [`script/roadmap.py`](../../script/roadmap.py) 校验，并有 [`tests/test_roadmap.py`](../../tests/test_roadmap.py) 做回归：

```bash
uv run python script/roadmap.py
uv run --group tests pytest tests/test_roadmap.py
```

条目尚未收口时，`设计关联文件` 按规范 3.3.2 处理：已有设计的写 `[<文件> §<路线ID>](<相对路径>#r<路线ID>)`，没有设计的留空——**没有关联即没有设计**。留空的条目尚未落设计，不要当成「设计已存在」。

## 废弃

按规范第 9 章，废弃条目不入路线增量、不占版本分配，以 `## 废弃附录` 的表格加附录体现，并沿用原路线ID（即该号仍占位，不回收）。

| 废弃 ID | 条目 | 原因 |
| --- | --- | --- |
| 005 | 使用组件 OnCasket | 自研存储引擎无代码、无设计、不可复现；由 106 / 107 以现成轮子取代，口径见 [storage.md](../design/storage.md) |
