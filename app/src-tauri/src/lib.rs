// SPDX-FileCopyrightText: 2026 HanYang06
// SPDX-License-Identifier: Apache-2.0
//! Lurnia 的 Tauri 壳：宿主 + 内核 sidecar 的装配台。
//!
//! 口径见 `docs/design/packaging.md`：
//!
//! * 宿主**拉起自己的** sidecar（I9 允许的内部实现），核心的生命周期由宿主掌握；
//! * sidecar 的 stdout 是行协议（§五）：`ready` 之后才认 `event`；
//! * 前端只看转发过去的封套（I8：封套是内核资产，宿主只是绑定）。
//!
//! 这里**不解释封套语义**：`event` 行里的 `envelope` 原样转发给前端，字段一个不改。
//!
//! v2（路线 115）多了一个反方向：前端的 `invoke("kernel_call", …)` 被写成一行 `call`
//! 帧喂给核心的 stdin，核心回 `reply` 帧，这里按行转给前端。
//! **subject 不在帧里** —— 由内核填本机主体（I6、ui.md §九），前端不许造身份。

use std::io::{BufRead, BufReader};
use std::sync::Mutex;
use std::sync::mpsc::{Sender, channel};

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

/// 与 `app/src/kernel.ts` 里的常量必须一致：Rust emit、前端 listen，
/// 名字对不上不会报错，只会安静地收不到任何东西。
const KERNEL_EVENT: &str = "kernel://event";
const KERNEL_READY: &str = "kernel://ready";
const KERNEL_STOPPED: &str = "kernel://stopped";
const KERNEL_REPLY: &str = "kernel://reply";

/// sidecar 的名字：对应 `bundle.externalBin` 的 `binaries/lurnia-core`，
/// 由 `script/build_sidecar.py` 构建并按目标三元组加后缀。
const SIDECAR: &str = "lurnia-core";

/// 协议号，必须与 `src/lurnia/sidecar.py` 的 `PROTOCOL_VERSION` 一致。
const PROTOCOL: u32 = 2;

/// 内核的写入口。
///
/// **state 里只放一个 `Sender`**：sidecar 的写句柄归写线程所有，不必跨线程共享
/// （它是不是 `Sync` 这里不猜）；`Mutex` 只保护这一个槽位。
#[derive(Default)]
struct Kernel {
    outbox: Mutex<Option<Sender<String>>>,
}

/// 前端 → 内核：一条 `call` 帧。
///
/// 只负责写进去；回复不在这里等 —— 它由 stdout 循环 emit 成 `kernel://reply`，
/// 前端按 `id` 关联。于是 Rust 侧既不需要挂起表，也不需要阻塞。
#[tauri::command]
fn kernel_call(
    kernel: State<'_, Kernel>,
    id: String,
    capability: String,
    request: serde_json::Value,
) -> Result<(), String> {
    let frame = serde_json::json!({
        "type": "call",
        "protocol": PROTOCOL,
        "id": id,
        "capability": capability,
        "request": request,
    });
    let mut line = serde_json::to_string(&frame).map_err(|error| error.to_string())?;
    line.push('\n');
    let sender = kernel
        .outbox
        .lock()
        .map_err(|_| "内核写入口的锁坏了".to_string())?
        .clone()
        .ok_or_else(|| "内核还没起来".to_string())?;
    sender.send(line).map_err(|_| "内核已经退出".to_string())
}

/// 拉起核心：它的 stdout 行转成前端事件，前端的 `call` 帧转成它的 stdin 行。
fn spawn_core(app: &AppHandle) -> Result<(), tauri_plugin_shell::Error> {
    let (mut receiver, mut child) = app.shell().sidecar(SIDECAR)?.spawn()?;
    let handle = app.clone();

    // 写线程：阻塞 `recv` 放独立线程，不去搅 async 运行时。
    let (outbox, inbox) = channel::<String>();
    std::thread::spawn(move || {
        while let Ok(line) = inbox.recv() {
            if child.write(line.as_bytes()).is_err() {
                // 核心没了就不再重试：前端会收到 stopped，重试只会刷屏。
                break;
            }
        }
    });
    if let Ok(mut slot) = app.state::<Kernel>().outbox.lock() {
        *slot = Some(outbox);
    }

    tauri::async_runtime::spawn(async move {
        // `ready` 之前到的事件一律丢掉：第一行没到，就还不知道核心是在解压、
        // 在建库，还是已经死了（packaging.md §五）。
        let mut ready = false;
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let lines = BufReader::new(bytes.as_slice()).lines();
                    for line in lines.map_while(|line| line.ok()) {
                        let Ok(payload) = serde_json::from_str::<serde_json::Value>(&line) else {
                            continue;
                        };
                        match payload.get("type").and_then(|kind| kind.as_str()) {
                            Some("ready") => {
                                ready = true;
                                let _ = handle.emit(KERNEL_READY, payload);
                            }
                            Some("event") if ready => {
                                let _ = handle.emit(KERNEL_EVENT, payload);
                            }
                            Some("reply") if ready => {
                                let _ = handle.emit(KERNEL_REPLY, payload);
                            }
                            Some("error") => {
                                let _ = handle.emit(KERNEL_STOPPED, payload);
                            }
                            _ => {}
                        }
                    }
                }
                CommandEvent::Terminated(status) => {
                    let _ = handle.emit(KERNEL_STOPPED, serde_json::json!({ "code": status.code }));
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Kernel::default())
        .invoke_handler(tauri::generate_handler![kernel_call])
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // 起不来也要把窗口开出来：界面上写「核心已退出」比白屏或一句崩溃日志
            // 有用得多 —— 尤其在那台还没跑过 build_sidecar.py 的开发机上。
            if let Err(error) = spawn_core(app.handle()) {
                eprintln!("[lurnia] 内核 sidecar 起不来：{error}");
                let _ = app.handle().emit(
                    KERNEL_STOPPED,
                    serde_json::json!({ "message": error.to_string() }),
                );
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
