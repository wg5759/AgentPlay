// AI播放器 Electron 主进程
// dev: 加载 Vite dev server；prod: 加载构建产物
// 集成 mpv sidecar，IPC 桥接渲染进程
const { app, BrowserWindow, ipcMain } = require('electron')
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

app.whenReady().then(async () => {
  const win = createWindow()

  // 启动 mpv sidecar
  mpv = new MpvService()
  await mpv.start()

  agentEngine = new AgentEngine(mpv)

  wifiTransfer = new WifiTransfer()
  wifiTransfer.start()

  castService = new CastService()

  syncService = new SyncService()
  syncService.start()

  // mpv 事件转发渲染进程
  mpv.on((event, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mpv:event', { event, data })
    }
  })

  // IPC：渲染进程 -> mpv
  ipcMain.handle('mpv:load', (_e, p) => { mpv.loadFile(p); return true })
  ipcMain.handle('mpv:play', () => { mpv.play(); return true })
  ipcMain.handle('mpv:pause', () => { mpv.pause(); return true })
  ipcMain.handle('mpv:seek', (_e, s) => { mpv.seek(s); return true })
  ipcMain.handle('mpv:volume', (_e, v) => { mpv.setVolume(v); return true })
  ipcMain.handle('mpv:subtitle', (_e, p) => { mpv.loadSubtitle(p); return true })

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
  if (wifiTransfer) wifiTransfer.stop()
})
