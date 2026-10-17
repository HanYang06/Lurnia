# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""配置层：内核第 0 层。

不变量 I3：`config → log → storage → bus`，本层不得 import 上层。

引擎用 OnConf。**OnConf 的引擎是进程级单例**：`AutoConf` 绑定之后不能再绑
（第二次调用抛 `ConfError`，而 `conf()` 仍写在旧目录）。绑定因此做成一次性动作：
重复绑定到**同一个** home 是幂等的，换 home 则显式报错 —— 否则就是"以为换了目录、
其实还写在旧目录"的静默错误，比直接报错难查得多。

推论：本层的隔离测试必须在**子进程**里跑，同进程内重绑不可能。
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from onconf import AutoConf, conf

from lurnia.core.contracts import Err, ErrKind, Ok, Reply

__all__ = [
    "Binding",
    "ConfError",
    "binding",
    "configure",
    "declare",
    "read",
    "try_read",
]


class ConfError(Exception):
    """配置层自身的失败。层内用异常，跨模块边界才转 `Err`。"""


@dataclass(frozen=True, slots=True)
class Binding:
    home: Path


_lock = threading.Lock()
_binding: Binding | None = None


def configure(home: str | Path, *, log_console: bool = True) -> Binding:
    """绑定配置目录。同一 home 幂等；换 home 显式报错。

    OnConf 的审计日志默认也往 stderr 复写一份；`log_console=False` 只关控制台
    副本，文件副本仍在（审计不静音）。测试用这个开关避免刷屏。
    """
    resolved = Path(home).expanduser().resolve()
    global _binding  # noqa: PLW0603 - 单例绑定，见模块 docstring
    with _lock:
        if _binding is not None:
            if _binding.home == resolved:
                return _binding
            msg = (
                f"配置引擎已绑定到 {_binding.home}，不能改绑到 {resolved}。"
                "OnConf 的引擎是进程级单例；请在进程最早处决定 home。"
            )
            raise ConfError(msg)
        AutoConf(home=str(resolved), log_console=log_console)
        _binding = Binding(home=resolved)
        return _binding


def binding() -> Binding:
    with _lock:
        if _binding is None:
            msg = "配置未初始化：先调用 configure(home)"
            raise ConfError(msg)
        return _binding


def read(key: str) -> Any:
    """读一个键。OnConf 的错误分类不是内核契约，这里统一翻译成 `ConfError`。"""
    binding()
    try:
        return conf(key)
    except Exception as exc:
        msg = f"读取配置 {key!r} 失败：{exc}"
        raise ConfError(msg) from exc


def declare(key: str, value: Any, doc: str | None = None) -> Any:
    """声明并补齐一个键。

    OnConf 的规则：**运行时不覆盖文件里已有的值**，只填补缺失的键。
    所以这是"声明 + 补齐"，不是"强制改写"。
    """
    binding()
    try:
        if doc is None:
            return conf(key, value)
        return conf(key, value, doc)
    except Exception as exc:
        msg = f"写入配置 {key!r} 失败：{exc}"
        raise ConfError(msg) from exc


def try_read(key: str) -> Reply[Any]:
    """跨模块边界的形态：失败走 `Err`，不让私有异常穿出去。"""
    try:
        return Ok(read(key))
    except ConfError as exc:
        return Err(ErrKind.NOT_FOUND, str(exc), retryable=False)
