// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 顶栏上的浮层钮（工具 / 属性）：开、关、禁用。
 *
 * 浮层有三个关闭路径（再点一次 / Esc / 点到别处），任何一条断了都会变成「关不掉」——
 * 它是**浮在内容上**的，关不掉就等于整块内容被它压住。所以三条逐个验。
 *
 * 第四轮之前这两颗钮在导航条上、面板往右开；现在它们在顶栏右端、面板往下开
 * （顶栏在最上面，往下是唯一不撞窗口边缘的方向）。
 */

// React 的 act() 需要一个显式标志，否则每个用例都会往控制台打一条
// 「The current testing environment is not configured to support act(...)」。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { TopPanelButton, type TopPanel } from "./Shell";

function mount(ui: ReactElement): {
  host: HTMLElement;
  root: ReturnType<typeof createRoot>;
} {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(ui);
  });
  return { host, root };
}

function panel(overrides: Partial<TopPanel> = {}): TopPanel {
  return {
    id: "tools",
    label: "工具",
    icon: <span />,
    content: <p>工具内容</p>,
    ...overrides,
  };
}

function click(element: HTMLElement): void {
  act(() => {
    element.click();
  });
}

/** 找不到就当场炸，而不是让 `!` 把 null 带进断言里 —— 那样失败信息会指向别处。 */
function pick(host: HTMLElement, selector: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(selector);
  if (found === null) {
    throw new Error(`找不到 ${selector}`);
  }
  return found;
}

describe("顶栏浮层", () => {
  it("默认关着；点一下才出现", () => {
    const { host, root } = mount(<TopPanelButton panel={panel()} />);
    expect(host.querySelector(".lr-panel")).toBeNull();
    click(pick(host, '[aria-label="工具"]'));
    expect(host.querySelector(".lr-panel")).not.toBeNull();
    expect(host.textContent).toContain("工具内容");
    act(() => {
      root.unmount();
    });
  });

  it("再点一次就关回去", () => {
    const { host, root } = mount(<TopPanelButton panel={panel()} />);
    const button = pick(host, '[aria-label="工具"]');
    click(button);
    click(button);
    expect(host.querySelector(".lr-panel")).toBeNull();
    act(() => {
      root.unmount();
    });
  });

  it("Esc 关得掉（浮层压着内容时这是最顺手的一条）", () => {
    const { host, root } = mount(<TopPanelButton panel={panel()} />);
    click(pick(host, '[aria-label="工具"]'));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(host.querySelector(".lr-panel")).toBeNull();
    act(() => {
      root.unmount();
    });
  });

  it("点到别处也关得掉", () => {
    const { host, root } = mount(<TopPanelButton panel={panel()} />);
    click(pick(host, '[aria-label="工具"]'));
    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(host.querySelector(".lr-panel")).toBeNull();
    act(() => {
      root.unmount();
    });
  });

  it("禁用时点不开：没有打开的文档就不该弹一个空面板", () => {
    const { host, root } = mount(<TopPanelButton panel={panel({ disabled: true })} />);
    click(pick(host, '[aria-label="工具"]'));
    expect(host.querySelector(".lr-panel")).toBeNull();
    act(() => {
      root.unmount();
    });
  });

  it("两颗钮各自开关，互不牵连", () => {
    const { host, root } = mount(
      <>
        <TopPanelButton panel={panel()} />
        <TopPanelButton
          panel={panel({ id: "props", label: "属性", content: <p>属性内容</p> })}
        />
      </>,
    );
    click(pick(host, '[aria-label="属性"]'));
    expect(host.textContent).toContain("属性内容");
    expect(host.textContent).not.toContain("工具内容");
    act(() => {
      root.unmount();
    });
  });
});
