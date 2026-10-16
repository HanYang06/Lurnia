// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 原语的标记门禁。用 `react-dom/server` 把组件渲成字符串再断言 —— 不引
 * Testing Library：这一层要验的是「产出的标记对不对」，不是交互行为，
 * 为一个 `renderToStaticMarkup` 装一整套 DOM 测试栈不划算。
 *
 * 重点在两条不变量：
 * 1. `StateBadge` 吃的是**三值枚举**（I2），渲染出「颜色 + 形状 + 文字」三者，
 *    且三个状态之间只有颜色不同；
 * 2. 表单原语的 `label for` 与控件 `id` 必须真的对上（ui.md §7.3 的可用性底线）。
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  Button,
  Checkbox,
  Input,
  Meter,
  Select,
  Skeleton,
  StateBadge,
  Switch,
  Tag,
  type Decision,
} from "./index";

const DECISIONS: Decision[] = ["allow", "deny", "uncertain"];

describe("StateBadge：I2 的三态在界面上看得见", () => {
  it("三态都能渲染，且各自带上形状、文字与状态标记", () => {
    const shapes: Record<Decision, string> = { allow: "✓", deny: "✗", uncertain: "?" };
    for (const decision of DECISIONS) {
      const html = renderToStaticMarkup(<StateBadge decision={decision} />);
      expect(html).toContain(`data-decision="${decision}"`);
      expect(html).toContain(shapes[decision]);
      expect(html).toContain(`lr-state-badge--${decision}`);
    }
  });

  it("三态是同级：结构与类名构成一致，差异只在修饰类与文字", () => {
    // 任何一态若是「更大 / 更亮 / 更饱和」，就等于在视觉上宣布它是默认值 ——
    // I2 明确禁止。所以把状态相关部分与文字都归一化之后，三者必须逐字相同。
    // 形状与措辞**本来就该不同**（那是 §2.5 要求的冗余编码），不能被这条断言抹平。
    const normalize = (html: string): string =>
      html
        .replace(/--(allow|deny|uncertain)/g, "--STATE")
        .replace(/data-decision="[^"]+"/g, 'data-decision="STATE"')
        .replace(/>[^<]+</g, ">TEXT<");
    const [allow, deny, uncertain] = DECISIONS.map((decision) =>
      normalize(renderToStaticMarkup(<StateBadge decision={decision} />)),
    );
    expect(deny).toBe(allow);
    expect(uncertain).toBe(allow);
  });

  it("文本里不出现「失败」这类把不确定当错误的措辞", () => {
    const html = renderToStaticMarkup(<StateBadge decision="uncertain" />);
    expect(html).toContain("待裁");
    expect(html).not.toMatch(/失败|错误/);
  });
});

describe("Button", () => {
  it("默认 type=button，不会误触表单提交", () => {
    expect(renderToStaticMarkup(<Button>确定</Button>)).toContain('type="button"');
  });

  it("变体走修饰类，可以叠外部 className", () => {
    const html = renderToStaticMarkup(
      <Button className="extra" variant="quiet">
        取消
      </Button>,
    );
    expect(html).toContain("lr-button--quiet");
    expect(html).toContain("extra");
  });
});

describe("表单原语：label 与控件必须真的接上", () => {
  const pairs = (html: string): { forId: string; controlId: string } => {
    const forId = /for="([^"]+)"/.exec(html)?.[1] ?? "";
    const controlId = /id="([^"]+)"/.exec(html)?.[1] ?? "";
    return { forId, controlId };
  };

  it("Input", () => {
    const html = renderToStaticMarkup(<Input label="搜索" />);
    const { forId, controlId } = pairs(html);
    expect(forId).not.toBe("");
    expect(forId).toBe(controlId);
  });

  it("Select", () => {
    const html = renderToStaticMarkup(
      <Select
        label="主题"
        options={[
          { value: "system", label: "跟随系统" },
          { value: "dark", label: "深色" },
        ]}
      />,
    );
    const { forId, controlId } = pairs(html);
    expect(forId).toBe(controlId);
    expect(html).toContain("<option");
    expect(html).toContain("跟随系统");
  });

  it("Checkbox", () => {
    const html = renderToStaticMarkup(<Checkbox label="开机自启" />);
    const { forId, controlId } = pairs(html);
    expect(forId).toBe(controlId);
    expect(html).toContain('type="checkbox"');
  });

  it("Switch 用 role=switch 与 aria-checked，读屏会念「开/关」", () => {
    const on = renderToStaticMarkup(
      <Switch checked={true} label="动效" onChange={() => undefined} />,
    );
    const off = renderToStaticMarkup(
      <Switch checked={false} label="动效" onChange={() => undefined} />,
    );
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');
    expect(off).toContain('aria-checked="false"');
    expect(on).toContain('aria-label="动效"');
  });
});

describe("非交互原语：语义与承载", () => {
  it("Meter 用 role=meter，并带取值范围与名字", () => {
    const html = renderToStaticMarkup(<Meter label="存储占用" max={100} value={42} />);
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-label="存储占用"');
  });

  it("Meter 会把越界值夹回范围，不把非法百分比交给浏览器", () => {
    const high = renderToStaticMarkup(<Meter label="x" max={10} value={99} />);
    const low = renderToStaticMarkup(<Meter label="x" max={10} value={-5} />);
    expect(high).toContain('aria-valuenow="10"');
    expect(low).toContain('aria-valuenow="0"');
  });

  it("Skeleton 声明 aria-busy，且行数可控", () => {
    const html = renderToStaticMarkup(<Skeleton lines={2} />);
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/lr-skeleton__line/g)).toHaveLength(2);
  });

  it("Tag 是纯文本标签，不带交互语义", () => {
    const html = renderToStaticMarkup(<Tag>笔记</Tag>);
    expect(html).toContain("lr-tag");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("tabindex");
  });
});
