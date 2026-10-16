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

use std::io::{BufRead, BufReader};

use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

/// 与 `app/src/kernel.ts` 里的常量必须一致：Rust emit、前端 listen，
/// 名字对不上不会报错，只会安静地收不到任何东西。
const KERNEL_EVENT: &str = "kernel://event";
const KERNEL_READY: &str = "kernel://ready";
const KERNEL_STOPPED: &str = "kernel://stopped";

/// sidecar 的名字：对应 `bundle.externalBin` 的 `binaries/lurnia-core`，
/// 由 `script/build_sidecar.py` 构建并按目标三元组加后缀。
const SIDECAR: &str = "lurnia-core";

/// 拉起核心，并把它的 stdout 行转成前端事件。
fn spawn_core(app: &AppHandle) -> Result<(), tauri_plugin_shell::Error> {
    let (mut receiver, _child) = app.shell().sidecar(SIDECAR)?.spawn()?;
    let handle = app.clone();

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
