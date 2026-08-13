# AgentPlay

<p align="center">
  <img src="resources/icons/agentplay-mark.svg" width="88" alt="AgentPlay 飞鸽标识">
</p>

<p align="center">
  <strong>一个入口，播放、下载、字幕、拉片、文档与 AI 创作。</strong>
</p>

<p align="center">
  <a href="#下载">下载稳定版</a> ·
  <a href="docs/QUICK_START.md">5 分钟上手</a> ·
  <a href="https://github.com/wg5759/AgentPlay/discussions">交流与问答</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a>
</p>

<p align="center">
  <a href="https://github.com/wg5759/AgentPlay/actions/workflows/build.yml"><img alt="Source quality" src="https://github.com/wg5759/AgentPlay/actions/workflows/build.yml/badge.svg?branch=master"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/License-Apache--2.0-blue.svg"></a>
  <img alt="Windows 11 x64 verified" src="https://img.shields.io/badge/Windows_11_x64-verified-2ea44f">
</p>

AgentPlay 是一个面向 AI 时代的本地媒体工作台：在可靠播放的基础上，提供字幕、翻译、拉片、深度解剖、原创重构、成片渲染、模型接入与受控的电脑操作能力。

开源项目、桌面端、Web/PWA、Android、浏览器扩展和安装包统一使用 `AgentPlay` 名称与飞鸽标识。为兼容已有安装和用户数据，内部包名仍为 `ai-player`、应用标识仍为 `com.aiplayer.app`；品牌升级不得清空模型、历史任务、授权设置或“打开方式”注册。

> 当前源码候选版本：`0.8.0`；公开稳定版为 `0.7.6`。Windows 11 x64 候选包必须通过安装包、真实 EXE、视频加载与链接下载验收后才能发布；macOS、Linux、Android、iOS 尚未完成同等级端到端验证。请以 [MULTIPLATFORM.md](MULTIPLATFORM.md) 为准，不把“代码存在”或“CI 配置存在”当作已交付。

尚未完成的产品深化、跨平台验证和发布顺序统一记录在 [ROADMAP.md](ROADMAP.md)；版本变化见 [CHANGELOG.md](CHANGELOG.md)，维护者发布门禁见 [RELEASING.md](RELEASING.md)。

## 下载

以下仍是公开稳定版；本地 `0.8.0` 候选包未经签名且尚未发布到 GitHub Release。

- [AgentPlay 0.7.6 发布页](https://github.com/wg5759/AgentPlay/releases/tag/v0.7.6)
- [Windows x64 标准版](https://github.com/wg5759/AgentPlay/releases/download/v0.7.6/AgentPlay-0.7.6-Windows-x64-Standard.exe)：不内置模型，SHA-256 `B6680A6AE570268D4BA81D5E74CC3DE2D626063FBADCF7387467606F7F63E8CF`

当前版本未购买 Authenticode 代码签名证书，Windows SmartScreen 可能提示“未知发布者”。请只从上述官方 Release 下载并核对 SHA-256。

## 5 分钟上手

1. 从上面的官方 Release 下载稳定版并核对 SHA-256。
2. 打开 AgentPlay 后，直接拖入本地视频、图片或办公文档；也可以粘贴 B站、YouTube、抖音、X 或 Facebook 链接。
3. 对链接选择“仅下载”或“下载并拉片”；对本地文件直接播放、预览，再在同一输入框继续提出字幕、翻译、整理或分析要求。
4. 只有使用 AI 能力时才需要选择“智能选择 / 只在本机 / 优先效果”。单纯播放、下载和本地文档转换不要求配置云模型。
5. 结果与长任务进度在任务中心查看；程序重启后，可恢复的任务会从持久检查点继续。

首次使用、模型选择、日志位置和问题反馈方式见 [5 分钟上手指南](docs/QUICK_START.md)。

## 已实现能力

- 横屏、竖屏及不同宽高比视频完整适配，支持原始大小、1/2 窗口、铺满窗口和全屏。
- 播放/暂停、进度、音量、倍速、字幕、右键菜单、拖放、命令行打开及 Windows 文件关联。
- 字幕发现与加载、语音识别/翻译入口，以及外挂字幕工作流。
- 拉片标记、证据化深度解剖、片段裁剪重排和项目恢复。
- AI 成片方案、新镜头素材接入、旁白、系统配音、字幕包装、音乐混音和 MP4 渲染。
- AI 使用方式：日常只需选择“智能选择 / 只在本机 / 优先效果”；厂商、型号、地址和真实任务评测收进高级设置。已批准的文档、拉片、字幕与创作任务冻结模型身份，重启恢复时不会悄悄换模型。
- 模型中心：支持主流云模型、自定义 OpenAI 兼容接口、Ollama、LM Studio、vLLM、llama.cpp 等本地服务；Key 先选择来源再仅向该服务验证，并由系统安全存储加密。
- 局域网投送、设备同步、DLNA 分享/接收；全部默认关闭，由用户显式开启。
- 可选本地 Qwen2.5-0.5B Q4_0 轻量模型（模型接入中心一键下载组件，含断点续传与 SHA-256 校验），播放器控制仍走本地规则，不让小模型阻塞基础操作。
- AI 文档工作台：文字输入或语音输入统一驱动文档任务；支持文本/DOCX生成与转换、XLSX清理去重和公式写入、基于 JSZip/Open XML 的确定性 PPTX 生成、PDF合并拆分。所有结果默认另存，复杂内容任务在发送给云端模型前要求用户明确同意。
- 高级扫描文档解析：硬件合格的用户可自行部署 Unlimited-OCR，再通过高级设置接入 OpenAI-compatible 本机服务；模型权重不进入 AgentPlay 安装包，服务不可用时明确回退本机 OCR。详见 [可选接入说明](docs/UNLIMITED_OCR.md)。
- 链接视频：B站、YouTube、抖音、X 与 Facebook 统一进入站点下载链；每个识别链接都保留“仅下载”和“下载并拉片”两个选择。需要登录态的平台通过站点登录或导入 Cookies，失败时明确提示，不伪造下载成功。
- 模型无关 Agent Runtime：Agnes、OpenAI、Claude、Gemini、本地模型与订阅 CLI 共用“问答 / 规划 / 执行 / 自动”四种模式；工具调用受权限和预算约束，任务中心展示真实步骤、证据回执与成果文件校验。
- 专业视频拉片报告固定为“视频讲了什么”和“专业视听拆解与 AI 复刻”两部分；关键帧覆盖全片，低质量结果经过门禁和一次自动修复，无法确认的摄影参数明确标记为专业估计。

## Windows 版本与本地 AI

自 0.7.6 起只发布标准版一个安装包。需要离线模型的用户在“模型接入中心”一键下载本地 AI 组件（约 426MB，含 Qwen2.5-0.5B Q4_0 与 llama.cpp 运行时；断点续传、SHA-256 校验、可随时取消），下载完成后离线可用。0.6.1 及更早版本曾提供内置模型的“本地 AI 版”安装包。

模型、密钥和服务能力彼此独立。未配置模型时，正常播放、窗口比例、右键菜单和本地快捷控制仍应工作。

## Code signing policy

未来若通过开源项目资格审核，计划采用：Free code signing provided by SignPath.io, certificate by SignPath Foundation。当前申请已于 2026-07-23 因公开采用与社区可见度证据不足被拒，所有现有版本仍未签名，继续以官方 Release 与 SHA-256 校验为准。

- Committers and reviewers: [wg5759](https://github.com/wg5759)
- Approvers: [wg5759](https://github.com/wg5759)
- Privacy policy: [PRIVACY.md](PRIVACY.md)

## 安全与隐私默认值

- 语音唤醒、Wi-Fi 传片、设备同步和 DLNA 服务默认关闭。
- Wi-Fi 上传要求会话 PIN，并在解析上传内容之前完成校验；日志不记录 PIN。
- Office 预览使用隔离的沙箱页面；电子表格单元格按纯文本转义。
- API 密钥保存在 Electron 用户数据目录，不应提交到仓库；日志和问题报告也不得粘贴密钥。
- 连接云模型时，用户选中的文本、字幕、画面描述或提示词可能发送给对应服务商。详见 [PRIVACY.md](PRIVACY.md)。
- 文档工作台的本地转换、明确公式、PDF合并和拆分不调用模型；需要改写、翻译、总结或生成内容时，仅把所选文件的必要文本发给当前模型，并在云端连接下要求逐次授权。

## 本地开发

需要 Node.js 20+ 与 pnpm。

第三方扩展采用不执行任意代码的声明式插件与 Skill 接口。清单、权限模型、示例和安装生命周期见 [插件与 Skill 开发文档](docs/PLUGINS_AND_SKILLS.md)。

```powershell
pnpm install
pnpm dev:electron
```

完整检查：

```powershell
pnpm check
pnpm audit --prod --registry=https://registry.npmjs.org
pnpm audit --registry=https://registry.npmjs.org
pnpm build:electron
pnpm release:verify
node scripts/smoke-packaged-ui.mjs
node scripts/smoke-packaged-download.mjs
node scripts/smoke-creative-render.mjs --packaged
pnpm security:scan:packaged
```

Windows 安装包依赖仓库外的可再分发媒体与本地模型资源。大体积二进制和模型由构建准备流程放入 `resources/`，不会提交到 Git。

公开发布前先运行：

```powershell
pnpm security:scan
pnpm release:public:verify
```

源码仓库已经公开。mpv/FFmpeg GPL 二进制、完整对应源码和绑定清单已在 [稳定公开 Release](https://github.com/wg5759/AgentPlay/releases/tag/mpv-gpl-v0.41.0-20260719) 托管；`pnpm release:public:verify:binary` 会在线核对三个远端资产的固定 URL、字节数和 SHA-256，任一不一致即故障关闭。GitHub Actions 只做源码质量门禁，不把 CI 配置存在冒充 macOS/Linux 已交付，也不会因推送标签自动发布安装包。

## 开源边界

项目自有源代码按 [Apache License 2.0](LICENSE) 开放。第三方组件和模型继续受各自许可约束，参见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。Apache-2.0 不授予 `AgentPlay` 名称、飞鸽标识或其他品牌资产的使用权，参见 [TRADEMARKS.md](TRADEMARKS.md)。

- 播放器界面、Electron 主进程、模型接入、字幕、拉片、深度解剖、原创重构与安全门禁等项目自研代码全部开放，不保留隐藏的闭源功能模块。
- 仓库不提交安装包、大模型权重、第三方原生二进制、代码签名证书、用户媒体或 API Key；这些内容受体积、安全或各自许可证约束，不等于项目自研代码闭源。
- `AgentPlay` 名称、飞鸽标识和官方发行版视觉识别保留品牌权利。允许修改和分发代码，但衍生版本不能冒充 AgentPlay 官方版本。

普通问题、功能讨论和成果展示请进入 [GitHub Discussions](https://github.com/wg5759/AgentPlay/discussions)；可复现缺陷请提交 [Issue](https://github.com/wg5759/AgentPlay/issues/new/choose)。完整支持边界见 [SUPPORT.md](SUPPORT.md)，参与开发请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题请阅读 [SECURITY.md](SECURITY.md)。
