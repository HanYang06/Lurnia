// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 前端与内核的**唯一**接触面。
 *
 * 内核在自己的进程里（Tauri 管理的 sidecar），前端只能通过宿主转发过来的事件
 * 看它 —— 事件封套是内核资产，宿主只是绑定（不变量 I8）。所以这里不做任何
 * 逻辑，只把通道名与类型摆在明处。
 *
 * ⚠ 这三个通道名必须与 `src-tauri/src/lib.rs` 里的常量一致：Rust 侧 emit，
 * 这里 listen。名字对不上不会报错，只会安静地收不到任何东西。
 *
 * v2（路线 115）多了一个方向：`callKernel()` 走 `invoke("kernel_call")` 把请求
 * 交给宿主，宿主写成一行 `call` 帧喂给内核，内核的 `reply` 帧再由宿主 emit 回来。
 * **调用不进事件通道**：调用平面「恰好一个提供者、没人接必须报错」，广播平面
 * 「允许没人接」（bus.md §一），合成一条会让「没人接」不可区分。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** 一条事件封套（内核 → UI），字段由内核定义。 */
export const KERNEL_EVENT = "kernel://event";

/** 核心装配完成（对应 stdio 的 `ready` 行）。 */
export const KERNEL_READY = "kernel://ready";

/** 核心退出或起不来（对应 `error` 行与进程终止）。 */
export const KERNEL_STOPPED = "kernel://stopped";

/** 一条调用回复（对应 stdio 的 `reply` 行）。 */
export const KERNEL_REPLY = "kernel://reply";

export type Envelope = {
  id: string;
  seq: number;
  ts_wall: string;
  topic: string;
  subject: { id: string; kind: string };
  cause: string | null;
  payload: Record<string, unknown>;
  version: number;
};

/** `ready` 行里那些宿主与 UI 都用得上的字段。 */
export type Ready = {
  protocol: number;
  version: string;
  data_dir: string;
  db_version: number;
  rotated: number;
  frozen: boolean;
};

/** 核心退出/起不来的说明。可能只有 `message`，也可能只有退出码。 */
export type Stopped = {
  message?: string;
  code?: number | null;
};

/** 内核的共享错误模型（bus.md §四）：跨边界的失败只有这一种形状。 */
export type KernelError = {
  kind: string;
  message: string;
  retryable: boolean;
};

/** 调用平面的回复。**不是布尔** —— 失败必须显式看 `err`。 */
export type Reply = { ok: unknown } | { err: KernelError };

export function onKernelEvent(
  handler: (envelope: Envelope) => void,
): Promise<UnlistenFn> {
  return listen<{ envelope: Envelope }>(KERNEL_EVENT, (event) =>
    handler(event.payload.envelope),
  );
}

export function onKernelReady(handler: (ready: Ready) => void): Promise<UnlistenFn> {
  return listen<Ready>(KERNEL_READY, (event) => handler(event.payload));
}

export function onKernelStopped(
  handler: (stopped: Stopped) => void,
): Promise<UnlistenFn> {
  return listen<Stopped>(KERNEL_STOPPED, (event) => handler(event.payload));
}

/** 挂起中的调用：`id` 由这里生成，内核原样带回来。 */
const pending = new Map<string, (reply: Reply) => void>();
let wired: Promise<void> | null = null;

function wireReplies(): Promise<void> {
  wired ??= listen<{ id: string; reply: Reply }>(KERNEL_REPLY, (event) => {
    const settle = pending.get(event.payload.id);
    pending.delete(event.payload.id);
    settle?.(event.payload.reply);
  }).then(() => undefined);
  return wired;
}

function newCallId(): string {
  const raw =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return raw.replace(/-/g, "");
}

/**
 * 调用一个内核能力（如 `doc.save`）。
 *
 * 请求里**不带 subject**：身份由内核填（I6、ui.md §九），前端不造身份概念。
 * 内核没起来或宿主转发失败时返回 `err(unavailable)`，不抛异常 —— 调用方只需要
 * 看一种失败形状（bus.md §四）。
 */
export async function callKernel(
  capability: string,
  request: unknown,
): Promise<Reply> {
  await wireReplies();
  const id = newCallId();
  const arrived = new Promise<Reply>((resolve) => {
    pending.set(id, resolve);
  });
  try {
    await invoke("kernel_call", { id, capability, request });
  } catch (error) {
    pending.delete(id);
    return {
      err: { kind: "unavailable", message: String(error), retryable: true },
    };
  }
  return arrived;
}
