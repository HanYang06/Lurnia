<!-- SPDX-FileCopyrightText: 2026 HanYang06 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# 路线图

本目录遵循 [Lurnia-RS-2026 路线图结构规范](https://github.com/HanYang06/Lurnia/blob/main/Lurnia-RS-2026.md)。

## 文件

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| [1.x-开发.md](1.x-开发.md) | 路线图文件 | 1.x 开发线 |

## 说明

`1.x-开发.md` 为 1.x 版本线，含 `## 路线增量` 与 `## 版本分配` 两块。路线ID `001`–`105`，按「层 → 模块 → 子模块 → 条目」以缩进无序列表嵌套；层、模块、子模块只写名字与勾选框，条目另附六行卡片。

父项的勾选框由子项汇总：子项全部收口后父项方可收口（规范 3.3.4）。该一致性由 [`script/roadmap.py`](../../script/roadmap.py) 校验：

```bash
uv run python script/roadmap.py
```

条目尚未收口，`设计关联文件` 一律留空——按规范 3.3.2，没有关联即没有设计。