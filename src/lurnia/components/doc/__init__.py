# SPDX-FileCopyrightText: 2026 HanYang06
# SPDX-License-Identifier: Apache-2.0
"""文档服务组件（路线 114）。

口径见 [editor.md](../../../docs/design/editor.md) §3 / §十七。
"""

from lurnia.components.doc.model import (
    Compiled,
    DocumentError,
    compile_schema,
    validate,
)
from lurnia.components.doc.registry import DocType, Registry, RegistryError
from lurnia.components.doc.store import MAX_BODY_BYTES, SCHEMA, DocStore

__all__ = [
    "MAX_BODY_BYTES",
    "SCHEMA",
    "Compiled",
    "DocStore",
    "DocType",
    "DocumentError",
    "Registry",
    "RegistryError",
    "compile_schema",
    "validate",
]
