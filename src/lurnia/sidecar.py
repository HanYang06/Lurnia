# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""Sidecar 入口：被 Tauri 宿主拉起的 Python 核心。

口径见 [packaging.md](../../../docs/design/packaging.md)。

**这是内核的对外入口，不是 UI。** 进程由宿主（Tauri）管理，绝不自己开浏览器、
不起监听端口、不联网（不变量 I9）。通信走 stdio：一行一个 JSON 对象。

输出一律用 ``sys.stdout.write``（不用 ``print``）—— stdout 是协议通道，必须
精确控制字节，且内核层不允许随手打印。
"""

from __future__ import annotations

import json
import sys
from typing import Any

PROTOCOL_VERSION = 1


def _emit(payload: dict[str, Any]) -> None:
    """写一行 JSON 到 stdout 并立刻 flush（宿主按行读，不能等缓冲）。"""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")
    sys.stdout.flush()


def self_check() -> int:
    """自检：验证打包产物**在冻结环境里**真的能用。

    这是打包脚本的验证钩子。它检查两件在成品里最容易坏的事：

    1. **DDL 资源读得到** —— `.sql` 不会被 PyInstaller 自动收集，必须
       ``--add-data``；漏了就只在装完之后才炸；
    2. **能建库并迁移** —— 资源齐了不等于路径对（冻结后 ``sys.executable``
       指向临时解包目录，任何靠它推路径的写法都会在这里现原形）。
    """
    import tempfile
    from pathlib import Path

    from lurnia.core.ddl import highest_version, read_schema, read_tables
    from lurnia.core.storage import KERNEL_SCHEMA, open_db

    problems: list[str] = []
    try:
        migrations = read_schema(KERNEL_SCHEMA)
        tables = read_tables(KERNEL_SCHEMA)
    except Exception as exc:
        problems.append(f"读不到 DDL 资源：{exc}")
        migrations, tables = [], []

    version = 0
    if not problems:
        with tempfile.TemporaryDirectory() as scratch:
            try:
                db = open_db(Path(scratch) / "selfcheck.db")
                try:
                    version = db.current_version(KERNEL_SCHEMA)
                finally:
                    db.close()
            except Exception as exc:
                problems.append(f"建库/迁移失败：{exc}")

    _emit(
        {
            "type": "self-check",
            "protocol": PROTOCOL_VERSION,
            "frozen": bool(getattr(sys, "frozen", False)),
            "executable": sys.executable,
            "ddl_migrations": [v for v, _ in migrations],
            "ddl_tables": [name for name, _ in tables],
            "expected_version": highest_version(KERNEL_SCHEMA) if migrations else None,
            "migrated_to": version,
            "problems": problems,
            "ok": not problems,
        }
    )
    return 1 if problems else 0


def main(argv: list[str] | None = None) -> int:
    """入口。未知参数按用法错误处理，不静默忽略。"""
    args = list(sys.argv[1:] if argv is None else argv)

    if "--version" in args:
        from lurnia import __version__

        _emit({"type": "version", "protocol": PROTOCOL_VERSION, "version": __version__})
        return 0

    if "--self-check" in args:
        return self_check()

    unknown = [a for a in args if a.startswith("-")]
    if unknown:
        _emit(
            {
                "type": "error",
                "protocol": PROTOCOL_VERSION,
                "message": f"未知参数：{' '.join(unknown)}",
            }
        )
        return 2

    # 正常启动：先握手，宿主据此确认核心已就绪
    _emit(
        {
            "type": "ready",
            "protocol": PROTOCOL_VERSION,
            "frozen": bool(getattr(sys, "frozen", False)),
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
