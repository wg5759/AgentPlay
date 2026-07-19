# AI播放器 项目索引

> 一句话：给极客家庭和内容创作者的 AI 媒体中枢 -- Agent 替你操作媒体（播、投、印、理），桌面+Web 双端。

## 目录结构

```
ai-player/
├── electron/           主进程 + 服务层
│   ├── main.js         主进程（mpv+Agent+files+print+wifi+cast+sync+tmdb IPC）
│   ├── preload.js      桌面 API 桥接（contextIsolation）
│   ├── mpv-service.js  mpv sidecar（命名管道 IPC 双向+事件）
│   ├── llm-service.js  Agent 引擎（OpenAI/Anthropic/Gemini 协议 + 工具调用）
│   ├── model-providers.js 主流厂商、动态模型列表与协议配置
│   ├── model-config-store.js Windows 系统加密的模型配置存储
│   ├── local-model-discovery.js Ollama/LM Studio/vLLM/llama.cpp/Fara 本机只读发现
│   ├── analysis-studio-service.js 拉片证据、字幕解析与基础重构
│   ├── creative-studio-service.js 多模态方案、新镜头/配音/字幕/音乐与创意渲染
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
├── resources/bin/win/        mpv 0.41.0 播放内核 + SAPI 配音辅助程序
└── package.json        依赖 + 双端 scripts
```

## 关键文档

| 文档 | 用途 |
|---|---|
| `../AI播放器实施方案.md` | 执行依据（全功能+架构+路线+任务勾选） |
| `../AI播放器产品规划.md` | 初稿（产品规划） |
| `../AI播放器最终方案.md` | 五模互审定稿（含分歧裁决） |

## 当前状态

- **Windows 0.6.0 当前交付版**：完整状态与外部条件见 `MULTIPLATFORM.md` 和 `../../../方案文档/AI播放器完工方案.md`。
- 验证：50 项产品回归 + TypeScript + ESLint + Web/PWA 构建 + 双 Electron/NSIS 安装包 + 正式 EXE 打开视频和创作工作台 + 包内 mpv/SAPI 真实生成 H.264/AAC 成片。
- 画面规则：每次打开新媒体都回到“完整显示”；HTML5 与 mpv 都保留完整宽高比。裁剪铺满改成明确的可选模式并提示可能隐藏边缘。
- 桌面播放：常见编码使用 HTML5 内嵌，特殊编码回退独立 mpv 兼容窗口；Web 端为浏览器能力子集。
- Agent：无 Key 可执行基础播放控制；模型中心覆盖官方、聚合、本地和自定义服务，支持动态读取账户模型；Ollama、LM Studio、vLLM、llama.cpp、Colibri/Fara 可作为外部本机服务。
- AI 创作：关键帧 + 字幕 + 人工拉片进入多模态模型；支持结构化原创方案、AI 图像新镜头、系统/云配音、三种字幕包装、授权音乐自动压低和最终 MP4。所选型号不接受图片时会明确回退文本证据，不伪称视觉分析。
- 仍未完整交付：macOS/Linux/Android/iOS 的高级渲染闭包与实机端到端验收；详见 `MULTIPLATFORM.md`。

## 运行

```bash
cd "D:\Ai工具升级\项目源码（开发者用）\ai-player"
$env:DEEPSEEK_API_KEY="key"   # 可选；也可在“功能 -> 模型接入中心”配置
$env:TMDB_API_KEY="key"        # 海报（可选）
pnpm dev:electron              # 桌面端
pnpm dev:web                   # Web 端
```
