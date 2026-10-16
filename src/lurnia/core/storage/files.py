# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""存储层的文件写入原语。

「临时文件 → `fsync` → `os.replace`」这件事有两个使用者（附件库、事件日志归档），
所以它单独一层。顺序写错一次就会留下半截文件，而半截文件在两个地方都表现为
「数据看起来在、其实坏了」—— 这种错不该有第二份实现。
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

__all__ = ["write_atomic"]


def write_atomic(path: Path, data: bytes) -> bool:
    """把 ``data`` 原子写到 ``path``；目标已存在则返回 `False` 且**不动它**。

    先写同目录下的临时文件并 `fsync`，再 `os.replace` 换名：同一文件系统内
    `replace` 是原子的，所以并发读到的要么是旧内容、要么是完整的新内容。

    返回 `False` 而不是覆盖，是因为两个使用者的语义都是「这份内容已经有了」：
    附件库靠它去重，归档靠它拒绝「删行没成功」之后的重跑。
    """
    if path.is_file():
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    handle_fd, temp_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    temp = Path(temp_name)
    try:
        with os.fdopen(handle_fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    return True
