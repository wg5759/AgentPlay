# 第三方组件与模型说明

本文件是发布清单，不替代各项目的完整许可证。二进制发行前必须把适用许可证随包提供，并核对实际打包版本与来源。

| 组件 | 当前用途/版本证据 | 许可证与来源 |
|---|---|---|
| Electron / Chromium / Node.js | 桌面运行时，Electron 28.3.3 | 各项目许可证；<https://www.electronjs.org/> |
| React / React DOM | UI，18.3.x | MIT；<https://react.dev/> |
| Zustand | 状态管理，4.5.x | MIT；<https://github.com/pmndrs/zustand> |
| Mammoth.js | DOCX 安全预览，1.12.x | BSD-2-Clause；<https://github.com/mwilliamson/mammoth.js> |
| ExcelJS | XLSX 安全预览，4.4.0 | MIT；<https://github.com/exceljs/exceljs> |
| word-extractor | AI 文档工作台提取老式 .doc 文字，1.0.4 | MIT；<https://github.com/morungos/word-extractor> |
| docx | AI 文档工作台生成 DOCX，9.5.1 | MIT；<https://docx.js.org/> |
| PptxGenJS | AI 文档工作台生成 PPTX，4.0.1 | MIT；<https://gitbrent.github.io/PptxGenJS/> |
| pdf-lib | AI 文档工作台合并、拆分 PDF，1.17.1 | MIT；<https://pdf-lib.js.org/> |
| unpdf（内嵌 PDF.js） | AI 文档工作台提取 PDF 文字层，1.6.x | MIT；<https://github.com/unjs/unpdf> |
| JSZip | 提取 PPTX 中的可读文本，3.10.1 | MIT 或 GPL-3.0-or-later；<https://stuk.github.io/jszip/> |
| Formidable | 显式开启的局域网上传，3.5.x | MIT；<https://github.com/node-formidable/formidable> |
| mpv | 播放与 MP4 渲染；v0.41.0、commit `41f6a645...`，本项目可复现 GPL 构建的本地文件与发布清单哈希一致 | 本构建明确启用 GPL；许可证与来源证据位于 `resources/licenses/mpv/`；[二进制、清单与完整对应源码](https://github.com/wg5759/AgentPlay/releases/tag/mpv-gpl-v0.41.0-20260719) |
| FFmpeg | 静态进入上述官方 mpv 构建，报告 `f853d12`；官方构建脚本明确设置 `ffmpeg:gpl=enabled` | GPL 构建；<https://github.com/mpv-player/mpv/blob/41f6a645068483470267271e1d09966ca3b9f413/ci/build-win32.ps1> |
| llama.cpp | 本地 AI 服务，tag `b10063`，commit `7d56da7e...` | MIT；许可证副本位于 `resources/licenses/llama.cpp/` |
| Qwen2.5-0.5B-Instruct-GGUF | 本地 AI 组件内置 Q4_0 模型（应用内下载） | Apache-2.0；许可证和模型卡位于 `resources/licenses/qwen2.5-0.5b/` |

JavaScript 依赖的精确闭包由 `pnpm-lock.yaml` 记录。`resources/bundled-ai-manifest.json` 记录内置模型、运行时、来源和 SHA-256。

## 公开二进制发行证据

当前 Windows mpv/FFmpeg 构建明确属于 GPL 路径。以下三项已经在同一个稳定公开 Release 托管：

1. `GPL-BUNDLE-MANIFEST.json`；
2. `mpv-v0.41.0-windows-x64-gpl.zip`；
3. `mpv-v0.41.0-complete-corresponding-source.zip`，覆盖 35 个固定仓库、46,849 个文件。

固定 URL、字节数和 SHA-256 记录在 `binary-source-evidence.json`，`pnpm release:public:verify:binary` 会通过公开 GitHub Release API 在线核对远端资产状态、大小和摘要。许可证全文、版权说明、构建来源和公开源码地址均随安装闭包配置。
