# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""Sidecar 入口：被 Tauri 宿主拉起的 Python 核心。

口径见 [packaging.md](../../../docs/design/packaging.md)（§五 行协议、§六 数据目录）。

**这是内核的对外入口，不是 UI。** 进程由宿主（Tauri）管理，绝不自己开浏览器、
不起监听端口、不联网（不变量 I9）。通信走 stdio：一行一个 JSON 对象。

两件事刻意不在这里做：

* **事件线不在这里拼。** 它们是 :class:`StdioTransport` 这个**传输绑定**把封套的
  wire 字节搬出去的（不变量 I8：封套归内核，传输只搬 bytes）。这里只管控制线
  （`ready` / `error`）与进程生命周期。
* **stdin 走 v2 的 ``call`` 帧。** 宿主 → 内核的请求经 Tauri IPC 落到这里，
  回复走 ``reply`` 帧（packaging.md §五）；读到 EOF 就退出，所以宿主没了核心
  不会变孤儿。

输出一律用 ``sys.stdout.write``（不用 ``print``）—— stdout 是协议通道，必须精确
控制字节，且内核层不允许随手打印。
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO

from lurnia import __version__
from lurnia.assembly import Core, assemble
from lurnia.components import install as install_components
from lurnia.core import conf
from lurnia.core.contracts import Command, Err, ErrKind, Ok, Reply, Subject
from lurnia.core.storage import KERNEL_SCHEMA

#: v2：多了宿主 → 内核的 `call` / `reply` 两帧（路线 115）。
#: 0.1.0 未发布，所以是干净升级，不做双版本兼容。
PROTOCOL_VERSION = 2

#: 数据目录的覆盖口子：测试与便携安装用，宿主日常不传（packaging.md §五）。
DATA_DIR_ENV = "LURNIA_DATA_DIR"

#: 事件日志保留条数（路线 004）。宿主可改 settings.json 覆盖；声明式写入见
#: :func:`_rotate_on_start`。
EVENT_LOG_KEEP_KEY = "event_log.keep"
DEFAULT_EVENT_LOG_KEEP = 50_000

#: 本机单用户。真主体标识是权限模块的事（路线 014），这里先给一个明确的值。
LOCAL_SUBJECT = Subject(id="local")


def _use_utf8(stream: TextIO) -> None:
    """把协议通道锁成 UTF-8。**两个方向都要**（v2 起 stdin 也走协议）。

    宿主按 UTF-8 解 JSON 行；本机编码一进来（中文 Windows 上是 GBK），中文
    payload 立刻变成乱码甚至解不出来。协议通道的字节必须自己说了算，不能听
    控制台的。测试里注入的 `StringIO` 没有 `reconfigure`，跳过即可。

    > 这条在 v2 上踩过：只锁了 stdout，中文经 `call` 帧进来当场解不开 ——
    > 是端到端测试（子进程 + 真入口）抓到的，单元测试看不见。
    """
    reconfigure = getattr(stream, "reconfigure", None)
    if callable(reconfigure):
        reconfigure(encoding="utf-8")


def _emit(payload: dict[str, Any], *, stream: TextIO | None = None) -> None:
    """写一行 JSON 到 stdout 并立刻 flush（宿主按行读，不能等缓冲）。"""
    target = stream if stream is not None else sys.stdout
    target.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")
    target.flush()


class StdioTransport:
    """传输绑定：把封套的 wire 字节写成 stdout 上的一行 ``event``。

    传输只搬 bytes（不变量 I8）：这里把内核给的 wire **原样**嵌进协议行，字段名
    一个不改，也不替内核解释它。

    ``drain()`` 故意返回空表：这条通道只有内核 → UI 一个方向，假装能回读只会让
    调用方以为存在一条回读通道。
    """

    def __init__(self, stream: TextIO) -> None:
        self._stream = stream

    def publish(self, wire: bytes) -> None:
        _emit(
            {
                "type": "event",
                "protocol": PROTOCOL_VERSION,
                "envelope": json.loads(wire),
            },
            stream=self._stream,
        )

    def drain(self) -> list[bytes]:
        return []


@dataclass(frozen=True, slots=True)
class Options:
    """命令行解析结果。未知参数**不静默吞掉**，交给调用方报错。"""

    data_dir: Path | None = None
    leftover: tuple[str, ...] = ()


def _parse(args: list[str]) -> Options:
    """只认 ``--data-dir <path>`` / ``--data-dir=<path>``，其余原样留着。"""
    data_dir: Path | None = None
    leftover: list[str] = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "--data-dir":
            index += 1
            if index >= len(args):
                leftover.append(arg)
                break
            data_dir = Path(args[index])
        elif arg.startswith("--data-dir="):
            data_dir = Path(arg.split("=", 1)[1])
        else:
            leftover.append(arg)
        index += 1
    return Options(data_dir=data_dir, leftover=tuple(leftover))


def _data_dir_from_env() -> Path | None:
    """数据目录：``--data-dir`` > ``LURNIA_DATA_DIR`` > 平台默认（`None`）。"""
    override = os.environ.get(DATA_DIR_ENV)
    return Path(override) if override else None


def _rotate_on_start(core: Core) -> int:
    """启动时轮转一次事件日志（路线 004），返回归档条数。

    保留条数走配置声明（路线 001 的「声明 + 补齐」用法）：键不存在就按默认值补齐，
    存在就用文件里的值 —— 运行时不覆盖用户写的值。
    """
    conf.declare(
        EVENT_LOG_KEEP_KEY,
        DEFAULT_EVENT_LOG_KEEP,
        "事件日志保留条数：轮转时留最新的多少条",
    )
    keep = int(conf.read(EVENT_LOG_KEEP_KEY))
    return core.rotate_event_log(keep=keep).archived


def _announce_start(core: Core, rotated: int) -> None:
    """把「核心已启动」做成一条**真事件**：先落日志（I5），再上广播平面。

    顺序就是 I5 的顺序，而这一条恰好也被推给 UI —— 于是「日志里有」与
    「UI 看到了」是同一个封套，不用对两次账。
    """
    envelope = core.bus.envelope(
        "kernel.started",
        {"rotated": rotated, "version": __version__},
        subject=LOCAL_SUBJECT,
    )
    core.record(envelope)
    core.bus.emit_envelope(envelope)


def _wire_reply(reply: Reply[Any]) -> dict[str, Any]:
    """把内核的 `Ok` / `Err` 摊成线上形状。

    `Err` 用共享错误模型（bus.md §四）：跨边界的失败只有这一种形状，
    调用方不需要 `except Exception`。
    """
    if isinstance(reply, Ok):
        return {"ok": reply.value}
    return {
        "err": {
            "kind": reply.kind.value,
            "message": reply.message,
            "retryable": reply.retryable,
        }
    }


def _handle_line(raw: str, core: Core, out: TextIO) -> None:
    """处理一行宿主 → 内核的报文。v2 只认 `call`，其余一律显式报错。

    **subject 由内核填**（本机主体），前端不传、也不许造身份（ui.md §九，I6）——
    所以 `call` 帧里根本没有 subject 字段。
    """
    text = raw.strip()
    if not text:
        return
    protocol = {"protocol": PROTOCOL_VERSION}
    try:
        frame = json.loads(text)
    except json.JSONDecodeError as exc:
        _emit(
            {"type": "error", **protocol, "message": f"报文不是合法 JSON：{exc}"},
            stream=out,
        )
        return
    if not isinstance(frame, dict) or frame.get("type") != "call":
        _emit(
            {"type": "error", **protocol, "message": "v2 只认 call 帧"},
            stream=out,
        )
        return
    call_id = frame.get("id")
    if not isinstance(call_id, str) or not call_id:
        _emit(
            {"type": "error", **protocol, "message": "call 帧缺少 id，无法关联回复"},
            stream=out,
        )
        return
    capability = frame.get("capability")
    reply: Reply[Any]
    if not isinstance(capability, str) or not capability:
        reply = Err(ErrKind.INVALID, "call 帧缺少 capability")
    else:
        command = Command(
            capability=capability,
            subject=LOCAL_SUBJECT,
            request=frame.get("request"),
        )
        reply = core.bus.invoke(command)
    _emit(
        {"type": "reply", **protocol, "id": call_id, "reply": _wire_reply(reply)},
        stream=out,
    )


def serve(
    *,
    data_dir: str | Path | None = None,
    stream: TextIO | None = None,
    stdin: TextIO | None = None,
) -> int:
    """正常启动：装配核心、推事件、等宿主关掉 stdin。

    `data_dir` 为 `None` 时先看环境变量，再看平台默认（packaging.md §六）。
    """
    out = stream if stream is not None else sys.stdout
    source = stdin if stdin is not None else sys.stdin
    _use_utf8(out)
    _use_utf8(source)  # v2：stdin 也是协议通道，两个方向都锁 UTF-8
    if data_dir is None:
        data_dir = _data_dir_from_env()

    try:
        core = assemble(data_dir, transport=StdioTransport(out))
        install_components(core)  # 组件装配台：注册文档类型与能力（路线 108 / 114）
    except Exception as exc:  # 起不来必须报给宿主，不能只留 traceback
        _emit(
            {
                "type": "error",
                "protocol": PROTOCOL_VERSION,
                "message": f"核心起不来：{exc}",
            },
            stream=out,
        )
        return 1

    try:
        rotated = _rotate_on_start(core)
        _emit(
            {
                "type": "ready",
                "protocol": PROTOCOL_VERSION,
                "version": __version__,
                "data_dir": str(core.paths.home),
                "db_version": core.db.current_version(KERNEL_SCHEMA),
                "frozen": bool(getattr(sys, "frozen", False)),
                "rotated": rotated,
            },
            stream=out,
        )
        _announce_start(core, rotated)
        # v2：解析 stdin。EOF 仍然是退出的信号（生命周期归宿主）
        for line in source:
            _handle_line(line, core, out)
    except Exception as exc:  # 同上：宿主需要一行能读懂的失败
        _emit(
            {
                "type": "error",
                "protocol": PROTOCOL_VERSION,
                "message": f"核心运行失败：{exc}",
            },
            stream=out,
        )
        return 1
    finally:
        core.close()
    return 0


def self_check() -> int:
    """自检：验证打包产物**在冻结环境里**真的能用。

    这是打包脚本的验证钩子。它检查两件在成品里最容易坏的事：

    1. **DDL 资源读得到** —— `.sql` 不会被 PyInstaller 自动收集，必须
       ``--add-data``；漏了就只在装完之后才炸；
    2. **能建库并迁移** —— 资源齐了不等于路径对（冻结后 ``sys.executable``
       指向临时解包目录，任何靠它推路径的写法都会在这里现原形）。
    """
    import tempfile

    from lurnia.core.ddl import highest_version, read_schema, read_tables
    from lurnia.core.storage import open_db

    problems: list[str] = []
    try:
        migrations = read_schema(KERNEL_SCHEMA)
        tables = read_tables(KERNEL_SCHEMA)
    except Exception as exc:
        problems.append(f"读不到 DDL 资源：{exc}")
        migrations, tables = [], []

    # **文档 schema 资源**：`.json` 同样不会被 PyInstaller 自动收集（editor.md §4.5）。
    # 漏了它 = 装完之后一存文档就报「没有注册过的文档类型」——所以和 `.sql` 同级验。
    doc_types: list[str] = []
    try:
        from lurnia.components import NOTE_PACKAGE, NOTE_SCHEMA, load_schema
        from lurnia.components.doc import compile_schema

        compiled = compile_schema(load_schema(NOTE_PACKAGE, NOTE_SCHEMA))
        doc_types = sorted(compiled.allowed)
    except Exception as exc:
        problems.append(f"读不到文档 schema 资源：{exc}")

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
            "doc_schema_types": doc_types,
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
    _use_utf8(sys.stdout)

    if "--version" in args:
        _emit({"type": "version", "protocol": PROTOCOL_VERSION, "version": __version__})
        return 0

    if "--self-check" in args:
        return self_check()

    options = _parse(args)
    if options.leftover:
        _emit(
            {
                "type": "error",
                "protocol": PROTOCOL_VERSION,
                "message": f"未知参数：{' '.join(options.leftover)}",
            }
        )
        return 2

    return serve(data_dir=options.data_dir)


if __name__ == "__main__":
    raise SystemExit(main())
