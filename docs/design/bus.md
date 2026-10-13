<!-- SPDX-FileCopyrightText: 2026 HanYang06 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# 事件总线：两个平面

## 一、为什么不合成一个

模块间通信有两种语义完全不同的需求：

| 需求 | 形态 | 没人接的时候 |
| --- | --- | --- |
| 广播 | 一个事件 0..N 个订阅者 | **正常**，允许没人接 |
| 调用 | 一个能力恰好一个提供者 | **错误**，必须显式报错 |

合起来的唯一后果是「没人接」不可区分——而**静默丢弃是模块化系统里最难查的一类 bug**。所以分成两个平面。

## 二、广播平面

```
emit(topic, payload) -> None
```

- 0..N 订阅者，**尽力而为**，允许没人接；
- 同步还是异步由绑定决定，但**顺序保证：同一 topic 内按 emit 顺序投递**；
- 用于：状态变更通告、事件日志、UI 推送。

## 三、调用平面

```
invoke(capability, request) -> Reply
```

- 恰好一个提供者；注册重复 = 启动期报错；
- **没有提供者 = 显式报错**（`NoProviderError`），不是返回 `None`；
- 用于：模块间代理，也就是 `docs/roadmap/1.x-开发.md` 说的「模块互不依赖，经它调用」。

`capability` 用字符串命名空间（如 `note.create`），提供者在启动时**静态注册**。不做热加载（见 [../roadmap/1.x-开发.md](../roadmap/1.x-开发.md) 内核层）。

## 四、事件封套（内核资产）

封套字段由内核定义，传输只是绑定（不变量 I8）：

```python
EventEnvelope:
    id: str            # 全局唯一
    seq: int           # 进程内单调递增，用于定序与补洞
    ts_wall: str       # ISO8601，带时区
    ts_mono: int       # 单调时钟，纳秒，用于测耗时
    topic: str
    subject: Subject   # 谁做的（不变量 I6）
    cause: str | None  # 触发它的事件 / 命令 id，构成因果链
    payload: dict
    version: int       # 封套自身版本
```

`Command` 与 `Reply` 同样带 `id` / `subject` / `cause`，`Reply` 用共享错误模型：

```
Reply = Ok(value) | Err(kind, message, retryable)
```

**跨模块异常必须走 `Err`，不许让模块私有异常类型穿过总线**——否则调用方只能 `except Exception`。

## 五、事件日志只落什么

- **落**：调用平面的请求与回复（有 `capability`、有 subject、有因果）；
- **落**：显式声明为「状态变更」的广播；
- **不落**：每一次广播。

理由：广播是发散的、可丢的，全落会让日志量爆炸并冲垮轮转策略。而单进程内，**调用平面的事件日志本身就是 trace**——不另做 trace / span。

## 六、权限在总线上的位置

`guard` 属于内核（见 [../roadmap/1.x-开发.md](../roadmap/1.x-开发.md) 权限模块），总线在**调用平面**上强制它：

```
invoke(capability, request):
    decision = guard(request.subject, capability.action, request.object)
    if decision is DENY:      return Err(...)
    if decision is UNCERTAIN: 查默认值声明表 → 再判
    ...
```

`UNCERTAIN` 不塌陷成 bool（不变量 I2）：默认值来自「资源类型 × 动作」的声明表，由组件注册、内核查表，可审计可测试。
