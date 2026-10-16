<!-- SPDX-FileCopyrightText: 2026 HanYang06 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# app：Lurnia 的界面层

Tauri 宿主 + React 19 + TypeScript。目录口径见 [`docs/design/packaging.md`](../docs/design/packaging.md)，
界面口径见 [`docs/design/ui.md`](../docs/design/ui.md)。

## 现在有什么

| 路径                    | 是什么                                                                 |
| ----------------------- | ---------------------------------------------------------------------- |
| `src/styles/tokens.css` | **设计令牌层**（路线 093/099/100）。全项目唯一允许出现颜色字面量的文件 |
| `src/styles/base.css`   | 全局基线：重置、焦点环、`prefers-reduced-motion`                       |
| `src/theme.ts`          | 主题切换：跟随系统为默认，可锁定深/浅（096/097 的机制部分）            |
| `src/kernel.ts`         | 与内核的**唯一**接触面（事件订阅 + `callKernel`）                      |
| `src/App.tsx`           | 占位壳：内核状态与事件流。四区布局（095）与组件库（094/103）还没做     |

## 门禁

和 Python 侧同一套思路：**能机械检查的就不靠人守**。命令与 CI 保持一致。

```bash
pnpm gate          # 下面全部，外加打包
pnpm check:spdx    # SPDX 头
pnpm lint:js       # ESLint（类型感知 + React + 无障碍 + 令牌纪律）
pnpm lint:css      # stylelint（颜色字面量只能出现在 tokens.css）
pnpm format:check  # prettier
pnpm typecheck     # tsc --noEmit（strict）
pnpm test          # vitest：令牌与 ui.md 逐格比对 + 对比度实算
pnpm build         # tsc + vite build
```

`src/styles/tokens.test.ts` 不是普通的单测：它读 `docs/design/ui.md`，把设计文档里的
令牌表、三态表、圆角/间距/动效表与 `tokens.css` 逐格比对，并**实算** §7.2 那张对比度表。
改了令牌值却忘了改设计文档（或反过来）——测试就红。

## 开发

```bash
pnpm install
pnpm dev           # 只起前端（浏览器里看界面，没有内核通道）
pnpm tauri dev     # 起完整 APP（需要先有 sidecar，见 script/build_sidecar.py）
```
