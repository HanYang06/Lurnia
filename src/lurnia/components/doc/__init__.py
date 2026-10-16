# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""文档服务组件（路线 114）。

口径见 [editor.md](../../../docs/design/editor.md) §3 / §十七。

三块拼成一件事：`store`（读写与提交点）、`refs`（引用索引与反链，111）、
`annotations`（批注与锚点重定位，112）；`anchor` 是它们共用的坐标（§五）。
"""

from lurnia.components.doc.anchor import (
    ACTIVE,
    ORPHANED,
    QUOTE_LIMIT,
    Anchor,
    Placement,
    block_texts,
    plain_text,
    relocate,
)
from lurnia.components.doc.annotations import AnnotationStore
from lurnia.components.doc.model import (
    Compiled,
    DocumentError,
    compile_schema,
    validate,
)
from lurnia.components.doc.refs import RefIndex
from lurnia.components.doc.registry import (
    DocType,
    Migration,
    Registry,
    RegistryError,
    check_chain,
    current_version,
    migrate,
)
from lurnia.components.doc.store import MAX_BODY_BYTES, SCHEMA, DocStore

__all__ = [
    "ACTIVE",
    "MAX_BODY_BYTES",
    "ORPHANED",
    "QUOTE_LIMIT",
    "SCHEMA",
    "Anchor",
    "AnnotationStore",
    "Compiled",
    "DocStore",
    "DocType",
    "DocumentError",
    "Migration",
    "Placement",
    "RefIndex",
    "Registry",
    "RegistryError",
    "block_texts",
    "check_chain",
    "compile_schema",
    "current_version",
    "migrate",
    "plain_text",
    "relocate",
    "validate",
]
