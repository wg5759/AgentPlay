# AI播放器 代码审核报告

**审核对象**: git commit `75a843f` (MVP P0+V1 14 features)  
**审核范围**: `electron/` 下全部 `.js` + `src/` 下全部 `.tsx/.ts`  
**审核模型**: DeepSeek V4 Pro (补 Fable5 深度推理位)  
**审核日期**: 2026-07-15

---

## 一、项目概览与 14 项功能映射

| # | 功能 | 实现文件 | 状态 |
|---|------|---------|------|
| 1 | mpv 播放内核 | `electron/mpv-service.js` | 基本实现 |
| 2 | 媒体库本地扫描 | `electron/file-service.js` | 实现 |
| 3 | WiFi 局域网传文件 | `electron/wifi-transfer.js` | 实现 |
| 4 | DLNA/UPnP 投屏 | `electron/cast-service.js` | 实现 |
| 5 | 跨设备播放进度同步 | `electron/sync-service.js` | 实现 |
| 6 | AI Agent 对话+function calling | `electron/llm-service.js` | 实现（有致命缺陷） |
| 7 | TMDB 元数据刮削 | `electron/tmdb-service.js` | 实现 |
| 8 | 图片/PDF 打印 | `electron/print-file.js` | 实现 |
| 9 | 播放器控制条 UI | `src/components/PlayerControls.tsx` | 实现 |
| 10 | 媒体库 UI | `src/components/MediaLibrary.tsx` | 实现 |
| 11 | Agent 对话面板 | `src/components/AgentPanel.tsx` | 实现 |
| 12 | 语音唤醒（热词） | `src/components/VoiceWake.tsx` | **占位未实现** |
| 13 | 播放视图（双端适配） | `src/components/PlayerView.tsx` | 实现 |
| 14 | 网络源管理 | `src/components/MediaLibrary.tsx` | 实现 |

---

## 二、P0 致命缺陷（必须立即修复）

### P0-1: TOOLS 数组结构错误 —— `load_subtitle` 工具定义嵌套在 `print_file` 对象内部

**文件**: `electron/llm-service.js:57-80`  
**问题**: `print_file` 工具对象在第 67 行 `},` 后未闭合并新建数组元素，导致 `load_subtitle` 的完整定义 `{ type: 'function', function: {...} }` 被当作 `print_file` 对象的额外属性塞入，而非 TOOLS 数组的第 7 个元素。后果：
- `load_subtitle` 工具对 LLM 不可见，用户无法通过 Agent 加载字幕
- TOOLS 序列化后的 JSON 结构包含垃圾属性，可能被 API 拒绝或产生不可预测行为

**修复**:
```js
// 将第 67 行的 }, 改为 }, 并在其后闭合 print_file 对象，load_subtitle 独立为数组元素
    },    // 闭合 function 属性
  },      // ← 新增：闭合 print_file 的整个对象
  {       // ← 独立的新数组元素
    type: 'function',
    function: {
      name: 'load_subtitle',
      ...
    }
  }
```

---

### P0-2: `print-file.js` 图片路径注入 —— XSS + 任意文件读取

**文件**: `electron/print-file.js:11-12`  
**问题**: 用户提供的 `filePath` 直接拼接到 HTML 字符串中，没有任何转义：
```js
const html = '<img src="file://' + filePath + '" style="max-width:100%">'
```
- 若 `filePath` 包含 `"` 字符，可闭合 `src` 属性注入任意 HTML/JS
- `file://` 协议可读取本地任意文件（通过 `../` 路径穿越）
- 这个函数通过 Agent 的 `print_file` 工具暴露给 LLM，且 LLM 可被用户自然语言操控

**修复**:
```js
// 1. 校验路径是否在允许的目录内
// 2. 对 filePath 做 HTML 实体转义
const escaped = filePath.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const html = `<img src="file://${escaped}" style="max-width:100%">`
```

---

### P0-3: `cast-service.js` 文件服务器路径穿越 + 校验与使用不一致

**文件**: `electron/cast-service.js:79-105`  
**问题**: 存在两个独立的安全缺陷：

**(a) 校验路径与使用路径不一致 (行 79 vs 94)**:
```js
const filePath = decodeURIComponent(req.url.slice(1))   // 攻击者控制的原始路径
const resolved = path.resolve(filePath)                   // 解析后的路径（用于校验）
// ...
if (!allowedRoots.some(...)) { ... }                     // 校验的是 resolved
if (fs.existsSync(filePath)) {                           // ⚠️ 使用的是原始 filePath！
  fs.createReadStream(filePath).pipe(res)                // ⚠️ 攻击者绕过校验
```
攻击者构造 `http://host:18901/..%2f..%2f..%2fWindows%2fwin.ini`，`path.resolve` 解析后落入 `C:\Windows`，但若 `allowedRoots` 不包含 `C:\Windows`，校验通过的是另一个路径，而实际读取的是 `filePath`。

**(b) `startsWith` 校验在 Windows 上不可靠 (行 88)**:
```js
allowedRoots.some((d) => resolved === d || resolved.startsWith(d + path.sep))
```
Windows 路径不区分大小写，`C:\videos` 和 `c:\Videos` 是同一路径但 `startsWith` 不匹配。此外 `path.sep` 是 `\`，但攻击者可能使用 `/` 或 UNC 路径绕过。

**修复**:
```js
// 1. 统一使用 resolved 路径做所有操作
// 2. 使用 path.relative 检查是否在允许目录内
const resolved = path.resolve(filePath)
const allowed = allowedRoots.some((d) => {
  const rel = path.relative(d, resolved)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
})
if (!allowed) { res.writeHead(403); return }
if (fs.existsSync(resolved)) {
  fs.createReadStream(resolved).pipe(res)
}
```

---

### P0-4: `sync-service.js` HTTP 服务无任何认证 —— LAN 内任意读写

**文件**: `electron/sync-service.js:24-57`  
**问题**: Sync 服务在 `0.0.0.0:18902` 启动 HTTP 服务器，无任何认证机制。同一局域网内任何设备可以：
- GET `/progress` — 读取所有播放进度数据（隐私泄露）
- POST `/progress` — 篡改播放进度（数据投毒）

**修复**:
```js
// 至少加入简单 token 校验
constructor() {
  this.token = crypto.randomUUID()
  // ...
}
handle(req, res) {
  if (req.headers['x-sync-token'] !== this.token) {
    res.writeHead(401); res.end(); return
  }
  // ...
}
```

---

### P0-5: `mpv-service.js` 硬编码 800ms 等待 —— IPC 连接竞态条件

**文件**: `electron/mpv-service.js:60-61`  
**问题**:
```js
await new Promise((r) => setTimeout(r, 800))
this.connectIpc()
```
mpv 子进程启动后固定等待 800ms 再连接 IPC。若系统负载高或磁盘慢导致 mpv 启动超过 800ms，`connectIpc()` 将连接失败，且**失败被静默吞掉**（行 79 仅 `console.error`），后续所有播放指令全部无效但不会有任何用户可见的错误提示。

**修复**:
```js
// 轮询 IPC socket 就绪，或监听 mpv 子进程 stdout 输出就绪信号
// 方案：mpv 启动时加 --msg-level=ipc=v，监听 stdout 中 "IPC listening" 后再连接
// 或：retry connect 最多 N 次，每次间隔 200ms
```

---

### P0-6: `agentStore.ts` 过滤逻辑操作不存在的消息

**文件**: `src/stores/agentStore.ts:39-41`  
**问题**:
```js
const history = get()
  .messages.filter((m) => m.text !== '思考中…')
  .map(...)
```
代码过滤掉 `text === '思考中…'` 的消息，但 `addMessage` 从未以 `'思考中…'` 为参数调用。这意味着：
- 该过滤条件永远不会命中（死代码）
- 但设计意图显然是在 `thinking` 状态下先添加一条占位消息再等待 LLM 回复，然后过滤掉它。实际流程中缺少这一步，导致 Agent 在等待 LLM 回复期间 UI 无任何反馈

**修复**: 在 `send()` 中 `addMessage('agent', '思考中…')` 后再发请求，或在 UI 层根据 `thinking` 状态显示加载指示器。

---

## 三、P1 严重问题（应在下一版修复）

### P1-1: `cast-service.js` UDP 扫描无错误处理

**文件**: `electron/cast-service.js:24-52`  
**问题**: `socket.bind()` 不带端口参数（随机端口），但未处理绑定失败的情况。`socket.on('error')` 未注册，若 UDP 端口被占用或权限不足，Promise 永不 resolve，导致 UI 永久卡在"扫描中"。

**修复**: 添加 `socket.on('error', reject)` 和超时兜底。

---

### P1-2: `file-service.js` 递归扫描无深度限制 + 无符号链接循环检测

**文件**: `electron/file-service.js:22`  
**问题**: `scanDir` 递归调用自身无深度限制。若目录结构包含符号链接循环（如 `a -> b -> a`），将导致无限递归直至栈溢出。

**修复**:
```js
function scanDir(dir, depth = 0, maxDepth = 20) {
  if (depth > maxDepth) return []
  // 或用 Set 记录已访问的 realpath
  // ...
}
```

---

### P1-3: `llm-service.js` `fetch` 无超时控制

**文件**: `electron/llm-service.js:148`  
**问题**: 对 LLM API 的 `fetch` 调用无 `AbortController` 超时。若网络不通或 API 挂起，前端将永久等待，`thinking` 状态无法解除，Agent 面板卡死。

**修复**:
```js
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 30000)
const resp = await fetch(url, { ..., signal: controller.signal })
clearTimeout(timer)
```

---

### P1-4: `llm-service.js` `JSON.parse` 无异常保护

**文件**: `electron/llm-service.js:171`  
**问题**: `JSON.parse(tc.function.arguments || '{}')` — 若 LLM 返回的 `arguments` 是非法 JSON 字符串（如 `{seconds: 30}` 缺少引号），`JSON.parse` 将抛出异常，整个 `chat` 函数崩溃，且错误未被 try-catch 包裹。

**修复**:
```js
let args = {}
try { args = JSON.parse(tc.function.arguments || '{}') } catch { /* 记录日志 */ }
```

---

### P1-5: `PlayerView.tsx` 拖拽文件 `.path` 属性无类型保护

**文件**: `src/components/PlayerView.tsx:107,112`  
**问题**: `(file as File & { path: string }).path` 使用类型断言强制读取 `path` 属性。在 Web 端（非 Electron），`File` 对象没有 `path` 属性，虽然外层有 `isDesktop` 判断保护，但类型断言本身不安全，且如果将来 `isDesktop` 判断逻辑变更，会在运行时静默拿到 `undefined`。

**修复**: 在 `global.d.ts` 中声明 Electron 扩展的 `File` 接口，或使用 `(file as any).path` 并做运行时检查 `if (typeof filePath !== 'string') return`。

---

### P1-6: `cast-service.js` 文件服务器端口固定，并发投屏冲突

**文件**: `electron/cast-service.js:107,115`  
**问题**: `startFileServer()` 在端口 18901 启动文件服务器，且 `if (this.fileServer) return` 防止重复启动。但若两个不同设备同时投屏，第二次调用 `cast()` 时，`startFileServer()` 已存在不会重新启动，但 `mediaUrl` 中的 `filePath` 是新的——这实际上是正确的，因为服务器按 URL 路径动态读取文件。但问题是：如果服务器启动失败（端口被占用），`this.fileServer` 仍为 `null`，每次 `cast()` 都会重复尝试启动。

**修复**: 添加 `error` 事件监听，标记启动失败状态。

---

### P1-7: `MediaLibrary.tsx` 两个 `useEffect([])` 无 cleanup

**文件**: `src/components/MediaLibrary.tsx:82-101`  
**问题**: 两个 `useEffect` 都依赖 `[]` 且发起异步操作。如果组件在异步操作完成前卸载（例如用户快速切换到播放视图），`setState` 会触发 React 警告 "Can't perform a React state update on an unmounted component"。

**修复**: 使用 `AbortController` 或 `let cancelled = false` 模式。

---

### P1-8: `wifi-transfer.js` 上传目录无大小限制

**文件**: `electron/wifi-transfer.js:53-56`  
**问题**: formidable 的 `maxFileSize` 未设置，默认为 200MB（formidable v3 默认）。但更重要的是，上传目录无容量检查，恶意用户可上传大量文件占满磁盘。

**修复**: 设置 `maxFileSize` 和 `maxTotalFileSize`。

---

### P1-9: `global.d.ts` 缩进不一致

**文件**: `src/types/global.d.ts:7-8`  
**问题**: `setVolume` 和 `loadSubtitle` 使用了 4 空格缩进，而其他方法使用 2 空格缩进。这不影响运行但表明代码未经过格式化工具检查。

**修复**: 统一缩进，建议配置 Prettier 或 ESLint。

---

### P1-10: `main.js` 未注册 `before-quit` 中 castService 和 syncService 的 stop

**文件**: `electron/main.js:105-108`  
**问题**: `before-quit` 事件中仅调用了 `mpv.stop()` 和 `wifiTransfer.stop()`，未调用 `castService.stop()` 和 `syncService.stop()`。虽然 `app.quit()` 会强制关闭进程，但 HTTP 服务器可能未正确释放端口，导致下次启动时端口冲突。

**修复**: 在 `before-quit` 中补全所有服务的 `stop()` 调用。

---

## 四、P2 建议（改进方向）

### P2-1: 语音唤醒功能完全未实现

**文件**: `src/components/VoiceWake.tsx:1-26`  
**问题**: 组件仅检查 `SpeechRecognition` 可用性并输出警告，核心热词检测逻辑（`TODO Phase 1`）未实现。14 项功能中第 12 项"语音唤醒"实际未交付。

**建议**: 若 Phase 1 未排期，应从功能列表中移除或标注为"占位"。

---

### P2-2: `toolRegistry.ts` 与 `device.ts` 类型定义未使用

**文件**: `src/agents/toolRegistry.ts`, `src/types/device.ts`  
**问题**: 这两个文件定义了完整的工具注册表和设备抽象接口，但代码中无任何 import 引用。属于提前设计但未接入的代码，增加了维护负担。

**建议**: 要么接入使用，要么移除。若为 Phase 1 预留，应添加明确的注释说明接入计划。

---

### P2-3: `llm-service.js` 模型选择逻辑

**文件**: `electron/llm-service.js:89-101`  
**问题**: 优先 DeepSeek (`deepseek-chat`)，其次火山方舟 (`doubao-seed-1-6-250615`)。但：
- `deepseek-chat` 的 function calling 能力有限（截至 2025 年初），应使用 `deepseek-chat` 的 function calling 模式确认参数
- `doubao-seed-1-6-250615` 模型名看起来很具体，可能是某一个特定版本，长期维护风险高（版本过期后 API 可能拒绝）
- 缺少环境变量 `LLM_MODEL` 允许用户自定义模型名

**建议**: 添加 `LLM_MODEL` 环境变量覆盖默认模型名。

---

### P2-4: 错误处理模式不一致

**问题**: 各文件错误处理风格不统一：
- `mpv-service.js`: 仅 `console.error`，调用方无感知
- `cast-service.js`: 返回 `{ success: false, error: String(e) }`
- `tmdb-service.js`: 静默返回 `null`
- `llm-service.js`: 返回 `{ text: '[API 错误]', toolResults }`

**建议**: 统一错误处理模式，建议使用 `{ success: boolean, data?: T, error?: string }` 结构。

---

### P2-5: `PlayerView.tsx` 桌面端 UI 为占位

**文件**: `src/components/PlayerView.tsx:128-135`  
**问题**: 桌面端显示"mpv 播放中（独立窗口）"占位文本，而非将 mpv 窗口嵌入 Electron。用户看到的是文本而非视频画面，体验割裂。

**建议**: 在 Phase 1 中通过 `BrowserWindow` 的 `parent` 选项或 `setParentWindow` API 将 mpv 窗口嵌入 Electron 渲染窗口。

---

### P2-6: `useEffect` 依赖数组不完整

**文件**: `src/components/PlayerView.tsx:55-70`  
**问题**: mpv 事件监听 `useEffect` 依赖数组为 `[]`，但内部使用了 `seek` 和 `setDuration`。虽然 zustand 的 selector 返回稳定引用，但 ESLint `react-hooks/exhaustive-deps` 规则会报警。

**建议**: 将 `seek` 和 `setDuration` 加入依赖数组，或使用 `usePlayerStore.getState()` 直接调用。

---

### P2-7: 缺少 TypeScript 严格模式检查

**文件**: `tsconfig.json:15-16`  
**问题**: `noUnusedLocals` 和 `noUnusedParameters` 均设为 `false`。启用后能发现 `VoiceWake.tsx` 中未使用的 `openPanel` 参数（第 10 行解构了但未使用）等潜在问题。

**建议**: 在代码清理后启用 `noUnusedLocals: true` 和 `noUnusedParameters: true`。

---

### P2-8: `mpv-service.js` 进程崩溃无自动重启

**文件**: `electron/mpv-service.js:58`  
**问题**: mpv 子进程退出时仅 `console.log`，无自动重启逻辑。若 mpv 崩溃，用户需手动重启整个应用。

**建议**: 添加 `respawning` 策略，在 `exit` 事件中重新调用 `start()`。

---

### P2-9: `cast-service.js` SOAP XML 硬编码字符串拼接

**文件**: `electron/cast-service.js:117-126`  
**问题**: SOAP 请求体通过字符串拼接构建，`mediaUrl` 直接注入 XML。若 `filePath` 包含 `&`、`<`、`>` 等 XML 特殊字符，会破坏 SOAP 结构。

**建议**: 使用 XML 转义或模板库（如 `xmlbuilder2`）。

---

### P2-10: 缺少 `index.html` 入口文件

**问题**: `vite.config.ts` 未配置 `root`，默认使用项目根目录。但项目根目录应存在 `index.html` 作为 Vite 入口。若该文件存在但不在审核范围，建议确认其内容正确性。

**建议**: 确认 `index.html` 存在且正确引用了 `/src/main.tsx`。

---

## 五、总结

| 等级 | 数量 | 关键项 |
|------|------|--------|
| P0 致命 | 6 | TOOLS 结构错误、路径穿越×2、无认证 sync、mpv 竞态、Agent 死代码 |
| P1 严重 | 10 | 无超时、无异常保护、类型安全、资源泄露、端口冲突 |
| P2 建议 | 10 | 占位未实现、死代码、代码风格、健壮性 |

**总体评价**: 架构设计合理，14 项功能中 13 项有实际实现，Electron 主进程模块拆分清晰，IPC 桥接通过 `contextBridge` 正确隔离。**但 P0 问题中存在影响功能正确性的结构缺陷（TOOLS 数组错误）和安全漏洞（路径穿越），必须在合入前修复。**

**14 项功能达成情况**: 12 项基本完成，1 项（语音唤醒）占位未实现，1 项（Agent load_subtitle 工具）因 TOOLS 数组结构错误而不可用。