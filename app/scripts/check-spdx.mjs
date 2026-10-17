// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * SPDX 头检查（前端侧）。仓库约定见 AGENTS.md §5：每个源码与文档文件顶部都带
 *
 *     SPDX-FileCopyrightText: 2026 HanYang06
 *     SPDX-License-Identifier: Apache-2.0
 *
 * Python 侧是靠人守着的 —— 没有对应的门禁。前端从第一天就用脚本钉住，
 * 免得「新加的组件忘了写头」攒到发布前才发现。
 *
 * **匹配的是注释行的形状，不是「包含这两个字符串」**：本文件自己的这段文档注释里
 * 就写着那两个标记。第一版用「前 5 行里包含」判定，于是把它自己的头删掉仍然报通过
 * —— 反向验证（删头必须变红）当场抓到了这个假通过。所以现在要求：
 * 标记**紧跟在注释起始符之后**，且整行就是它。
 *
 * 不检查 JSON：JSON 没有注释，写不了头（package.json / tsconfig.json 因此豁免）。
 *
 * 用法：node scripts/check-spdx.mjs
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 扩展名 → [注释起始符, 注释结束符]。结束符为空表示行注释（TS/JS 用 `//`）。 */
const COMMENT_OPENERS = {
  ".ts": ["//", ""],
  ".tsx": ["//", ""],
  ".js": ["//", ""],
  ".mjs": ["//", ""],
  ".css": ["/*", "*/"],
  ".html": ["<!--", "-->"],
  ".md": ["<!--", "-->"],
};

const SKIP_DIRS = new Set(["node_modules", "dist", "src-tauri", ".vscode", "coverage"]);

const REQUIRED = [
  "SPDX-FileCopyrightText: 2026 HanYang06",
  "SPDX-License-Identifier: Apache-2.0",
];

/** 头必须出现在最前面几行之内 —— 不能藏在文件中间。 */
const HEAD_LINES = 4;

const escapeRe = (raw) => raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 该扩展名下，某个标记作为「一整行注释」的精确形状。 */
function headerPattern(extension, marker) {
  const [open, close] = COMMENT_OPENERS[extension];
  const tail = close ? `\\s*${escapeRe(close)}` : "";
  return new RegExp(`^${escapeRe(open)}\\s?${escapeRe(marker)}${tail}\\s*$`);
}

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.isDirectory()) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      found.push(...walk(full));
      continue;
    }
    if (entry.isFile() && path.extname(entry.name) in COMMENT_OPENERS) {
      found.push(full);
    }
  }
  return found;
}

const problems = [];
let checked = 0;

for (const file of walk(appDir).sort()) {
  const extension = path.extname(file);
  const relative = path.relative(appDir, file).split(path.sep).join("/");
  const head = readFileSync(file, "utf8").split("\n").slice(0, HEAD_LINES);
  checked += 1;

  const missing = REQUIRED.filter(
    (marker) =>
      !head.some((line) => headerPattern(extension, marker).test(line.trimEnd())),
  );
  if (missing.length > 0) {
    problems.push(
      `${relative}：前 ${HEAD_LINES} 行里没有以注释形式出现的 ${missing.join(" 与 ")}`,
    );
  }
}

if (problems.length > 0) {
  console.error(`SPDX 头检查失败（查了 ${checked} 个文件）：`);
  for (const problem of problems) {
    console.error(`  ✗ ${problem}`);
  }
  process.exit(1);
}

console.log(`SPDX 头检查通过（${checked} 个文件）。`);
