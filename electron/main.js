// AI播放器 Electron 主进程
// dev: 加载 Vite dev server；prod: 加载构建产物
// 集成 mpv sidecar，IPC 桥接渲染进程
const { app, BrowserWindow, ipcMain, Menu } = require('electron')
const path = require('path')
const { MpvService } = require('./mpv-service')
const { AgentEngine } = require('./llm-service')
const { scanDir, defaultVideoDir } = require('./file-service')
const { printFile } = require('./print-file')
const { WifiTransfer } = require('./wifi-transfer')
const { searchMovie } = require('./tmdb-service')
const { CastService } = require('./cast-service')
const { SyncService } = require('./sync-service')

const isDev = !app.isPackaged
let mpv = null
let agentEngine = null
let wifiTransfer = null
let castService = null
let syncService = null
let mainWindow = null
let mpvContainer = null
let playerArea = null

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
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
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

const menuTemplate = [
  { label: '文件', submenu: [{ role: 'quit', label: '退出' }] },
  { label: '功能', submenu: [{ label: 'Agent 对话', click: () => mainWindow?.webContents.send('menu:agent') }] },
  { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭' }] },
  { label: '帮助', submenu: [{ label: '关于 AI播放器' }] }
]
Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate))

app.whenReady().then(async () => {
  const win = createWindow()

  mpv = new MpvService()
  await mpv.start(null)

  agentEngine = new AgentEngine(mpv)

  wifiTransfer = new WifiTransfer()
  try { wifiTransfer.start() } catch (e) { console.error('WiFi 传输启动失败:', e) }

  castService = new CastService()

  syncService = new SyncService()
  try { syncService.start() } catch (e) { console.error('同步服务启动失败:', e) }

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
  ipcMain.handle('mpv:load', (_e, p) => { mpv.loadFile(p); return true })
  ipcMain.handle('mpv:play', () => { mpv.play(); return true })
  ipcMain.handle('mpv:pause', () => { mpv.pause(); return true })
  ipcMain.handle('mpv:seek', (_e, s) => { mpv.seek(s); return true })
  ipcMain.handle('mpv:volume', (_e, v) => { mpv.setVolume(v); return true })
  ipcMain.handle('mpv:subtitle', (_e, p) => { mpv.loadSubtitle(p); return true })
  ipcMain.handle('mpv:subtitle-visible', (_e, v) => { mpv.setSubtitleVisible(v); return true })

  // IPC：Agent 对话（function calling 控制播放）
  ipcMain.handle('ai:chat', (_e, messages) => agentEngine.chat(messages))

  ipcMain.handle('files:scan', (_e, dir) => scanDir(dir || defaultVideoDir()))
  ipcMain.handle('files:defaultDir', () => defaultVideoDir())
  ipcMain.handle('print:file', (_e, p) => printFile(p))
  ipcMain.handle('wifi:url', () => (wifiTransfer ? wifiTransfer.getUrl() : null))
  ipcMain.handle('tmdb:search', (_e, name) => searchMovie(name, process.env.TMDB_API_KEY))
  ipcMain.handle('cast:scan', () => castService.scan())
  ipcMain.handle('cast:cast', (_e, deviceId, filePath) => castService.cast(deviceId, filePath))
  ipcMain.handle('sync:url', () => (syncService ? syncService.getUrl() : null))
  ipcMain.handle('sync:setPeer', (_e, url) => {
    syncService?.setPeer(url)
    return true
  })
  ipcMain.handle('sync:upload', () => syncService.upload())
  ipcMain.handle('sync:download', () => syncService.download())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (mpv) mpv.stop()
  if (mpvContainer && !mpvContainer.isDestroyed()) mpvContainer.destroy()
  if (wifiTransfer) wifiTransfer.stop()
  if (castService) castService.stop()
  if (syncService) syncService.stop()
})
