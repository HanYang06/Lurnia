# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""内核包：四层单向 config → log → storage → bus（不变量 I3）。

`contracts` 是四层共用的基座，不计入单向链。
"""

from __future__ import annotations

__all__ = ["bus", "conf", "contracts", "log", "storage"]
