<!-- SPDX-FileCopyrightText: 2026 HanYang06 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# 打包：Tauri 宿主 + Python 核心 sidecar

## 一、先说结论

| 产物 | 工具 | 是什么 |
| --- | --- | --- |
| **APP**（用户双击的那个） | **Tauri bundler**（`tauri build`） | `.msi` / `.exe` / `.dmg` / `.AppImage` |
| **Python 核心** | **PyInstaller** | 一个可执行文件，作为 Tauri 的 **sidecar** |

**`uv build` 不在这条链路上。** 它产出 wheel，是给 `pip install` / 发 PyPI 用的。本项目**不发 PyPI**，所以它既不是 APP 产物，也不该当打包门禁。把它当"打包"是错的。

## 二、为什么不是别的

| 方案 | 判定 |
| --- | --- |
| `uv build` → wheel | ❌ 发库链路，打不出 EXE，本项目没有发布理由 |
| PyInstaller 单独出 EXE 当 APP | ❌ 那就没有 WebView UI，等于只有核心没有界面 |
| Nuitka | 可选替代（编译成 C，产物体积/启动更好），但**生态坑多、构建慢**；先用 PyInstaller |
| PyOxidizer | ❌ 项目活跃度不足，不做首选 |
| 核心改写成 Rust | ❌ 放弃整个 Python 内核，前期工作归零 |

## 三、两条产物，一个安装包

```
pnpm build                     # 前端 -> app/dist
    ↓
PyInstaller lurnia-core        # Python 内核 -> 单文件可执行
    ↓
tauri build                    # 把上面两者 + Rust 外壳 打成安装包
    ↓
Lurnia_0.1.0_x64-setup.msi     # 用户双击这个
```

Tauri 通过 **`bundle.externalBin`** 声明 sidecar：Tauri 会按**目标三元组**给 sidecar 文件名加后缀（如 `lurnia-core-x86_64-pc-windows-msvc.exe`），打包时收进安装包，运行时用 `Command::new_sidecar` 或 shell 插件拉起。

## 四、I9 的边界（关键）

sidecar 是**宿主拉起自己的核心**，属 APP 内部实现。按 I9 修订后的判据：

- ✅ 允许：拉起自己的 sidecar、stdio / 命名管道通信、写自己的数据目录；
- ❌ 禁止：**监听 TCP 端口**、起 HTTP 服务、联网、拉起第三方程序。

**进程内通信不算"对外"。** 这条边界写在 [invariants.md](invariants.md) § I9，不变量没有被削弱，只是判据从"有没有拉进程"改成"用户是否被动承受了没要的东西"。

## 五、前后端怎么说话

两条通道，职责不同：

| 通道 | 走什么 | 为什么 |
| --- | --- | --- |
| **Tauri IPC**（`invoke`） | 请求/回复：查询、命令、拿数据 | 复用 Tauri 现成机制，不自己造 |
| **sidecar stdio** | 事件流（内核 → UI 推送）、长连接 | 内核的广播平面需要一个持续通道 |

事件封套仍是**内核资产**（不变量 I8），Tauri IPC / stdio 只是**绑定**。所以封套的序列化与协议测试在换绑定时必须复用通过。

**不引本地套接字**：既然已经有一个 sidecar 进程，用它的 stdio 就够了，多开一个监听端口反而触 I9 红线。

### stdio 行协议（v1，2026-10-16 定）

<a id="r009"></a>

一行一个 JSON 对象，用 `type` 区分。**内核 → UI 只有这一条通道**：

| `type` | 什么时候出 | 关键字段 |
| --- | --- | --- |
| `ready` | 核心装配完成后，**第一行** | `protocol` / `version` / `data_dir` / `frozen` / `rotated` |
| `event` | 广播平面每出一条 | `envelope`：**封套原样嵌进来** |
| `error` | 起不来、参数不认、配置坏了 | `message`；退出码非 0 |
| `version` / `self-check` | 对应参数 | 见 `--version` / `--self-check` |

封套不重新发明字段名，`{"type":"event","protocol":1,"envelope":{…}}` 里的 `envelope`
就是 `EventEnvelope` 自己的字段（不变量 I8）。宿主先等 `ready`，再认 `event`；
`ready` 之前到的事件一律丢弃。

**数据目录**：核心默认走平台口径（§六），宿主**不传**；`--data-dir <path>` 或环境变量
`LURNIA_DATA_DIR` 可覆盖 —— 这是给测试与便携安装留的口，不是给宿主日常用的。

**stdin（v1 不解析）**：宿主 → 内核的请求走 Tauri IPC（上表），不走 stdio。所以
sidecar 只等 stdin 关闭（EOF）就退出：生命周期由宿主掌握，宿主没了核心不会变孤儿。

**为什么 `ready` 必须是第一行**：宿主按行读，第一行没到之前它不知道核心是在解压、
在建库，还是已经死了。把「已就绪」显式说出来，UI 才能区分「核心没起来」与
「核心起来了但还没有事件」。

### 宿主 → 内核：`call` / `reply`（v2，2026-10-17 已实现，未实机联调）

<a id="r115"></a>

v1 只有「内核 → UI」一个方向。编辑器是第一个**必须请求**的组件（存文档、取文档），
所以补两种帧，协议号升到 **2**：

| `type` | 方向 | 帧 |
| --- | --- | --- |
| `call` | 宿主 → 内核 | `{"type":"call","protocol":2,"id":"…","capability":"doc.save","request":{…}}` |
| `reply` | 内核 → 宿主 | `{"type":"reply","protocol":2,"id":"…","reply":{"ok":…}}`／`{"…","reply":{"err":{"kind","message","retryable"}}}` |

- **`request.body` 是 JSON 文本，不是对象**（`doc.save` 用）：文档要**原样入库**、
  不 re-dump（[editor.md §3.3](editor.md) 第 2 条），双重编码就是这条口径的代价。
- `reply` 用共享错误模型（[bus.md](bus.md) §四）：`ok` 与 `err` 二选一，调用方只需要
  认识一种失败形状。
- `call` 进**调用平面**（`bus.invoke`），不进广播平面：调用恰好一个提供者、没人接必须报错，
  而广播允许没人接（bus.md §一）。合成一条会让「没人接」不可区分 —— 那正是 bus.md
  拒绝合并两个平面的理由。
- **`subject` 由内核填本机主体**，前端不传、也不许造身份（[ui.md](ui.md) §九；I6）；
  帧里就算带了 `subject` 也会被忽略（有测试钉住）。
- **两个方向都锁 UTF-8**：v2 加 stdin 解析时只锁了 stdout，中文经 `call` 帧进来当场
  解不开 —— 这条是端到端测试（子进程 + 真入口）抓到的，单元测试看不见。
- **一行不合法不会打断循环**：坏 JSON、非 `call` 帧各回一条 `error` 帧后继续读；
  `call` 缺 `id` 也回 `error`（没有 id 就无法关联回复）。EOF 仍然退出。
- 宿主侧：`lib.rs` 的 `#[tauri::command] kernel_call` 把请求写成一行喂给 sidecar 的 stdin
  （写句柄归一个独立写线程），`reply` 帧由 stdout 循环 emit 成 `kernel://reply`；
  前端 `app/src/kernel.ts` 的 `callKernel()` 按 `id` 关联 —— **Rust 侧不维护挂起表**。
- 状态：**代码已落，未实机联调**。Python 侧有端到端测试；Rust 侧 `cargo check`/`clippy`
  通过；前端 `tsc` 通过。真正的联调要 `build_sidecar.py` + `tauri dev`。
- 动机与验收见 [editor.md §十八](editor.md)；**帧格式以本节为准**（协议是打包边界的设计，
  不是编辑器的设计）。

## 六、数据放哪

`sys.executable` 在 PyInstaller 单文件模式下指向**临时解包目录**，不是安装目录。所以数据路径**绝不能**由 `__file__` 或 `sys.executable` 推导：

| 数据 | 位置 |
| --- | --- |
| 数据库、附件库、配置 | `%APPDATA%/Lurnia`（Windows）、`~/Library/Application Support/Lurnia`（macOS）、`~/.local/share/Lurnia`（Linux） |
| **只读资源**（`.sql`、schema `.json`、图标） | **打进 PyInstaller 包内**，用 `importlib.resources` 读 |

这就是为什么 DDL 必须在**包内**而**不能**放仓库根 `config/`：`config/` 既不属于包、也不在 `--add-data` 的目标里，成品里根本没有它。包内哪一处见 [storage.md §五](storage.md)：**所有 schema 都在 `src/lurnia/sql/<schema>/`**（一处放全部，包括内核 schema）。**`.json` 与 `.sql` 同级**：文档类型的 schema 资源也是数据文件，`script/build_sidecar.py` 两者一起收，`--self-check` 在冻结产物里验它们读得到（[editor.md §4.5](editor.md)）。

## 七、构建脚本与门禁

**先删掉了 `uv build` 那条"打包门禁"** —— 它验的不是 APP，而且会让人误以为打包已验证。取而代之的是下面这个真正验产物的脚本。

侧车由 [`script/build_sidecar.py`](../../script/build_sidecar.py) 构建，**不手敲 pyinstaller 参数**：

```bash
uv run python script/build_sidecar.py          # 构建 + 冻结产物自检
uv run python script/build_sidecar.py --check  # 只验已有产物
```

脚本存在的理由，都是实测踩出来的：

| 坑 | 事实 |
| --- | --- |
| **`.sql` 不会自动收集** | PyInstaller 只自动收 Python 模块。数据文件必须显式 `--add-data`。实测漏掉时**装完才炸**（`FileNotFoundError`） |
| **`--paths src` 必需** | src 布局下 `lurnia` 从仓库根不可导入 |
| **`externalBin` 只吃单个文件** | Tauri 要求一个名为 `<name>-<目标三元组>` 的二进制，**不接受目录**。所以脚本同时产出 `--onedir`（运行时用，见 §八）与单文件（Tauri 消费），放进 `app/src-tauri/binaries/`（已 gitignore） |

**构建必须自证。** `--self-check` 在**冻结产物内部**跑，读不到 DDL 或迁移失败就让构建失败。反向验证过：去掉 `--add-data`，它如实报 `ok: false` 并 exit 1。**能构建但打不开自己数据库的产物，比构建失败更糟**，所以 CI 不许传 `--skip-check`。

产物实测（Windows / x86_64-pc-windows-msvc）：

```
app/src-tauri/binaries/lurnia-core-x86_64-pc-windows-msvc.exe   9.2 MB
冻结产物自检: frozen=True, ddl=[1], tables=['event_log.sql'], migrated_to=1
```

## 八、产物里的 Python 是什么形态（实测）

**产物里没有裸 `.py`，也没有散落的 `.pyc`。** 实测 onedir 产物的文件类型统计：`9 pyd / 4 dll / 1 zip / 1 exe`，`.py` 与 `.pyc` 均为 **0 个**。

拆开归档看格式：

| 位置 | 形态 |
| --- | --- |
| 顶层入口脚本 | **字节码**（`marshal.loads` → `code` 对象，开头 `b'c'`） |
| `import` 到的模块 | 收进 `PYZ.pyz` 归档，同样**是 `code` 对象** |

所以：

| 问题 | 答案 |
| --- | --- |
| 注释去哪了 | **自动消失** —— 变成字节码就不存在注释文本，无需任何选项 |
| 是不是拼成一个大文件 | ❌ 每个模块仍是独立 code object |
| 是不是纯字节码二进制 | ✅ **是** |
| docstring | **默认保留**；`--optimize 2`（=`-OO`）剥掉。实测**两者体积都是 21M**，省不下来 |

**构建选了 `--optimize 2`**：理由不是体积（实测省 0），而是"产物即纯运行时"的原则；代价是产物内 `help()` 看不到文档字符串，我们接受——**调试用源码，不用产物**。

**必须说清楚：这不是保护。** PyInstaller 只保证能跑，不做混淆；字节码可被反编译。traceback 仍会显示原始文件名与行号（这有利于诊断，但说明它无意隐藏）。要真正的保护得换 Nuitka 或加壳，**现在不做**。

## 九、`--onedir` 而不是 `--onefile`

| 模式 | 实测体积 | 运行时行为 |
| --- | --- | --- |
| `--onedir` | 21 MB（目录总计） | 直接跑，启动快 |
| `--onefile` | **8.2 MB**（单文件，更小） | **每次启动解压到临时目录**（`sys._MEIPASS`） |

**注意体积直觉是反的**：单文件反而更小。选 `--onedir` 的真实理由是：

- sidecar 会被宿主频繁拉起，`--onefile` 每次启动都要解压几十 MB、写临时盘；
- 自解压行为更容易触发杀毒软件误报。

**但 Tauri 的 `externalBin` 不收目录**，所以两条都要出：`--onedir` 供直接运行与排查，单文件供 Tauri 打包消费（见 §七）。

## 十、明确不做

| 不做 | 为什么 |
| --- | --- |
| 发 PyPI | 没有发的理由，也没有消费者 |
| 启动时联网检查更新 | 破 I9；更新由用户显式发起 |
| 监听本地端口做 IPC | 有 stdio 就够；多开端口触 I9 红线 |
| 让内核自己拉起子进程 | 只有宿主管理 sidecar 生命周期 |
