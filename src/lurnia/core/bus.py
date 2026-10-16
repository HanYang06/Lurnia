# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""总线层：内核第 3 层。

不变量 I3：本层只可依赖 config、log、storage 与契约。

两个平面，语义不同，刻意不合并（[bus.md §一](../../../docs/design/bus.md)）：

* **广播平面** `emit`：0..N 订阅者，尽力而为，**允许没人接**；
* **调用平面** `invoke`：恰好一个提供者，**没人接 = 显式报错**。

合起来的唯一后果是"没人接"不可区分。所以这里把两种"没人接"做成两种不同的结果：
`emit` 返回 0 不报错，`invoke` 返回 `Err(NO_PROVIDER)`。

调用平面是权限的强制点（不变量 I2）：`invoke` 先问 `guard`，且**三态不塌陷** ——
`DENY` 拒绝，`UNCERTAIN` 查默认值声明表，`ALLOW` 放行。没有 guard 就没有默认值，
此时 `UNCERTAIN` 按**拒绝**处理（fail closed）。
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from time import monotonic_ns, time_ns
from typing import Any

from lurnia.core.contracts import (
    Command,
    Decision,
    Err,
    ErrKind,
    EventEnvelope,
    Guard,
    Ok,
    Reply,
    Sequencer,
    Subject,
    Transport,
    wall_clock,
)
from lurnia.core.log import get_logger

_log = get_logger("bus")

Listener = Callable[[EventEnvelope], None]
Provider = Callable[[Command[Any]], Reply[Any]]


class DuplicateProviderError(Exception):
    """同一能力被注册了第二个提供者。启动期错误。"""


class DefaultCriterion:
    """「资源类型 × 动作」的默认值声明表（不变量 I2）。

    由组件注册、内核查表 —— 可审计、可测试。
    未声明的一律视为**拒绝**（fail closed）。
    """

    def __init__(self) -> None:
        self._table: dict[tuple[str, str], Decision] = {}

    def declare(self, resource: str, action: str, decision: Decision) -> None:
        if decision is Decision.UNCERTAIN:
            msg = "默认值只能是 ALLOW 或 DENY，不能是 UNCERTAIN"
            raise ValueError(msg)
        self._table[(resource, action)] = decision

    def lookup(self, resource: str, action: str) -> Decision:
        return self._table.get((resource, action), Decision.DENY)

    def declared(self) -> dict[tuple[str, str], Decision]:
        return dict(self._table)


class MemoryTransport:
    """传输绑定的一种：进程内回环（路线 008）。

    封套由内核定义，传输只搬 bytes（不变量 I8）。
    """

    def __init__(self) -> None:
        self._queue: list[bytes] = []
        self._lock = threading.Lock()

    def publish(self, wire: bytes) -> None:
        with self._lock:
            self._queue.append(wire)

    def drain(self) -> list[bytes]:
        with self._lock:
            out, self._queue = self._queue, []
        return out


class Bus:
    """两平面总线。"""

    def __init__(
        self,
        *,
        guard: Guard | None = None,
        defaults: DefaultCriterion | None = None,
        transport: Transport | None = None,
        event_log: Callable[[EventEnvelope], None] | None = None,
    ) -> None:
        self._listeners: dict[str, list[Listener]] = {}
        self._providers: dict[str, Provider] = {}
        self._guard = guard
        self._defaults = defaults if defaults is not None else DefaultCriterion()
        self._transport = transport
        self._event_log = event_log
        self._sequencer = Sequencer()
        self._lock = threading.RLock()
        self._calls = 0

    # ---- 广播平面 -------------------------------------------------------

    def subscribe(self, topic: str, listener: Listener) -> Callable[[], None]:
        """订阅一个 topic，返回取消订阅的句柄。

        同一 topic 内按订阅顺序投递；**同一订阅者重复订阅只算一次**，
        否则顺序保证会被重复注册悄悄破坏。
        """
        with self._lock:
            listeners = self._listeners.setdefault(topic, [])
            if listener not in listeners:
                listeners.append(listener)

        def unsubscribe() -> None:
            with self._lock:
                current = self._listeners.get(topic, [])
                if listener in current:
                    current.remove(listener)

        return unsubscribe

    def emit(
        self,
        topic: str,
        payload: dict[str, Any],
        *,
        subject: Subject,
        cause: str | None = None,
    ) -> int:
        """广播。允许没人接，返回投递数。"""
        envelope = self.envelope(topic, payload, subject=subject, cause=cause)
        with self._lock:
            listeners = list(self._listeners.get(topic, []))
        for listener in listeners:
            listener(envelope)
        if self._transport is not None:
            self._transport.publish(envelope.to_wire())
        return len(listeners)

    def emit_envelope(self, envelope: EventEnvelope) -> int:
        """按已有封套广播：转发时**不重编号**，保留原 seq 与原 id。"""
        with self._lock:
            listeners = list(self._listeners.get(envelope.topic, []))
        for listener in listeners:
            listener(envelope)
        if self._transport is not None:
            self._transport.publish(envelope.to_wire())
        return len(listeners)

    @property
    def transport(self) -> Transport | None:
        return self._transport

    def recorded(self, envelope: EventEnvelope) -> None:
        """把封套交给事件日志落点（路线 004 / 010）。I5 的顺序由调用方保证。"""
        if self._event_log is not None:
            self._event_log(envelope)

    # ---- 调用平面 -------------------------------------------------------

    def provide(self, capability: str, provider: Provider) -> None:
        """静态注册一个提供者。重复注册是启动期错误。"""
        with self._lock:
            if capability in self._providers:
                msg = f"能力 {capability!r} 已有提供者，重复注册"
                raise DuplicateProviderError(msg)
            self._providers[capability] = provider

    def provided(self, capability: str) -> bool:
        with self._lock:
            return capability in self._providers

    @property
    def call_count(self) -> int:
        return self._calls

    def invoke(self, command: Command[Any]) -> Reply[Any]:
        """调用平面。权限 -> 提供者 -> 回复。失败一律走 `Err`。"""
        with self._lock:
            self._calls += 1

        decision = self._decide(command)
        if decision is not Decision.ALLOW:
            return Err(
                ErrKind.DENIED,
                f"权限判定为 {decision.value}：{command.subject.id} -> "
                f"{command.capability}",
                retryable=False,
            )

        with self._lock:
            provider = self._providers.get(command.capability)
        if provider is None:
            return Err(
                ErrKind.NO_PROVIDER,
                f"能力 {command.capability!r} 没有提供者",
                retryable=False,
            )
        return provider(command)

    def _decide(self, command: Command[Any]) -> Decision:
        if self._guard is None:
            return Decision.ALLOW
        decision = self._guard(command.subject, command.capability, command.request)
        if decision is not Decision.UNCERTAIN:
            return decision
        resource, _, action = command.capability.partition(".")
        return self._defaults.lookup(resource, action)

    # ---- 封套（内核资产，不变量 I8） -------------------------------------

    def envelope(
        self,
        topic: str,
        payload: dict[str, Any],
        *,
        subject: Subject,
        cause: str | None = None,
    ) -> EventEnvelope:
        """构造一个内核封套。

        `seq` 与两种时间戳**由内核给**（不变量 I8）：调用方不自己拼封套，
        否则定序与补洞会各写各的。
        """
        # 两种时钟各司其职，别混用：ts_wall 给人和审计读，必须来自纪元时钟；
        # ts_mono 给测耗时与进程内定序，来自单调时钟（不承诺跨进程可比）。
        # 实测：拿 monotonic_ns() 去换算墙上时间，得到的是 1970。
        ts_mono = monotonic_ns()
        return EventEnvelope(
            topic=topic,
            subject=subject,
            payload=payload,
            seq=self._sequencer.next(),
            ts_wall=wall_clock(time_ns()),
            ts_mono=ts_mono,
            cause=cause,
        )


__all__ = [
    "Bus",
    "DefaultCriterion",
    "DuplicateProviderError",
    "MemoryTransport",
    "Ok",
]
