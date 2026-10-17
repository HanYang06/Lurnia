// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 稳定身份：`uuid7`，以及块 id 要的那个 32 位十六进制。
 *
 * 两条约束来自设计，不是随手定的：
 *
 * 1. **块级节点必须带稳定 id**（editor.md A4）：校验器只认 `^[0-9a-f]{32}$`
 *    （`src/lurnia/components/doc/model.py` 的 `ID_PATTERN`）—— 带横线的 UUID 会被
 *    内核当场判成 `Err(INVALID)`，所以块 id 一律是**去掉横线的 hex**。
 * 2. **用 uuid7 而不是 uuid4**：它把 48 位毫秒时间戳放在高位，因此 id 本身按时间有序，
 *    B 树插入不会随机散开 —— Python 侧同样是 `uuid.uuid7()`（标准库）。
 *
 * 这里不引依赖：一个 20 行的布局，比为一个函数拉一个包省事。
 */

/** 48 位毫秒 + 版本/变体 + 80 位随机。返回带横线的标准形式。 */
export function uuid7(): string {
  const bytes = new Uint8Array(16);
  fillRandom(bytes);

  // 前 6 字节 = 48 位毫秒时间戳（大端）。
  const stamp = Date.now();
  bytes[0] = Math.floor(stamp / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(stamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(stamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(stamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(stamp / 2 ** 8) & 0xff;
  bytes[5] = stamp & 0xff;

  // 版本 7 与 RFC 4122 变体：位运算而不是「或者一个数字」，免得改坏别的位。
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/** 块 id：**32 位 hex**，无横线（内核的 `ID_PATTERN` 只认这个形状）。 */
export function blockId(): string {
  return uuid7().replace(/-/g, "");
}

/**
 * 首选 `crypto.getRandomValues`；WebView 版本旧或者 jsdom 里没有它时退回 `Math.random`
 * —— 这些 id 是**本地标识**，不是安全令牌，退化的代价只是碰撞概率，不是安全问题。
 */
function fillRandom(bytes: Uint8Array): void {
  const host = globalThis as unknown as {
    crypto?: { getRandomValues?: (target: Uint8Array) => Uint8Array };
  };
  const source = host.crypto?.getRandomValues;
  if (typeof source === "function") {
    host.crypto?.getRandomValues?.(bytes);
    return;
  }
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
}
