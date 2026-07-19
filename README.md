# AgentPlay（AI播放器）

AgentPlay 是一个面向 AI 时代的本地媒体工作台：在可靠播放的基础上，提供字幕、翻译、拉片、深度解剖、原创重构、成片渲染、模型接入与受控的电脑操作能力。

开源项目与未来仓库统一使用 `AgentPlay`。Windows 0.6.x 暂时保留 `ai-player` 内部包名、“AI播放器”产品名与可执行文件名，以兼容已有用户数据、安装路径和“打开方式”注册；正式改名必须经过带数据与旧关联迁移的版本升级，不能只改文件名。

> 当前版本：`0.6.1`。Windows 11 x64 已完成安装包、真实 EXE、视频加载和 MP4 导出验收；macOS、Linux、Android、iOS 尚未完成同等级端到端验证。请以 [MULTIPLATFORM.md](MULTIPLATFORM.md) 为准，不把“代码存在”或“CI 配置存在”当作已交付。

## 已实现能力

- 横屏、竖屏及不同宽高比视频完整适配，支持原始大小、1/2 窗口、铺满窗口和全屏。
- 播放/暂停、进度、音量、倍速、字幕、右键菜单、拖放、命令行打开及 Windows 文件关联。
- 字幕发现与加载、语音识别/翻译入口，以及外挂字幕工作流。
- 拉片标记、证据化深度解剖、片段裁剪重排和项目恢复。
- AI 成片方案、新镜头素材接入、旁白、系统配音、字幕包装、音乐混音和 MP4 渲染。
- 模型中心：主流云模型、自定义 OpenAI 兼容接口、Ollama、LM Studio、vLLM、llama.cpp 等本地服务。
- 局域网投送、设备同步、DLNA 分享/接收；全部默认关闭，由用户显式开启。
- 本地 AI 版可选内置 Qwen2.5-0.5B Q4_0，播放器控制仍走本地规则，不让小模型阻塞基础操作。

## 两种 Windows 版本

| 版本 | 用途 | 本地模型 |
|---|---|---|
| 标准版 | 安装快、体积小；可连接云模型或用户已有的本地模型服务 | 不内置 |
| 本地 AI 版 | 离线摘要、一般问答和轻量辅助 | 内置约 409MB 的 Qwen2.5-0.5B Q4_0 |

模型、密钥和服务能力彼此独立。未配置模型时，正常播放、窗口比例、右键菜单和本地快捷控制仍应工作。

## 安全与隐私默认值

- 语音唤醒、Wi-Fi 传片、设备同步和 DLNA 服务默认关闭。
- Wi-Fi 上传要求会话 PIN，并在解析上传内容之前完成校验；日志不记录 PIN。
- Office 预览使用隔离的沙箱页面；电子表格单元格按纯文本转义。
- API 密钥保存在 Electron 用户数据目录，不应提交到仓库；日志和问题报告也不得粘贴密钥。
- 连接云模型时，用户选中的文本、字幕、画面描述或提示词可能发送给对应服务商。详见 [PRIVACY.md](PRIVACY.md)。

## 本地开发

需要 Node.js 20+ 与 pnpm。

```powershell
pnpm install
pnpm dev:electron
```

完整检查：

```powershell
pnpm check
pnpm audit --prod --registry=https://registry.npmjs.org
pnpm build:electron
pnpm release:verify
node scripts/smoke-packaged-ui.mjs
node scripts/smoke-creative-render.mjs --packaged
```

Windows 安装包依赖仓库外的可再分发媒体与本地模型资源。大体积二进制和模型由构建准备流程放入 `resources/`，不会提交到 Git。

公开发布前先运行：

```powershell
pnpm security:scan
pnpm release:public:verify
```

当前策略只允许发布源码；`pnpm release:public:verify:binary` 会在 GPL 对应源码包尚未托管时故障关闭。GitHub Actions 只做源码质量门禁，不再把 CI 配置存在冒充 macOS/Linux 已交付，也不会因推送标签自动发布安装包。

## 开源边界

项目自有源代码按 [Apache License 2.0](LICENSE) 开放。第三方组件和模型继续受各自许可约束，参见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。Apache-2.0 不授予“AgentPlay”“AI播放器”名称、蜂鸟图标或其他品牌标识的使用权，参见 [TRADEMARKS.md](TRADEMARKS.md)。

- 播放器界面、Electron 主进程、模型接入、字幕、拉片、深度解剖、原创重构与安全门禁等项目自研代码全部开放，不保留隐藏的闭源功能模块。
- 仓库不提交安装包、大模型权重、第三方原生二进制、代码签名证书、用户媒体或 API Key；这些内容受体积、安全或各自许可证约束，不等于项目自研代码闭源。
- `AgentPlay` 名称、蜂鸟图标和官方发行版视觉识别保留品牌权利。允许修改和分发代码，但衍生版本不能冒充 AgentPlay 官方版本。

参与开发请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题请阅读 [SECURITY.md](SECURITY.md)。
