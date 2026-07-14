# AI 播放器代码审核报告（commit 75a843f）

**审核模型**：Kimi K2.7  
**审核范围**：`electron/*.js`、`src/**/*.tsx`、`src/**/*.ts`  
**审核维度**：功能达成、代码质量、安全、规范  
**风险分级**：P0（阻断/崩溃/严重安全漏洞）> P1（显著缺陷/功能不可用/需加固）> P2（可维护性/代码债/小瑕疵）

---

## 执行摘要

当前 commit 处于 MVP 阶段，核心播放链路（mpv sidecar + React UI）已基本跑通，但存在 **1 个 P0 语法错误** 导致 Agent AI 功能完全不可用，另有多个 P1 级功能缺陷与安全漏洞需要立即修复。建议在合并/发布前优先处理 P0/P1 问题。

---

## P0 问题（必须立即修复）

### 1. `electron/llm-service.js:68` — TOOLS 数组结构语法错误
**问题**：`print_file` 与 `load_subtitle` 两个 function 对象嵌套错误，`load_subtitle` 被写在 `print_file` 对象内部，导致 Node 解析报错 `SyntaxError: Unexpected token '{'`。  
**影响**：`llm-service.js` 无法加载，`ai:chat` IPC 全部不可用，Agent 面板聊天功能 100% 崩溃。  
**修复**：将 `load_subtitle` 改为独立的数组元素，补全外层 `}`。

```js
// 修复后片段
  {
    type: 'function',
    function: {
      name: 'print_file',
      description: '打印图片或PDF文件',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string', description: '文件路径' } },
        required: ['file_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'load_subtitle',
      description: '加载字幕文件（srt/ass/vtt）',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string', description: '字幕文件路径' } },
        required: ['file_path']
      }
    }
  }
]
```

### 2. `electron/llm-service.js:171` — 工具参数 JSON.parse 无异常处理
**问题**：`const args = JSON.parse(tc.function.arguments || '{}')` 未 try-catch。LLM 偶发会返回不合规 JSON。  
**影响**：单条消息即可抛异常，整个 `chat()` 流程崩溃，且 `toolResults` 中已执行的工具结果全部丢失。  
**修复**：
```js
let args = {}
try {
  args = JSON.parse(tc.function.arguments || '{}')
} catch (e) {
  args = { error: '参数解析失败: ' + e.message }
}
```

---

## P1 问题（显著缺陷，建议本轮修复）

### 3. `electron/llm-service.js:163` — 未校验 LLM 响应结构
**问题**：直接访问 `data.choices[0].message`，未检查 `choices` 是否存在。  
**影响**：API 返回异常结构时直接抛错，用户体验为“发送无反应”或白屏。  
**修复**：
```js
const msg = data.choices?.[0]?.message
if (!msg) return { text: '[LLM 返回异常]', toolResults }
```

### 4. `electron/cast-service.js:79-93` — 文件服务器路径穿越漏洞
**问题**：`decodeURIComponent(req.url.slice(1))` 后直接 `path.resolve(filePath)`，再与 allowedRoots 比较。  
**影响**：攻击者可通过编码或构造相对路径绕过白名单，读取用户任意文件。  
**修复**：
```js
const filePath = decodeURIComponent(req.url.split('?')[0].slice(1))
const resolved = path.resolve(this.uploadDir, filePath)
if (!allowedRoots.some((d) => resolved.startsWith(d + path.sep))) {
  res.writeHead(403); return res.end()
}
```
并统一将 `uploadDir` 作为根目录，禁止绝对路径输入。

### 5. `electron/cast-service.js:117-126` — SOAP XML 注入
**问题**：`mediaUrl` 直接拼接到 XML 文本中，未做 XML 转义。  
**影响**：文件路径含 `&`、`"`、`'`、`<`、`>` 时会导致 SOAP 报文格式错误或被篡改。  
**修复**：使用转义函数：
```js
function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]))
}
`<CurrentURI>${escapeXml(mediaUrl)}</CurrentURI>`
```

### 6. `src/stores/playerStore.ts:37` + `src/components/PlayerControls.tsx:74-80` — 全屏按钮只是改状态
**问题**：`toggleFullscreen` 仅翻转布尔值，未调用 `document.documentElement.requestFullscreen()` / `exitFullscreen()`。  
**影响**：用户点击全屏按钮无任何实际效果。  
**修复**：在 store 或组件中调用实际 DOM API：
```ts
async toggleFullscreen() {
  if (!document.fullscreenElement) {
    await document.documentElement.requestFullscreen()
  } else {
    await document.exitFullscreen()
  }
}
```

### 7. `src/components/AgentPanel.tsx:21-28` + `src/stores/agentStore.ts:30` — 麦克风按钮未实现语音识别
**问题**：`toggleListening` 只切换布尔状态，没有调用 Web Speech API 或触发桌面语音识别。  
**影响**：核心卖点“语音唤醒 Agent”当前不可用。  
**修复**：在 store 中集成 `SpeechRecognition`（Web）或通过 IPC 调用桌面 faster-whisper 热词检测。

### 8. `src/stores/playerStore.ts:38` — 字幕开关未同步播放器
**问题**：`toggleSubtitle` 仅改本地状态，未向 mpv 发送 `sub-visibility` 命令，也未控制 HTMLVideoElement 字幕轨道。  
**影响**：按钮状态与实际字幕显示不一致。  
**修复**：在组件/store 中调用 `window.aiPlayer?.player?.send({ command: ['set_property', 'sub-visibility', !s.subtitleVisible] })` 或设置 video 字幕模式。

### 9. `electron/mpv-service.js:101` — `send()` 写 IPC 可能抛未捕获异常
**问题**：`this.ipc.write(JSON.stringify(cmd) + '\n')` 在连接断开时会抛错。  
**影响**：渲染进程操作播放器时主进程崩溃。  
**修复**：
```js
send(cmd) {
  if (!this.ipc || this.ipc.destroyed) return
  try {
    this.ipc.write(JSON.stringify(cmd) + '\n')
  } catch (e) {
    console.error('[MpvService] IPC 写入失败', e)
  }
}
```

### 10. `electron/llm-service.js:123-124` — `set_subtitle` 工具语义混乱
**问题**：工具描述为“开关字幕”，实际实现是设置 `sub-visibility` 属性，但未读取当前状态，且与 `load_subtitle` 功能边界不清。  
**影响**：LLM 调用后行为不可预期。  
**修复**：将 `set_subtitle` 改为明确参数 `visible: boolean`，并校验布尔值；另在 store/组件层同步状态。

### 11. `electron/cast-service.js:96-101` — 声明支持 Range 请求但未实现
**问题**：响应头写了 `Accept-Ranges: bytes`，但实际未处理 `Range` 请求。  
**影响**：DLNA 设备/浏览器Seek时可能失败或从头开始缓冲。  
**修复**：解析 `req.headers.range` 并使用 `fs.createReadStream(filePath, { start, end })` 返回 206。

### 12. `electron/wifi-transfer.js:57-65` — 上传文件未处理与反馈
**问题**：`form.parse` 的 `files` 参数被忽略，无论是否真正保存文件都返回“上传成功”。  
**影响**：用户无法确认文件是否写入，且无法看到文件名。  
**修复**：
```js
form.parse(req, (err, fields, files) => {
  if (err) { /* 500 */ }
  const saved = Object.values(files || {}).map(f => f.originalFilename || f.newFilename)
  res.end(`<p>上传成功：${saved.join(', ')}</p>`)
})
```

### 13. `electron/main.js:50-51` — mpv 启动失败未阻断后续流程
**问题**：`await mpv.start()` 返回 `false` 时未处理，后续仍然注册 IPC 并启动 Agent。  
**影响**：用户点击播放无反应，且错误信息只打印在控制台。  
**修复**：
```js
const ok = await mpv.start()
if (!ok) {
  dialog.showErrorBox('播放器初始化失败', '未找到 mpv 二进制文件')
}
```

### 14. `electron/print-file.js:11` — HTML 拼接存在注入/路径断裂风险
**问题**：`'file://' + filePath` 直接拼入 HTML，路径含中文或特殊字符时可能异常。  
**影响**：图片无法加载或 HTML 结构被破坏。  
**修复**：
```js
const html = `<img src="${filePath.replace(/"/g, '&quot;')}" style="max-width:100%">`
```
并优先使用 `encodeURI(filePath)`。

### 15. `src/components/PlayerView.tsx:115` — Web 端拖拽视频未释放 Object URL
**问题**：`URL.createObjectURL(file)` 创建后没有 `URL.revokeObjectURL` 清理。  
**影响**：反复拖拽大文件会导致内存泄漏。  
**修复**：在切换视频源或组件卸载时调用 `URL.revokeObjectURL(videoSrc)`。

### 16. `electron/cast-service.js:137` — 仅通过 HTTP status 判断投屏成功
**问题**：UPnP 设备常在 200 响应中返回 SOAP Fault。  
**影响**：投屏失败时仍提示“已投屏到 xxx”。  
**修复**：解析响应体，检查是否包含 `<errorCode>` 或 `<UPnPError>`。

---

## P2 问题（代码债与优化建议）

### 17. `electron/mpv-service.js:38-39` — IPC 管道名使用 Date.now() 可能冲突
**建议**：使用随机串或进程 PID，如 `\\.\pipe\mpv-${process.pid}-${randomBytes(4).toString('hex')}`。

### 18. `electron/mpv-service.js:60` — 硬编码 800ms 等待 IPC 启动
**建议**：改为轮询检测管道是否可连接，最多等待 3s。

### 19. `electron/mpv-service.js:64-68` — 未等 IPC 连接成功就发送 observe
**建议**：将 `observe_property` 命令放到 `ipc.on('connect')` 回调中。

### 20. `electron/mpv-service.js:74-80` — IPC 断开后无重连
**建议**：监听 `error`/`close` 后尝试重连或通知渲染进程。

### 21. `electron/file-service.js:6-9` — `VIDEO_EXTS` 包含音频格式
**建议**：拆分 `VIDEO_EXTS` 与 `AUDIO_EXTS`，避免媒体库把 MP3 显示为视频。

### 22. `electron/file-service.js:11-33` — 扫描无递归深度限制
**建议**：增加 `maxDepth` 参数，防止极深目录栈溢出。

### 23. `electron/main.js:55-61` — 多个服务启动缺少错误处理
**建议**：每个 `start()` 包 try-catch 并记录到日志。

### 24. `electron/main.js:105-107` — `before-quit` 未阻塞退出
**建议**：使用 `e.preventDefault()` + 异步清理完成后 `app.quit()`。

### 25. `electron/sync-service.js:24-26` — HTTP 监听无错误处理
**建议**：监听 `server.on('error', ...)`，避免端口占用时静默失败。

### 26. `electron/sync-service.js:33-57` — 进度同步无鉴权
**建议**：至少增加 Origin/IP 白名单或简单 token，防止局域网任意设备篡改进度。

### 27. `electron/sync-service.js:62,76` — `peerUrl` 未校验即 fetch
**建议**：校验 URL 协议为 `http/https` 并限制为内网地址。

### 28. `electron/cast-service.js:14-22`、`electron/sync-service.js:13-21`、`electron/wifi-transfer.js:38-46` — `getLanIp` 重复实现
**建议**：抽到公共工具模块 `electron/utils/network.js`。

### 29. `electron/cast-service.js:59-63` — 正则解析设备描述脆弱
**建议**：使用 XML 解析器或更严格的标签匹配。

### 30. `electron/cast-service.js:64-69` — `controlUrl` 假设为相对路径
**建议**：先判断 `ctrlMatch[1]` 是否为绝对 URL，再决定拼接方式。

### 31. `electron/tmdb-service.js:8` — fetch 无超时
**建议**：使用 `AbortController` 设置 10s 超时。

### 32. `electron/wifi-transfer.js:23-31` — HTTP 监听无错误处理
**建议**：同 #25。

### 33. `electron/wifi-transfer.js:10-11` — input 声明 multiple 但未处理多文件
**建议**：与 #12 一并处理，列出所有上传文件。

### 34. `electron/print-file.js:14-15` — print 未 await 且 2s 强制关闭
**建议**：使用 `webContents.on('did-finish-load')` + `print()` Promise。

### 35. `src/components/MediaLibrary.tsx:240` — 视频扩展名列表与 file-service 重复
**建议**：从后端扫描结果扩展名推导，或共享常量。

### 36. `src/components/MediaLibrary.tsx:188,226` — key 使用 URL/Path 可能重复
**建议**：使用 `url` + index 或确保路径唯一。

### 37. `src/components/PlayerView.tsx:29,35` — 可能触发重复 play/pause
**建议**：在 loadFile effect 中不主动 play，统一由 isPlaying effect 控制。

### 38. `src/types/global.d.ts:7-9` — 缩进不一致
**建议**：统一为 2 空格缩进。

### 39. `src/agents/toolRegistry.ts:8` — `parameters` 类型太宽松
**建议**：使用更具体的 JSON Schema 类型，如 `Record<string, { type: string; description?: string }>`。

### 40. 多处空 catch 吞掉异常
**涉及文件**：`tmdb-service.js:19`、`file-service.js:16,27`、`mpv-service.js:95`、`cast-service.js:71`、`MediaLibrary.tsx:99-100`。  
**建议**：至少打印 `console.warn`，保留排障信息。

---

## 修复优先级建议

| 优先级 | 必须修复项 | 预计工时 |
|--------|-----------|---------|
| P0 | #1、#2 | 0.5h |
| P1 | #3-#16 | 4-6h |
| P2 | #17-#40 | 2-3h |

建议先合入 P0 修复保证 Agent 功能可运行，再按 P1 列表逐项处理，P2 可在下一个迭代中消化。
