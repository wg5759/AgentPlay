# 第三方组件与模型说明

本文件是发布清单，不替代各项目的完整许可证。二进制发行前必须把适用许可证随包提供，并核对实际打包版本与来源。

| 组件 | 当前用途/版本证据 | 许可证与来源 |
|---|---|---|
| Electron / Chromium / Node.js | 桌面运行时，Electron 28.3.3 | 各项目许可证；<https://www.electronjs.org/> |
| React / React DOM | UI，18.3.x | MIT；<https://react.dev/> |
| Zustand | 状态管理，4.5.x | MIT；<https://github.com/pmndrs/zustand> |
| Mammoth.js | DOCX 安全预览，1.12.x | BSD-2-Clause；<https://github.com/mwilliamson/mammoth.js> |
| ExcelJS | XLSX 安全预览，4.4.0 | MIT；<https://github.com/exceljs/exceljs> |
| Formidable | 显式开启的局域网上传，3.5.x | MIT；<https://github.com/node-formidable/formidable> |
| mpv | 播放与 MP4 渲染；官方 v0.41.0 MSVC 资产，commit `41f6a645...`，本地文件与官方资产哈希完全一致 | 本构建明确启用 GPL；许可证与来源证据位于 `resources/licenses/mpv/`；<https://github.com/mpv-player/mpv/releases/tag/v0.41.0> |
| FFmpeg | 静态进入上述官方 mpv 构建，报告 `f853d12`；官方构建脚本明确设置 `ffmpeg:gpl=enabled` | GPL 构建；<https://github.com/mpv-player/mpv/blob/41f6a645068483470267271e1d09966ca3b9f413/ci/build-win32.ps1> |
| llama.cpp | 本地 AI 服务，tag `b10063`，commit `7d56da7e...` | MIT；许可证副本位于 `resources/licenses/llama.cpp/` |
| Qwen2.5-0.5B-Instruct-GGUF | 本地 AI 版内置 Q4_0 模型 | Apache-2.0；许可证和模型卡位于 `resources/licenses/qwen2.5-0.5b/` |

JavaScript 依赖的精确闭包由 `pnpm-lock.yaml` 记录。`resources/bundled-ai-manifest.json` 记录内置模型、运行时、来源和 SHA-256。

## 公开二进制发行前的待办

当前 Windows mpv/FFmpeg 二进制的官方下载来源、版本、构建脚本和逐文件哈希已经确认；该构建明确属于 GPL 路径。正式公开安装包前仍必须：

1. 为该官方 CI 构建准备并托管完整对应源码包，覆盖静态链接的 FFmpeg 和其他子项目；
2. 按 GPL 要求保持源码获取方式和期限，并在发布页与安装包内明确指向；
3. 将对应源码包的 URL、大小和 SHA-256 加入发布校验。

许可证全文、版权说明和构建来源现已随包配置。在对应源码包上线前，可以审查和发布项目自有源代码，但不应把 Windows 安装包标记为“GPL 对应源码交付已完成”。
