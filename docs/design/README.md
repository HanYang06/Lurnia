<!-- SPDX-FileCopyrightText: 2026 HanYang06 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lurnia 设计

> 本目录是 Lurnia 的设计事实来源。代码是实现，这里是契约；两者不一致时，要么改代码，要么改这里。

## 一、本体是 APP

**Lurnia 是桌面应用（Tauri 打包），不是网页。**

- 用户双击就能用，**不是双击之后自己去开浏览器**。
- UI 用前端技术写，跑在 Tauri 的 WebView 里，随 APP 分发。
- **不得做未授权动作**：不开浏览器、不起服务、不弹窗、不拉进程、不自己联网（不变量 I9）。

这条是本体的前提，不是实现细节。

## 二、当前不承诺 1.0

Lurnia 当前没有发布 1.0 的必要，不承诺 1.0——不是「永不发 1.0」，将来若有必要可重新评估。版本格式 `0.MINOR.PATCH` 是当前格式，设计也不以任何「终点版本」为对象。

设计对象不是「1.0 的范围」，而是三样：

| 对象 | 性质 | 载体 |
| --- | --- | --- |
| **不变量** | 硬、少、任何 0.x 都不许破 | [invariants.md](invariants.md)，并落成可执行 conformance 测试 |
| **能力池** | 软、多、每条独立可发布 | [../roadmap/1.x-开发.md](../roadmap/1.x-开发.md) 的路线增量 |
| **弃用管道** | 替代「稳定性」的唯一机制 | [versioning.md](versioning.md) |

**不变量保证 0.9 的代码在 0.23 还认得出来；能力池保证永远有下一个 0.x 可发。**

## 三、文档

| 文档 | 回答什么 |
| --- | --- |
| [invariants.md](invariants.md) | 哪些东西任何 0.x 都不许破（九条） |
| [versioning.md](versioning.md) | 版本号怎么走、破坏性变更怎么办 |
| [bus.md](bus.md) | 模块之间怎么说话（两平面 + 事件封套） |
| [../roadmap/1.x-开发.md](../roadmap/1.x-开发.md) | **总量**：这个项目可能包含的全部东西 |

## 四、施工顺序

内核最好做、最容易做，**先做**。内核做完，剩下的慢慢来。

```
内核（K）→ 权限（P）→ 笔记（N）→ 项目（PRJ）→ AI
```

AI 专项慢慢做，从来不拖内核。存储与数据库等 OnCasket 的结果。协作模块等网络架构（P2P / 半中心化）定形。

## 五、工程侧待办

- `pyproject.toml` 与 `uv.lock` 已脱钩：pyproject 里有 `onconf>=2.1.0` 而 lock 里查不到，`.venv` 里却装着 2.1.0。**加新依赖之前先对齐锁。**
- 确认 `onconf` 走 PyPI registry 还是本地路径依赖。
- `README.md` 是空的。
