// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 会话状态 → 状态条上那句话。
 *
 * 单独放一个文件，是因为它要在 App 里用、又该被测：**「有没有存下去」是用户唯一
 * 能看到的安全感**，措辞写错比不写更糟（`clean` 那一态尤其不能报「已保存」——
 * 那是在说一件没发生过的事）。
 */

import type { SaveState } from "./session";

export type StatusLabel = { text: string; bad: boolean };

export function saveLabel(save: SaveState): StatusLabel | null {
  switch (save.kind) {
    // 没有改动就什么都别说（§1.0：没有信息的话是噪音）。
    case "clean":
      return null;
    case "dirty":
      return { text: "编辑中…", bad: false };
    case "saving":
      return { text: "保存中…", bad: false };
    case "saved":
      return { text: "已保存", bad: false };
    case "failed":
      // `✗` 与颜色冗余（§7.3 第 1 条）。消息来自内核或本层的收窄，原样摆出来 ——
      // 「保存失败」四个字不带原因，用户除了再敲一遍没有别的办法。
      return { text: `✗ ${save.message}`, bad: true };
  }
}
