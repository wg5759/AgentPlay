# AgentPlay 快速上手

[English](QUICK_START.en.md)

## 1. 下载当前公开预览版

当前测试入口是 [0.9.1 Preview 3](https://github.com/wg5759/AgentPlay/releases/tag/v0.9.1-preview.3)。它尚未取得 Authenticode 签名（NotSigned），适合愿意核对文件来源和SHA-256的测试者。历史稳定版标签0.7.6也未签名，只作历史与回滚入口，不是本指南推荐的测试版本。

从同一个官方发布页选择一个包即可：

- **普通安装**：AgentPlay-0.9.1-Windows-x64-Standard.exe，适合希望有开始菜单入口的用户。
- **免安装体验**：AgentPlay-0.9.1-Windows-x64-Portable.zip，完整解压后运行AgentPlay.exe，不要直接在压缩包里启动。

同时下载该页的AgentPlay-0.9.1-SHA256SUMS.txt，核对对应文件这一行的哈希：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\AgentPlay-0.9.1-Windows-x64-Standard.exe'
```

只有来源与哈希均正确才继续。Windows可能显示“未知发布者”；校验不能消除SmartScreen，不要关闭系统保护或运行来源不明的远程脚本。

## 2. 三分钟首次任务：本地播放，不用云模型

这是一个小任务流程，不是性能承诺；不包含下载、安装或首次兼容准备时间。

1. 准备一段自己已有、可正常播放的短视频，打开AgentPlay后把它拖进去。
2. 确认视频仍按原比例显示；有音轨的文件应有声音，无声素材则只检查画面。
3. 按空格暂停和继续，拖动进度条。若主动进入全屏，按ESC退出，再确认仍能播放。
4. 在播放记录里找到原视频。到这里才算完成首次验证，不以“正在处理”或亮起进度点作为完成。

这个任务不需要API Key，也不需要先下载大语言模型。部分格式仍需要网络获取解码组件或准备本地缓存；等待期间原文件不会被替换。若黑屏、比例不对、无法退出或组件报错，停在这里反馈，不要反复提交同一任务。

公开Preview 3与未发布候选必须区分：首启组件及后续窗口/字幕加固正在[PR #44](https://github.com/wg5759/AgentPlay/pull/44)中；只有新版本正式出现在Releases后才按该发布页更新，不把源码分支或候选包当成已公开的Preview 4。

## 3. 需要AI时再连接模型

- **智能选择**：从已连接且获授权的模型中选择，不会凭空提供云端额度。
- **只在本机**：使用可选本地组件，效果与速度受本机硬件影响。
- **优先效果**：使用已接入的云端模型，上云前按任务确认。

API Key只粘贴到应用的模型连接表单，不发到聊天、Issue、截图或日志。安装AgentPlay不自动赠送云模型额度。

基础播放成功后，再试粘贴链接并选“仅下载”；想要报告则选“下载并拉片”。拉片分内容精华与专业视听/AI复刻两部分，不是恢复原作者的原始提示词。字幕翻译和文档总结在模型连接后再测试。

## 4. 卡住时怎样反馈

提供版本、Windows版本、想完成的动作、文件扩展名/编码（若知道）、停在哪一步及脱敏截图；无需发送原视频或文档。

日志通常在%APPDATA%\ai-player\logs\。发送前删去Key、Cookie、账号、私人路径与文件正文。

- [Bug报告](https://github.com/wg5759/AgentPlay/issues/new?template=bug_report.yml)
- [使用问答](https://github.com/wg5759/AgentPlay/discussions/categories/q-a)
- [私密安全报告](https://github.com/wg5759/AgentPlay/security/advisories/new)

更多说明：[支持](../SUPPORT.md)、[隐私](../PRIVACY.md)、[平台边界](../MULTIPLATFORM.md)。
