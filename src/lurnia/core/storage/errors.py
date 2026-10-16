# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""存储层的失败类型。

单独一个文件是为了**断环**：附件库要抛 `StorageError`，而它的名字由
`storage/__init__.py` 转出。错误类型挪到这里，两个模块都能 import，谁也不用
import 谁。
"""

from __future__ import annotations

__all__ = ["AttachmentError", "StorageError"]


class StorageError(Exception):
    """存储层自身的失败。"""


class AttachmentError(StorageError):
    """附件库的失败：缺元数据行、缺本体、引用计数对不上。

    继承 `StorageError`，所以按层捕获的老写法不受影响。
    """
