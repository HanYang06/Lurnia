// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 把 [session.ts](session.ts) 的状态机接到 React 上：防抖计时器、换文档前推一次、
 * 卸载前推一次、`Ctrl/Cmd + S` 显式提交。
 *
 * 状态机本身不碰 React（所以它测得动），这里只解决**时机**：
 *
 * - 编辑停 3 秒 → 自动落盘（`commit: false`，revision 不动）；
 * - `Ctrl/Cmd + S` → 提交（`commit: true`，+1 并留一条修订）；
 * - 换文档 / 组件卸载 → 立刻把没落盘的那一版推下去（**不然它就真丢了**）。
 *
 * 标题与正文**共用一条防抖**：它们落的是同一条 `doc.save`，分成两条只会在三秒里
 * 写出两次，而第二次拿的是同一个 `base_revision`。
 *
 * 「推下去」是异步的，但每一条保存都带着**发起时的 docId**，所以换文档之后回来的
 * 迟到回复会被状态机挡掉（见 `session.ts` 的 `saved`）。
 */

import { useCallback, useEffect, useReducer, useRef } from "react";

import { loadNote, saveNote } from "./notes";
import { blockId } from "./ids";
import {
  AUTOSAVE_MS,
  INITIAL_NOTE_SESSION,
  noteSessionReducer,
  titleOf,
  type NoteSessionState,
} from "./session";
import type { NoteBody } from "./schema";

export type NoteController = {
  state: NoteSessionState;
  /** 打开一篇已有的笔记（按内核已有的 `doc.get`）。 */
  open: (id: string) => void;
  /** 新建：本地先起一个 id，**第一次编辑**才真正入库。 */
  create: () => void;
  /** 编辑器每次变化都进来。 */
  onEdit: (body: NoteBody) => void;
  /** 标题每次变化都进来（独立字段，走 `doc.save` 的 `title`）。 */
  setTitle: (title: string) => void;
  /** 显式提交（`Ctrl/Cmd + S`），产生一条修订。 */
  commit: () => void;
};

export function useNote(): NoteController {
  /*
   * **一开始什么都没有**：不预先造一张空稿。空稿会让「打开了什么」这件事变成假的，
   * 而且用户一进来就看到一篇没有标题的空文档，比看到欢迎面更糊涂。
   * 新建是显式动作：列表栏那颗长条、快捷键、欢迎面双击，三条路都通到 `create()`。
   */
  const [state, dispatch] = useReducer(noteSessionReducer, INITIAL_NOTE_SESSION);

  // 计时器与快捷键都要读「最新的一版」，而它们都不是渲染的一部分。
  // 同步放在 effect 里而不是渲染期间：渲染期间写 ref 会踩 react-hooks/refs 那条规则
  // （渲染必须是纯的）。晚一次提交没有影响 —— 读它的都是提交之后才发生的事。
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const push = useCallback(
    async (commit: boolean) => {
      const snapshot = latest.current;
      const { activeId, pending, initialBody, titleDirty } = snapshot;
      if (activeId === null) {
        return;
      }
      /*
       * **只看 `pending` 是不够的**（第五轮）：标题是独立字段，只改了名字时正文没动，
       * `pending` 是空的 —— 那么改完标题停三秒，什么都不会发生，也不会有任何提示。
       */
      if (pending === null && !titleDirty) {
        return;
      }
      /*
       * 只改标题时，正文取**会话里最后知道的那一份**（`initialBody` 是挂载时的正文，
       * 没敲过字就等于当前正文）。真正的正文归编辑器自己持有，会话不重复存一份。
       */
      const body = pending ?? initialBody;
      if (body === null) {
        return;
      }
      const title = snapshot.title.trim();
      stopTimer();
      dispatch({ type: "save-started", docId: activeId });
      const reply = await saveNote({
        docId: activeId,
        body,
        baseRevision: snapshot.revision,
        commit,
        // 空标题**不让这个键出场**：内核会从正文里抽一个（store.py 的 `_title`）。
        ...(title === "" ? {} : { title }),
      });
      if ("ok" in reply) {
        dispatch({
          type: "saved",
          docId: activeId,
          revision: reply.ok.revision,
          body,
          // 列表上那条标签：用户起了名就用名字，没起名就从正文里抽（`titleOf`）。
          title: title === "" ? titleOf(body) : title,
        });
      } else {
        dispatch({
          type: "save-failed",
          docId: activeId,
          message: reply.err.message,
        });
      }
    },
    [stopTimer],
  );

  const open = useCallback(
    (id: string) => {
      // 先推上一篇：它带着自己的 docId，即便回复晚到也不会污染这一篇。
      void push(false);
      void loadNote(id).then((reply) => {
        if ("ok" in reply) {
          dispatch({
            type: "opened",
            note: {
              id: reply.ok.docId,
              title: reply.ok.title,
              body: reply.ok.body as NoteBody,
              revision: reply.ok.revision,
            },
          });
        } else {
          dispatch({ type: "load-failed", message: reply.err.message });
        }
      });
    },
    [push],
  );

  const create = useCallback(() => {
    void push(false);
    dispatch({ type: "created", id: blockId() });
  }, [push]);

  /** 防抖窗口：正文与标题共用一条，因为它们落的是同一条 `doc.save`。 */
  const schedule = useCallback(() => {
    stopTimer();
    timer.current = setTimeout(() => {
      void push(false);
    }, AUTOSAVE_MS);
  }, [push, stopTimer]);

  const onEdit = useCallback(
    (body: NoteBody) => {
      dispatch({ type: "edited", body });
      schedule();
    },
    [schedule],
  );

  const setTitle = useCallback(
    (title: string) => {
      dispatch({ type: "title-edited", title });
      schedule();
    },
    [schedule],
  );

  const commit = useCallback(() => {
    void push(true);
  }, [push]);

  // Ctrl/Cmd + S 提交。没有打开的文档时不拦这个组合键 —— 别把浏览器的默认行为抢掉。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") {
        return;
      }
      if (latest.current.activeId === null) {
        return;
      }
      event.preventDefault();
      void push(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [push]);

  // 卸载前把没落盘的那一版推下去。**这一条不能省**：编辑归编辑器自己持有。
  useEffect(() => () => void push(false), [push]);

  return { state, open, create, onEdit, setTitle, commit };
}
