<!-- SPDX-FileCopyrightText: 2026 HanYang06 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# 资产渲染源

本目录是 `../review-*.png` 的**可复现来源**。早期那批 `ui-*.png` 与
`lurnia-design-baseline.png` 没留下任何生成脚本，无法重跑、无法核对、
令牌一改就失真——那是它们被清理掉的原因之一。

## 为什么用 HTML 而不是绘图脚本

设计图要回答的是「这个界面看起来怎么样」，涉及中文字形、字体回退、真实排版与层叠。
Chromium 正是 Lurnia 运行时所在的引擎（Tauri WebView = WebView2/Chromium），
因此 HTML 渲染出来的图**与真实运行结果同源**，不是近似。用绘图库重画一遍反而引入偏差。

## 渲染方式

无外部依赖，用系统自带的 Edge（Chromium）无头截图：

```bash
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"

"$EDGE" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1440,900 \
  --screenshot=../review-01-current-dark.png \
  "file:///$(pwd)/current-dark.html"
```

`--force-device-scale-factor=2` 出 2x 图；`--window-size` 必须与页面
`body` 宽度一致，否则会出现空白边。

## 源文件清单

| 源文件 | 产出 | 窗口尺寸 | 说明 |
| --- | --- | --- | --- |
| `current-dark.html` | `review-01-current-dark.png` | 1440×900 | 按 `ui.md` 令牌渲染的真实界面（深色） |
| `current-light.html` | `review-02-current-light.png` | 1440×900 | 同上（浅色） |
| `structure.html` | `review-04-structure.png` | 1840×520 | 四区现状 / 脊柱收起态 / 首次启动空状态 |
| `fix.html` | `review-05-chroma-fix.png` | 1500×780 | 中性色彩度分档的前后对比 |
| `cvd.html` | `review-07-cvd.png` | 1260×430 | 语义三态的 protan/deutan 模拟 |
| `logo-candidates.html` | `review-08-logo-candidates.png` | 1560×1120 | 四个标识候选 + 小尺寸表现 |
| `logo-iris.html` | `review-09-logo-iris.png` | 1380×560 | 光圈形态（定稿），叶片为环形扇区 |
| `logo-animation.html` | `review-10-logo-animation.png` | 1560×700 | 标识动画分解，2.4s 采样 10 帧 |
| `mark-base-proof.html` | `review-11-mark-base-proof.png` | 1560×1420 | 基础版/着色版的灰度一致性验证（含 canvas 逐像素比对） |
| `fractal-options.html` | `review-12-fractal-options.png` | 1560×700 | 内核分形候选（六角分形 / Koch / 螺旋）与浮雕幅度 |
| `mark-assets.html` | `review-13-mark-assets.png` | 1700×560 | 八份标识资产的最终校验（深浅两底，16–96px） |
| `core-variants.html` | `review-14-core-variants.png` | 1700×860 | 内核四种取法：镂空/填充深缝/填充无缝/更密，各含整枚标识与 64·40px |
| `core-rolling.html` | `review-15-core-rolling.png` | 1700×900 | 蜂窝球面滚动实测（6 帧 × 15°）与最终资产 |
| `core-curvature.html` | `review-16-core-curvature.png` | 1720×880 | 球半径放大六档（比值 1.00 → 0.15）与明暗归一化 |
| `core-projection-fix.html` | `review-17-core-projection-fix.png` | 1500×620 | 投影修正（ρ=S·sinθ）前后与滚动修正 |
| `core-disc.html` | `review-18-core-disc.png` | 1660×2344 | 核心盘：旧版逐格仿射 vs 新版顶点投影（含 2.5× 局部）、密度、缝、球半径 S/A、实际尺寸 |
| `core-unified.html` | `review-19-core-unified.png` | 1700×620 | 统一方法后的校验：六份标识 × 16–160px，独立圆盘 × 4 档 |

> `mark-base-proof.html` 需要 `--allow-file-access-from-files` 才能用 fetch 读取同级 SVG。
>
> `review-06-mark-sizes.png` 是**已废弃**旧标识的实测记录（三弧形态在 16–32px 糊成一团），
> 保留它是为了留证，**它的渲染源已随旧形态一起删除**，不可重跑。

> 蜂窝纹理的源在 [`../pattern/`](../pattern/)，不在本目录。

## 注意

这些图是**评审与设计过程证据**，不是设计事实来源。
`ui.md` 才是事实来源；本目录的图只是它的配图与推演过程。