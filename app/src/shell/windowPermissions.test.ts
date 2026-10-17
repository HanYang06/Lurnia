// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 窗口权限门禁（自绘标题栏）。
 *
 * `tauri.conf.json` 把 `decorations` 关掉之后，拖窗与最小化/最大化/关闭都归前端调用，
 * 而 Tauri v2 的 ACL 只放行 capability 里显式列出的命令。`core:default` 展开出的
 * `core:window:default` **只有只读 API**（`allow-is-*`、`allow-title` 等），写命令一条都
 * 不在里面。漏一条的失败方式是最坏的一种：按钮照常渲染，点了没反应，只有真机点一下才
 * 看得出来 —— 没有异常、没有红字，只有 ACL 的一条 denial。
 *
 * 所以把这个 bug 钉成两条机械检查：
 *
 * 1. capability 里逐字存在那四条写权限；
 * 2. 这四条字符串也出现在 Tauri 生成的 `desktop-schema.json` 权限枚举里。
 *
 * 第 2 条是给手滑用的：`allow-minimise`（英式拼写）与 `allow-minimize` 在运行时没有
 * 任何区别，都是静默拒绝；只有对照 schema 的枚举才能在 CI 里抓到。
 *
 * 路径一律从**当前工作目录**算：vitest 的 root 就是 `app/`（见 vitest.config.ts），
 * 所以 capability 在 `src-tauri/capabilities/default.json`（不是 `../src-tauri` ——
 * 那会指到仓库根，根下没有 src-tauri）。`gen/` 被 `app/src-tauri/.gitignore` 忽略，
 * 干净 checkout 里可能没有 schema，那种情况下第 2 条明确 skip，而不是假装通过。
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const appDir = process.cwd();
const CAPABILITY_PATH = path.join(appDir, "src-tauri/capabilities/default.json");
const SCHEMA_PATH = path.join(appDir, "src-tauri/gen/schemas/desktop-schema.json");

/**
 * 自绘标题栏真的会调用的四条写命令。
 *
 * 来源：`WindowControls.tsx` 的 `minimize()` / `toggleMaximize()` / `close()`，
 * 以及 `Shell.tsx` 上 `data-tauri-drag-region` 走的 `start_dragging`。
 * 名字必须与 Tauri 生成的权限标识符逐字一致，大小写与连字符都算。
 */
const REQUIRED_PERMISSIONS = [
  "core:window:allow-start-dragging",
  "core:window:allow-minimize",
  "core:window:allow-toggle-maximize",
  "core:window:allow-close",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 读一个 JSON 文件。解析失败会在这里直接抛，比后面读出一堆 undefined 清楚。 */
function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** capability 文件里的 `permissions` 数组。形状不对就响亮地失败。 */
function readCapabilityPermissions(): string[] {
  const parsed = readJson(CAPABILITY_PATH);
  if (!isRecord(parsed) || !Array.isArray(parsed.permissions)) {
    throw new Error(`${CAPABILITY_PATH} 里没有 permissions 数组`);
  }
  const values = parsed.permissions.filter(
    (value): value is string => typeof value === "string",
  );
  if (values.length !== parsed.permissions.length) {
    throw new Error(`${CAPABILITY_PATH} 的 permissions 里有非字符串条目`);
  }
  return values;
}

/**
 * `desktop-schema.json` 的 `definitions.Identifier.oneOf` 就是 Tauri 的权限枚举，
 * 每条形如 `{ "const": "core:window:allow-close", ... }`。
 */
function readSchemaPermissionIdentifiers(): string[] {
  const parsed = readJson(SCHEMA_PATH);
  if (!isRecord(parsed) || !isRecord(parsed.definitions)) {
    throw new Error(`${SCHEMA_PATH} 里没有 definitions`);
  }
  const identifier = parsed.definitions.Identifier;
  if (!isRecord(identifier) || !Array.isArray(identifier.oneOf)) {
    throw new Error(`${SCHEMA_PATH} 里没有 definitions.Identifier.oneOf`);
  }
  return identifier.oneOf.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry.const === "string" ? [entry.const] : [],
  );
}

describe("capabilities/default.json：自绘标题栏的写权限必须逐条显式开", () => {
  const permissions = readCapabilityPermissions();

  for (const permission of REQUIRED_PERMISSIONS) {
    it(`声明了 ${permission}`, () => {
      expect(permissions).toContain(permission);
    });
  }

  it("保留了原有的 core:default 与 opener:default", () => {
    expect(permissions).toContain("core:default");
    expect(permissions).toContain("opener:default");
  });

  it("没有顺手开前端用不到的宽权限（close 就够了，不需要 destroy）", () => {
    // allow-destroy 跳过 close 请求直接销毁窗口，前端没有任何地方需要它。
    // 维护者的口径：前端只该有它真的用到的那几条。
    expect(permissions).not.toContain("core:window:allow-destroy");
  });
});

const schemaExists = existsSync(SCHEMA_PATH);

// 条件 skip：`gen/` 是 Tauri 生成并被 gitignore 的目录，干净 checkout 里可能不存在。
const itWithSchema = schemaExists ? it : it.skip;
const schemaTestTitle = schemaExists
  ? "四条标识符都在 desktop-schema.json 的权限枚举里"
  : "四条标识符都在 desktop-schema.json 的权限枚举里（gen/ 被 gitignore，本机无该文件，跳过）";

describe("Tauri 生成的权限枚举：拼错一个字母就静默失效", () => {
  itWithSchema(schemaTestTitle, () => {
    const identifiers = readSchemaPermissionIdentifiers();
    // 防止把文件读成空数组之后「四条都不在里面」被误判成通过。
    expect(identifiers.length).toBeGreaterThan(REQUIRED_PERMISSIONS.length);
    for (const permission of REQUIRED_PERMISSIONS) {
      expect(
        identifiers,
        `${permission} 不在 desktop-schema.json 的 Identifier 枚举里 —— 标识符拼错了`,
      ).toContain(permission);
    }
  });
});
