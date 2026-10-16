// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 前端与内核的**唯一**接触面。
 *
 * 内核在自己的进程里（Tauri 管理的 sidecar），前端只能通过宿主转发过来的事件
 * 看它 —— 事件封套是内核资产，宿主只是绑定（不变量 I8）。所以这里不做任何
 * 逻辑，只把三个通道名与类型摆在明处。
 *
 * ⚠ 这三个通道名必须与 `src-tauri/src/lib.rs` 里的常量一致：Rust 侧 emit，
 * 这里 listen。名字对不上不会报错，只会安静地收不到任何东西。
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** 一条事件封套（内核 → UI），字段由内核定义。 */
export const KERNEL_EVENT = "kernel://event";

/** 核心装配完成（对应 stdio 的 `ready` 行）。 */
export const KERNEL_READY = "kernel://ready";

/** 核心退出或起不来（对应 `error` 行与进程终止）。 */
export const KERNEL_STOPPED = "kernel://stopped";

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
