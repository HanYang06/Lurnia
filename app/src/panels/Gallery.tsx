// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 组件陈列页（设计评审用）。
 *
 * **这不是业务界面**，也不会进入正常的模块流程：它是把 §八 的原语连同 §4.2 的六个状态
 * 摊在一屏上，用来回答「这套样式到底长什么样」。有了它，改一个令牌的效果可以立刻看见，
 * 而不必先等内核把数据接上。
 *
 * 它同样守着两条硬规则：颜色只走令牌（这里一个十六进制都没有），状态不只用颜色表达
 * （禁用/开/关都另有文字或形状）。
 */

import { useState, type ReactNode } from "react";

import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  Input,
  Meter,
  Select,
  Skeleton,
  StateBadge,
  Switch,
  Tag,
  type Decision,
} from "../components";
import "./Gallery.css";

const DECISIONS: readonly Decision[] = ["allow", "deny", "uncertain"];

const THEME_OPTIONS = [
  { value: "system", label: "跟随系统" },
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
];

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="gallery__section">
      <h2 className="gallery__heading">{title}</h2>
      {note && <p className="gallery__note">{note}</p>}
      <div className="gallery__row">{children}</div>
    </section>
  );
}

export function Gallery() {
  const [switched, setSwitched] = useState(true);
  const [checked, setChecked] = useState(false);
  const [text, setText] = useState("");

  return (
    <div className="gallery">
      <Section
        note="填充态与次级态。悬停、按压、禁用三个状态都写在同一张样式表里（§4.2）。"
        title="Button"
      >
        <Button>主要动作</Button>
        <Button variant="quiet">次级动作</Button>
        <Button disabled>禁用</Button>
        <Button variant="quiet" disabled>
          禁用（次级）
        </Button>
      </Section>

      <Section
        note="只有 StateBadge 可以内置三态语义（§八）。三态同级，另带形状与文字。"
        title="StateBadge"
      >
        {DECISIONS.map((decision) => (
          <StateBadge decision={decision} key={decision} />
        ))}
      </Section>

      <Section
        note="分类靠图标与文字，不靠颜色 —— 所以标签只有中性色（§十）。"
        title="Tag"
      >
        <Tag>笔记</Tag>
        <Tag>草稿</Tag>
        <Tag tone="accent">当前</Tag>
      </Section>

      <Section note="四个原语都自带标签，不给「无标签输入框」留口子。" title="表单">
        <Input
          label="搜索"
          onChange={(event) => {
            setText(event.target.value);
          }}
          placeholder="输入点什么…"
          value={text}
        />
        <Select label="主题" options={THEME_OPTIONS} />
        <Checkbox
          checked={checked}
          label="关闭时确认"
          onChange={(event) => {
            setChecked(event.target.checked);
          }}
        />
        <Switch checked={switched} label="动效" onChange={setSwitched} />
        <Input disabled label="禁用" placeholder="不可编辑" />
      </Section>

      <Section
        note="卡片、骨架、量度、空态。均非交互，因此**不该**有悬停/按压态。"
        title="承载"
      >
        <Card>
          <p className="gallery__card-title">卡片</p>
          <p className="gallery__note">卡片比它所在的底更亮，两个主题方向一致。</p>
        </Card>
        <div className="gallery__stack">
          <Skeleton lines={2} />
          <Meter label="存储占用" max={100} value={42} />
        </div>
      </Section>

      <Section note="空态是三段：这是什么、为什么空、将来长出什么。" title="EmptyState">
        <EmptyState
          next="接上之后，这里会变成真正的正文。"
          title="还没有内容"
          why="示例文案：这一段说明为什么这里是空的。"
        />
      </Section>
    </div>
  );
}
