# AgentPlay 5 分钟上手

## 1. 先确认你下载的是哪一版

公开稳定版是 `0.7.6`，下载入口只认 [GitHub Releases](https://github.com/wg5759/AgentPlay/releases)。`0.8.0` 当前是公开源码候选，还没有签名安装包或正式 Release。

Windows 安装包尚未取得 Authenticode 签名，系统可能显示“未知发布者”。下载后请在 PowerShell 核对发布页给出的 SHA-256：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\AgentPlay-0.7.6-Windows-x64-Standard.exe'
```

只有文件来自官方 Release 且哈希完全一致时才继续安装；不要从群聊、网盘或第三方下载站获取安装包。

## 2. 不用配置模型也能做的事

- 拖入或双击本地视频进行播放。
- 粘贴 B站、YouTube、抖音、X 或 Facebook 链接，选择“仅下载”。
- 打开图片、PDF、Word、Excel、PPT 等办公文件进行预览。
- 执行本地文档转换、PDF 合并拆分和明确的表格公式写入。

这些基础能力不应该因为没有 Key 或本地模型而失效。

## 3. 需要 AI 时只选一种使用方式

- **智能选择**：在已经接入且获得授权的模型中，按能力、成功率和质量选择。
- **只在本机**：内容不交给云端模型；未安装本地组件时会给出唯一的下载入口。
- **优先效果**：使用已接入的云端模型；发送媒体、字幕或文档内容前仍需按任务授权。

日常无需理解厂商地址、上下文长度或路由分数。只有接入自建服务、Ollama、LM Studio、vLLM、llama.cpp 或 Unlimited-OCR 时才展开高级设置。

API Key 只应粘贴到 AgentPlay 的模型接入界面。不要把 Key 发到 Issue、Discussion、日志或截图中。

## 4. 常见工作流

### 下载视频

粘贴链接后选择“仅下载”。任务卡应显示真实下载进度，完成后给出本地文件入口；不会自动进入拉片流程。

### 下载并拉片

选择“下载并拉片”。下载完成后，拉片作为独立的可恢复任务继续执行。报告应分为“视频讲了什么”和“专业视听拆解与 AI 复刻”两部分。

### 字幕翻译

打开视频后选择翻译字幕。原字幕为英文时默认显示中文；原字幕为中文时默认显示英文。翻译字幕只显示目标语言，位置可在播放器内调整。

### 文档处理

选择、粘贴或拖入文档后先预览，再在同一输入框描述结果，例如“整理成 Word”“提取表格”“把这两份合同做差异说明”。涉及云端改写、总结或生成时，AgentPlay 会在发送内容前请求授权。

## 5. 任务、日志与反馈

长任务会写入主进程持久检查点。应用关闭、崩溃或重启后，可恢复任务应从检查点继续；无法自动恢复时必须说明失败原因和可采取的下一步。

Windows 日志通常位于：

```text
%APPDATA%\ai-player\logs\
```

提交反馈前请删除 API Key、Cookie、本地绝对路径、文件正文和个人信息：

- 使用问题与排障：[GitHub Discussions](https://github.com/wg5759/AgentPlay/discussions/categories/q-a)
- 可复现缺陷：[Bug 报告](https://github.com/wg5759/AgentPlay/issues/new?template=bug_report.yml)
- 功能想法：[Ideas](https://github.com/wg5759/AgentPlay/discussions/categories/ideas)
- 安全漏洞：[私密报告](https://github.com/wg5759/AgentPlay/security/advisories/new)

更多边界见 [支持说明](../SUPPORT.md)、[隐私说明](../PRIVACY.md) 与 [多平台状态](../MULTIPLATFORM.md)。
