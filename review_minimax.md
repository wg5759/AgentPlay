# AI播放器 75a843f 代码审核报告

> **审核范围**：`electron/*.js` (10 个文件，884 行) + `src/**/*.{ts,tsx}` (12 个文件，893 行)
> **审核维度**：功能 / 质量 / 安全 / 规范
> **严重级别**：P0 阻断 (需立即修) / P1 重要 (本迭代内) / P2 一般 (后续优化)
> **审核工具**：逐文件 Read + Node.js 语法校验
> **数据基础**：33 files, 9236 lines（commit 75a843f）

---

## 0. 致命阻断（验证过的事实）

### P0-#01 🔴 验证通过：Agent 引擎模块**根本加载不了**
- **文件:行**：`electron/llm-service.js:67-79`
- **问题**：`TOOLS` 数组在 `print_file` 工具对象**未闭合**的情况下开始 `load_subtitle`，导致第 68 行的 `{` 出现位置不合法。Node 报：
  ```
  SyntaxError: Unexpected token '{'
    at electron/llm-service.js:68
  ```
- **影响**：①`require('./llm-service')` 整个抛错 → main.js 启动链路 ⑦ 死 ②Agent 7 个工具（暂停/继续/跳转/音量/字幕/打印/加载字幕）**全部不可用** ③voice 唤醒后用户说"暂停"会静默失败
- **根因**：手写 JSON 风格对象时漏掉了一层 `}`；`toolRegistry.ts` 已有定义但 `llm-service.js` 没复用，导致双源
- **修复**：
  ```js
  // electron/llm-service.js:57-79 改为
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
    }                                   // ← 闭合 function
  },                                    // ← 闭合外层对象（这里之前漏了！）
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
  ```
  修后 `node -c electron/llm-service.js` 应无输出。

### P0-#02 🔴 桌面端：mpv 独立窗口与 React UI **完全脱钩**
- **文件:行**：`electron/mpv-service.js:47` `--force-window --no-border` + `src/components/PlayerView.tsx:128-135`
- **问题**：mpv 启动时强制开自己的 OS 窗口（独立窗体），而 React 端只渲染一个"mpv 播放中（独立窗口）"的灰色占位文字。用户在 UI 上拖进度条 / 调音量 / 暂停 → 通过 IPC 改了 mpv 状态，但 UI 上**完全看不到画面**，用户不知道发生了什么；进度条上的 `currentTime` 来源于 mpv 的 `time-pos` 事件回流，但用户在 React 端**始终看到的是一个空白占位框**。
- **影响**：核心卖点"AI 媒体中枢"在桌面端 = 体验崩坏；V1 必须修；MVP 阶段就上线会被截图吐槽
- **修复（两选一，推荐 A）**：
  - **A. 嵌入窗口（推荐）**：mpv 启动改用 `--wid=<HWND>`（Windows）或 `--wid=<xid>`（Linux/macOS），把 mpv 帧贴进 Electron 的 `webContents` 隐藏 BrowserWindow；PlayerView 显示 `<webview>` 或把隐藏窗口的 frame 暴露
  - **B. 退化为子进程黑盒**：在 PlayerView 显著标注"mpv 独立窗口已打开，请切到该窗口" + 提供 `bringMpvToFront()` IPC；并把"窗口嵌入"移出 V1 待办

### P0-#03 🔴 `WifiTransfer` 零鉴权 = 邻居可往你电脑灌文件
- **文件:行**：`electron/wifi-transfer.js:7-66`（全文件）
- **问题**：
  - 任何能连上你家 WiFi 的人（访客、楼上邻居穿墙信号）打开 `http://<lan_ip>:18900` 即可上传任意文件
  - 上传目录固定为 `~/Videos/ai-player-uploads`，无大小/类型/数量限制
  - 攻击者能灌入 1TB 文件 → 磁盘撑爆；或灌入伪装成 `.mp4` 的恶意载荷，mpv 解码时执行漏洞
- **影响**：高危，家庭场景默认信任模型不成立
- **修复**：
  ```js
  // 1. 启动时生成 6 位 PIN
  this.pin = String(Math.floor(100000 + Math.random() * 900000))
  // 2. UPLOAD_PAGE 渲染时把 PIN 印在页面上，让用户手机输入
  // 3. handle POST 时校验 body.pin === this.pin，否则 403
  // 4. 单文件 >2GB 拒绝；每小时最多 20 个文件
  // 5. 改用 https + 临时自签证书（防同网段明文抓包）
  ```

### P0-#04 🔴 `SyncService` 零鉴权 = 任意 POST 改进度
- **文件:行**：`electron/sync-service.js:33-56`
- **问题**：HTTP 服务 `POST /`（实际是根路径，路由混乱）接收任意 JSON 写入 `this.progress`，没有任何 token / IP 校验 / 来源验证。`updatedAt` 字段也未做时间戳单调性保护，攻击者可发 `updatedAt: 9999999999999` 永久覆盖。
- **影响**：①进度被乱改 ②攻击者可枚举 hash（你观看的每个文件指纹） ③简单 DoS（发 1GB body → `body += c` 字符串拼接 → 内存爆炸，见 Q-#07）
- **修复**：
  ```js
  // 1. 启动时生成共享 secret，跨设备配对时手动交换
  this.secret = crypto.randomBytes(16).toString('hex')
  // 2. handle POST 校验 X-Sync-Token header === this.secret
  // 3. body 上限 1MB（Content-Length 校验 + 流式累加截断）
  // 4. updatedAt 取 Math.min(serverNow, clientUpdatedAt) 防回拨
  ```

---

## 1. 功能问题（F）

### F-P1-#05 mpv 启动用 `setTimeout(800ms)` 握手（脆弱）
- **文件:行**：`electron/mpv-service.js:60-61`
- **问题**：硬等 800ms 后 `connectIpc()`，不验证 `connect` 事件；老机器/冷启动下 mpv 启动慢，800ms 不够；首次 `observe_property` 命令在 socket 未连时丢
- **修复**：
  ```js
  await new Promise((resolve) => {
    this.ipc = net.connect(this.ipcPath)
    this.ipc.once('connect', resolve)
    this.ipc.once('error', resolve) // 超时也不阻塞
    setTimeout(resolve, 3000)        // 兜底
  })
  // 然后再发 observe_property
  ```

### F-P1-#06 `mpv:*` IPC 全部 `return true`，错误静默
- **文件:行**：`electron/main.js:71-76`
- **问题**：`mpv:load / play / pause / seek / volume / subtitle` 6 个 handler 一律 `{ mpv.xxx(); return true }`，mpv 没启动（`isAvailable() === false`）时调用全静默失败，UI 不知道
- **修复**：
  ```js
  ipcMain.handle('mpv:load', (_e, p) => {
    if (!mpv?.isAvailable()) return { ok: false, error: 'mpv 未就绪' }
    mpv.loadFile(p)
    return { ok: true }
  })
  ```
  同步把 preload.js / global.d.ts 的 `Promise<boolean>` 改为 `Promise<{ok:boolean,error?:string}>`

### F-P1-#07 `defaultVideoDir` 无目录时 fallback 到 `~`，扫描会卡死
- **文件:行**：`electron/file-service.js:35-46`
- **问题**：4 个候选目录全不存在时 `return home`；`scanDir(home)` 会同步递归整个用户目录（桌面/下载/...几百 GB）→ 主线程阻塞几秒到几十秒，UI 冻屏
- **修复**：
  ```js
  function defaultVideoDir() {
    const home = require('os').homedir()
    const candidates = [path.join(home, 'Videos'), path.join(home, '视频'), path.join(home, 'Movies')]
    for (const c of candidates) if (fs.existsSync(c)) return c
    return path.join(home, 'Videos') // 返回一个不存在的固定路径，让用户自己建/选
  }
  ```
  进一步：`scanDir` 改为 async + 限深度 3 层 + 限文件数 5000

### F-P2-#08 字幕开关（store ↔ mpv）不同步
- **文件:行**：`src/components/PlayerControls.tsx:68` + `src/components/PlayerView.tsx`
- **问题**：`toggleSubtitle` 改 `subtitleVisible` store，**但 PlayerView 没有 useEffect 监听 subtitleVisible → 调用 mpv `set_property sub-visibility`**；用户点"字幕"按钮，mpv 那边不动
- **修复**：在 PlayerView 加
  ```ts
  useEffect(() => {
    if (isDesktop && player) player.send({ command: ['set_property', 'sub-visibility', subtitleVisible] })
  }, [subtitleVisible])
  ```
  注：preload 要补 `player.send` API

### F-P2-#09 `setVolume` / `seek` 不做 clamp，LLM 幻觉传 -50 不会报错
- **文件:行**：`electron/mpv-service.js:108-109` + `electron/llm-service.js:117-122`
- **问题**：mpv `set_property volume` 接受 0-130（130 是放大），传 -1 或 999 静默裁切到合法范围，UI 反馈失真
- **修复**：
  ```js
  setVolume(level) {
    const v = Math.max(0, Math.min(130, Number(level) || 0))
    this.send({ command: ['set_property', 'volume', v] })
  }
  ```

### F-P2-#10 `tmdb:search` 错误吞掉，UI 看到"无结果"以为搜错
- **文件:行**：`electron/tmdb-service.js:19-22`
- **问题**：网络错 / 401 key 错 / 429 限流全部 `catch {}; return null`；前端只看到"没有海报"
- **修复**：返回 `{ error: 'TMDB_API_KEY 无效' | '网络错误' | '未找到' }`，前端按错误类型给提示

### F-P2-#11 `printFile` 固定 `setTimeout(close, 2000)`，大文件/PDF 渲染未完就关
- **文件:行**：`electron/print-file.js:15`
- **问题**：大图或多页 PDF `loadFile` + `print` 完需要 5-10s，2s 后窗口关掉导致打印丢内容
- **修复**：
  ```js
  win.webContents.once('did-finish-load', () => {
    win.webContents.print({ printBackground: true }, (success, reason) => {
      if (!success) console.error('[print] failed:', reason)
      setTimeout(() => win.close(), 1000)
    })
  })
  ```

### F-P2-#12 React `key={i}` 在消息列表 → 倒序/编辑时错位
- **文件:行**：`src/components/AgentPanel.tsx:42`
- **修复**：用 `crypto.randomUUID()` 给 `addMessage` 时打 id，store 里 `AgentMessage` 加 `id: string`

### F-P2-#13 拖拽字幕用 `file.path`，Electron 28+ 已废弃
- **文件:行**：`src/components/PlayerView.tsx:107, 112`
- **问题**：`File.path` 在 Electron 32 删，28 已警告
- **修复**：
  ```ts
  // preload.js 增加
  const { webUtils } = require('electron')
  contextBridge.exposeInMainWorld('aiPlayer', {
    ...
    getPathForFile: (file) => webUtils.getPathForFile(file),
  })
  // 渲染端
  const filePath = window.aiPlayer.getPathForFile(file)
  ```

### F-P2-#14 Web 端 `v.play().catch(() => {})` 完全吞错
- **文件:行**：`src/components/PlayerView.tsx:77`
- **问题**：浏览器 autoplay policy 失败用户无感知
- **修复**：catch 后 `addMessage('agent', '[提示] 浏览器阻止了自动播放，请点击页面')` 或 toast

### F-P2-#15 `MpvService` 无重复 start 保护
- **文件:行**：`electron/mpv-service.js:31`
- **问题**：StrictMode 下 `mpv.start()` 在 dev 模式可能调多次 → 启 2 个 mpv 进程争 IPC
- **修复**：
  ```js
  async start() {
    if (this.proc) return true
    ...
  }
  ```

### F-P2-#16 `SyncService.setProgress` / `getProgress` 是死代码
- **文件:行**：`electron/sync-service.js:90-95` + `electron/main.js:88-94`
- **问题**：定义了但 `main.js` 没注册 IPC，前端拿不到 → 进度实际上从未被记录
- **修复**：要么删掉（同步只用 upload/download 推拉），要么补 IPC `sync:setProgress` / `sync:getProgress`

---

## 2. 质量问题（Q）

### Q-P1-#17 `llm-service.chat` 无消息历史长度限制
- **文件:行**：`electron/llm-service.js:144-176` + `src/stores/agentStore.ts:39-41`
- **问题**：前端把整个 `messages` 数组都发，5 轮工具调用后消息数 = 5×(user+agent+tool)≈20，token 单次可达 8k，长会话会持续增长
- **修复**：①前端加 token 估算，超 4k 时截断最早对话（保留 system + 最近 6 轮）②main 端循环上限改 8 轮 ③用 `tiktoken` 精确计数

### Q-P1-#18 `agentStore.send` 中 `result.text` / `result.toolResults` 无空判断
- **文件:行**：`src/stores/agentStore.ts:47-57`
- **问题**：`result.toolResults.length > 0` 假设 `toolResults` 一定存在；若 main 返回 `{ error }` 形状（实际 llm-service 不会但 main.js:159 会返 `errText`），`.toolResults` 是 undefined → `Cannot read property 'length'`
- **修复**：
  ```ts
  const result = await window.aiPlayer.ai.chat(history)
  const reply = result?.text ?? '[无回复]'
  const trs = result?.toolResults ?? []
  ```

### Q-P1-#19 `MpvService.handleData` buffer 无上限
- **文件:行**：`electron/mpv-service.js:82-98`
- **问题**：`this.buffer += data.toString()` 无长度限制；mpv 高频发 1KB/s 可长期累计
- **修复**：
  ```js
  if (this.buffer.length > 1 << 20) { this.buffer = ''; return } // 1MB 上限
  ```

### Q-P1-#20 `SyncService.handle` 拼 body 字符串无上限
- **文件:行**：`electron/sync-service.js:38-39`
- **问题**：`body += c` 无 Content-Length 校验，攻击者发 1GB body → 内存爆
- **修复**：
  ```js
  if (parseInt(req.headers['content-length'] || '0') > 1 << 20) {
    res.writeHead(413); res.end(); return
  }
  ```

### Q-P1-#21 全局无 React ErrorBoundary
- **文件:行**：`src/main.tsx:6-9`
- **问题**：任何子组件 throw → 整个白屏（Vite 自带 overlay 仅 dev）
- **修复**：加 `src/components/ErrorBoundary.tsx` 包 `<App />`，fallback UI "出错了，刷新重试"

### Q-P1-#22 `llm-service.executeTool` 不校验 LLM 返回参数
- **文件:行**：`electron/llm-service.js:109-134`
- **问题**：LLM 幻觉可能发 `args = {}`（缺 seconds）→ `mpv.seek(undefined)` 静默失败；或 `args.seconds = "abc"` → `NaN`
- **修复**：
  ```js
  case 'seek': {
    const s = Number(args?.seconds)
    if (!Number.isFinite(s)) return { error: '无效的 seconds' }
    this.mpv?.seek(s)
    return { success: true, action: `跳转到 ${s} 秒` }
  }
  ```
  每个 case 都加 Number 强转 + 范围检查

### Q-P2-#23 React StrictMode 双调用导致 mpv loadFile 两次
- **文件:行**：`src/main.tsx:7` + `src/components/PlayerView.tsx:26-30`
- **问题**：dev 下 useEffect 跑两次，每次 setMedia 都触发 loadFile，mpv 重新加载（从 0 开始）
- **修复**：给 `videoSrc` 用 ref 记上次的值，effect 内比较再决定是否 loadFile
  ```ts
  const lastSrc = useRef('')
  useEffect(() => {
    if (videoSrc && videoSrc !== lastSrc.current) {
      player.loadFile(videoSrc)
      lastSrc.current = videoSrc
    }
  }, [videoSrc])
  ```

### Q-P2-#24 全项目无 ESLint / Prettier
- **文件:行**：`/`（根目录）
- **问题**：风格不一致（2 空格/4 空格混用、单/双引号混用、`async ()` 缺空格），靠人眼 review
- **修复**：加 `.eslintrc.json`（extends: `eslint:recommended` + `@typescript-eslint/recommended`）+ `.prettierrc`（printWidth: 100, singleQuote: true, semi: false）

### Q-P2-#25 Magic number 满天飞
- **文件:行**：
  - `electron/wifi-transfer.js:20` 端口 18900
  - `electron/cast-service.js:11` 端口 18901
  - `electron/sync-service.js:7` 端口 18902
  - `electron/mpv-service.js:60` 800ms
  - `electron/cast-service.js:48` 3000ms SSDP
  - `electron/print-file.js:15` 2000ms
- **修复**：提常量到 `electron/constants.js`：
  ```js
  module.exports = {
    PORTS: { WIFI: 18900, CAST: 18901, SYNC: 18902 },
    TIMING: { MPV_BOOT_WAIT: 800, SSDP_SCAN: 3000, PRINT_TIMEOUT: 2000 }
  }
  ```

### Q-P2-#26 `localStorage.networkSources` 写入/读取不校验
- **文件:行**：`src/components/MediaLibrary.tsx:20-26, 37-45`
- **问题**：解析失败 fallback `[]`，写入也无 URL scheme 校验 → 用户可加 `javascript:alert(1)` 虽然只在 onClick 传参不直接执行，但脏数据会保留
- **修复**：
  ```ts
  const isValid = (u) => /^(https?|smb|webdav):\/\//i.test(u)
  if (!isValid(url)) { setError('只支持 http/https/smb/webdav'); return }
  ```

### Q-P2-#27 `printFile` 拼接 HTML 注入风险
- **文件:行**：`electron/print-file.js:11-12`
- **问题**：`'<img src="file://' + filePath + '" ...>'` —— filePath 含 `"` 会破 HTML（虽然 BrowserWindow.loadURL data: 在主进程内，但 filePath 来自 IPC，攻击者可注入 `"></img><script>...`）
- **修复**：用 URL 类
  ```js
  const html = `<img src="${new URL('file://' + filePath).href}" style="max-width:100%">`
  ```

---

## 3. 安全问题（S）

### S-P0（已在第 0 章）
- **#03 WifiTransfer 零鉴权**
- **#04 SyncService 零鉴权**

### S-P1-#28 `cast-service` 文件服务器可被任意读取（认证缺失）
- **文件:行**：`electron/cast-service.js:76-108`
- **问题**：`startFileServer` 一旦在投屏时被启动，整个家庭网段任何人都能 `GET http://<lan_ip>:18901/C:%5CUsers%5CPublic%5CVideos%5Cany.mp4` 直接读视频文件。`allowedRoots` 校验可绕过：若 filePath 已经是合法路径（如用户已添加的网络源），文件就裸奔。
- **修复**：
  ```js
  // 1. 启动文件服务器时生成临时 token（投屏 URL 里带 ?token=xxx）
  // 2. handler 校验 token
  // 3. 只对 controlUrl 指向的 LAN IP 响应（X-Forwarded-For 不信，自己 socket.remoteAddress 校验 RFC1918 段）
  // 4. 投屏结束就 close
  this.fileServer.close()
  ```

### S-P1-#29 `cast:cast` 接收任意 controlUrl = SSRF 风险
- **文件:行**：`electron/cast-service.js:110-143`
- **问题**：`scan()` 通过 SSDP 收响应，攻击者可在同网段伪造 SSDP 响应注入恶意 `controlUrl`（如 `http://127.0.0.1:8080/admin`），用户点投屏时 fetch 打到内网
- **修复**：
  ```js
  // 1. parseDevice 里校验 location 是 http:// 开头
  // 2. 校验 hostname 是 RFC1918 私有 IP
  // 3. setTimeout 防 SSDP flood（已有但 3s 偏短）
  ```

### S-P1-#30 IPC `mpv:load` / `print:file` 接收任意路径
- **文件:行**：`electron/main.js:71, 76, 83`
- **问题**：渲染进程被 `contextIsolation: true` 保护，但 XSS 仍可通过 preload 暴露的 API 触发任意文件播放/打印。`print:file` 可打印 `file:///etc/passwd`（PDF）或读取任意图片文件内容
- **修复**：
  ```js
  // main.js 加路径白名单
  const allowedPaths = new Set() // 从 files:scan 返回的 path 集合
  ipcMain.handle('mpv:load', (_e, p) => {
    if (!allowedPaths.has(p)) return { ok: false, error: '路径未授权' }
    mpv.loadFile(p)
    return { ok: true }
  })
  // files:scan 返回时同步填充 allowedPaths
  // print:file 同理
  ```

### S-P1-#31 BrowserWindow webPreferences 缺 `sandbox: true`
- **文件:行**：`electron/main.js:30-34`
- **问题**：只关了 `nodeIntegration`，没开 sandbox → 渲染进程仍可访问部分 Node API（虽然有限）；preload 桥也跑在隔离但非沙箱环境
- **修复**：
  ```js
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,              // ← 加
    webSecurity: true           // ← 加（默认 true 但显式声明）
  }
  ```

### S-P1-#32 `app.requestSingleInstanceLock` 缺失
- **文件:行**：`electron/main.js:46`（app.whenReady 内）
- **问题**：用户双开应用 → 第二个实例也启 mpv（端口冲突） + 起 WifiTransfer/SyncService（端口冲突）→ 整个应用行为不可预测
- **修复**：
  ```js
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) { app.quit(); return }
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() }
  })
  ```

### S-P2-#33 TMDB API key 走 env，无泄露
- **文件:行**：`electron/main.js:85` + `electron/tmdb-service.js:1-22`
- **状态**：✅ 良好。key 在 main 进程读 env，IPC handler 不传 key 到渲染
- **建议**：补充 .env.example 并在 README 提示 `TMDB_API_KEY` 选填

### S-P2-#34 网络源 URL 注入 localStorage
- **文件:行**：`src/components/MediaLibrary.tsx:37-45`
- **问题**：用户可加 `javascript:` / `data:` URL，脏数据进 localStorage；目前只在 onClick 传 `onPlay(name, url)`，没真去 fetch，但耦合脆弱
- **修复**：见 Q-P2-#26 的 `isValid` 校验

### S-P2-#35 `localStorage` 全局读写无 try-catch（隐私模式/无痕浏览会爆）
- **文件:行**：`src/components/MediaLibrary.tsx:20-26, 42, 77`
- **问题**：Safari 隐私模式或某些 iframe 沙箱里 `localStorage.setItem` 抛 `QuotaExceededError`
- **修复**：try-catch 已有了，但写入路径（行 42, 77）没有：
  ```ts
  try { localStorage.setItem('networkSources', JSON.stringify(next)) } catch {}
  ```

### S-P2-#36 CSP（Content-Security-Policy）缺失
- **文件:行**：`index.html`（未读但 package.json 提到）
- **问题**：主入口无 CSP meta，XSS 后 `<script src="http://evil">` 直接执行
- **修复**：在 `index.html` 加：
  ```html
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self'; img-src 'self' data: https:; media-src 'self' https: blob:; connect-src 'self' http: https: ws:; script-src 'self'">
  ```

---

## 4. 规范问题（N）

### N-P1-#37 TS 严格度不够
- **文件:行**：`tsconfig.json`（未读）+ 各组件
- **问题**：多处用 `as any` / `(file as File & { path: string })` 类型断言；store 接口定义不完整
- **修复**：
  ```json
  // tsconfig.json compilerOptions
  "strict": true,
  "noUnusedLocals": true,
  "noUnusedParameters": true,
  "noImplicitAny": true,
  "noFallthroughCasesInSwitch": true
  ```

### N-P1-#38 `setProgress`/`getProgress` 死代码
- 见 F-P2-#16

### N-P1-#39 Preload `version: '0.1.0'` 硬编码
- **文件:行**：`electron/preload.js:7`
- **修复**：
  ```js
  const { version } = require('../package.json')
  // ...version
  ```

### N-P2-#40 无单元测试
- **修复**：加 vitest + `electron/__tests__/` 测核心服务（mpv 协议、sync merge、llm tools）

### N-P2-#41 中文注释 + 英文 log 混用，无统一规范
- **建议**：在 AGENTS.md 立"日志规范：英文 prefix + 中文 message"，如 `[MpvService] mpv 启动失败` 已 OK，但 `console.log('[preload] AI播放器 desktop API 已注入（含 mpv player）')`（preload.js:49）太口语

### N-P2-#42 TODO 散落
- **文件:行**：
  - `src/components/VoiceWake.tsx:20-22`
  - `src/agents/toolRegistry.ts:21-29`
  - `electron/llm-service.js` 注释里也有
- **修复**：INDEX.md 已写"待优化：mpv 窗口嵌入、局域网服务认证、本地 LLM"，但代码里再无引用 → 维护者不知道。建议在仓库加 `TODO.md` 集中收纳 + owner + 优先级

### N-P2-#43 `process.exit` 缺失 + 进程清理
- **文件:行**：`electron/main.js:105-108`
- **问题**：`before-quit` 只 stop mpv + wifi，没 stop castService / syncService → 进程残留
- **修复**：
  ```js
  app.on('before-quit', () => {
    mpv?.stop()
    wifiTransfer?.stop()
    castService?.stop()
    syncService?.stop()
  })
  ```

### N-P2-#44 `getLanIp` 在 3 个 service 中重复实现
- **文件:行**：
  - `electron/wifi-transfer.js:38-46`
  - `electron/cast-service.js:14-22`
  - `electron/sync-service.js:13-21`
- **修复**：提 `electron/utils.js`：
  ```js
  module.exports = { getLanIp, getBinaryPath: ..., ... }
  ```

### N-P2-#45 `electron/preload.js` 大量 IPC 桥可考虑用 `electron-vite/preload` 自动化
- 长期项，本期跳过

---

## 5. 问题汇总

| 严重 | 数量 | 主要类别 |
|---|---|---|
| **P0 阻断** | 4 | Agent 引擎死 / mpv 脱钩 / WiFi 零鉴权 / Sync 零鉴权 |
| **P1 重要** | 19 | 启动握手、IPC 错误、扫描、字幕同步、消息限长、XSS 防护、SSRF、CSP、sandbox、single-instance、TypeScript 严格度、ESLint、TOOLS 语法 |
| **P2 一般** | 22 | clamp、错误吞错、ErrorBoundary、key 错位、port 常量化、测试、CSP 细节、清理函数、代码复用、TODO 集中、preload 硬编码 |

**P0 必须先修**（按顺序）：
1. P0-#01 TOOLS 语法（5 分钟，1 个 `}` 的事）— 解锁 Agent
2. P0-#02 mpv 窗口嵌入（核心体验）
3. P0-#03 / #04 鉴权（家庭场景基本信任）

**P1 建议本迭代内修**：F-#05-#07, F-#21, Q-#17-#22, S-#28-#32, N-#37-#39

**P2 进 backlog**：其余 22 条

---

## 6. 亮点（值得保留）

- ✅ `index.html` 入口精简，主进程/渲染进程职责清晰（main.js 只 108 行）
- ✅ `contextIsolation: true` + `nodeIntegration: false`（基线正确）
- ✅ `scanDir` 走白名单扩展名，不会扫敏感文件
- ✅ `cast-service.js` allowedRoots 用 `path.resolve + startsWith` 是正确做法
- ✅ `agentStore` 用 zustand 简洁清晰，类型完备
- ✅ 全局未引入重型框架（无 Redux/MobX），启动开销低
- ✅ `toolRegistry.ts` 单源定义工具意图（虽然 `llm-service.js` 没复用导致 #01 翻车，但思路对）

---

## 7. 建议的下一步

1. **立即**：修 P0-#01（解 7 工具），跑 `node -c` + `pnpm build` 验证
2. **本周**：修 P0-#02-#04 三大体验/安全问题
3. **本迭代**：把 P1 全过一遍
4. **加 CI**：在 `.github/workflows/ci.yml` 加 `node -c` 校验所有 `electron/*.js` + `tsc --noEmit` 钩子，杜绝 #01 此类低级错误再发生
