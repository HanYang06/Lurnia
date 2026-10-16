# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""内核契约。

契约是内核的公共基座，**不属于** config / log / storage / bus 四层中的任何一层：
四层都可以依赖它，它不依赖四层（不变量 I3）。
"""

from __future__ import annotations

import json
import threading
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any, Protocol, runtime_checkable

ENVELOPE_VERSION = 1


class ErrKind(Enum):
    """跨模块错误的封闭分类。

    模块私有异常类型不许穿过总线（[bus.md §四](../../docs/design/bus.md)），
    否则调用方只能 `except Exception`。
    """

    DENIED = "denied"
    NO_PROVIDER = "no_provider"
    INVALID = "invalid"
    NOT_FOUND = "not_found"
    CONFLICT = "conflict"
    UNAVAILABLE = "unavailable"
    INTERNAL = "internal"


@dataclass(frozen=True, slots=True)
class Err:
    kind: ErrKind
    message: str
    retryable: bool = False


@dataclass(frozen=True, slots=True)
class Ok[T]:
    value: T


type Reply[T] = Ok[T] | Err


class Decision(Enum):
    """权限三态（不变量 I2）。

    两条硬约束，由 `tests/test_invariants.py` 强制：

    * **不是 `IntEnum` / `IntFlag`**：成员值为 0 时会被 `bool()` 判假；
    * **`__bool__` 抛 `TypeError`**：这是本条的关键。枚举**不实现** `__bool__`
      时走的是默认对象真值，`bool(Decision.DENY)` 恒为 `True` —— 也就是说
      `if decision:` 对 DENY 也会进真分支，静默走错。所以这里把"当 bool 用"
      从**静默错误**升级为**立即崩溃**。
    """

    ALLOW = "allow"
    DENY = "deny"
    UNCERTAIN = "uncertain"

    def __bool__(self) -> bool:
        msg = (
            f"Decision.{self.name} 不能当 bool 用（不变量 I2）："
            "请显式比较 `is Decision.ALLOW` / `is Decision.DENY`，"
            "或把 UNCERTAIN 交给默认值声明表。"
        )
        raise TypeError(msg)


@dataclass(frozen=True, slots=True)
class Subject:
    """谁在做（不变量 I6）。哪怕当前只有本机单用户也必须携带。"""

    id: str
    kind: str = "local_user"


@dataclass(frozen=True, slots=True)
class EventEnvelope:
    """事件封套，内核资产；传输只是绑定（不变量 I8）。"""

    topic: str
    subject: Subject
    payload: dict[str, Any]
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    seq: int = 0
    ts_wall: str = ""
    ts_mono: int = 0
    cause: str | None = None
    version: int = ENVELOPE_VERSION

    def to_wire(self) -> bytes:
        """Serialize the envelope. Transport bindings only ever move these bytes."""
        return json.dumps(
            {
                "id": self.id,
                "seq": self.seq,
                "ts_wall": self.ts_wall,
                "ts_mono": self.ts_mono,
                "topic": self.topic,
                "subject": {"id": self.subject.id, "kind": self.subject.kind},
                "cause": self.cause,
                "payload": self.payload,
                "version": self.version,
            },
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")

    @classmethod
    def from_wire(cls, wire: bytes) -> EventEnvelope:
        raw: dict[str, Any] = json.loads(wire.decode("utf-8"))
        subject = raw["subject"]
        return cls(
            topic=raw["topic"],
            subject=Subject(id=subject["id"], kind=subject["kind"]),
            payload=raw["payload"],
            id=raw["id"],
            seq=raw["seq"],
            ts_wall=raw["ts_wall"],
            ts_mono=raw["ts_mono"],
            cause=raw["cause"],
            version=raw["version"],
        )


@dataclass(frozen=True, slots=True)
class Command[T]:
    """调用平面的请求。同样带 `id` / `subject` / `cause`。"""

    capability: str
    subject: Subject
    request: T
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    cause: str | None = None


@runtime_checkable
class Transport(Protocol):
    """传输绑定：只搬运 bytes，不理解封套语义（不变量 I8）。"""

    def publish(self, wire: bytes) -> None: ...

    def drain(self) -> list[bytes]: ...


@runtime_checkable
class Guard(Protocol):
    """权限判定唯一入口（不变量 I2）。"""

    def __call__(self, subject: Subject, action: str, obj: object) -> Decision: ...


class Sequencer:
    """进程内单调递增序号，用于定序与补洞。"""

    __slots__ = ("_lock", "_value")

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._value = 0

    def next(self) -> int:
        with self._lock:
            self._value += 1
            return self._value

    @property
    def current(self) -> int:
        with self._lock:
            return self._value


def wall_clock(ts_ns: int) -> str:
    """纳秒时间戳 -> 带时区的 ISO8601。"""
    return datetime.fromtimestamp(ts_ns / 1_000_000_000, tz=UTC).isoformat()
