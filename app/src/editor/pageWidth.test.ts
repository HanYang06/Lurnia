// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 纸宽的钳位与存取（ui.md §4.6 第 3 条）。
 *
 * 这一组测的是**不会崩**而不是「拖得爽」：拖拽手感在 jsdom 里测不出来，但「存了个
 * 垃圾值之后纸变成 0 宽」是能测的，而那种故障会让整个编辑区消失。
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  clampWidth,
  PAGE_WIDTH_DEFAULT,
  PAGE_WIDTH_KEY,
  PAGE_WIDTH_MAX,
  PAGE_WIDTH_MIN,
  readWidth,
  writeWidth,
} from "./usePageWidth";

describe("纸宽的上下限", () => {
  it("低于 400 取 400、高于 880 取 880", () => {
    expect(clampWidth(120)).toBe(PAGE_WIDTH_MIN);
    expect(clampWidth(9999)).toBe(PAGE_WIDTH_MAX);
  });

  it("区间内原样保留，但取整（像素没有小数）", () => {
    expect(clampWidth(560)).toBe(560);
    expect(clampWidth(560.6)).toBe(561);
  });

  it("非数字回默认值：存坏了不该让纸变成 0 宽", () => {
    expect(clampWidth(Number.NaN)).toBe(PAGE_WIDTH_DEFAULT);
    expect(clampWidth(Number.POSITIVE_INFINITY)).toBe(PAGE_WIDTH_DEFAULT);
  });

  it("默认值本身在区间内（否则一开机就违例）", () => {
    expect(PAGE_WIDTH_DEFAULT).toBeGreaterThanOrEqual(PAGE_WIDTH_MIN);
    expect(PAGE_WIDTH_DEFAULT).toBeLessThanOrEqual(PAGE_WIDTH_MAX);
  });
});

describe("纸宽的存取", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("没存过 = 默认宽度", () => {
    expect(readWidth()).toBe(PAGE_WIDTH_DEFAULT);
  });

  it("写进去能读回来", () => {
    writeWidth(700);
    expect(readWidth()).toBe(700);
    expect(localStorage.getItem(PAGE_WIDTH_KEY)).toBe("700");
  });

  it("库里是垃圾文本：回默认值，不抛", () => {
    localStorage.setItem(PAGE_WIDTH_KEY, "宽一点");
    expect(readWidth()).toBe(PAGE_WIDTH_DEFAULT);
  });

  it("库里超范围：读的时候也钳回来（别的版本写进去的也不怕）", () => {
    localStorage.setItem(PAGE_WIDTH_KEY, "9999");
    expect(readWidth()).toBe(PAGE_WIDTH_MAX);
    localStorage.setItem(PAGE_WIDTH_KEY, "10");
    expect(readWidth()).toBe(PAGE_WIDTH_MIN);
  });
});
