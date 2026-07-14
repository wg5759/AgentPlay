# AI 播放器代码审核报告（commit 75a843f）

## 审核概览

| 统计项 | 数量 |
|--------|------|
| 审核文件总数 | 22 |
| - Electron 后端文件 | 10 |
| - React 前端文件 | 12 |
| 问题总数 | 34 |
| - P0 阻断性问题 | 4 |
| - P1 严重问题 | 16 |
| - P2 改进建议 | 14 |

---

## P0 阻断性问题（必须立即修复）

### 1. TOOLS 数组语法错误
**文件**：`electron/llm-service.js:61-79`
**问题**：`print_file` 工具对象定义后缺少闭合逗号和方括号，导致 JavaScript 语法解析错误，整个 LLM 服务无法正常初始化。
```javascript
{
  type: 'function',
  function: {
    name: 'print_file',
    // ...
  },
  // 此处缺少闭合逗号，且 load_subtitle 对象直接嵌套在 print_file 内
  {
    type: 'function',
    function: {
      name: 'load_subtitle',
      // ...
    }
  }
] // 整个数组结构错误
```
**修复建议**：修正数组结构，每个工具作为独立元素：
```javascript
{
  type: 'function',
  function: {
    name: 'print_file',
    // ...
  }
},
{
  type: 'function',
  function: {
    name: 'load_subtitle',
    // ...
  }
}
```

---

### 2. 投屏文件服务器路径验证逻辑错误
**文件**：`electron/cast-service.js:86-93`
**问题**：路径验证逻辑存在根本性错误：
- `resolved === d` 比较永远不会成立（URL 解码后的路径与绝对路径格式不一致）
- 使用 `path.sep` 进行路径前缀检查，但 URL 路径使用 `/` 分隔，Windows 下是 `\\`，导致所有合法路径都被 403 拒绝
**修复建议**：统一使用 `path.normalize` 处理，并正确解析 URL 编码的路径

---

### 3. 服务启动无错误处理
**文件**：`electron/main.js:55-56, 60-61`
**问题**：`wifiTransfer.start()` 和 `syncService.start()` 调用时没有 try/catch，端口占用或启动失败时会静默崩溃，用户完全无感知。
**修复建议**：添加错误捕获和用户提示：
```javascript
try {
  wifiTransfer.start()
} catch (e) {
  console.error('WiFi 传输服务启动失败:', e)
  // 通过 IPC 通知前端显示错误
}
```

---

### 4. mpv 事件转发类型不匹配
**文件**：`electron/main.js:64-68` 和 `src/components/PlayerView.tsx:57-67`
**问题**：主进程转发的事件结构与前端期望的结构不一致，导致 mpv 播放状态无法同步到 UI。
- 主进程发送：`{ event, data }` 两层嵌套
- 前端解析：`evt.event !== 'property' || !evt.data`，然后再次解构 `evt.data.name/data`
**修复建议**：统一事件数据结构，避免多层嵌套混淆

---

## P1 严重问题（影响功能或安全）

### 安全问题

#### 5. 打印功能 XSS 注入风险
**文件**：`electron/print-file.js:11-12`
**问题**：直接将文件路径拼接到 HTML 字符串中，未进行 HTML 转义，恶意文件名可执行 JavaScript：
```javascript
const html = '<img src="file://' + filePath + '" style="max-width:100%">'
```
**修复建议**：使用 `he` 库或手动转义特殊字符

---

#### 6. WiFi 传文件无任何安全限制
**文件**：`electron/wifi-transfer.js:52-65`
**问题**：
- 无文件类型白名单验证，可上传任意可执行文件
- 无文件大小限制，可能导致磁盘耗尽
- 无身份认证，局域网内任意设备都可上传
**修复建议**：添加文件类型验证、大小限制、简单 token 认证

---

#### 7. 同步服务无认证和速率限制
**文件**：`electron/sync-service.js:33-56`
**问题**：HTTP 接口完全开放，无任何认证机制，无请求频率限制，可被恶意写入大量数据。
**修复建议**：添加基于时间的一次性密码（TOTP）或简单的配对机制

---

#### 8. SOAP XML 构造无转义
**文件**：`electron/cast-service.js:117-126`
**问题**：构造 DLNA 投屏的 SOAP XML 时，`mediaUrl` 直接拼接未进行 XML 转义，特殊字符可能导致 XML 解析错误或注入。
**修复建议**：使用 XML 构建库或对特殊字符进行转义

---

#### 9. 文件服务器路径遍历风险
**文件**：`electron/cast-service.js:79`
**问题**：仅使用 `decodeURIComponent` 解码 URL 路径，未处理 `../` 路径遍历攻击。
**修复建议**：使用 `path.resolve` 后验证是否在允许的根目录内

---

### 功能问题

#### 10. 音频格式扩展不一致
**文件**：`electron/file-service.js:7-9` 和 `src/components/MediaLibrary.tsx:240`
**问题**：后端识别的音频扩展名（含 `.ogg`）与前端投屏按钮判断的视频扩展名不一致，导致音频文件无法投屏。
**修复建议**：统一扩展名配置到公共常量文件

---

#### 11. Web 端拖拽视频内存泄漏
**文件**：`src/components/PlayerView.tsx:115`
**问题**：`URL.createObjectURL(file)` 创建的对象 URL 从未释放，持续累积导致内存泄漏。
**修复建议**：在组件卸载或切换视频时调用 `URL.revokeObjectURL`

---

#### 12. 全屏切换未实际执行
**文件**：`src/stores/playerStore.ts:37`
**问题**：`toggleFullscreen` 只修改状态变量，并未调用 `document.documentElement.requestFullscreen()` 或 `exitFullscreen()`。
**修复建议**：在 action 中添加实际的全屏 API 调用

---

#### 13. 字幕开关状态未同步到 mpv
**文件**：`src/components/PlayerControls.tsx:67-72`
**问题**：点击字幕按钮只修改本地状态，未通过 IPC 调用 mpv 的 `set_property` 命令，桌面端字幕显示不受控制。
**修复建议**：在 `toggleSubtitle` action 中同步调用 mpv 接口

---

### 代码质量问题

#### 14. getLanIp 函数三重重复
**文件**：`electron/cast-service.js:14`, `electron/wifi-transfer.js:38`, `electron/sync-service.js:13`
**问题**：相同的获取局域网 IP 函数在三个服务中完全重复定义，违反 DRY 原则。
**修复建议**：提取到 `utils/network.js` 公共模块

---

#### 15. 工具定义两处不一致
**文件**：`electron/llm-service.js:5-80` vs `src/agents/toolRegistry.ts:13-25`
**问题**：LLM 工具定义在前后端两处重复维护，且命名和参数都不一致：
- 后端：`pause`, `resume`, `seek`, `set_volume`
- 前端：`media_pause`, `media_play`, `media_seek`, `media_set_volume`
**修复建议**：统一使用单一数据源，建议以后端的实际可执行工具为准

---

#### 16. 可打印扩展名重复定义
**文件**：`electron/file-service.js:4-5` vs `src/components/MediaLibrary.tsx:107`
**问题**：`IMAGE_EXTS` 和 `PRINTABLE` 数组内容基本相同但分开维护，容易不一致。
**修复建议**：共享常量定义

---

#### 17. mpv 子进程无错误处理和清理
**文件**：`electron/mpv-service.js:41-58`
**问题**：
- mpv 进程启动失败或异常退出时，只有 console.log，无状态同步到 UI
- 缺少 `on('exit')` 处理，可能产生僵尸进程
- 应用退出时 kill 信号可能不够优雅
**修复建议**：添加进程状态监听和优雅退出机制

---

#### 18. 所有网络请求无超时机制
**文件**：多处 fetch 调用（`llm-service.js`, `cast-service.js`, `tmdb-service.js`）
**问题**：所有 `fetch` 调用都没有设置超时，网络异常时会无限等待，导致 UI 假死。
**修复建议**：封装带超时的 fetch 工具函数

---

#### 19. IPC 调用无错误处理
**文件**：多个前端组件
**问题**：所有 `window.aiPlayer.*` 调用都直接调用，无 try/catch，无返回值校验，IPC 失败时静默失败。
**修复建议**：统一封装带错误处理的 API 调用层

---

## P2 改进建议（提升代码质量）

### 代码规范

#### 20. 缩进风格不一致
**文件**：`src/types/global.d.ts:7-9`, `electron/llm-service.js:8-9`
**问题**：部分代码使用 4 空格缩进，与整体 2 空格规范不一致。
**修复建议**：配置 Prettier 统一格式化

---

#### 21. 缺少 JSDoc 注释
**文件**：所有公共 API 和复杂函数
**问题**：关键函数如 `MpvService`, `AgentEngine`, `SyncService` 等缺少 JSDoc 注释，参数和返回值含义不明确。
**修复建议**：为公共 API 添加完整的 JSDoc 文档

---

#### 22. 魔法数字未提取为常量
**文件**：多处
**问题**：`3000`（隐藏超时）、`18900`（WiFi 端口）、`18901`（投屏端口）、`18902`（同步端口）等魔法数字散落在代码中。
**修复建议**：提取到 `config/constants.js`

---

### 架构设计

#### 23. 缺少统一的日志系统
**文件**：所有文件
**问题**：只用 `console.log/error`，无日志级别、无持久化、无法追踪问题。
**修复建议**：接入 `winston` 或 `electron-log`

---

#### 24. Zustand 状态无持久化
**文件**：`src/stores/playerStore.ts`
**问题**：音量、播放进度、上次播放文件等用户偏好状态重启后丢失。
**修复建议**：使用 `zustand-persist` 中间件持久化关键状态

---

#### 25. 错误边界缺失
**文件**：前端无 ErrorBoundary
**问题**：React 组件渲染异常时整个应用白屏，无降级 UI。
**修复建议**：添加全局错误边界组件

---

#### 26. 组件缺少 displayName
**文件**：所有组件
**问题**：匿名函数组件在 React DevTools 中显示不友好。
**修复建议**：为组件添加 `displayName` 或使用命名函数

---

#### 27. TypeScript 类型断言过多
**文件**：`src/components/PlayerView.tsx:107, 112`
**问题**：`file as File & { path: string }` 类型断言绕过类型检查，可能隐藏问题。
**修复建议**：使用类型守卫函数进行运行时验证

---

### 边界条件处理

#### 28. 浮点数比较缺少精度处理
**文件**：`src/components/PlayerView.tsx:48, 91`
**问题**：直接用 `Math.abs(a - b) > 1` 比较时间，未考虑浮点数精度误差。
**修复建议**：使用更小的 epsilon 值或整数毫秒比较

---

#### 29. 时间格式化缺少小时处理
**文件**：`src/components/PlayerControls.tsx:17-21`
**问题**：`fmt` 函数只处理分秒，超过 1 小时的视频显示异常（如 61:30 而不是 1:01:30）。
**修复建议**：完善时间格式化逻辑

---

#### 30. 文件大小格式化单位不统一
**文件**：`src/components/MediaLibrary.tsx:114-118`
**问题**：GB/MB 与字节的换算使用十进制（1e9）而非二进制（1024^3）。
**修复建议**：统一使用标准的二进制单位换算

---

#### 31. 缺少 mpv 二进制存在性校验
**文件**：`electron/mpv-service.js:23-25`
**问题**：`isAvailable()` 只检查文件是否存在，不检查执行权限和可执行性。
**修复建议**：尝试执行 `mpv --version` 进行完整性校验

---

#### 32. localStorage 访问无错误处理
**文件**：`src/components/MediaLibrary.tsx:20-26`
**问题**：Safari 隐私模式下 localStorage 不可用，会抛出异常。
**修复建议**：封装安全的存储访问工具函数

---

#### 33. 组件卸载时未清理监听器
**文件**：多处
**问题**：`onEvent` 返回的清理函数在 `useEffect` 中正确返回了，但其他监听器（如窗口大小变化）缺少清理。
**修复建议**：审计所有副作用的清理逻辑

---

#### 34. TMDB API Key 可能泄露
**文件**：`electron/main.js:85`
**问题**：通过环境变量传递 API Key，但在渲染进程日志或错误堆栈中可能泄露。
**修复建议**：避免在错误信息中返回完整 API Key，只显示掩码版本

---

## 总结建议

### 优先修复顺序
1. **立即修复 P0 问题**：语法错误、路径验证错误 - 这些直接阻止核心功能运行
2. **本周修复 P1 安全问题**：XSS、路径遍历、无认证接口 - 存在安全隐患
3. **迭代优化 P2 问题**：代码质量、架构、边界条件 - 提升可维护性

### 架构改进方向
1. **建立公共模块层**：提取网络工具、常量定义、工具函数等共享代码
2. **统一错误处理机制**：前后端都需要统一的错误捕获、上报和用户反馈
3. **完善类型系统**：确保 TypeScript 类型覆盖完整，减少 `any` 和类型断言
4. **添加测试覆盖**：核心业务逻辑（播放器控制、同步、投屏）需要单元测试

### 代码质量提升
1. **配置 ESLint + Prettier**：自动检查代码风格和常见错误
2. **添加 git hooks**：提交前自动格式化和类型检查
3. **建立代码审查流程**：后续 PR 必须经过审核才能合并

整体而言，这个 MVP 版本功能完整度很高，架构设计也较为合理，但在安全防护、错误处理、代码复用方面还需要加强。建议按优先级逐步修复上述问题。
