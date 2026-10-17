// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 欢迎面：编辑区一片空白时的那一屏（学 VS Code 的空编辑器）。
 *
 * 一屏只有两样东西：一个大的品牌标识，和几条能立刻上手的快捷键。**没有一句说明文字**
 * （§1.0）—— 「双击这里就能新建」这种句子如果非写不可，说明这条路本来就不该靠读。
 *
 * 所以「双击新建」是**隐藏操作**，必须另有可达路径：列表栏底下那颗吃满栏宽的新建按钮
 * 才是主入口，这里只是让熟练的手指少走一趟。也正因如此，这一片
 * **不是按钮**：没有 `role="button"`、不进 Tab 序、没有 `aria-label` ——
 * 把一个非按钮的东西声明成按钮，读屏用户会去找一个键盘按不动的「按钮」。
 *
 * 选中文字不被这一片打断：容器不监听单击、`user-select` 也不动它。
 */

import type { ReactElement } from "react";

import mark256 from "../assets/brand/lurnia-mark-250.png";
import "./Welcome.css";

export type Shortcut = { label: string; keys: readonly string[] };

/**
 * 键帽之间的 `+` 是**装饰**：真正的语义靠两个并列的元素读出来
 * （`Ctrl`、`N` 是分开的两颗键帽），所以它 `aria-hidden`。
 * 不把它渲染成 `Ctrl+N` 一个字符串，是因为键帽各自有边界 —— 那是形状，不是排印。
 */
function keySeparator(index: number) {
  return (
    <span aria-hidden="true" className="lr-welcome__plus" key={`plus-${index}`}>
      +
    </span>
  );
}

/** 返回类型用 `ReactElement`：React 19 起没有全局 `JSX` 命名空间（见 brand.tsx）。 */
export function Welcome(props: {
  shortcuts: readonly Shortcut[];
  /** 双击这一片 = 新建（草稿层的动作，由调用方给）。 */
  onNew: () => void;
}): ReactElement {
  const { shortcuts, onNew } = props;

  return (
    <div className="lr-welcome" onDoubleClick={onNew}>
      {/*
       * 显示约 160px —— 这是**显示尺寸**，不是资源档位：图源用 256 那一档，
       * 缩放后仍然清晰（64 那一档在大尺寸下会糊）。数值由 Welcome.css 定。
       */}
      <img alt="" className="lr-welcome__mark" height={256} src={mark256} width={256} />

      {/*
       * 快捷键是**列表**而不是段落：几条并列、顺序无所谓。
       * 空数组时整块不渲染 —— 没有键位可列时留白，不写「暂无快捷键」（§1.0）。
       */}
      {shortcuts.length > 0 && (
        <ul className="lr-welcome__keys">
          {shortcuts.map((shortcut) => (
            <li className="lr-welcome__row" key={shortcut.label}>
              <span className="lr-welcome__label">{shortcut.label}</span>
              <span className="lr-welcome__chord">
                {shortcut.keys.map((key, index) => (
                  // 键位字符串在一条里不会重复（`["Ctrl","N"]`），标签才是行主键。
                  <span className="lr-welcome__chord-item" key={key}>
                    {index > 0 && keySeparator(index)}
                    <kbd className="lr-welcome__key">{key}</kbd>
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
