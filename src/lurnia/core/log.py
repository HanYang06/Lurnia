# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""日志层：内核第 1 层。

不变量 I3：本层只可依赖 config 与契约。

这一层刻意很薄：记录器族与级别交给标准库 `logging`，**不自研日志框架**。
内核其余部分只经 `get_logger()` 拿记录器，因此换 handler / 换格式不牵动调用点。
"""

from __future__ import annotations

import logging
import sys
from typing import TextIO

ROOT_LOGGER = "lurnia"
DEFAULT_FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"

_configured = False


def configure(
    *,
    level: int = logging.INFO,
    stream: TextIO | None = None,
    fmt: str = DEFAULT_FORMAT,
) -> logging.Logger:
    """配置内核记录器族。幂等：重复调用只更新级别与 handler。"""
    global _configured  # noqa: PLW0603 - module-level "configure once" flag
    logger = logging.getLogger(ROOT_LOGGER)
    logger.setLevel(level)
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        handler.close()
    handler = logging.StreamHandler(stream if stream is not None else sys.stderr)
    handler.setFormatter(logging.Formatter(fmt))
    logger.addHandler(handler)
    # 内核自己管 handler，不让记录冒泡到 root（否则测试里会重复输出）
    logger.propagate = False
    _configured = True
    return logger


def is_configured() -> bool:
    return _configured


def get_logger(name: str) -> logging.Logger:
    """取一个内核记录器。未 configure 时仍是可用的标准库记录器。"""
    return logging.getLogger(f"{ROOT_LOGGER}.{name}")
