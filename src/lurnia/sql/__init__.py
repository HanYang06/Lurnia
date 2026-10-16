# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""库结构的家：**所有 schema 的 DDL 都在这里**。

口径见 [storage.md §五](../../../docs/design/storage.md)。布局：

```
src/lurnia/sql/<schema>/{tables,migrations}/*.sql
```

为什么集中一处、而不是塞进内核或组件里：

* **一眼看全**：`git log -- src/lurnia/sql` 就是「库结构变更史」。原来内核 schema 在
  `core/sql/`、业务 schema 在 `components/<组件>/sql/`，看目录分不清「库结构变了」与
  「内核逻辑变了」；
* **少了活动零件**：一套加载路径，不需要「schema → 哪个包」的注册与查表；
* **内核与业务一视同仁**：`kernel` 只是其中一个 schema 名，内核的表不因为住在 `core/`
  就更高贵。

**只在包内**：这个包随代码发布（packaging 冻结只收 `src/lurnia/**`），仓库根的
`config/` 不在产物里 —— 放那儿会「开发时能跑、装完就炸」。
"""
