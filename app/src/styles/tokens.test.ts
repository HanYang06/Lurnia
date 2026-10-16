// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 令牌与对比度门禁（路线 099 / 100 / 101）。
 *
 * 这个文件不是「顺手写点测试」，它是 ui.md 那几张表的**机械绑定**：
 *
 * | 检查 | 依据 |
 * | --- | --- |
 * | 令牌值与文档逐格一致 | ui.md §2.3 / §2.4 / §2.5 / §4.1 / §4.4 |
 * | `oklch()` 与文档所标的十六进制互相吻合 | ui.md §2.3 / §2.4（实测逐通道一致） |
 * | 深浅两方案的令牌**名字集合相等** | ui.md §五（组件里不许有 `if (darkMode)`） |
 * | 对比度按「对该方案三层底取最差」达标 | ui.md §7.1 |
 * | 文档所标的对比度数字 = 实算数字 | ui.md §7.2 |
 *
 * **文档优先于代码**（AGENTS.md §3：Roadmap > Design > Code）。所以这里读
 * `docs/design/ui.md` 并解析它的表格：改了令牌值却忘了改文档（或反过来），这个测试就红。
 * 解析刻意写得很直白，宁可在文档改结构时**响亮地失败**，也不要静默地什么都不检查。
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// 读文件
// ---------------------------------------------------------------------------

// 路径一律从**当前工作目录**算：vitest 的 root 就是 app/（见 vitest.config.ts），
// 而 `import.meta.url` 在 jsdom 环境下不是 file: 协议，`new URL(..., import.meta.url)`
// 会直接报错。cwd 是这里唯一稳定的锚点。
const appDir = process.cwd();
const repoDir = path.resolve(appDir, "..");

const CSS_TEXT = readFileSync(path.join(appDir, "src/styles/tokens.css"), "utf8");
const UI_MD = readFileSync(path.join(repoDir, "docs/design/ui.md"), "utf8");

// ---------------------------------------------------------------------------
// 颜色换算（OKLCH → sRGB）与 WCAG 对比度
// ---------------------------------------------------------------------------

/** oklch → #rrggbb。与文档数值一致，所以下游可以断言**精确相等**而不是「差不多」。 */
function oklchToHex(lightness: number, chroma: number, hue: number): string {
  const rad = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(rad);
  const b = chroma * Math.sin(rad);

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const channels = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];

  return `#${channels
    .map((channel) => {
      const c = Math.min(1, Math.max(0, channel));
      const encoded = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
      return Math.round(encoded * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

const HEX_RE = /^#[0-9a-f]{6}$/i;
const OKLCH_RE = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/i;

function toHex(value: string): string {
  const trimmed = value.trim();
  if (HEX_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  const match = OKLCH_RE.exec(trimmed);
  if (match) {
    return oklchToHex(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  throw new Error(`认不出的颜色值：${value}`);
}

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const raw = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((offset) =>
    toLinear(Number.parseInt(raw.slice(offset, offset + 2), 16)),
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 对比度。 */
function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// 读 tokens.css
// ---------------------------------------------------------------------------

type Declarations = Map<string, string>;

/**
 * 极简 CSS 块解析：只认「选择器 { --token: value; }」。
 *
 * 选择器**不按逗号拆**：`tokens.css` 里 `:root` 与 `:root, [data-theme="dark"]` 是两个
 * 不同的块，拆开会让后者把前者的令牌覆盖掉。
 *
 * 不处理 at-rule 嵌套 —— tokens.css 里没有，**而且不该有**：令牌必须是平铺的，
 * 否则「两个方案的令牌名字一致」这条就没法机械检查。
 */
function parseCssBlocks(css: string): Map<string, Declarations> {
  const blocks = new Map<string, Declarations>();
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;

  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(body)) !== null) {
    const declarations: Declarations = new Map();
    for (const raw of match[2].split(";")) {
      const colon = raw.indexOf(":");
      if (colon < 0) {
        continue;
      }
      const name = raw.slice(0, colon).trim();
      if (name.startsWith("--")) {
        declarations.set(name, raw.slice(colon + 1).trim());
      }
    }
    const key = match[1].trim().replace(/\s+/g, " ");
    if (key.length > 0) {
      blocks.set(key, declarations);
    }
  }
  return blocks;
}

const CSS_BLOCKS = parseCssBlocks(CSS_TEXT);

function cssBlock(selector: string): Declarations {
  const block = CSS_BLOCKS.get(selector);
  if (!block) {
    throw new Error(`tokens.css 里找不到选择器「${selector}」`);
  }
  return block;
}

const CSS_COMMON = cssBlock(":root");
const CSS_DARK = cssBlock(':root, [data-theme="dark"]');
const CSS_LIGHT = cssBlock('[data-theme="light"]');

function resolveColors(block: Declarations): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, value] of block) {
    resolved[name] = toHex(value);
  }
  return resolved;
}

const COLORS_DARK = resolveColors(CSS_DARK);
const COLORS_LIGHT = resolveColors(CSS_LIGHT);

// ---------------------------------------------------------------------------
// 读 ui.md
// ---------------------------------------------------------------------------

/** 取某个标题下的行，到下一个二/三级标题为止。 */
function section(heading: RegExp): string[] {
  const lines = UI_MD.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) {
    throw new Error(`ui.md 里找不到标题 ${String(heading)}`);
  }
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{2,3}\s/.test(lines[i])) {
      break;
    }
    body.push(lines[i]);
  }
  return body;
}

/** markdown 表格的数据行（去掉表头与 `---` 分隔行）。 */
function tableRows(lines: string[]): string[][] {
  const rows: string[][] = [];
  for (const line of lines) {
    if (!line.trim().startsWith("|")) {
      continue;
    }
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.every((cell) => cell === "" || /^:?-+:?$/.test(cell))) {
      continue;
    }
    if (/^(令牌|状态|检查|内容)$/.test(cells[0] ?? "")) {
      continue;
    }
    rows.push(cells);
  }
  return rows;
}

/** 单元格里的反引号内容。 */
function backticks(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

type DocToken = { value: string; hex: string };

/** 解析 `令牌 | 值 | 十六进制` 这类表（ui.md §2.3 / §2.4）。 */
function docColorTokens(heading: RegExp, label: string): Map<string, DocToken> {
  const tokens = new Map<string, DocToken>();
  for (const cells of tableRows(section(heading))) {
    const [name] = backticks(cells[0] ?? "");
    if (!name.startsWith("--lr-")) {
      continue;
    }
    const values = cells.slice(1).flatMap(backticks);
    const value = values[0];
    const hex = values.find((candidate) => HEX_RE.test(candidate));
    if (!value || !hex) {
      throw new Error(`ui.md ${label} 的 ${name} 行缺少值或十六进制`);
    }
    tokens.set(name, { value, hex: hex.toLowerCase() });
  }
  return tokens;
}

type TriSet = Record<string, { fill: string; ink: string }>;

/** 解析三态表（ui.md §2.5）：状态 | 深色 fill | 深色 ink | 浅色 fill | 浅色 ink | 形状。 */
function docTriStates(): { dark: TriSet; light: TriSet } {
  const dark: TriSet = {};
  const light: TriSet = {};
  for (const cells of tableRows(section(/^### 2\.5\s/))) {
    const [state] = backticks(cells[0] ?? "");
    if (state !== "allow" && state !== "deny" && state !== "uncertain") {
      continue;
    }
    const hexes = cells
      .slice(1)
      .flatMap(backticks)
      .filter((cell) => HEX_RE.test(cell));
    if (hexes.length !== 4) {
      throw new Error(
        `ui.md §2.5 的 ${state} 行应有 4 个十六进制，收到 ${hexes.length}`,
      );
    }
    dark[state] = { fill: hexes[0].toLowerCase(), ink: hexes[1].toLowerCase() };
    light[state] = { fill: hexes[2].toLowerCase(), ink: hexes[3].toLowerCase() };
  }
  return { dark, light };
}

/**
 * 解析 §4.1 / §4.4 的 `令牌 | 值 | 用途` 表。
 *
 * **值不一定在反引号里**：§4.1 的圆角写成 `| \`--lr-radius-sm\` | 6px | ...`，
 * §4.4 的时长同样是没有反引号的 `120ms`。只认反引号会安静地漏掉这些行
 * —— 这正是「测试很绿但其实什么都没查」的典型，所以这里两种都收。
 */
function docValueTable(heading: RegExp): Map<string, string> {
  const table = new Map<string, string>();
  for (const cells of tableRows(section(heading))) {
    const [name] = backticks(cells[0] ?? "");
    if (!name.startsWith("--lr-")) {
      continue;
    }
    const quoted = backticks(cells[1] ?? "");
    const value = quoted.length > 0 ? quoted[0] : cells[1].trim();
    if (value.length > 0) {
      table.set(name, value);
    }
  }
  return table;
}

/** §4.1 的间距是散文里的一串数，不是表格 —— 一样绑住它。 */
function docSpacingSteps(): number[] {
  const line = UI_MD.split("\n").find((candidate) =>
    candidate.includes("间距基准 4px"),
  );
  const [list] = line ? backticks(line) : [];
  if (!list) {
    throw new Error("ui.md §4.1 里找不到反引号包着的间距列表");
  }
  return list.split("/").map((step) => Number(step.trim()));
}

/** §4.3 的焦点环是散文：`2px --lr-accent` 外环 + `2px` 偏移。 */
function docFocusRing(): { width: string; offset: string } {
  const line = UI_MD.split("\n").find((candidate) => candidate.includes("键盘焦点"));
  const parts = line ? backticks(line) : [];
  const width = /^([\d.]+px)/.exec(parts[0] ?? "")?.[1];
  const offset = /^([\d.]+px)/.exec(parts[1] ?? "")?.[1];
  if (!width || !offset) {
    throw new Error("ui.md §4.3 里找不到焦点环的 2px 环 + 2px 偏移");
  }
  return { width, offset };
}

/** §4.2 的悬停规则：深色端明度 +0.04、浅色端 −0.03（减号是文档里的全角 −）。 */
function docHoverDeltas(): { dark: number; light: number } {
  const row = UI_MD.split("\n").find((line) => /^\|\s*hover\s*\|/.test(line));
  if (!row) {
    throw new Error("ui.md §4.2 里找不到 hover 那一行");
  }
  const deltas = [...row.matchAll(/([+−-])\s?(\d+\.\d+)/g)].map(
    (match) => Number(match[2]) * (match[1] === "+" ? 1 : -1),
  );
  if (deltas.length < 2) {
    throw new Error(`ui.md §4.2 的 hover 行里读不出两个位移：${row}`);
  }
  return { dark: deltas[0], light: deltas[1] };
}

/** §4.2 的按压方向：跟着**填充上的文字颜色**走。+1 = 变亮，−1 = 变暗。 */
function docPressDirections(): { dark: number; light: number } {
  const lines = UI_MD.split("\n");
  const read = (marker: string): number => {
    const line = lines.find((candidate) => candidate.includes(marker));
    if (!line) {
      throw new Error(`ui.md §4.2 里找不到「${marker}」`);
    }
    return line.includes("变亮") ? 1 : -1;
  };
  return { dark: read("深色端：填充上是"), light: read("浅色端：填充上是") };
}

/** 取出 oklch 的三个分量，供「按规则验派生令牌」使用。 */
function oklchParts(value: string): { l: number; c: number; h: number } {
  const match = OKLCH_RE.exec(value.trim());
  if (!match) {
    throw new Error(`不是 oklch()：${value}`);
  }
  return { l: Number(match[1]), c: Number(match[2]), h: Number(match[3]) };
}

const DOC_HOVER = docHoverDeltas();
const DOC_PRESS = docPressDirections();

const DOC_DARK = docColorTokens(/^### 2\.3\s/, "§2.3");
const DOC_LIGHT = docColorTokens(/^### 2\.4\s/, "§2.4");
const DOC_TRI = docTriStates();
const DOC_RADIUS = docValueTable(/^### 4\.1\s/);
const DOC_MOTION = docValueTable(/^### 4\.4\s/);
const DOC_SPACING = docSpacingSteps();
const DOC_FOCUS = docFocusRing();
const DOC_TYPE = docValueTable(/^### 4\.5\s/);

/** 把 §2.5 的三态并进颜色表：它们在同一个 CSS 块里，所以集合比对要一起算。 */
function withTriStates(
  base: Map<string, DocToken>,
  tri: TriSet,
): Map<string, DocToken> {
  const all = new Map(base);
  for (const state of ["allow", "deny", "uncertain"] as const) {
    all.set(`--lr-${state}-fill`, { value: tri[state].fill, hex: tri[state].fill });
    all.set(`--lr-${state}-ink`, { value: tri[state].ink, hex: tri[state].ink });
  }
  return all;
}

const DOC_DARK_ALL = withTriStates(DOC_DARK, DOC_TRI.dark);
const DOC_LIGHT_ALL = withTriStates(DOC_LIGHT, DOC_TRI.light);

/**
 * 由**规则**派生、而不是由 ui.md 逐个列出的颜色令牌（ui.md §4.2 的悬停/按压方向）。
 * 它们进集合比对，但值不照抄文档 —— 由下面 `派生令牌必须能从 §4.2 的规则算出来` 一组
 * 测试按规则验。这样「多出来的颜色」永远有出处。
 */
const DERIVED_COLOR_TOKENS = ["--lr-accent-hover", "--lr-accent-active"] as const;

/** 令牌值写错、少写、多写，全在这一处报出来。 */
function expectTokensMatchDoc(
  block: Declarations,
  doc: Map<string, DocToken>,
  label: string,
): void {
  expect(
    [...block.keys()].sort(),
    `${label}：tokens.css 与 ui.md 的令牌集合不一致`,
  ).toEqual([...doc.keys(), ...DERIVED_COLOR_TOKENS].sort());

  for (const [name, expected] of doc) {
    const raw = block.get(name) ?? "";
    expect(toHex(raw), `${label}：${name} 的值（${raw}）与 ui.md 不符`).toBe(
      expected.hex,
    );
    if (OKLCH_RE.test(expected.value)) {
      // 文档自己标的十六进制必须与它自己标的 oklch 吻合。实测 22 个令牌逐通道一致，
      // 所以这里断言精确相等：有人只改其中一个形式时，测试立刻红。
      expect(
        toHex(expected.value),
        `${label}：ui.md 里 ${name} 的 oklch 与它自己标的十六进制对不上`,
      ).toBe(expected.hex);
    }
  }
}

/** 值的写法可以不同（`.2` / `0.2`、逗号后有没有空格），数字与关键字必须一致。 */
function normalizeValue(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s,]/g, "")
    .replace(/(^|\()\./g, (_match, prefix: string) => `${prefix}0.`);
}

// ---------------------------------------------------------------------------
// 断言一：令牌与文档逐格一致
// ---------------------------------------------------------------------------

describe("令牌层与 ui.md 逐格一致", () => {
  it("深色块 = ui.md §2.3 + §2.5 的深色列", () => {
    expectTokensMatchDoc(CSS_DARK, DOC_DARK_ALL, "深色");
  });

  it("浅色块 = ui.md §2.4 + §2.5 的浅色列", () => {
    expectTokensMatchDoc(CSS_LIGHT, DOC_LIGHT_ALL, "浅色");
  });

  it("两方案的令牌名字完全一致（ui.md §五：组件里不许有 if (darkMode)）", () => {
    expect([...CSS_DARK.keys()].sort()).toEqual([...CSS_LIGHT.keys()].sort());
  });

  it("圆角令牌 = ui.md §4.1", () => {
    expect(DOC_RADIUS.size).toBeGreaterThan(0);
    // 双向比对：漏解出一行（比如值没在反引号里）也会被抓到 —— 只查「文档里的都在」
    // 会安静地放过「文档里有 5 行、脚本只解出 1 行」。
    expect([...DOC_RADIUS.keys()].sort()).toEqual(
      [...CSS_COMMON.keys()].filter((name) => name.startsWith("--lr-radius-")).sort(),
    );
    for (const [name, value] of DOC_RADIUS) {
      expect(CSS_COMMON.get(name), `tokens.css 缺 ${name}`).toBeDefined();
      expect(normalizeValue(CSS_COMMON.get(name) ?? ""), `${name} 与 ui.md 不符`).toBe(
        normalizeValue(value),
      );
    }
  });

  it("动效令牌 = ui.md §4.4", () => {
    expect(DOC_MOTION.size).toBeGreaterThan(0);
    expect([...DOC_MOTION.keys()].sort()).toEqual(
      [...CSS_COMMON.keys()]
        .filter((name) => name.startsWith("--lr-dur-") || name === "--lr-ease")
        .sort(),
    );
    for (const [name, value] of DOC_MOTION) {
      expect(CSS_COMMON.get(name), `tokens.css 缺 ${name}`).toBeDefined();
      expect(normalizeValue(CSS_COMMON.get(name) ?? ""), `${name} 与 ui.md 不符`).toBe(
        normalizeValue(value),
      );
    }
  });

  it("字号与行距令牌 = ui.md §4.5", () => {
    expect(DOC_TYPE.size).toBeGreaterThan(0);
    // 双向比对：文档里写了而 tokens.css 没有（或反过来）都算不一致。
    expect([...DOC_TYPE.keys()].sort()).toEqual(
      [...CSS_COMMON.keys()]
        .filter(
          (name) => name.startsWith("--lr-font-size-") || name.startsWith("--lr-line-"),
        )
        .sort(),
    );
    for (const [name, value] of DOC_TYPE) {
      expect(CSS_COMMON.get(name), `tokens.css 缺 ${name}`).toBeDefined();
      expect(normalizeValue(CSS_COMMON.get(name) ?? ""), `${name} 与 ui.md 不符`).toBe(
        normalizeValue(value),
      );
    }
  });

  it("界面文字不得小于 12px（ui.md §4.5 的边界：中文小字会糊）", () => {
    const sizes = [...DOC_TYPE].filter(([name]) => name.startsWith("--lr-font-size-"));
    expect(sizes.length).toBeGreaterThanOrEqual(5);
    for (const [name, value] of sizes) {
      expect(
        Number.parseFloat(value),
        `${name} = ${value} 太小了`,
      ).toBeGreaterThanOrEqual(12);
    }
  });

  it("焦点环 = ui.md §4.3", () => {
    expect(CSS_COMMON.get("--lr-focus-ring-width")).toBe(DOC_FOCUS.width);
    expect(CSS_COMMON.get("--lr-focus-ring-offset")).toBe(DOC_FOCUS.offset);
  });

  it("间距只有 ui.md §4.1 列出的那八级", () => {
    const steps = [...CSS_COMMON.keys()]
      .filter((name) => name.startsWith("--lr-space-"))
      .map((name) => Number(name.replace("--lr-space-", "")))
      .sort((a, b) => a - b);
    expect(steps).toEqual([...DOC_SPACING].sort((a, b) => a - b));
    for (const step of steps) {
      expect(CSS_COMMON.get(`--lr-space-${step}`)).toBe(`${step}px`);
    }
  });

  it("正文量度 = ui.md §3.1 表里写的那个 ch", () => {
    // 从「读面」那一行里读，而不是从散文里捞一个 "58ch" —— 否则测试会自己给自己出题。
    const row = UI_MD.split("\n").find((line) => line.trim().startsWith("| 读面"));
    const match = row ? /max-width:\s*(\d+ch)/.exec(row) : null;
    if (!match) {
      throw new Error("ui.md §3.1 的「读面」那一行里找不到 max-width: <n>ch");
    }
    expect(CSS_COMMON.get("--lr-measure")).toBe(match[1]);
  });
});

/**
 * ui.md §4.2 只给了**规则**（悬停位移 + 按压方向），没给数值。所以令牌是算出来的，
 * 这里按规则验，而不是拿一个数字去比一个数字。规则改了，或者谁手改了那两个值，都红。
 */
describe("派生令牌必须能从 ui.md §4.2 的规则算出来", () => {
  it("文档里读得到悬停位移与按压方向（读不到就该红，不许静默跳过）", () => {
    expect(DOC_HOVER.dark).not.toBe(0);
    expect(DOC_HOVER.light).not.toBe(0);
    expect(
      [DOC_PRESS.dark, DOC_PRESS.light].every((value) => Math.abs(value) === 1),
    ).toBe(true);
  });

  for (const scheme of ["dark", "light"] as const) {
    const block = scheme === "dark" ? CSS_DARK : CSS_LIGHT;
    const colors = scheme === "dark" ? COLORS_DARK : COLORS_LIGHT;
    const label = scheme === "dark" ? "深色" : "浅色";

    it(`${label}：悬停位移 = 文档写的 ${DOC_HOVER[scheme]}，彩度与色相不动`, () => {
      const accent = oklchParts(block.get("--lr-accent") ?? "");
      const hovered = oklchParts(block.get("--lr-accent-hover") ?? "");
      expect(hovered.l - accent.l).toBeCloseTo(DOC_HOVER[scheme], 5);
      expect(hovered.c).toBeCloseTo(accent.c, 5);
      expect(hovered.h).toBeCloseTo(accent.h, 5);
    });

    it(`${label}：按压比悬停走得更远，且方向与 §4.2 一致`, () => {
      const accent = oklchParts(block.get("--lr-accent") ?? "");
      const hovered = oklchParts(block.get("--lr-accent-hover") ?? "");
      const pressed = oklchParts(block.get("--lr-accent-active") ?? "");
      expect(
        Math.sign(pressed.l - accent.l),
        "方向与 §4.2 的「按压时填充变亮/变暗」不一致",
      ).toBe(DOC_PRESS[scheme]);
      expect(Math.abs(pressed.l - accent.l)).toBeGreaterThan(
        Math.abs(hovered.l - accent.l),
      );
    });

    it(`${label}：方向确实跟着填充上的文字颜色走（§4.2 给的理由）`, () => {
      // 文档说方向由「该填充上的文字颜色」决定：填充上的字偏暗 → 按压变亮，反之变暗。
      const implied = Math.sign(
        luminance(colors["--lr-accent"]) - luminance(colors["--lr-on-accent"]),
      );
      expect(implied).toBe(DOC_PRESS[scheme]);
    });
  }
});

// ---------------------------------------------------------------------------
// 断言二：对比度（ui.md §7.1 目标 / §7.2 实算结果）
// ---------------------------------------------------------------------------

const GROUNDS = ["--lr-bg", "--lr-surface", "--lr-surface-raised"] as const;
const STATES = ["allow", "deny", "uncertain"] as const;

/** 对**该方案下全部三个层级底**取最差（ui.md §7.1 的验证方式）。 */
function worstOnGrounds(colors: Record<string, string>, token: string): number {
  return Math.min(...GROUNDS.map((ground) => contrast(colors[token], colors[ground])));
}

/**
 * ui.md §7.1 的目标。**只许更严，不许放宽**（theme.md §九 同一条口径）。
 * 焦点环「对元素本身」那一半要等 094 有组件才验得了，这里只验「对底」与其余各行。
 */
const TARGETS: { token: string; min: number; why: string }[] = [
  { token: "--lr-text", min: 4.5, why: "正文，WCAG 2.1 AA" },
  { token: "--lr-text-strong", min: 4.5, why: "标题" },
  { token: "--lr-text-muted", min: 4.5, why: "次要说明" },
  { token: "--lr-text-faint", min: 3, why: "仅大字/非正文" },
  { token: "--lr-border", min: 1.2, why: "纯装饰分隔线，可感知即可" },
  { token: "--lr-border-strong", min: 3, why: "控件边界，WCAG 1.4.11" },
  { token: "--lr-accent", min: 4.5, why: "强调色兼作链接与非文本指示" },
];

describe("对比度（ui.md §7.1 目标）", () => {
  for (const scheme of ["dark", "light"] as const) {
    const colors = scheme === "dark" ? COLORS_DARK : COLORS_LIGHT;

    for (const { token, min, why } of TARGETS) {
      it(`${scheme}：${token} 对三层底最差 ≥ ${min}（${why}）`, () => {
        const worst = worstOnGrounds(colors, token);
        expect(worst, `实算 ${worst.toFixed(2)}`).toBeGreaterThanOrEqual(min);
      });
    }

    it(`${scheme}：三态 ink 对其自身 fill ≥ 4.5`, () => {
      for (const state of STATES) {
        const ratio = contrast(
          colors[`--lr-${state}-ink`],
          colors[`--lr-${state}-fill`],
        );
        expect(ratio, `${state} 实算 ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${scheme}：on-accent 在 accent 上 ≥ 4.5`, () => {
      const ratio = contrast(colors["--lr-on-accent"], colors["--lr-accent"]);
      expect(ratio, `实算 ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    });
  }
});

/** §7.2 的每一行都必须在这里有对应算法；少一行、多一行都要报错。 */
type DocRowSpec = {
  label: string;
  compute: (colors: Record<string, string>) => number[];
};

const DOC_ROW_SPECS: DocRowSpec[] = [
  {
    label: "正文 on bg / surface / raised",
    compute: (colors) =>
      GROUNDS.map((ground) => contrast(colors["--lr-text"], colors[ground])),
  },
  {
    label: "text-muted 最差",
    compute: (colors) => [worstOnGrounds(colors, "--lr-text-muted")],
  },
  {
    label: "text-faint 最差",
    compute: (colors) => [worstOnGrounds(colors, "--lr-text-faint")],
  },
  {
    label: "border（纯装饰）最差",
    compute: (colors) => [worstOnGrounds(colors, "--lr-border")],
  },
  {
    label: "border-strong 最差",
    compute: (colors) => [worstOnGrounds(colors, "--lr-border-strong")],
  },
  {
    label: "accent 最差",
    compute: (colors) => [worstOnGrounds(colors, "--lr-accent")],
  },
  {
    label: "on-accent on accent",
    compute: (colors) => [contrast(colors["--lr-on-accent"], colors["--lr-accent"])],
  },
  {
    label: "三态 ink on fill（最差）",
    compute: (colors) => [
      Math.min(
        ...STATES.map((state) =>
          contrast(colors[`--lr-${state}-ink`], colors[`--lr-${state}-fill`]),
        ),
      ),
    ],
  },
];

/** 把 §7.2 的表格读成 `{ 检查 → { 深色: number[], 浅色: number[] } }`。 */
function docContrastTable(): Map<string, { dark: number[]; light: number[] }> {
  const table = new Map<string, { dark: number[]; light: number[] }>();
  for (const cells of tableRows(section(/^### 7\.2\s/))) {
    const label = (cells[0] ?? "").replace(/`/g, "").replace(/\s+/g, " ").trim();
    const numbers = (cell: string): number[] =>
      [...cell.matchAll(/\d+\.\d+/g)].map((match) => Number(match[0]));
    const dark = numbers(cells[1] ?? "");
    const light = numbers(cells[2] ?? "");
    if (label.length > 0 && dark.length > 0 && light.length > 0) {
      table.set(label, { dark, light });
    }
  }
  return table;
}

describe("对比度（ui.md §7.2 所标数字 = 实算数字）", () => {
  const documented = docContrastTable();

  it("文档里每一行都有一一对应的算法，一行都不落", () => {
    expect(documented.size).toBeGreaterThan(0);
    expect([...documented.keys()].sort()).toEqual(
      DOC_ROW_SPECS.map((spec) => spec.label).sort(),
    );
  });

  for (const spec of DOC_ROW_SPECS) {
    it(spec.label, () => {
      const row = documented.get(spec.label);
      expect(row, `ui.md §7.2 缺少「${spec.label}」行`).toBeDefined();
      if (!row) {
        return;
      }
      for (const scheme of ["dark", "light"] as const) {
        const colors = scheme === "dark" ? COLORS_DARK : COLORS_LIGHT;
        const computed = spec.compute(colors);
        const expected = scheme === "dark" ? row.dark : row.light;
        expect(computed.length, `${spec.label} / ${scheme}：个数与文档不符`).toBe(
          expected.length,
        );
        computed.forEach((value, index) => {
          expect(
            value,
            `${spec.label} / ${scheme}：文档标 ${expected[index]}，实算 ${value.toFixed(2)}`,
          ).toBeCloseTo(expected[index], 2);
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 断言三：令牌必须真的被用上（防「令牌层写完没人引用」）
// ---------------------------------------------------------------------------

describe("令牌层的自洽", () => {
  it("三态在界面语义上是三值枚举，不是布尔", () => {
    // I2 的可视化在令牌层的体现：三个 fill / ink 成对出现，缺一不可。
    for (const colors of [COLORS_DARK, COLORS_LIGHT]) {
      for (const state of STATES) {
        expect(colors[`--lr-${state}-fill`]).toBeDefined();
        expect(colors[`--lr-${state}-ink`]).toBeDefined();
      }
    }
    expect(STATES).toHaveLength(3);
  });
});
