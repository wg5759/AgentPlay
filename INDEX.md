# AI播放器 项目索引

> 一句话：给极客家庭和内容创作者的 AI 媒体中枢 -- Agent 替你操作媒体（播、投、印、理），桌面+Web 双端。

## 目录结构

```
ai-player/
├── electron/           主进程 + 服务层
│   ├── main.js         主进程（mpv+Agent+files+print+wifi+cast+sync+tmdb IPC）
│   ├── preload.js      桌面 API 桥接（contextIsolation）
│   ├── mpv-service.js  mpv sidecar（命名管道 IPC 双向+事件）
│   ├── llm-service.js  Agent 引擎（云端 LLM + 7 工具 function calling）
│   ├── file-service.js 媒体库扫描（视频/图片/PDF）
│   ├── print-file.js   打印（Electron print）
│   ├── wifi-transfer.js WiFi 传文件（HTTP 服务器 + formidable）
│   ├── cast-service.js 投屏（SSDP 发现 + UPnP 推送 + 文件服务器）
│   ├── sync-service.js 跨设备同步（HTTP 服务端+客户端）
│   └── tmdb-service.js TMDB 海报刮削
├── src/                React 前端（共享）
│   ├── components/     PlayerView/PlayerControls/AgentPanel/MediaLibrary/VoiceWake
│   ├── stores/         playerStore + agentStore（Zustand）
│   └── types/          device + global 声明
├── resources/bin/win/mpv.exe  mpv 0.41.0 播放内核
└── package.json        依赖 + 双端 scripts
```

## 关键文档

| 文档 | 用途 |
|---|---|
| `../AI播放器实施方案.md` | 执行依据（全功能+架构+路线+任务勾选） |
| `../AI播放器产品规划.md` | 初稿（产品规划） |
| `../AI播放器最终方案.md` | 五模互审定稿（含分歧裁决） |

## 当前状态

- **P0 MVP（7/7）+ V1（7/7）= 14 项功能完成**
- 验证：tsc 零错误 + vite build 通过
- 双端：Electron 桌面（mpv 全功能）+ Web PWA（HTML5 video）
- Agent 工具集（7个）：暂停/继续/跳转/音量/字幕/打印/加载字幕
- 已完成：mpv 窗口嵌入（--wid HWND 真嵌入，mpv 嵌入容器 child 窗口，MainWindowHandle=0 验证通过；控制条留白可点击 + 键盘快捷键）
- 待优化：局域网服务认证、本地 LLM

## 运行

```bash
cd D:\Ai工具升级\ai-player
$env:DEEPSEEK_API_KEY="key"   # Agent
$env:TMDB_API_KEY="key"        # 海报（可选）
pnpm dev:electron              # 桌面端
pnpm dev:web                   # Web 端
```
