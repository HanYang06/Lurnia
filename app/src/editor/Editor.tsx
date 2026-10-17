// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 所见即所得编辑面（路线 109）。口径：[editor.md](../../../docs/design/editor.md) §8.1
 * 与 §七（撤销建在事务层），节点与标记的清单见 [schema.ts](schema.ts)。
 *
 * 三条契约，都是这个组件之所以长这样的原因：
 *
 * 1. **挂载后文档归编辑器自己持有**。`body` 只在挂载那一刻读一次；换文档由调用方换
 *    `key` 重新挂载（`App.tsx` 挂在文档 id 上）。所以这里不在 `body` 变化时重建视图
 *    —— 那会把光标、选区与撤销栈一起丢掉，而撤销栈正是「写得下去」的前提。
 * 2. **每个事务都要把 wire 形状交出去**：`dispatchTransaction` 里先补块 id
 *    （`ensureBlockIds`），再 `view.updateState`，最后 `onChange(bodyFromDoc(...))`。
 *    没有别的出口，所以「文档变了」与「回调收到新正文」是同一件事。
 * 3. **销毁必须真的销毁**：React 19 的 StrictMode 会挂载两次，`view.destroy()` 不执行
 *    就会留下两个 contenteditable 抢同一块 DOM。
 *
 * **这里没有工具栏**（§8.3 的浮动工具栏是路线 117，尚未设计）：只有键位。
 */

import { useEffect, useRef, type CSSProperties } from "react";
import { baseKeymap, chainCommands } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { splitListItem } from "prosemirror-schema-list";

import mark256 from "../assets/brand/lurnia-mark-250.png";
import { bodyFromDoc, buildNoteSchema, docFromBody, ensureBlockIds } from "./schema";
import {
  PAGE_WIDTH_MAX,
  PAGE_WIDTH_MIN,
  usePageWidth,
  type GripEdge,
} from "./usePageWidth";
import type { NoteBody } from "./schema";
import "./Editor.css";

/**
 * 一份 schema 用到底。`Schema` 不可变，每个编辑器实例各建一份只是白白多一次装配；
 * 这份 schema 同时是键位里 `list_item` 的来源。
 */
const schema = buildNoteSchema();

/**
 * 键位。**自己的绑定排在前面**（`keymap` 的次序就是优先级），baseKeymap 兜底。
 *
 * * `Enter`：列表里拆项（`splitListItem`），列表外走 baseKeymap 的拆段；
 *   列表的**创建**归块插入（§8.2 / §8.3，路线 030 / 032），不在这里凭空加键位。
 * * `Mod-z` / `Mod-y` / `Mod-Shift-z`：撤销重做。栈在事务层（§七），只在会话内，
 *   不落库 —— 输入合并窗口是 prosemirror-history 的默认 500ms，与设计一致。
 */
function editorPlugins() {
  return [
    history(),
    keymap({
      Enter: chainCommands(splitListItem(schema.nodes.list_item), baseKeymap.Enter),
      "Mod-z": undo,
      "Mod-y": redo,
      "Mod-Shift-z": redo,
    }),
    keymap(baseKeymap),
  ];
}

/** 编辑面的属性：`role`/`aria-multiline` 是 contenteditable 无障碍的既有写法。 */
function surfaceAttributes(label: string): Record<string, string> {
  return {
    class: "lr-editor__surface",
    role: "textbox",
    "aria-multiline": "true",
    "aria-label": label,
  };
}

/**
 * 空文档的占位开关（第五轮）。
 *
 * 一片空白里只有一个光标，回答不了「从哪儿开始写」—— 这不是光标不够明显，是**没有
 * 可以落笔的地方**。占位本身是 CSS 伪元素（见 `Editor.css`），不进文档模型：
 * 一旦有字就消失，不会被当成正文存下去。
 */
function syncEmpty(view: EditorView, root: HTMLElement | null): void {
  const empty = view.state.doc.textContent.length === 0 ? "true" : "false";
  view.dom.dataset.empty = empty;
  /*
   * 根节点上那一份是给**水印**看门的：它要知道「这一页还是空的吗」——
   * 空的时候纸上有枚很淡的水印，一有字就淡出（`Editor.css` 的 `.lr-editor__mark`）。
   */
  if (root) {
    root.dataset.empty = empty;
  }
}

export type NoteEditorProps = {
  /** 初始正文，**只在挂载时读一次**。 */
  body: NoteBody;
  /** 文档每次变化都回调（wire 形状，可以直接交给 `doc.save`）。 */
  onChange: (body: NoteBody) => void;
  /**
   * 文档标题。**独立字段**，不写进正文（`doc.save` 的 `title` / `doc.get` 的 `title`）：
   * 标题改的是「这篇叫什么」，正文改的是「这篇写了什么」，混成一行的话，改名会在
   * 正文里多出一行字。
   */
  title?: string;
  /** 标题变化。不给就是只读标题（比如以后的只读视图）。 */
  onTitleChange?: (title: string) => void;
  /** 默认 true。`false` 时是只读的同一片版面（§8.1：读面与编辑面是同一处）。 */
  editable?: boolean;
  /** aria-label，默认「正文」。 */
  label?: string;
};

export function NoteEditor({
  body,
  onChange,
  title = "",
  onTitleChange,
  editable = true,
  label = "正文",
}: NoteEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // 纸宽是**视图属性**，不是文档属性：它属于这台机器上的这个人，不进库、不进协作。
  const page = usePageWidth();
  const viewRef = useRef<EditorView | null>(null);
  // 回调与 prop 都走 ref：父组件每次渲染都会传个新函数，视图不能因此重建。
  const onChangeRef = useRef(onChange);
  const editableRef = useRef(editable);
  const initialBody = useRef(body);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc: docFromBody(schema, initialBody.current),
        plugins: editorPlugins(),
      }),
      // `editable` 在 prosemirror-view 1.42 里只收函数；这里隔一层 ref，
      // 于是开关能随 prop 变，而视图不需要重建。
      editable: () => editableRef.current,
      attributes: surfaceAttributes(label),
      dispatchTransaction(transaction) {
        // 块 id 在这里补齐：入口只有这一个，漏不掉（见 schema.ts 的 `ensureBlockIds`）。
        const next = view.state.apply(ensureBlockIds(transaction));
        view.updateState(next);
        syncEmpty(view, rootRef.current);
        onChangeRef.current(bodyFromDoc(next.doc));
      },
    });
    viewRef.current = view;
    syncEmpty(view, rootRef.current);

    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // 依赖是空的，这是契约不是疏忽：body 只在挂载时读一次，editable / label 走下面的同步。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 只读开关与 aria-label 是 props，可以随父组件变。PM 认不出「函数的返回值变了」，
  // 所以这里更新 ref 之后再显式推一次 props —— setProps 会重算内容装饰，
  // 也就是把 contenteditable 与那几个 aria 属性重新落下去。
  useEffect(() => {
    const view = viewRef.current;
    editableRef.current = editable;
    view?.setProps({ attributes: surfaceAttributes(label) });
  }, [editable, label]);

  /*
   * 纸左右两条抓取带（§4.6 第 3 条）。
   *
   * 角色取 `slider` 而不是 `separator`：这东西**就是一个连续值调节器**（最小 400、
   * 最大 880、当前 560、左右键调节），`slider` 的 ARIA 模型天然带 `aria-valuenow`
   * 与方向键，读屏念出来是「纸宽 560，可调节」—— 比「分隔条」更接近真相；
   * 而且 `separator` 在 jsx-a11y 眼里不是可交互角色，挂 `tabIndex` 会被门禁拦下。
   * **不做成纯鼠标拖拽**：只靠指针的动作，键盘用户等于没有这个功能。
   */
  const grip = (edge: GripEdge) => (
    <div
      aria-label="纸宽"
      aria-valuemax={PAGE_WIDTH_MAX}
      aria-valuemin={PAGE_WIDTH_MIN}
      aria-valuenow={page.width}
      className="lr-editor__grip"
      data-edge={edge}
      onKeyDown={page.onKeyDown(edge)}
      onPointerDown={page.onPointerDown(edge)}
      onPointerMove={page.onPointerMove}
      onPointerUp={page.onPointerUp}
      role="slider"
      tabIndex={0}
    />
  );

  return (
    /*
     * 一张纸（第五轮）：头区放标题，正文区交给 ProseMirror。**头区不是标题牌** ——
     * 它是这篇文档的名字本身，空的时候给一句「无标题」占位。
     *
     * 视图挂在里面那层 `.lr-editor__body` 上，而不是纸本身：ProseMirror 会把自己
     * 造的 contenteditable 塞进宿主节点，宿主若同时装着标题，那些 DOM 就成了它的孩子。
     */
    <div
      className="lr-editor"
      // 纸宽走内联变量：`Editor.css` 只声明「用这个变量」，数值归这里。
      style={{ "--lr-page-width": `${String(page.width)}px` } as CSSProperties}
      ref={rootRef}
    >
      {grip("start")}
      {grip("end")}
      {/*
       * 空页的水印（第六轮）：一枚很淡的水豚压在纸的右下角。**它不是内容** ——
       * `aria-hidden` + `pointer-events: none`，不进文档模型，一有字就淡出。
       * 理由见 `Editor.css` 里那段：空白的纸不缺信息，缺的是「这张纸有主人」的那点质感。
       */}
      <img
        alt=""
        aria-hidden="true"
        className="lr-editor__mark"
        height={256}
        src={mark256}
        width={256}
      />
      <div className="lr-editor__head">
        <input
          aria-label="标题"
          className="lr-editor__title"
          onChange={(event) => {
            onTitleChange?.(event.target.value);
          }}
          placeholder="无标题"
          readOnly={onTitleChange === undefined || !editable}
          type="text"
          value={title}
        />
      </div>
      <div className="lr-editor__body" ref={hostRef} />
    </div>
  );
}
