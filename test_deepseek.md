# AI播放器 代码测试报告（DeepSeek V4 Pro）

> 审查范围：`electron/*.js` (18文件) + `src/**/*.tsx` (14文件) + 配置文件  
> 方法：逐文件阅读 + 逐逻辑验证 + 边界条件 + 安全漏洞 + 功能完整性  
> 日期：2026-07-16

---

## 一、审查结论摘要

| 等级 | 数量 | 说明 |
|------|------|------|
| **P0 致命** | 7 | 阻断运行/安全漏洞/数据泄露（必须修） |
| **P1 严重** | 11 | 功能缺陷/边界崩溃/性能隐患（尽快修） |
| **P2 建议** | 9 | 代码质量/健壮性/架构优化（可延后） |

---

## 二、P0 致命问题（7个）

### P0-1: DLNA Server 无路径校验 —— 任意文件读取漏洞
**文件**: `electron/dlna-server.js:50-55`

**问题**: 文件服务器直接使用 `decodeURIComponent(req.url.slice(1))` 作为文件路径，无任何校验。攻击者可通过 HTTP 请求读取本机任意文件（含系统文件），例如：
```
http://localhost:18904/C:/Windows/System32/drivers/etc/hosts
http://localhost:18904/../../../etc/passwd
```

**修复**:
```js
// 在 handle 方法中，用 path.resolve 规范化后校验必须在 sharedDir 子目录内
const resolved = path.resolve(filePath)
if (!resolved.startsWith(path.resolve(this.sharedDir))) {
  res.writeHead(403); res.end('forbidden'); return
}
```

---

### P0-2: WiFi 传文件 —— PIN 校验在文件上传之后
**文件**: `electron/wifi-transfer.js:53-73`

**问题**: `formidable.parse()` 在 `form.parse(req, callback)` 中完成整个文件上传解析后才检查 PIN。攻击者无需知道 PIN 即可上传任意大小文件（最多 1GB），耗尽磁盘空间和带宽。

**修复**: 在 `formidable` 的 `on('field', ...)` 事件中提前校验 PIN，或者使用 HTTP 中间件在请求体解析前检查 `pin` 查询参数/header。

---

### P0-3: print-file.js —— Electron 无沙箱窗口加载任意文件
**文件**: `electron/print-file.js:8-9`

**问题**: `win.loadFile(filePath)` 直接加载用户传入的 PDF 路径。若 PDF 含恶意 JS（在 Electron 环境中可执行），则获得主进程级权限。图片路径虽做了 HTML 实体转义，但 `file://` scheme 本身可绕过路径限制加载任意本地文件。

**修复**:
```js
// 1. 校验 filePath 在允许目录内
// 2. 为打印窗口设置 sandbox: true + contextIsolation: true
// 3. PDF 打印改用 webContents.print() 的 pageSize 参数，避免 loadFile
const win = new BrowserWindow({ 
  show: false, 
  sandbox: true,
  webPreferences: { contextIsolation: true, nodeIntegration: false }
})
```

---

### P0-4: llm-service.js —— 用户传入 API Key 但 base URL 不变
**文件**: `electron/llm-service.js:143-166`

**问题**: `chat(messages, apiKey)` 接受用户传入的 `apiKey` 参数，但 `this.apiBase` 在构造函数中已根据环境变量固化。若用户配置了 Ollama（环境变量），但传入 DeepSeek Key，请求仍发往 `http://localhost:11434/v1`，导致 API Key 泄露到本地 Ollama 服务。

**修复**:
```js
async chat(messages, apiKey = null) {
  const key = apiKey || this.apiKey
  // 若用户传入了 key，且不同于构造函数中的 key，则应推断正确的 base URL
  let base = this.apiBase
  if (apiKey && apiKey !== this.apiKey) {
    // 若 key 以 sk- 开头，默认为 DeepSeek
    if (apiKey.startsWith('sk-')) base = 'https://api.deepseek.com/v1'
    // 若 key 很长（火山方舟），则用火山方舟
    else if (apiKey.length > 50) base = 'https://ark.cn-beijing.volces.com/api/v3'
  }
  // ...
}
```

---

### P0-5: sync-service.js —— 无认证、无加密，局域网任意读写
**文件**: `electron/sync-service.js:28-50`

**问题**: HTTP 服务（端口 18902）完全无认证。局域网内任意设备可：
- **GET** `/progress` → 读取本机所有播放进度（含文件名、时间戳）  
- **POST** `/progress` → 写入/覆盖播放进度数据

**修复**:
1. 添加共享密钥（在 UI 中显示，对端输入后验证）
2. 请求头添加 `Authorization: Bearer <shared_secret>` 校验
3. 或使用简单的 HMAC 签名防止伪造

---

### P0-6: cast-service.js —— 路径穿越 + Windows 大小写不敏感绕过
**文件**: `electron/cast-service.js:79-83`

**问题**: 路径校验使用 `startsWith`，在 Windows 上大小写敏感。例如 `allowedRoots` 含 `C:\Videos`，但 `path.resolve('c:\\videos\\..\\..\\Windows\\test')` 因大小写不匹配而绕过检查。此外 `resolved === d` 的精确匹配几乎不会命中，主要靠 `startsWith`。

**修复**:
```js
const resolved = path.resolve(filePath)
const normalized = resolved.toLowerCase()
if (!allowedRoots.some(d => normalized.startsWith(d.toLowerCase() + path.sep) || normalized === d.toLowerCase())) {
  res.writeHead(403); res.end('forbidden'); return
}
```

---

### P0-7: mpv-service.js —— IPC 连接竞态：start() 返回 true 但实际连接失败
**文件**: `electron/mpv-service.js:72-88`

**问题**: 连接重试循环（10次 × 500ms）后，若 IPC 仍失败，`start()` 仍返回 `true`（第88行）。调用方（`main.js:122`）无法感知连接失败，后续所有播放操作静默失效。

**修复**:
```js
// 返回值改为连接状态
return !!this.ipc && !this.ipc.destroyed
// 或 throw 让调用方感知
// 同时增加总超时时间（如 5s），适应慢速磁盘启动
```

---

## 三、P1 严重问题（11个）

### P1-1: Agent 工具执行断层 —— executeTool 不调用 mpv
**文件**: `electron/llm-service.js:122-140` + `src/stores/agentStore.ts:55-62`

**问题**: `executeTool()` 返回描述性结果但**不调用 `this.mpv` 的实际方法**。真正的 mpv 控制发生在 `agentStore.ts:58-61`，靠前端硬编码 switch-case 匹配 action 字符串。这导致：
- 前后端工具定义脱钩：改 `executeTool` 的 action 名会破坏前端逻辑
- 插件系统（`plugin-service.js`）无法复用 Agent 工具执行链
- `summarize_video` 工具返回占位但 agentStore 中没有对应处理

**修复**: `executeTool` 应直接调用 `this.mpv` 的方法，返回值只作为 UI 反馈。

---

### P1-2: llm-service.js fetch 无 try/catch —— 网络异常导致未捕获错误
**文件**: `electron/llm-service.js:158-166`

**问题**: `fetch()` 调用无外层 try/catch。若网络不可达（DNS 解析失败、连接拒绝），错误会向上传播到 `agentStore.ts:67` 的 catch 块，但 `resp.json()` 和 `resp.text()` 的异常也未单独捕获。

**修复**: 在 `chat()` 方法外层包裹 `try/catch`，统一返回 `{ text: '[网络错误] ' + err.message, toolResults }`。

---

### P1-3: 全屏状态不同步 —— store 与 DOM 脱节
**文件**: `src/components/PlayerControls.tsx:80-84` + `src/components/PlayerView.tsx:123-129`

**问题**: 两处全屏切换逻辑都使用 `document.fullscreenElement` 判断当前状态，但 store 中的 `isFullscreen` 状态是独立 toggled 的。用户按 Esc 退出全屏时，store 状态不变，导致按钮显示错误图标。

**修复**:
```js
// 监听 fullscreenchange 事件同步 store
useEffect(() => {
  const handler = () => usePlayerStore.setState({ 
    isFullscreen: !!document.fullscreenElement 
  })
  document.addEventListener('fullscreenchange', handler)
  return () => document.removeEventListener('fullscreenchange', handler)
}, [])
```

---

### P1-4: VoiceWake 无限重启循环 —— 无重试上限
**文件**: `src/components/VoiceWake.tsx:40-44`

**问题**: `onerror` 和 `onend` 都无条件调用 `rec.start()` 重启。若麦克风权限被拒绝，`onerror` 会触发 → 调用 `start()` 失败 → 再次触发 `onerror` → 无限循环，导致 CPU 飙升和浏览器控制台刷屏。

**修复**:
```js
let retries = 0
const MAX_RETRIES = 5
rec.onerror = () => {
  if (retries++ < MAX_RETRIES) {
    setTimeout(() => { try { rec.start() } catch {} }, 1000 * retries)
  }
}
rec.onend = () => {
  try { rec.start() } catch {}
}
```

---

### P1-5: AgentPanel API Key 输入区永久隐藏 —— 无法更换 Key
**文件**: `src/components/AgentPanel.tsx:41-64`

**问题**: API Key 配置区域仅在 `!apiKey` 时显示。保存后输入区消失，用户无法修改或更换 Key。只能通过清除 localStorage 或开发者工具手动操作。

**修复**: 添加"修改 API Key"按钮，或始终显示输入区并使用 `type="password"` 遮罩。

---

### P1-6: tmdb-service.js / subtitle-service.js —— fetch 无超时
**文件**: `electron/tmdb-service.js:8` + `electron/subtitle-service.js:4`

**问题**: 两个服务中的 `fetch()` 调用无 `AbortController` 超时控制。若 API 服务无响应，请求会挂起直到 Node.js 默认超时（通常 30s+），期间 IPC 调用阻塞。

**修复**: 使用 `AbortSignal.timeout(10000)` 或手动 `AbortController`，设置 10 秒超时。

---

### P1-7: media-service.js 去重算法过于简单
**文件**: `electron/media-service.js:59-71`

**问题**: `findDuplicates` 仅按 `size + name` 作为 key，未使用文件内容哈希。两个同名同大小的不同文件会被误判为重复。虽然对于视频文件此场景概率低，但缺乏文件哈希对比是功能缺陷。

**修复**: 可选方案：对相同 size+name 的文件，读取前 4096 字节做 MD5 或使用 `fs.statSync` 的 `mtime` 辅助判断。

---

### P1-8: 前端文件类型列表与后端不同步
**文件**: `src/components/PlayerView.tsx:9-13` vs `electron/file-service.js:4-14`

**问题**: 前端 `PlayerView.tsx` 硬编码了扩展名列表，与后端 `file-service.js` 中的列表不完全一致：
- 前端缺少：`.ts`（文本）、`.tsx`（文本）、`.env`、`.toml`、`.conf`、`.bat`、`.ps1`、`.m4v`、`.wmv`（视频）、`.wma`（音频）、`.ico`、`.tif`、`.tiff`（图片）
- 前端多出：无（但过滤逻辑不同）

**修复**: 抽取共享常量到 `shared/constants.ts` 或 `electron/constants.js`，前后端共同引用。

---

### P1-9: dlna-server.js 文件列表泄露完整路径
**文件**: `electron/dlna-server.js:67`

**问题**: `/list` 端点返回的文件 URL 包含完整本地路径（如 `C:\Users\xxx\Videos\movie.mp4`），暴露用户目录结构和用户名。

**修复**: 使用相对路径或仅返回文件名，实际的 `/file/{id}` 路由用内部映射表查找。

---

### P1-10: agentStore.ts 思考中消息清理的竞态问题
**文件**: `src/stores/agentStore.ts:39-50`

**问题**: 若用户连续快速发送两条消息，第二条的 `send()` 在第 50 行执行 `messages.filter(m => m.text !== '思考中…')` 时，会同时清除第一条遗留的"思考中…"消息和第二条刚添加的"思考中…"消息。虽然 craft 上不会造成严重问题，但消息列表会短暂丢失状态。

**修复**: 为每个请求生成唯一 ID，只清理对应 ID 的"思考中"消息。

---

### P1-11: wifi-transfer.js HTTP 无 CORS 头
**文件**: `electron/wifi-transfer.js:31-32`

**问题**: HTTP 服务器未设置 `Access-Control-Allow-Origin` 等 CORS 头。虽然上传页面是服务端渲染的 HTML，但若前端通过 `fetch` 调用上传接口，会被浏览器拦截。

**修复**: 添加适当的 CORS 头（或保持现状，因为上传页面是服务端渲染的单一页面）。

---

## 四、P2 建议问题（9个）

### P2-1: llm-service.js TOOLS 缩进混乱
**文件**: `electron/llm-service.js:67-88`

**问题**: `print_file` 和 `load_subtitle` 的缩进不一致（第 81 行多 2 空格），`load_subtitle` 的 `function` 对象闭合括号缩进异常。虽不导致语法错误，但影响可读性。

**修复**: 统一缩进，使 `load_subtitle` 与其他工具格式一致。

---

### P2-2: print-file.js 文本打印 —— 路径无校验
**文件**: `electron/main.js:187-197`

**问题**: `print:text` handler 用 `readFileSync` 读取任意文件路径，若文件过大（仅截取前 50000 字符），但无路径校验。攻击者可读取任意文本文件。

**修复**: 校验文件路径在允许的目录内，或限制文件大小。

---

### P2-3: PlayerView 拖放字幕路径 —— TypeScript 类型断言不安全
**文件**: `src/components/PlayerView.tsx:82`

**问题**: `(file as File & { path: string }).path` 使用了不安全的类型断言。Electron 的 `File` 对象确实有 `path` 属性，但 TypeScript 标准库中 `File` 接口不含此属性。这在非 Electron 环境中会静默失败（`path` 为 `undefined`）。

**修复**: 在 `global.d.ts` 中声明 `ElectronFile` 接口，使用运行时检查 `'path' in file`。

---

### P2-4: PlayerView 双击全屏逻辑 —— 非媒体文件不退出全屏
**文件**: `src/components/PlayerView.tsx:123-129`

**问题**: 双击非媒体文件（office/other）时直接 return，不处理全屏。但如果用户正在全屏模式下查看 Office 文档，双击无法退出全屏，只能按 Esc 或按键退出。

**修复**: 对所有文件类型都提供退出全屏的能力。

---

### P2-5: MediaLibrary PRINTABLE 数组定义在组件内
**文件**: `src/components/MediaLibrary.tsx:134`

**问题**: `PRINTABLE` 常量定义在组件函数体内，每次渲染都重新创建数组。应移到组件外部或使用 `useMemo`。

**修复**: 移到 `export default` 之前定义为模块级常量。

---

### P2-6: Recorder 组件无错误处理状态
**文件**: `src/components/Recorder.tsx:8-32`

**问题**: `start()` 函数在 `getDisplayMedia` 失败时只 `console.error`，无 UI 反馈。用户点击"录制"后无反应，不知道是否成功。

**修复**: 添加错误状态 state，在 UI 中显示错误信息或 toast。

---

### P2-7: main.js 菜单中硬编码文件扩展名
**文件**: `electron/main.js:105, 218`

**问题**: 菜单和 dialog handler 中硬编码了视频/音频扩展名列表，与 `file-service.js` 中的 `ALL_EXTS` 独立维护。新增格式时需同步修改多处。

**修复**: 导入 `file-service.js` 中的常量，或抽取到 `constants.js`。

---

### P2-8: plugin-service.js —— 插件加载无沙箱隔离
**文件**: `electron/plugin-service.js:17`

**问题**: `require(path.join(PLUGIN_DIR, file))` 直接 require 用户安装的 JS 文件，插件代码在 Node.js 主进程上下文中运行，具有完全系统权限。恶意插件可读取任意文件、执行系统命令。

**修复**: 使用 `vm2` 或 Node.js `vm` 模块沙箱隔离，限制插件可访问的 API。

---

### P2-9: 缺少 `requestSingleInstanceLock`
**文件**: `electron/main.js`

**问题**: Electron 主进程未调用 `app.requestSingleInstanceLock()`。多实例启动可能导致端口冲突（18900-18904 五个端口）和 mpv 二进制文件锁冲突。

**修复**:
```js
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) { app.quit(); return }
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})
```

---

## 五、功能完整性检查

| 功能 | 状态 | 备注 |
|------|------|------|
| 视频/音频播放 | ✅ | mpv 内核 + HTML5 降级 |
| 图片查看 | ✅ | img 标签 |
| PDF 阅读 | ✅ | iframe 嵌入 |
| 文本文件查看 | ✅ | iframe 嵌入 |
| Office 预览 | ⚠️ | 仅 DOCX/XLSX，PPT/PPTX 不支持 |
| 媒体库扫描 | ✅ | 递归扫描，6 大类 |
| 标签过滤 | ✅ | 文件名关键词提取 |
| 去重建议 | ⚠️ | 算法过于简单（P1-7） |
| 粗剪建议 | ✅ | 按标签聚类 |
| Agent 对话 | ⚠️ | 工具执行断层（P1-1） |
| 语音唤醒 | ⚠️ | 无重试上限（P1-4） |
| 屏幕录制 | ✅ | getDisplayMedia + MediaRecorder |
| WiFi 传文件 | ⚠️ | PIN 校验在文件后（P0-2） |
| 投屏 | ⚠️ | 路径穿越（P0-6） |
| 跨设备同步 | ⚠️ | 无认证（P0-5） |
| DLNA Server | ⚠️ | 无路径校验（P0-1） |
| DLNA Receiver | ✅ | 基础功能正常 |
| 打印 | ⚠️ | 无窗口沙箱（P0-3） |
| 插件系统 | ⚠️ | 无沙箱隔离（P2-8） |
| TMDB 海报 | ✅ | 基础功能正常 |
| 字幕搜索 | ✅ | OpenSubtitles API |
| mpv 窗口嵌入 | ✅ | --wid 机制 |
| 错误边界 | ✅ | ErrorBoundary 包裹 |
| 多实例锁 | ❌ | 缺失（P2-9） |
| 状态持久化 | ✅ | zustand persist（音量+字幕） |
| 响应式布局 | ✅ | TailwindCSS 网格 |

---

## 六、修复优先级建议

```
第1轮（本周）: P0-1 ~ P0-7（7 个致命问题）
第2轮（下周）: P1-1 ~ P1-11（11 个严重问题）
第3轮（下月）: P2-1 ~ P2-9（9 个优化建议）
```

---

## 附录：llm-service.js TOOLS 语法验证

经逐行括号匹配验证，`electron/llm-service.js:5-89` 的 TOOLS 数组语法**合法**。`print_file` 对象（第 57-68 行）的 `function` 对象在第 67 行正确闭合，`load_subtitle`（第 77-88 行）的括号也正确匹配。之前审核报告中的"TOOLS 语法错误"判定可能是误报（缩进异常但语法正确）。

但 `load_subtitle` 对象（第 79-88 行）的 `function` 属性缩进为 4 空格而非 6 空格，与其他工具不一致，建议统一格式（P2-1）。