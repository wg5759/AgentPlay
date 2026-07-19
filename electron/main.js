// AI播放器 Electron 主进程
// dev: 加载 Vite dev server；prod: 加载构建产物
// 集成 mpv sidecar，IPC 桥接渲染进程
const { app, BrowserWindow, ipcMain, Menu, dialog, safeStorage } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { MpvService } = require('./mpv-service')
const { shouldEmbedMpv } = require('./playback-policy')
const { AgentEngine } = require('./llm-service')
const { scanDir, defaultVideoDir, ALL_EXTS, getType } = require('./file-service')
const { printFile } = require('./print-file')
const { WifiTransfer } = require('./wifi-transfer')
const { searchMovie } = require('./tmdb-service')
const { CastService } = require('./cast-service')
const { SyncService } = require('./sync-service')
const { previewDocx, previewXlsx } = require('./office-preview')
const { searchSubtitle, downloadSubtitle } = require('./subtitle-service')
const { DlnaReceiver } = require('./dlna-receiver')
const log = require('./logger')
const { analyzeDir, clusterByTag, findDuplicates, suggestClip } = require('./media-service')
const { DlnaServer } = require('./dlna-server')
const { listPlugins } = require('./plugin-service')
const { PROVIDERS, listModels, probeConnection } = require('./model-providers')
const { discoverLocalServices } = require('./local-model-discovery')
const { ModelConfigStore } = require('./model-config-store')
const { ComputerUseProvider } = require('./adapters/computer-use-provider')
const { ComputerUseOrchestrator } = require('./computer-use-orchestrator')
const { ScreenCaptureService } = require('./screen-capture-service')
const { BundledLocalRuntime } = require('./bundled-local-runtime')
const { extractExternalMediaPaths } = require('./external-media-open')
const { buildOfflineAnalysis, loadAnalysisContext, renderRecut } = require('./analysis-studio-service')
const {
  generateImageAsset,
  renderCreativeVideo,
  requestCreativePlan,
  synthesizeCloudVoice,
  synthesizeSystemVoice
} = require('./creative-studio-service')

process.on('uncaughtException', (error) => log.error('主进程未捕获异常', error))
process.on('unhandledRejection', (error) => log.error('主进程未处理 Promise', error))

const isDev = !app.isPackaged
let mpv = null
let agentEngine = null
let modelConfigStore = null
let computerUseOrchestrator = null
let bundledRuntime = null
let wifiTransfer = null
let castService = null
let syncService = null
let dlnaReceiver = null
let dlnaServer = null
let mainWindow = null
let mpvContainer = null
let playerArea = null
let mpvReady = false
let rendererLoaded = false
let activeRecutProcess = null
const pendingExternalMedia = []
const activeAiRequests = new Map()
const activeComputerUseRequests = new Map()

ipcMain.on('app:version', (event) => {
  event.returnValue = app.getVersion()
})

ipcMain.on('external-media:accepted', (event, filePath) => {
  assertTrustedSender(event)
  const acceptedPath = extractExternalMediaPaths([filePath])[0]
  if (acceptedPath) log.info(`播放界面已接收外部文件: ${path.basename(acceptedPath)}`)
})

function stopActiveRender() {
  if (!activeRecutProcess || activeRecutProcess.killed) return false
  if (process.platform === 'win32' && activeRecutProcess.pid) {
    const killer = spawn('taskkill.exe', ['/pid', String(activeRecutProcess.pid), '/t', '/f'], { windowsHide: true, shell: false })
    killer.unref()
  } else {
    activeRecutProcess.kill('SIGTERM')
  }
  return true
}

function flushPendingExternalMedia() {
  if (!rendererLoaded || !mainWindow || mainWindow.isDestroyed()) return false
  while (pendingExternalMedia.length > 0) {
    mainWindow.webContents.send('menu:openFile', pendingExternalMedia.shift())
  }
  return true
}

function queueExternalMediaArgs(argv) {
  const filePath = extractExternalMediaPaths(argv)[0]
  if (!filePath) return false
  pendingExternalMedia.length = 0
  pendingExternalMedia.push(filePath)
  log.info(`收到系统打开文件请求: ${path.basename(filePath)}`)
  flushPendingExternalMedia()
  return true
}

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    queueExternalMediaArgs(argv)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  queueExternalMediaArgs([filePath])
})

queueExternalMediaArgs(process.argv)

function assertTrustedSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) {
    throw new Error('已拒绝非主窗口 IPC 请求')
  }
}

function normalizeRequestId(value, prefix) {
  const id = String(value || '').trim()
  if (/^[A-Za-z0-9_-]{8,100}$/.test(id)) return id
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

// 读取 BrowserWindow 原生句柄 HWND（Windows：指针值实际落在 32 位范围）
function getHwndNumber(win) {
  const buf = win.getNativeWindowHandle()
  return buf.readInt32LE(0)
}

// 创建 mpv 嵌入容器窗口（child，无边框，黑色背景，不渲染 HTML 内容）
// mpv --wid 附加到此窗口的 HWND，在其内创建子窗口渲染视频
function createMpvContainer(parent) {
  const pb = parent.getBounds()
  const w = 800
  const h = 450
  const container = new BrowserWindow({
    parent,
    frame: false,
    show: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#000000',
    width: w,
    height: h,
    x: pb.x + Math.round((pb.width - w) / 2),
    y: pb.y + Math.round((pb.height - h) / 2)
  })
  container.loadURL('about:blank')
  container.webContents.once('dom-ready', () => {
    container.webContents.insertCSS('html,body{background:#000!important;margin:0;overflow:hidden}')
  })
  return container
}

function updateContainerBounds() {
  if (!mpvContainer || mpvContainer.isDestroyed()) return
  if (!playerArea || !mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) return
  const cb = mainWindow.getContentBounds()
  mpvContainer.setBounds({
    x: cb.x + playerArea.x,
    y: cb.y + playerArea.y,
    width: Math.max(1, playerArea.width),
    height: Math.max(1, playerArea.height)
  })
}

function createWindow() {
  const { screen } = require('electron')
  const display = screen.getPrimaryDisplay()
  const w = Math.min(1280, display.workArea.width - 40)
  const h = Math.min(800, display.workArea.height - 40)
  mainWindow = new BrowserWindow({
    width: w,
    height: h,
    minWidth: 800,
    minHeight: 520,
    maxWidth: display.workArea.width,
    maxHeight: display.workArea.height,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    log.error(`preload 加载失败: ${preloadPath}`, error)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error('渲染进程退出', details)
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    log.error(`页面加载失败 ${code} ${description} ${url}`)
  })
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const output = `renderer[${level}] ${message} (${sourceId}:${line})`
    if (level >= 2) log.error(output)
    else log.info(output)
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const allowedPrefix = isDev ? 'http://localhost:5173/' : 'file:///'
    if (!String(targetUrl).startsWith(allowedPrefix)) event.preventDefault()
  })
  mainWindow.webContents.once('did-finish-load', async () => {
    rendererLoaded = true
    flushPendingExternalMedia()
    try {
      const injected = await mainWindow.webContents.executeJavaScript('window.aiPlayer?.isElectron === true')
      log.info(`桌面桥接注入状态: ${injected}`)
    } catch (error) {
      log.error('桌面桥接自检失败', error)
    }
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
  return mainWindow
}

const supportedExtensions = ALL_EXTS.map((ext) => ext.slice(1))
const openFileOptions = {
  filters: [{ name: '支持的媒体与文档', extensions: supportedExtensions }, { name: '所有文件', extensions: ['*'] }],
  properties: ['openFile']
}

async function chooseFile() {
  const result = await dialog.showOpenDialog(mainWindow, openFileOptions)
  return result.canceled ? null : result.filePaths[0]
}

function sendAction(action) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu:action', action)
}

function setWindowPreset(preset, mediaSize = null) {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const { screen } = require('electron')
  const workArea = screen.getDisplayMatching(mainWindow.getBounds()).workArea
  if (preset === 'fullscreen') {
    mainWindow.setFullScreen(!mainWindow.isFullScreen())
    return true
  }
  if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false)
  if (preset === 'fill') {
    mainWindow.maximize()
    return true
  }
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  const width = preset === 'half'
    ? Math.max(800, Math.round(workArea.width / 2))
    : Math.min(workArea.width, Math.max(800, Math.round(mediaSize?.width || 1280)))
  const height = preset === 'half'
    ? Math.max(520, Math.round(workArea.height / 2))
    : Math.min(workArea.height, Math.max(520, Math.round((mediaSize?.height || 690) + 110)))
  mainWindow.setBounds({
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height
  }, true)
  return true
}

const menuTemplate = [
  { label: '文件', submenu: [
    { label: '打开文件…', accelerator: 'CmdOrCtrl+O', click: async () => { const filePath = await chooseFile(); if (filePath) mainWindow?.webContents.send('menu:openFile', filePath) } },
    { label: '打开文件夹…', accelerator: 'CmdOrCtrl+Shift+O', click: async () => { const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] }); if (!r.canceled) mainWindow?.webContents.send('menu:openFolder', r.filePaths[0]) } },
    { label: '添加网络源…', click: () => sendAction('network-source') },
    { type: 'separator' },
    { role: 'quit', label: '退出' }
  ] },
  { label: '播放', submenu: [
    { label: '播放 / 暂停　空格', click: () => sendAction('play-toggle') },
    { label: '后退 10 秒　←', click: () => sendAction('seek-backward') },
    { label: '前进 10 秒　→', click: () => sendAction('seek-forward') },
    { type: 'separator' },
    { label: '音量 +5　↑', click: () => sendAction('volume-up') },
    { label: '音量 -5　↓', click: () => sendAction('volume-down') },
    { label: '静音 / 恢复　M', click: () => sendAction('mute-toggle') },
    { label: '字幕开关', click: () => sendAction('subtitle-toggle') },
    { label: '在线字幕…', click: () => sendAction('online-subtitle') },
    { label: '播放速度', submenu: [0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => ({ label: `${rate}×`, click: () => sendAction(`speed-${rate}`) })) },
    { type: 'separator' },
    { label: '截取当前画面', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendAction('screenshot') }
  ] },
  { label: '功能', submenu: [
    { label: 'AI 助手', accelerator: 'CmdOrCtrl+K', click: () => sendAction('agent') },
    { label: '模型接入中心…', click: () => sendAction('model-center') },
    { label: '拉片、深度解剖与原创重构…', accelerator: 'CmdOrCtrl+L', click: () => sendAction('analysis-studio') },
    { type: 'separator' },
    { label: '屏幕录制', click: () => sendAction('record') },
    { label: '重复文件检查', click: () => sendAction('dedup') },
    { label: '智能整理建议', click: () => sendAction('organize') },
    { label: '海报信息刮削', click: () => sendAction('poster') },
    { label: '插件管理', click: () => sendAction('plugins') },
    { label: '电脑操作建议（只观察）', click: () => sendAction('computer-use') },
    { label: '语音唤醒（默认关闭）', click: () => sendAction('voice-wake-toggle') },
    { label: '设备、投屏与同步', click: () => sendAction('devices') }
  ] },
  { label: '窗口', submenu: [
    { label: '原始窗口', accelerator: 'CmdOrCtrl+1', click: () => sendAction('window-original') },
    { label: '1/2 屏窗口', accelerator: 'CmdOrCtrl+2', click: () => sendAction('window-half') },
    { label: '铺满桌面', accelerator: 'CmdOrCtrl+3', click: () => sendAction('window-fill') },
    { label: '全屏窗口', accelerator: 'F11', click: () => sendAction('window-fullscreen') },
    { type: 'separator' },
    { label: '画面比例', submenu: [
      { label: '原始比例（大画面自动缩小）', click: () => sendAction('picture-original') },
      { label: '完整显示（推荐）', accelerator: 'Ctrl+0', click: () => sendAction('picture-fit') },
      { label: '裁剪铺满（可能隐藏边缘）', click: () => sendAction('picture-fill') },
      { label: '拉伸铺满（可能变形）', click: () => sendAction('picture-stretch') }
    ] },
    { type: 'separator' },
    { role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭' }
  ] },
  { label: '帮助', submenu: [
    { label: '快捷键', click: () => sendAction('shortcuts') },
    { label: '关于 AI播放器', click: () => dialog.showMessageBox(mainWindow, { type: 'info', title: '关于 AI播放器', message: 'AI播放器', detail: `版本 ${app.getVersion()}\n支持本地播放、网络源、投屏同步与多模型 AI 助手。` }) }
  ] }
]
Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate))

log.info('AI播放器启动')

app.whenReady().then(async () => {
  const win = createWindow()

  mpv = new MpvService()
  const useEmbed = shouldEmbedMpv()
  if (useEmbed) {
    mpvContainer = createMpvContainer(win)
    const hwnd = getHwndNumber(mpvContainer)
    mpvReady = await mpv.start(hwnd)
    log.info(`mpv 嵌入模式${mpvReady ? '启动成功' : '启动失败，回退 HTML5'}，HWND=${hwnd}`)
  } else {
    mpvReady = await mpv.start(null)
    log.info(`默认使用 HTML5 播放；mpv 独立兼容模式${mpvReady ? '已就绪' : '不可用'}`)
  }

  modelConfigStore = new ModelConfigStore(app.getPath('userData'), safeStorage)
  bundledRuntime = new BundledLocalRuntime({
    resourceRoot: app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources')
  })
  agentEngine = new AgentEngine(mpv)
  const screenCapture = new ScreenCaptureService(() => mainWindow)
  computerUseOrchestrator = new ComputerUseOrchestrator({
    capture: () => screenCapture.capture(),
    provider: new ComputerUseProvider()
  })

  // LAN-facing services are instantiated but remain stopped until the user
  // explicitly enables them from “设备、投屏与同步”.
  wifiTransfer = new WifiTransfer()

  castService = new CastService()

  syncService = new SyncService(path.join(app.getPath('userData'), 'sync-progress.json'))

  dlnaServer = new DlnaServer()

  dlnaReceiver = new DlnaReceiver()
  dlnaReceiver.onPlay = (url) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('receiver:play', url)
  }

  // mpv 事件转发渲染进程
  mpv.on((event, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mpv:event', { event, data })
    }
  })

  // 容器即时跟随；resize/maximize 时播放区布局可能变，请前端重测上报
  ;['resize', 'move', 'maximize', 'unmaximize', 'restore'].forEach((evt) => {
    win.on(evt, () => {
      updateContainerBounds()
      if (evt === 'resize' || evt === 'maximize' || evt === 'unmaximize') {
        win.webContents.send('mpv:remeasure')
      }
    })
  })

  win.on('closed', () => {
    if (mpvContainer && !mpvContainer.isDestroyed()) mpvContainer.destroy()
    mpvContainer = null
    rendererLoaded = false
    mainWindow = null
  })
  win.on('enter-full-screen', () => win.webContents.send('window:fullscreen-changed', true))
  win.on('leave-full-screen', () => win.webContents.send('window:fullscreen-changed', false))

  // IPC：渲染进程 -> mpv
  ipcMain.on('mpv:playerArea', (_e, rect) => {
    playerArea = rect
    updateContainerBounds()
  })
  ipcMain.on('mpv:showContainer', () => {
    if (mpvContainer && !mpvContainer.isDestroyed()) mpvContainer.show()
  })
  ipcMain.on('mpv:hideContainer', () => {
    if (mpvContainer && !mpvContainer.isDestroyed()) mpvContainer.hide()
  })
  ipcMain.handle('mpv:info', () => ({ ready: mpvReady, embedded: mpvReady && !!mpvContainer, available: mpv.isAvailable() }))
  ipcMain.handle('mpv:load', (_e, p) => mpvReady && mpv.loadFile(p))
  ipcMain.handle('mpv:play', () => mpvReady && mpv.play())
  ipcMain.handle('mpv:pause', () => mpvReady && mpv.pause())
  ipcMain.handle('mpv:seek', (_e, s) => mpvReady && mpv.seek(s))
  ipcMain.handle('mpv:volume', (_e, v) => mpvReady && mpv.setVolume(v))
  ipcMain.handle('mpv:speed', (_e, v) => mpvReady && mpv.setSpeed(v))
  ipcMain.handle('mpv:picture-mode', (_e, mode) => mpvReady && mpv.setPictureMode(mode))
  ipcMain.handle('mpv:subtitle', (_e, p) => mpvReady && mpv.loadSubtitle(p))
  ipcMain.handle('mpv:subtitle-visible', (_e, v) => mpvReady && mpv.setSubtitleVisible(v))
  ipcMain.handle('mpv:stop', () => mpvReady && mpv.stopPlayback())
  ipcMain.handle('mpv:screenshot', async (_e, suggestedName) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('pictures'), String(suggestedName || 'AI播放器截图.png')),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }]
    })
    return result.canceled || !result.filePath ? false : mpvReady && mpv.screenshot(result.filePath)
  })

  ipcMain.on('context:show', (_event, state = {}) => {
    const item = (label, action, extra = {}) => ({ label, click: () => sendAction(action), ...extra })
    const contextMenu = Menu.buildFromTemplate([
      item(state.isPlaying ? '暂停' : '播放', 'play-toggle', { enabled: !!state.hasMedia }),
      item('后退 10 秒', 'seek-backward', { enabled: !!state.hasMedia }),
      item('前进 10 秒', 'seek-forward', { enabled: !!state.hasMedia }),
      { type: 'separator' },
      item('截取当前画面…', 'screenshot', { enabled: !!state.hasMedia }),
      item(state.subtitleVisible ? '关闭字幕' : '打开字幕', 'subtitle-toggle', { enabled: !!state.hasMedia }),
      item('拉片与原创重构…', 'analysis-studio', { enabled: !!state.hasMedia }),
      { label: '播放速度', submenu: [0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => item(`${rate}×`, `speed-${rate}`, { type: 'radio', checked: state.playbackRate === rate })) },
      { label: '画面比例', submenu: [
        item('原始比例（大画面自动缩小）', 'picture-original', { type: 'radio', checked: state.pictureMode === 'original' }),
        item('完整显示（推荐）', 'picture-fit', { type: 'radio', checked: state.pictureMode === 'fit' }),
        item('裁剪铺满（可能隐藏边缘）', 'picture-fill', { type: 'radio', checked: state.pictureMode === 'fill' }),
        item('拉伸铺满（可能变形）', 'picture-stretch', { type: 'radio', checked: state.pictureMode === 'stretch' })
      ] },
      { label: '窗口大小', submenu: [
        item('原始窗口', 'window-original'), item('1/2 屏窗口', 'window-half'),
        item('铺满桌面', 'window-fill'), item('全屏窗口', 'window-fullscreen')
      ] },
      { type: 'separator' },
      item('打开文件…', 'open-file')
    ])
    contextMenu.popup({ window: mainWindow })
  })
  ipcMain.handle('window:setPreset', (_e, preset, mediaSize) => setWindowPreset(preset, mediaSize))
  ipcMain.handle('window:setPlaybackChromeVisible', (_e, visible) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    if (process.platform !== 'darwin') mainWindow.setMenuBarVisibility(Boolean(visible))
    return true
  })
  ipcMain.handle('window:isPlaybackChromeVisible', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    return process.platform === 'darwin' ? true : mainWindow.isMenuBarVisible()
  })
  ipcMain.handle('screenshot:save', async (_e, dataUrl, suggestedName) => {
    try {
      const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''))
      if (!match) throw new Error('截图数据格式无效')
      const buffer = Buffer.from(match[1], 'base64')
      if (buffer.length > 50 * 1024 * 1024) throw new Error('截图超过 50MB')
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: path.join(app.getPath('pictures'), String(suggestedName || 'AI播放器截图.png')),
        filters: [{ name: 'PNG 图片', extensions: ['png'] }]
      })
      if (result.canceled || !result.filePath) return false
      fs.writeFileSync(result.filePath, buffer)
      return true
    } catch (error) {
      log.error('截图保存失败', error)
      return false
    }
  })

  // IPC：对话流式输出、取消，以及按角色隔离的模型配置。
  ipcMain.handle('ai:chat', async (event, messages, context, requestedId) => {
    assertTrustedSender(event)
    const requestId = normalizeRequestId(requestedId, 'chat')
    activeAiRequests.get(requestId)?.abort()
    const controller = new AbortController()
    activeAiRequests.set(requestId, controller)
    let usesBundledRuntime = false
    const send = (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai:stream', { requestId, ...payload })
    }
    try {
      send({ status: 'queued' })
      let chatConfig = modelConfigStore.resolved('chat')
      if (chatConfig.providerId === 'bundled-lite') {
        send({ status: 'loading-local-model' })
        const localStatus = await bundledRuntime.start()
        bundledRuntime.retain()
        usesBundledRuntime = true
        chatConfig = { ...chatConfig, model: localStatus.model, baseUrl: localStatus.baseUrl }
      }
      const result = await agentEngine.chat(messages, chatConfig, context, {
        signal: controller.signal,
        onStatus: (status) => send({ status }),
        onDelta: (delta) => send({ delta })
      })
      send({ status: result.cancelled ? 'cancelled' : 'done' })
      return { ...result, requestId }
    } finally {
      if (usesBundledRuntime) bundledRuntime.release()
      activeAiRequests.delete(requestId)
    }
  })
  ipcMain.handle('ai:cancel', (event, requestId) => {
    assertTrustedSender(event)
    const controller = activeAiRequests.get(String(requestId || ''))
    controller?.abort()
    return Boolean(controller)
  })
  ipcMain.handle('models:providers', (event) => {
    assertTrustedSender(event)
    return PROVIDERS
  })
  ipcMain.handle('models:config', (event, role = 'chat') => {
    assertTrustedSender(event)
    return modelConfigStore.publicConfig(role)
  })
  ipcMain.handle('models:save', (event, config) => {
    assertTrustedSender(event)
    return modelConfigStore.save(config)
  })
  ipcMain.handle('models:list', async (event, config = {}) => {
    assertTrustedSender(event)
    try {
      const saved = modelConfigStore.resolved(config.role || 'chat')
      const apiKey = config.apiKey || (config.useSavedKey && config.providerId === saved.providerId ? saved.apiKey : '')
      const localStatus = config.providerId === 'bundled-lite' ? await bundledRuntime.start() : null
      return { success: true, models: await listModels({ ...config, apiKey, ...(localStatus ? { model: localStatus.model, baseUrl: localStatus.baseUrl } : {}) }) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), models: [] }
    }
  })
  ipcMain.handle('models:test', async (event, config = {}) => {
    assertTrustedSender(event)
    try {
      const saved = modelConfigStore.resolved(config.role || 'chat')
      const apiKey = config.apiKey || (config.useSavedKey && config.providerId === saved.providerId ? saved.apiKey : '')
      const localStatus = config.providerId === 'bundled-lite' ? await bundledRuntime.start() : null
      const result = await probeConnection({ ...config, apiKey, ...(localStatus ? { model: localStatus.model, baseUrl: localStatus.baseUrl } : {}) })
      const detail = result.generationVerified ? '，并已完成最小生成验证' : ''
      return { success: true, message: `连接成功，返回 ${result.models.length} 个可用模型${detail}` }
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('models:discover-local', async (event, role = 'chat') => {
    assertTrustedSender(event)
    return discoverLocalServices(role)
  })
  ipcMain.handle('models:bundled-status', (event) => {
    assertTrustedSender(event)
    return bundledRuntime.status()
  })
  ipcMain.handle('models:start-bundled', async (event) => {
    assertTrustedSender(event)
    return bundledRuntime.start()
  })
  ipcMain.handle('models:stop-bundled', async (event) => {
    assertTrustedSender(event)
    return bundledRuntime.stop()
  })

  ipcMain.handle('studio:context', (event, mediaPath) => {
    assertTrustedSender(event)
    return loadAnalysisContext(mediaPath)
  })
  ipcMain.handle('studio:capabilities', (event) => {
    assertTrustedSender(event)
    const renderBinary = mpv?.getBinaryPath()
    const voiceHelper = process.platform === 'win32'
      ? (app.isPackaged ? path.join(process.resourcesPath, 'bin', 'win', 'ai-player-voice.exe') : path.join(__dirname, '..', 'resources', 'bin', 'win', 'ai-player-voice.exe'))
      : null
    const systemVoiceAvailable = process.platform === 'win32'
      ? Boolean(voiceHelper && fs.existsSync(voiceHelper))
      : process.platform === 'darwin'
        ? fs.existsSync('/usr/bin/say')
        : ['/usr/bin/espeak-ng', '/usr/local/bin/espeak-ng'].some((candidate) => fs.existsSync(candidate))
    return {
      platform: process.platform,
      multimodalPlanning: true,
      cloudImage: true,
      cloudVoice: true,
      systemVoice: systemVoiceAvailable,
      advancedRender: Boolean(renderBinary && fs.existsSync(renderBinary)),
      renderBinary: renderBinary && fs.existsSync(renderBinary) ? path.basename(renderBinary) : null
    }
  })
  ipcMain.handle('studio:offline-analysis', (event, input = {}) => {
    assertTrustedSender(event)
    return buildOfflineAnalysis(input)
  })
  ipcMain.handle('studio:export-project', async (event, project = {}) => {
    assertTrustedSender(event)
    const serialized = JSON.stringify(project, null, 2)
    if (Buffer.byteLength(serialized, 'utf8') > 10 * 1024 * 1024) throw new Error('项目文件超过 10MB')
    const safeName = String(project.mediaName || '视频').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\.[^.]+$/, '')
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('documents'), `${safeName}-AI拉片项目.aiproj.json`),
      filters: [{ name: 'AI播放器拉片项目', extensions: ['aiproj.json', 'json'] }]
    })
    if (result.canceled || !result.filePath) return { success: false, cancelled: true }
    fs.writeFileSync(result.filePath, serialized, 'utf8')
    return { success: true, outputPath: result.filePath }
  })
  ipcMain.handle('studio:render', async (event, input = {}) => {
    assertTrustedSender(event)
    if (activeRecutProcess && !activeRecutProcess.killed) throw new Error('已有原创重构任务正在渲染')
    const safeName = String(input.mediaName || '原创重构').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\.[^.]+$/, '')
    const destination = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('videos'), `${safeName}-原创重构.mp4`),
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
    })
    if (destination.canceled || !destination.filePath) return { success: false, cancelled: true }
    try {
      const playbackBinary = mpv.getBinaryPath()
      const renderBinary = process.platform === 'win32' && fs.existsSync(playbackBinary.replace(/\.exe$/i, '.com'))
        ? playbackBinary.replace(/\.exe$/i, '.com')
        : playbackBinary
      return await renderRecut({
        mpvPath: renderBinary,
        sourcePath: input.sourcePath,
        segments: input.segments,
        outputPath: destination.filePath,
        onSpawn: (child) => { activeRecutProcess = child }
      })
    } finally {
      activeRecutProcess = null
    }
  })
  ipcMain.handle('studio:creative-plan', async (event, input = {}) => {
    assertTrustedSender(event)
    return requestCreativePlan(modelConfigStore.resolved('chat'), input)
  })
  ipcMain.handle('studio:generate-image', async (event, input = {}) => {
    assertTrustedSender(event)
    return generateImageAsset(modelConfigStore.resolved('chat'), {
      ...input,
      outputDir: path.join(app.getPath('userData'), 'creative-assets', 'images')
    })
  })
  ipcMain.handle('studio:generate-voice', async (event, input = {}) => {
    assertTrustedSender(event)
    const request = {
      ...input,
      outputDir: path.join(app.getPath('userData'), 'creative-assets', 'voice'),
      helperPath: app.isPackaged
        ? path.join(process.resourcesPath, 'bin', 'win', 'ai-player-voice.exe')
        : path.join(__dirname, '..', 'resources', 'bin', 'win', 'ai-player-voice.exe')
    }
    return input.engine === 'cloud'
      ? synthesizeCloudVoice(modelConfigStore.resolved('chat'), request)
      : synthesizeSystemVoice(request)
  })
  ipcMain.handle('studio:select-asset', async (event, kind) => {
    assertTrustedSender(event)
    const image = kind === 'image'
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: image
        ? [{ name: '图片素材', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
        : [{ name: '音频素材', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'aiff'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('studio:render-creative', async (event, input = {}) => {
    assertTrustedSender(event)
    if (activeRecutProcess && !activeRecutProcess.killed) throw new Error('已有创作或渲染任务正在运行')
    const safeName = String(input.mediaName || input.title || 'AI原创成片').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\.[^.]+$/, '')
    const destination = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('videos'), `${safeName}-AI原创成片.mp4`),
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
    })
    if (destination.canceled || !destination.filePath) return { success: false, cancelled: true }
    try {
      const playbackBinary = mpv.getBinaryPath()
      const renderBinary = process.platform === 'win32' && fs.existsSync(playbackBinary.replace(/\.exe$/i, '.com'))
        ? playbackBinary.replace(/\.exe$/i, '.com')
        : playbackBinary
      return await renderCreativeVideo({
        mpvPath: renderBinary,
        input,
        outputPath: destination.filePath,
        onSpawn: (child) => { activeRecutProcess = child }
      })
    } finally {
      activeRecutProcess = null
    }
  })
  ipcMain.handle('studio:cancel-render', (event) => {
    assertTrustedSender(event)
    return stopActiveRender()
  })

  ipcMain.handle('computerUse:suggest', async (event, task, requestedId) => {
    assertTrustedSender(event)
    const requestId = normalizeRequestId(requestedId, 'observe')
    activeComputerUseRequests.get(requestId)?.abort()
    const controller = new AbortController()
    activeComputerUseRequests.set(requestId, controller)
    const sendStatus = (status) => {
      if (!event.sender.isDestroyed()) event.sender.send('computerUse:status', { requestId, status })
    }
    try {
      sendStatus('capturing')
      const result = await computerUseOrchestrator.suggest({
        task,
        config: modelConfigStore.resolved('computerUse'),
        signal: controller.signal,
        onStatus: sendStatus
      })
      sendStatus('done')
      return { ...result, requestId }
    } finally {
      activeComputerUseRequests.delete(requestId)
    }
  })
  ipcMain.handle('computerUse:cancel', (event, requestId) => {
    assertTrustedSender(event)
    const controller = activeComputerUseRequests.get(String(requestId || ''))
    controller?.abort()
    return Boolean(controller)
  })

  ipcMain.handle('files:scan', (_e, dir) => scanDir(dir || defaultVideoDir()))
  ipcMain.handle('files:defaultDir', () => defaultVideoDir())
  ipcMain.handle('files:readText', async (_e, filePath) => {
    try {
      const stat = fs.statSync(filePath)
      const ext = path.extname(filePath).toLowerCase()
      if (!stat.isFile() || !['text', 'subtitle'].includes(getType(ext))) throw new Error('只允许读取支持的文本文件')
      if (stat.size > 2 * 1024 * 1024) throw new Error('文本文件超过 2MB 预览上限')
      const content = fs.readFileSync(filePath, 'utf-8')
      return { success: true, content: content.slice(0, 100000) }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
  ipcMain.handle('files:readDataUrl', async (_e, filePath) => {
    try {
      const stat = fs.statSync(filePath)
      const type = getType(path.extname(filePath).toLowerCase())
      if (!stat.isFile() || !['image', 'pdf'].includes(type)) throw new Error('只允许读取图片或 PDF')
      if (stat.size > 50 * 1024 * 1024) throw new Error('文件超过 50MB 预览上限')
      const buffer = fs.readFileSync(filePath)
      const ext = path.extname(filePath).slice(1).toLowerCase()
      const mimeMap = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
        bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
        tif: 'image/tiff', tiff: 'image/tiff',
        pdf: 'application/pdf'
      }
      const mime = mimeMap[ext] || 'application/octet-stream'
      return { success: true, dataUrl: 'data:' + mime + ';base64,' + buffer.toString('base64') }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
  ipcMain.handle('print:file', (_e, p) => printFile(p))
  ipcMain.handle('print:text', async (_e, filePath) => {
    try {
      const content = require('fs').readFileSync(filePath, 'utf-8').slice(0, 50000)
      const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const win = new BrowserWindow({ show: false })
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<pre style="font-family:monospace;white-space:pre-wrap;padding:20px">' + escaped + '</pre>'))
      win.webContents.print({ printBackground: true })
      setTimeout(() => win.close(), 2000)
      return { success: true, action: '已发送打印' }
    } catch (e) { return { success: false, error: String(e) } }
  })
  ipcMain.handle('wifi:url', async () => {
    if (!wifiTransfer) return null
    try {
      if (!wifiTransfer.server) await wifiTransfer.start()
      return wifiTransfer.getUrl()
    } catch (error) {
      log.error('用户启用 WiFi 传输失败', error)
      return null
    }
  })
  ipcMain.handle('wifi:pin', () => (wifiTransfer?.server ? wifiTransfer.getPin() : null))
  ipcMain.handle('wifi:stop', () => { wifiTransfer?.stop(); return true })
  ipcMain.handle('tmdb:search', (_e, name, apiKey) => searchMovie(name, apiKey || process.env.TMDB_API_KEY))
  ipcMain.handle('subtitle:search', (_e, name, apiKey) => searchSubtitle(name, apiKey || process.env.OPENSUBTITLES_API_KEY))
  ipcMain.handle('subtitle:download', (_e, fileId, apiKey) => downloadSubtitle(fileId, apiKey || process.env.OPENSUBTITLES_API_KEY))
  ipcMain.handle('media:analyze', (_e, dir) => {
    const files = analyzeDir(dir || defaultVideoDir())
    return { files, clusters: clusterByTag(files) }
  })
  ipcMain.handle('media:dedup', (_e, dir) => {
    const files = analyzeDir(dir || defaultVideoDir())
    return findDuplicates(files)
  })
  ipcMain.handle('media:suggest', (_e, dir) => {
    const files = analyzeDir(dir || defaultVideoDir())
    return suggestClip(files)
  })
  ipcMain.handle('dlna:serverUrl', async () => {
    if (!dlnaServer) return null
    try {
      if (!dlnaServer.server) await dlnaServer.start(defaultVideoDir())
      return `http://${require('./utils').getLanIp()}:${dlnaServer.port}`
    } catch (error) {
      log.error('用户启用 DLNA 媒体库失败', error)
      return null
    }
  })
  ipcMain.handle('dlna:serverStop', () => { dlnaServer?.stop(); return true })
  ipcMain.handle('receiver:start', async () => {
    if (!dlnaReceiver) return false
    try {
      if (!dlnaReceiver.httpServer) await dlnaReceiver.start()
      return true
    } catch (error) {
      log.error('用户启用 DLNA 接收失败', error)
      return false
    }
  })
  ipcMain.handle('receiver:stop', () => { dlnaReceiver?.stop(); return true })
  ipcMain.handle('plugin:list', () => listPlugins())
  ipcMain.handle('plugin:openFolder', async () => {
    const { shell } = require('electron')
    const { PLUGIN_DIR } = require('./plugin-service')
    fs.mkdirSync(PLUGIN_DIR, { recursive: true })
    const error = await shell.openPath(PLUGIN_DIR)
    return error ? { success: false, error } : { success: true }
  })
  ipcMain.handle('cast:scan', () => castService.scan())
  ipcMain.handle('cast:cast', (_e, deviceId, filePath) => castService.cast(deviceId, filePath))
  ipcMain.handle('dialog:openFile', () => chooseFile())
  ipcMain.handle('dialog:openFolder', async () => { const { dialog } = require('electron'); const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0] })
  ipcMain.handle('system:openPath', async (_e, filePath) => {
    const { shell } = require('electron')
    if (!fs.existsSync(filePath)) return { success: false, error: '文件不存在' }
    const error = await shell.openPath(filePath)
    return error ? { success: false, error } : { success: true }
  })
  ipcMain.handle('docx:preview', (_e, filePath) => previewDocx(filePath))
  ipcMain.handle('xlsx:preview', (_e, filePath) => previewXlsx(filePath))
  ipcMain.handle('sync:url', async () => {
    if (!syncService) return null
    try {
      if (!syncService.server) await syncService.start()
      return syncService.getUrl()
    } catch (error) {
      log.error('用户启用跨设备同步失败', error)
      return null
    }
  })
  ipcMain.handle('sync:stop', () => { syncService?.stop(); return true })
  ipcMain.handle('sync:setPeer', (_e, url) => {
    return syncService?.setPeer(url) ?? false
  })
  ipcMain.handle('sync:upload', () => syncService.upload())
  ipcMain.handle('sync:download', () => syncService.download())
  ipcMain.handle('sync:getProgress', (_e, key) => syncService.getProgress(key))
  ipcMain.handle('sync:setProgress', (_e, key, position, preferences) => {
    syncService.setProgress(key, position, preferences)
    return true
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  for (const controller of activeAiRequests.values()) controller.abort()
  for (const controller of activeComputerUseRequests.values()) controller.abort()
  if (mpv) mpv.stop()
  if (mpvContainer && !mpvContainer.isDestroyed()) mpvContainer.destroy()
  if (wifiTransfer) wifiTransfer.stop()
  if (castService) castService.stop()
  if (syncService) syncService.stop()
  if (dlnaReceiver) dlnaReceiver.stop()
  if (dlnaServer) dlnaServer.stop()
  if (bundledRuntime) void bundledRuntime.stop()
  stopActiveRender()
})
