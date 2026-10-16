// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
/**
 * 壳：显示宿主转发的内核状态与事件流（路线 009 / 105）。
 *
 * 这个界面刻意什么业务都不做 —— 它要证明的是**通道通了**：核心起来、封套能到、
 * 顺序可读。真正的笔记 / 项目界面是后面的事，样式也只是占位（路线 098 的主题包
 * 会换掉它）。
 */

import { useEffect, useState } from "react";
import {
  onKernelEvent,
  onKernelReady,
  onKernelStopped,
  type Envelope,
  type Ready,
  type Stopped,
} from "./kernel";
import "./App.css";

/** 界面上只留最近这么多条，别让一个长跑的核心把内存撑起来。 */
const MAX_ROWS = 50;

function App() {
  const [ready, setReady] = useState<Ready | null>(null);
  const [stopped, setStopped] = useState<Stopped | null>(null);
  const [events, setEvents] = useState<Envelope[]>([]);

  useEffect(() => {
    // 订阅是异步拿到的句柄：卸载时如果还没拿到，拿到后立刻退订，
    // 否则 React 严格模式下的双挂载会留下两条活的监听。
    let disposed = false;
    const unlisten: Array<() => void> = [];
    const keep = (off: () => void) => {
      if (disposed) {
        off();
      } else {
        unlisten.push(off);
      }
    };

    void onKernelReady(setReady).then(keep);
    void onKernelStopped(setStopped).then(keep);
    void onKernelEvent((envelope) => {
      setEvents((current) => [envelope, ...current].slice(0, MAX_ROWS));
    }).then(keep);

    return () => {
      disposed = true;
      for (const off of unlisten) {
        off();
      }
    };
  }, []);

  const status = stopped ? "核心已退出" : ready ? "核心已就绪" : "等待核心…";

  return (
    <main className="shell">
      <header className="shell__header">
        <h1>Lurnia</h1>
        <span className={`badge badge--${stopped ? "down" : ready ? "up" : "wait"}`}>
          {status}
        </span>
      </header>

      {stopped && (
        <p className="note note--bad">
          {stopped.message ?? `核心退出，退出码 ${stopped.code ?? "未知"}`}
        </p>
      )}

      {ready && (
        <dl className="facts">
          <div>
            <dt>版本</dt>
            <dd>{ready.version}</dd>
          </div>
          <div>
            <dt>数据库版本</dt>
            <dd>v{ready.db_version}</dd>
          </div>
          <div>
            <dt>启动时归档</dt>
            <dd>{ready.rotated} 条</dd>
          </div>
          <div>
            <dt>数据目录</dt>
            <dd title={ready.data_dir}>{ready.data_dir}</dd>
          </div>
        </dl>
      )}

      <section className="stream">
        <h2>
          事件流 <span className="stream__count">{events.length}</span>
        </h2>
        {events.length === 0 ? (
          <p className="note">
            {ready ? "核心起来了，还没有事件。" : "等核心就绪。"}
          </p>
        ) : (
          <ol className="events">
            {events.map((envelope) => (
              <li key={envelope.id}>
                <div className="events__head">
                  <span className="events__seq">#{envelope.seq}</span>
                  <span className="events__topic">{envelope.topic}</span>
                  <span className="events__who">{envelope.subject.id}</span>
                  <time className="events__when">{envelope.ts_wall}</time>
                </div>
                <code className="events__payload">
                  {JSON.stringify(envelope.payload)}
                </code>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}

export default App;
