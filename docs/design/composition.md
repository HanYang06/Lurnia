<!-- SPDX-FileCopyrightText: 2026 HanYang06 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# 组合根：四层怎么装成一台能跑的核心

## 一、结论

内核四层是**零件**，组合根是**装配台**。零件已经各自验收（`conf` / `log` /
`storage` / `bus`），但没有任何地方把它们装在一起——装在一起的这件事本身就是
一个独立的东西，它叫组合根。

| | |
| --- | --- |
| 位置 | `src/lurnia/assembly.py`，**刻意在 `core/` 之外** |
| 产物 | 一台 `Core`：数据落点 + 数据库句柄 + 总线 |
| 装配 | `assemble(home=None, ...) -> Core` |

**为什么不在 `core/` 里。** 不变量 I3 的检查口径是「`core/` 下四层单向」；
组合根必须依赖**全部**四层，放进 `core/` 只有两个结果：要么破 I3，要么把检查
改成白名单——而白名单一旦开了口，I3 就开始说谎。所以它和 `sidecar.py` 一样待在
`core/` 之上：`core/` 是内核，组合根是内核的装配与出口。

## 二、它拥有什么

| 拥有 | 说明 |
| --- | --- |
| 数据目录 | 决定库文件与附件库落在哪（见 §三） |
| 数据库句柄 | 一个 APP 实例一个库文件（`storage.md` §三） |
| 总线 | 提供 guard / transport / 事件日志落点 |
| `change()` | 让调用方的数据写入与事件日志**同事务**（不变量 I5，见 §四） |

它**不**拥有：UI、网络、进程（不变量 I9）；也不替组件决定任何业务语义。

## 三、数据目录

**绝不由 `__file__` / `sys.executable` 推导**——冻结后它们指向临时解包目录
（`packaging.md` §六）。平台默认：

| 平台 | 位置 |
| --- | --- |
| Windows | `%APPDATA%/Lurnia` |
| macOS | `~/Library/Application Support/Lurnia` |
| Linux | `$XDG_DATA_HOME/Lurnia`，未设则 `~/.local/share/Lurnia` |

一个 home 下两样东西：`lurnia.db` 与 `attachments/`。三个路径同源，用户可以整体
备份、整体搬走（「数据归用户」）。`assemble(home=...)` 可显式覆盖默认位置。

只读资源（`.sql`、图标）**不进数据目录**，仍在包内，由 `importlib.resources` 读。

## 四、I5 怎么接线

I5 要求「先写事件日志，后落数据」。语义在 `storage` 层已被测试证明，但**证明过
不等于接上了**：`Bus.recorded()` 之前是个没人挂的钩子。接线方式是：

```
Bus(event_log = Core.record)      # 总线的事件日志落点
Core.record(envelope)             # 有活动事务 -> 并入它；没有 -> 自开一个
Core.change(topic, payload, ...)  # 先写日志，再把事务交给调用方写数据
```

| 场景 | 行为 |
| --- | --- |
| `with core.change(...) as tx:` | 事件与 `tx` 里的数据同一个事务，一起成或一起不成 |
| 嵌套 `change` | 并入外层事务，不重开 `BEGIN` |
| `core.record(...)` 在事务外 | 自开一个事务落日志（调用平面 trace 走这条） |

封套由内核构造（不变量 I8）：`Bus.envelope(topic, payload, subject=..., cause=...)`
给出 `seq` / `ts_wall` / `ts_mono`，调用方不自己拼。

## 五、不做什么

| 不做 | 为什么 |
| --- | --- |
| 不自动落每一次广播 | `bus.md` §五：只有显式声明为状态变更的才落，全落会冲垮轮转 |
| 不在内核里开关口 / 拉进程 | 不变量 I9，`script/audit.py` 静态拦 |
| 不替组件声明配置键 | 键归组件（路线 001 的「声明 + 补齐」用法），组合根只负责绑定与装配 |

## 六、验收

- 用临时目录能装出一台 `Core`，建库并迁到当前版本；
- `change()` 体内抛异常时，**事件与数据都不落**（反向验证 I5）；
- 事务外 `record()` 落库成功，且不污染后续 `change()` 的事务状态；
- 广播没人接不报错，调用平面没人接返回 `Err(NO_PROVIDER)`；
- 全进程零监听端口、零子进程（I9）。

## 七、待裁（未定，不属事实来源）

1. **调用平面请求/回复的 trace 形状**（路线 010）。`bus.md` §五 说「落调用平面的
   请求与回复」，但没有定封套形状：一条封套载请求+回复，还是请求、回复各一条？
   `seq` 怎么对齐？裁定前 `Core` 不自动落 `invoke`，只在事务外 `record()` 留口。
2. **宿主怎么把数据目录交给 sidecar**（路线 009/105）。`--data-dir` 参数、环境
   变量，还是 Tauri 侧按同一口径推导？三者在 `packaging.md` §六 下都成立，需选一个。
