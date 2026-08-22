// AgentPlay Electron 主进程
// dev: 加载 Vite dev server；prod: 加载构建产物
// 集成 mpv sidecar，IPC 桥接渲染进程
const { app, BrowserWindow, ipcMain, Menu, dialog, safeStorage, session, desktopCapturer, globalShortcut } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const ExcelJS = require('exceljs')
const { execFileSync, spawn } = require('child_process')
const { MpvService } = require('./mpv-service')
const { requestScreenGuide, askAboutImage } = require('./screen-guide-service')
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
const { analyzeDir, analyzeDirAsync, clusterByTag, findDuplicates, suggestClip } = require('./media-service')
const { DlnaServer } = require('./dlna-server')
const { PluginSkillService, PLUGIN_DIR } = require('./plugin-service')
const { replacePluginContributions } = require('./agent-tool-registry')
const { PROVIDERS, listModels, probeConnection, detectVolcenginePlan, VOLCENGINE_CODING_BASE_URL, VOLCENGINE_CODING_MODELS, normalizeConfig, normalizeProviderModels } = require('./model-providers')
const { discoverLocalServices } = require('./local-model-discovery')
const { ModelConfigStore } = require('./model-config-store')
const { ModelPerformanceRouter, modelKey, taskKindForPersistentType } = require('./model-performance-router')
const { chooseDocumentModel, cloudFallbackFromStore, contextWindowForConfig, maxOutputTokensForConfig } = require('./model-context-policy')
const { ServiceCredentialStore } = require('./service-credential-store')
const { ModelCatalog } = require('./model-catalog')
const { ComputerUseProvider } = require('./adapters/computer-use-provider')
const { ComputerUseOrchestrator } = require('./computer-use-orchestrator')
const { ScreenCaptureService } = require('./screen-capture-service')
const { BundledLocalRuntime } = require('./bundled-local-runtime')
const { extractExternalMediaPaths, hasDocumentVerbFlag, extractDocumentVerbPaths } = require('./external-media-open')
const { buildOfflineAnalysis, loadAnalysisContext, renderRecut, findAdjacentSubtitle, parseSubtitleCues } = require('./analysis-studio-service')
const { detectAnalysisIntent, resolveAnalysisOutput, runChatAnalysis } = require('./analysis-chat-service')
const { runLiveTranscribe, cuesToSrt } = require('./live-transcribe-service')
const {
  generateImageAsset,
  renderCreativeVideo,
  requestCreativePlan,
  synthesizeCloudVoice,
  synthesizeSystemVoice
} = require('./creative-studio-service')
const { generateVideoAsset } = require('./creative-studio-service')
const { DocumentWorkspaceService, SUPPORTED_EXTENSIONS, extractText, pdfPageCount } = require('./document-workspace-service')
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']
const AUDIO_MEDIA_EXTS = ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.wma']
const { WinRtOcrService } = require('./ocr-service')
const { UnlimitedOcrConfigStore, UnlimitedOcrService, isLoopbackEndpoint } = require('./unlimited-ocr-service')
const { LanguageDetectService } = require('./language-detect-service')
const { OfficeConvertService } = require('./office-convert-service')
const { TranscriptionService } = require('./transcription-service')
const { parseSrt, buildTranslationOnlySrt, chooseOppositeTarget, translateEntries, cuesToEntries, runLiveTranslation } = require('./subtitle-bilingual-service')
const { chooseSubtitleEngine } = require('./subtitle-engine-policy')
const { buildWhisperRecovery, buildOfflineTranslateRecovery, buildCloudTranslateRecovery } = require('./subtitle-recovery-policy')
const { buildTranscriptionStatus, subtitleMediaKey } = require('./subtitle-job-policy')
const { splitOpenAnyPaths, isPathInsideRoots } = require('./open-any')
const { downloadRemoteMedia, extractUrl, isDownloadIntent, isMediaUrl } = require('./media-download-service')
const { rasterizePdfPages } = require('./pdf-rasterizer')
const { LocalAiDownloadService } = require('./local-ai-download-service')
const { PersistentTaskRuntime } = require('./persistent-task-runtime')
const { snapshotDocumentSources, validateDocumentSources, outputsStillExist } = require('./persistent-document-task')
const { evaluateTaskResult, classifyTaskFailure } = require('./task-result-quality')
const { compileOutcomeWorkflow, assertOutcomeWorkflow } = require('./outcome-workflow')
const { OutcomeWorkflowRunner } = require('./outcome-workflow-runner')
const { ProjectCapsuleStore } = require('./project-capsule-store')
const { PublicLinkService } = require('./public-link-service')
const { videoTime, documentPage, sheetCell, imageRegion } = require('./evidence-reference')
const { CrossMaterialQaService, detectCrossMaterialQuestion } = require('./cross-material-qa-service')
const { imageSize } = require('./docx-image')
const { compileBurnSubtitlesDecisionList, compileConcatSourcesDecisionList, compileCueEditDecisionList, compileEditDecisionList, compileEditHistoryAction, compileMuxSubtitlesDecisionList, compileMusicDecisionList, compileShiftSubtitlesDecisionList, compileTranslateSubtitlesDecisionList } = require('./media-edit-decision')
const { MediaEditConversation } = require('./media-edit-conversation')
const { assertEditDecisionList, attachEditDecisionList } = require('./edit-decision-list')
const { MediaEditService, decodeSubtitleText, parseSrtCues } = require('./media-edit-service')
const { MediaEditProjectStore } = require('./media-edit-project-store')
const LOCAL_AI_PACK = require('./local-ai-pack-manifest')

process.on('uncaughtException', (error) => log.error('主进程未捕获异常', error))
process.on('unhandledRejection', (error) => log.error('主进程未处理 Promise', error))

const isDev = !app.isPackaged
let mpv = null
let agentEngine = null
let modelConfigStore = null
let modelPerformanceRouter = null
let serviceCredentialStore = null
let unlimitedOcrConfigStore = null
let unlimitedOcrService = null
let modelCatalog = null
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
let documentWorkspace = null
let localAiDownload = null
let persistentTaskRuntime = null
let pluginService = null
const pendingExternalMedia = []
const pendingDocumentFiles = []
let documentFlushTimer = null
const activeAiRequests = new Map()
const activeComputerUseRequests = new Map()
const activeDocumentRequests = new Map()
const activeAnalysisRequests = new Map()
const activeSubtitleMediaJobs = new Map()
const activeMediaDownloads = new Map()
const activeMediaTasks = new Map()
const activeCreativeTasks = new Map()
let liveSubtitleSession = null
let liveTranscribeSession = null
let mirrorReceiver = null
let mirrorSender = null
let mirrorCaptureTimer = null
let mirrorWindow = null
let mirrorDiscovery = null
let llmComplete = null
let llmCompleteVisionMulti = null
const approvedDocumentSelections = new Map()
const authorizedFolders = new Set()
const userAuthorizedPaths = new Set()

ipcMain.on('app:version', (event) => {
  assertTrustedSender(event)
  event.returnValue = app.getVersion()
})

ipcMain.on('external-media:accepted', (event, filePath) => {
  assertTrustedSender(event)
  const acceptedPath = extractExternalMediaPaths([filePath])[0]
  if (acceptedPath) {
    userAuthorizedPaths.add(path.resolve(acceptedPath))
    log.info(`播放界面已接收外部文件: ${path.basename(acceptedPath)}`)
  }
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
  if (hasDocumentVerbFlag(argv)) return queueDocumentVerbArgs(argv)
  const filePath = extractExternalMediaPaths(argv)[0]
  if (!filePath) return false
  pendingExternalMedia.length = 0
  pendingExternalMedia.push(filePath)
  log.info(`收到系统打开文件请求: ${path.basename(filePath)}`)
  flushPendingExternalMedia()
  return true
}

function approveDocumentPaths(filePaths) {
  const files = documentWorkspace.inspect(filePaths)
  return files.map((file) => {
    const token = crypto.randomUUID()
    approvedDocumentSelections.set(token, { path: file.path, createdAt: Date.now() })
    userAuthorizedPaths.add(file.path)
    return { token, name: file.name, ext: file.ext, size: file.size, previewPath: file.path }
  })
}

function flushPendingDocuments() {
  if (pendingDocumentFiles.length === 0) return false
  if (!rendererLoaded || !mainWindow || mainWindow.isDestroyed() || !documentWorkspace) return false
  const paths = pendingDocumentFiles.splice(0)
  try {
    mainWindow.webContents.send('documents:open-external', approveDocumentPaths(paths))
    log.info(`已把 ${paths.length} 个资源管理器文档请求转交文档工作台`)
  } catch (error) {
    log.error('资源管理器文档处理请求无效', error)
  }
  return true
}

// Windows 资源管理器“用 AgentPlay 智能处理”动词：多选时每个文件会各起一个
// 进程，这里汇总后成批交给文档工作台，绝不送入播放器。
function queueDocumentVerbArgs(argv) {
  const paths = extractDocumentVerbPaths(argv, { allowedExtensions: SUPPORTED_EXTENSIONS })
  if (paths.length === 0) return false
  const identityOf = (filePath) => (process.platform === 'win32' ? filePath.toLowerCase() : filePath)
  const seen = new Set(pendingDocumentFiles.map(identityOf))
  for (const filePath of paths) {
    if (seen.has(identityOf(filePath)) || pendingDocumentFiles.length >= 20) continue
    seen.add(identityOf(filePath))
    pendingDocumentFiles.push(filePath)
  }
  if (pendingDocumentFiles.length === 0) return false
  log.info(`收到资源管理器文档处理请求: ${paths.map((filePath) => path.basename(filePath)).join(', ')}`)
  if (documentFlushTimer) clearTimeout(documentFlushTimer)
  documentFlushTimer = setTimeout(() => {
    documentFlushTimer = null
    flushPendingDocuments()
  }, 700)
  if (typeof documentFlushTimer.unref === 'function') documentFlushTimer.unref()
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

// 创作类功能（生图/生视频/重构短片）天然需要云端大模型：当前 chat 切了本地小模型时，
// 自动使用一键切换时 stash 的云端配置（含加密 Key），用户无感；无 stash 才回落当前配置。
function creativeConfig() {
  const config = modelConfigStore.resolved('chat')
  // bundled-lite 与订阅类 CLI（codex/claude）都没有云端协议端点：回退 stash 云端配置
  const needsCloud = config.providerId === 'bundled-lite' || config.providerId === 'codex-chatgpt' || config.providerId === 'claude-code'
  if (!needsCloud) return config
  const stashed = modelConfigStore.readDocument().stash?.chat
  // stash 也可能是早期版本误存的非云端配置：视同无 stash，给出明确引导而非拿 cli 配置去撞云端协议
  if (!stashed || stashed.providerId === 'bundled-lite' || stashed.providerId === 'codex-chatgpt' || stashed.providerId === 'claude-code') return config
  return normalizeConfig({ ...stashed, role: 'chat', apiKey: modelConfigStore.decrypt(stashed.encryptedApiKey) }, 'chat')
}

function cloudConfigForExplicitFeature() {
  const settings = modelPerformanceRouter?.status([])?.settings
  if (settings?.preference === 'local') throw new Error('当前设置为“只在本机”；如需这项云端能力，请先切换为“智能选择”或“优先效果”')
  return creativeConfig()
}

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

// 屏幕指路覆盖层：透明、点击穿透、置顶，15 秒自动消失
let guideOverlay = null
let guideOverlayTimer = null
function dismissGuideOverlay() {
  if (guideOverlayTimer) { clearTimeout(guideOverlayTimer); guideOverlayTimer = null }
  if (guideOverlay && !guideOverlay.isDestroyed()) guideOverlay.destroy()
  guideOverlay = null
}
// 覆盖层内以 0-1000 归一化坐标画圈与箭头（注入执行，勿引用外层变量）
function drawGuideMarks(marks) {
  const svg = document.getElementById('s')
  const w = window.innerWidth
  const h = window.innerHeight
  const px = (v) => (v / 1000) * w
  const py = (v) => (v / 1000) * h
  let inner = '<defs><marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#6c70ff"/></marker></defs>'
  for (const mark of marks) {
    if (mark.type === 'circle') {
      inner += `<circle cx="${px(mark.x)}" cy="${py(mark.y)}" r="42" fill="none" stroke="#6c70ff" stroke-width="4" opacity="0.95"><animate attributeName="r" values="34;46;34" dur="1.6s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.95;0.5;0.95" dur="1.6s" repeatCount="indefinite"/></circle>`
      inner += `<circle cx="${px(mark.x)}" cy="${py(mark.y)}" r="5" fill="#6c70ff"/>`
    } else if (mark.type === 'arrow') {
      inner += `<line x1="${px(mark.x)}" y1="${py(mark.y)}" x2="${px(mark.toX)}" y2="${py(mark.toY)}" stroke="#6c70ff" stroke-width="5" stroke-linecap="round" marker-end="url(#ah)"/>`
      inner += `<circle cx="${px(mark.toX)}" cy="${py(mark.toY)}" r="30" fill="none" stroke="#6c70ff" stroke-width="3" opacity="0.7"/>`
    }
  }
  svg.innerHTML = inner
}
function showGuideOverlay(marks, durationMs = 15000) {
  dismissGuideOverlay()
  guideOverlay = new BrowserWindow({
    fullscreen: true, transparent: true, frame: false, skipTaskbar: true,
    focusable: false, hasShadow: false, resizable: false, movable: false,
    webPreferences: { sandbox: true }
  })
  guideOverlay.setAlwaysOnTop(true, 'screen-saver')
  guideOverlay.setIgnoreMouseEvents(true, { forward: true })
  const html = '<!doctype html><html><body style="margin:0;overflow:hidden;background:transparent"><svg id="s" style="position:fixed;inset:0;width:100vw;height:100vh"></svg></body></html>'
  guideOverlay.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  guideOverlay.webContents.once('did-finish-load', () => {
    if (guideOverlay && !guideOverlay.isDestroyed()) {
      guideOverlay.webContents.executeJavaScript(`(${drawGuideMarks.toString()})(${JSON.stringify(marks)})`).catch(() => {})
    }
  })
  guideOverlayTimer = setTimeout(dismissGuideOverlay, durationMs)
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
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (process.platform !== 'darwin') mainWindow.setMenuBarVisibility(false)

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
    flushPendingDocuments()
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

function assertPrintablePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('打印路径无效')
  const resolved = path.resolve(filePath)
  if (userAuthorizedPaths.has(resolved)) return resolved
  // 媒体库扫描目录与常用目录内的文件同样可打印（此前只放行显式选过的路径，库里点打印必静默失败）
  if (isPathInsideRoots(resolved, allowedRoots(), { realpathSync: (value) => fs.realpathSync(value) })) return resolved
  throw new Error('只允许打印经你明确选择过、媒体库或常用目录内的文件')
}

// 共享路径门禁：授权文件夹、默认媒体目录与常用用户目录内才放行；
// 敏感凭证文件与（按需）可执行扩展名一律拒绝；先解析真实路径再校验，防软链绕过
const SENSITIVE_FILE = /(?:^|[\\/])\.env(?:\.|$)|(?:^|[\\/])\.git-credentials$|(?:^|[\\/])\.ssh[\\/]|\.(?:pem|key|pfx|p12|pgpass|netrc|npmrc)$|(?:^|[\\/])web\.config$|(?:^|[\\/])(?:id_rsa|id_ed25519|id_dsa|\.aws[\\/]credentials)$/i
const EXECUTABLE_EXTS = new Set(['.exe', '.bat', '.cmd', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp', '.com', '.scr', '.pif', '.lnk', '.ps1', '.reg', '.dll'])

function allowedRoots() {
  const roots = new Set([...authorizedFolders])
  const home = path.resolve(os.homedir())
  for (const dir of [defaultVideoDir(), app.getPath('videos'), app.getPath('documents'), app.getPath('downloads'), app.getPath('desktop'), app.getPath('music')]) {
    // defaultVideoDir 退化到整个 home 时不得整盘放开
    if (dir && path.resolve(dir) !== home) roots.add(dir)
  }
  return [...roots]
}

function assertAllowedPath(filePath, { denyExecutable = false } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('路径无效')
  let resolved = path.resolve(filePath)
  try { resolved = fs.realpathSync(resolved) } catch { /* 文件不存在时按词法路径校验 */ }
  if (SENSITIVE_FILE.test(resolved)) throw new Error('该文件属于敏感凭证，禁止访问')
  if (denyExecutable && EXECUTABLE_EXTS.has(path.extname(resolved).toLowerCase())) throw new Error('不允许打开可执行文件')
  if (userAuthorizedPaths.has(resolved) || userAuthorizedPaths.has(path.resolve(filePath))) return resolved
  if (isPathInsideRoots(resolved, allowedRoots(), { realpathSync: (value) => fs.realpathSync(value) })) return resolved
  throw new Error('只允许访问你明确授权过、媒体库或常用目录内的文件')
}

const SUBTITLE_ARTIFACT_EXTS = new Set(['.srt', '.vtt', '.ass', '.ssa', '.sub'])

// 应用自己下载、识别或翻译得到的字幕是用户已授权媒体的派生产物。
// 只有已经落盘的字幕文件才能进入授权集合，避免把任意渲染端路径变成通用读取通道。
function authorizeDerivedSubtitle(subtitlePath) {
  if (typeof subtitlePath !== 'string' || !subtitlePath.trim()) throw new Error('字幕产物路径无效')
  const resolved = path.resolve(subtitlePath)
  if (!SUBTITLE_ARTIFACT_EXTS.has(path.extname(resolved).toLowerCase())) throw new Error('字幕产物格式不受支持')
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) throw new Error('字幕产物不是文件')
  if (stat.size > 20 * 1024 * 1024) throw new Error('字幕产物超过 20MB 安全上限')
  userAuthorizedPaths.add(resolved)
  log.info(`字幕产物已授权并可加载: ${path.basename(resolved)}`)
  return resolved
}

// 云端发送同意：原生对话框一次确认、本次开机内有效（渲染器自报布尔不算数）
let cloudConsentGranted = false
async function ensureCloudConsent(detail) {
  if (cloudConsentGranted) return true
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '云端发送确认',
    message: '本次任务需要把内容发送给你配置的云端模型',
    detail: `${detail}\n\n允许后本次开机内不再询问。内容只发往你配置的模型地址；不允许则改用本地处理或取消。`,
    buttons: ['不允许', '允许'],
    defaultId: 0,
    cancelId: 0
  })
  if (result.response === 1) {
    cloudConsentGranted = true
    return true
  }
  return false
}

async function ensurePersistentApproval(approval) {
  if (!approval) return true
  if (approval.action === 'cloud') return ensureCloudConsent(approval.summary)
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const isPaid = approval.action === 'paid'
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: isPaid ? '付费任务确认' : '敏感操作确认',
    message: isPaid ? '这项创作会调用可能产生费用的云端模型' : '这项任务需要你的明确授权',
    detail: `${approval.summary}\n\n确认只对当前任务有效；任务中断后会使用同一恢复令牌继续，不会重复创建已记录的云端任务。`,
    buttons: ['取消', isPaid ? '确认并开始' : '确认'],
    defaultId: 0,
    cancelId: 0
  })
  return result.response === 1
}

async function chooseFile() {
  const result = await dialog.showOpenDialog(mainWindow, openFileOptions)
  if (result.canceled) return null
  userAuthorizedPaths.add(path.resolve(result.filePaths[0]))
  return result.filePaths[0]
}

async function renderHtmlToPdf(html, finalPath) {
  const preview = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  const tempPath = `${finalPath}.${process.pid}.tmp`
  try {
    await preview.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(String(html || ''))}`)
    const buffer = await preview.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'none' }
    })
    fs.writeFileSync(tempPath, buffer)
    fs.renameSync(tempPath, finalPath)
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })
    if (!preview.isDestroyed()) preview.destroy()
  }
}

function createHiddenWindow({ width, height }) {
  return new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
}

const ocrService = new WinRtOcrService()
const languageDetect = new LanguageDetectService({
  whisperRoot: resolveWhisperRoot(),
  mpvPath: app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'win', 'mpv.com')
    : path.join(__dirname, '..', 'resources', 'bin', 'win', 'mpv.com')
})
const officeConvert = new OfficeConvertService()

function resolveWhisperRoot() {
  const packRoot = path.join(app.getPath('userData'), 'whisper-pack')
  if (fs.existsSync(path.join(packRoot, 'engine', 'whisper-cli.exe')) && fs.existsSync(path.join(packRoot, 'ggml-tiny.bin'))) return packRoot
  if (!app.isPackaged) return path.join(__dirname, '..', 'resources', 'whisper')
  return packRoot
}

const transcriptionService = new TranscriptionService({
  whisperRoot: resolveWhisperRoot(),
  mpvPath: app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'win', 'mpv.com')
    : path.join(__dirname, '..', 'resources', 'bin', 'win', 'mpv.com')
})
const WHISPER_PACK = require('./whisper-pack-manifest')
const WHISPER_SMALL_PACK = require('./whisper-small-pack-manifest')
const whisperDownload = new LocalAiDownloadService({
  installRoot: path.join(app.getPath('userData'), 'whisper-pack'),
  manifest: WHISPER_PACK,
  logger: log
})
// 精修模型（ggml-small）：与 whisper-pack 同目录安装，引擎共用
const whisperSmallDownload = new LocalAiDownloadService({
  installRoot: path.join(app.getPath('userData'), 'whisper-pack'),
  manifest: WHISPER_SMALL_PACK,
  logger: log
})
const TRANSLATE_PACK = require('./translate-pack-manifest')
const YTDLP_PACK = require('./ytdlp-pack-manifest')
const { SiteVideoService, detectCookiesDomain, normalizeCookiesText, cookiesDomainForUrl, cookiesFileForUrl } = require('./site-video-service')
const { SiteLoginService, SITE_HOME } = require('./site-login-service')
const { MirrorReceiver, MirrorSender, MirrorDiscovery } = require('./mirror-service')
const { VideoFrameService } = require('./video-frame-service')
const ytdlpDownload = new LocalAiDownloadService({
  installRoot: path.join(app.getPath('userData'), 'yt-dlp'),
  manifest: YTDLP_PACK,
  logger: log
})
// 站点登录态：App 内扫码一次，持久分区自持，cookies 过期时隐藏窗静默续期
const SITE_COOKIES_DIR = path.join(app.getPath('userData'), 'site-cookies')
const siteSessionCookies = () => session.fromPartition('persist:site-login').cookies.get({})
const siteLogin = new SiteLoginService({
  cookiesDir: SITE_COOKIES_DIR,
  createWindow: ({ show }) => {
    const win = new BrowserWindow({
      show,
      width: 480,
      height: 760,
      autoHideMenuBar: true,
      webPreferences: { partition: 'persist:site-login', sandbox: true, contextIsolation: true }
    })
    return {
      loadURL: (url, ua) => {
        win.webContents.setUserAgent(ua)
        return win.loadURL(url, { userAgent: ua })
      },
      getCookies: () => win.webContents.session.cookies.get({}),
      close: () => { if (!win.isDestroyed()) win.close() },
      onClosed: (fn) => win.on('closed', fn)
    }
  }
})
const siteVideo = new SiteVideoService({
  enginePath: path.join(app.getPath('userData'), 'yt-dlp', 'yt-dlp.exe'),
  ffmpegDir: path.join(app.getPath('userData'), 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin'),
  cookiesDir: SITE_COOKIES_DIR,
  refreshCookies: (target) => {
    const file = cookiesFileForUrl(SITE_COOKIES_DIR, target)
    const domain = file ? path.basename(file, '.txt') : ''
    return domain ? siteLogin.silentRefresh(domain, siteSessionCookies) : false
  }
})
// 拉片关键帧：复用 yt-dlp 组件包里的 ffmpeg/ffprobe，组件未下载时优雅降级为纯字幕分析
const videoFrames = new VideoFrameService({
  ffmpegPath: path.join(app.getPath('userData'), 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin', 'ffmpeg.exe'),
  ffprobePath: path.join(app.getPath('userData'), 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin', 'ffprobe.exe')
})
const mediaEditService = new MediaEditService({ frames: videoFrames })
const mediaEditProjects = new MediaEditProjectStore({ rootDir: path.join(app.getPath('userData'), 'media-edit-projects') })
const projectCapsules = new ProjectCapsuleStore({ rootDir: path.join(app.getPath('userData'), 'project-capsules') })
const publicLinkService = new PublicLinkService()
const mediaEditConversation = new MediaEditConversation()
const translateDownload = new LocalAiDownloadService({
  installRoot: path.join(app.getPath('userData'), 'translate-pack'),
  manifest: TRANSLATE_PACK,
  logger: log
})
const { OfflineTranslateService, shouldUseOffline } = require('./offline-translate-service')
const offlineTranslate = new OfflineTranslateService({
  modelRoot: path.join(app.getPath('userData'), 'translate-pack', 'models')
})
const RAPIDOCR_PACK = require('./rapidocr-pack-manifest')
const rapidocrDownload = new LocalAiDownloadService({
  installRoot: path.join(app.getPath('userData'), 'rapidocr-pack'),
  manifest: RAPIDOCR_PACK,
  logger: log
})
const { RapidOcrService } = require('./rapidocr-service')
const onlineMedia = require('./online-media-service')
const ebookService = require('./ebook-service')
const wikisource = require('./wikisource-service')
const ebookCacheRoot = () => path.join(app.getPath('userData'), 'ebook-cache')
// 统一取章：ws: 前缀走维基文库（按页序目录+按页正文），其余走 IA 的 epub/txt
async function loadEbookChapters(identifier, fileName) {
  if (String(identifier || '').startsWith('ws:')) {
    const bookTitle = String(identifier).slice(3)
    const chapters = await wikisource.listChapters(bookTitle)
    return chapters.map((chapter) => ({ page: chapter.page, title: chapter.title, wsBook: bookTitle }))
  }
  const bookPath = await ebookService.fetchBook(ebookCacheRoot(), identifier, fileName)
  if (/\.epub$/i.test(fileName)) return ebookService.parseEpubChapters(bookPath)
  return ebookService.parseTxtChapters(fs.readFileSync(bookPath, 'utf8'))
}
const rapidOcr = new RapidOcrService({
  modelRoot: path.join(app.getPath('userData'), 'rapidocr-pack')
})

// 字幕翻译路由：配置过云模型时默认走云端加速（内容上云前仍由原生确认框把关）；
// 没配置云端或用户拒绝后退回本地 OPUS-MT。Agnes 等 OpenAI 兼容模型直接复用统一文本接口。
function pickTranslateEngine(entries, targetLang = '中文', preference = 'auto') {
  const offlineAvailable = offlineTranslate.availability().available && shouldUseOffline(entries, targetLang)
  const cloudConfig = creativeConfig()
  const requiresKey = cloudConfig.requiresKey !== false
  const cloudReady = !isLocalModelConfig(cloudConfig)
    && cloudConfig.protocol !== 'cli'
    && Boolean(cloudConfig.baseUrl && cloudConfig.model && (!requiresKey || cloudConfig.apiKey))
  const selected = chooseSubtitleEngine({ preference, cloudReady, offlineAvailable })
  if (selected === 'cloud') {
    return {
      complete: ({ systemPrompt, prompt, signal, timeoutMs }) => llmComplete({
        systemPrompt, prompt, signal, timeoutMs, modelConfig: cloudConfig, taskKind: 'subtitle-translation'
      }),
      label: `${cloudConfig.providerName} · ${cloudConfig.model}`,
      providerId: cloudConfig.providerId,
      model: cloudConfig.model,
      offline: false
    }
  }
  if (selected === 'offline') {
    return { complete: (input) => offlineTranslate.jsonComplete(input), label: '本地离线翻译', providerId: 'offline-opus-mt', model: 'Xenova/opus-mt-en-zh', offline: true }
  }
  return null
}

async function translateAnalysisCuesToChinese({ cues, signal, onStatus = () => {} }) {
  const entries = cuesToEntries(cues)
  if (!entries.length || chooseOppositeTarget(entries) !== '中文') return []
  const engine = pickTranslateEngine(entries, '中文', 'local')
  if (!engine) return []
  const { translations } = await translateEntries(entries, engine.complete, {
    targetLang: '中文',
    signal,
    onProgress: ({ done, total }) => onStatus(`正在把英文证据翻成中文 ${done}/${total}`)
  })
  return entries.map((entry, index) => ({
    start: cues[index].start,
    end: cues[index].end,
    text: translations.get(entry.index) || '（该段未能可靠翻译，不纳入语义结论）'
  }))
}

async function transcribeToFile(sourcePath, finalPath, { timestamps = false } = {}) {
  const transcription = await transcriptionService.transcribe({
    sourcePath,
    timestamps,
    onProgress: (stage) => log.info(`转写进度: ${stage}`)
  })
  const tempPath = `${finalPath}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(finalPath), { recursive: true })
  fs.writeFileSync(tempPath, `${transcription.text}\n`, 'utf8')
  fs.renameSync(tempPath, finalPath)
  return { summary: `离线转写完成（${transcription.text.length} 字${timestamps ? '，含时间轴' : ''}）` }
}

async function recognizePdfWithLightOcr(filePath) {
  // 高精度组件在位时优先（PP-OCRv4 中文精度显著优于系统 OCR）；否则回退 WinRT 系统 OCR
  const useRapid = rapidOcr.availability().available
  const status = await ocrService.detect()
  if (!useRapid && !status.available) return null
  const pageCount = await pdfPageCount(filePath)
  const images = await rasterizePdfPages({ pdfPath: filePath, pageCount, createWindow: createHiddenWindow })
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-ocr-'))
  try {
    const imagePaths = images.map((buffer, index) => {
      const imagePath = path.join(tempDir, `page-${index + 1}.png`)
      fs.writeFileSync(imagePath, buffer)
      return imagePath
    })
    const results = useRapid ? await rapidOcr.recognize(imagePaths) : await ocrService.recognize(imagePaths)
    const chunks = []
    for (let index = 0; index < imagePaths.length; index += 1) {
      const entry = results.get(imagePaths[index])
      if (entry?.ok && entry.text) chunks.push(`## 第 ${index + 1} 页\n${entry.text}`)
    }
    return chunks.join('\n\n')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

async function recognizePdfWithOcr(filePath, options = {}) {
  if (!unlimitedOcrService) return recognizePdfWithLightOcr(filePath, options)
  return unlimitedOcrService.recognizePdf(filePath, options)
}

async function wordsForImage(imagePath) {
  const status = await ocrService.detect()
  if (!status.available) throw new Error(`系统 OCR 不可用：${status.reason}`)
  const results = await ocrService.recognizeWords([imagePath])
  const entry = results.get(imagePath)
  if (!entry?.ok) throw new Error(entry?.error || 'OCR 识别失败')
  return entry.words
}

async function wordsForPdf(filePath) {
  const status = await ocrService.detect()
  if (!status.available) throw new Error(`系统 OCR 不可用：${status.reason}`)
  const pageCount = await pdfPageCount(filePath)
  // 表格恢复用 1.5 倍栅格化：CJK 小字号在 1600px 宽页面上会丢字/误字（实测 20px 丢张三、30px 全对）
  const images = await rasterizePdfPages({ pdfPath: filePath, pageCount, createWindow: createHiddenWindow, scale: 1.5 })
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-table-'))
  try {
    const imagePaths = images.map((buffer, index) => {
      const imagePath = path.join(tempDir, `page-${index + 1}.png`)
      fs.writeFileSync(imagePath, buffer)
      return imagePath
    })
    const results = await ocrService.recognizeWords(imagePaths)
    return imagePaths.map((imagePath, index) => ({
      page: index + 1,
      words: results.get(imagePath)?.ok ? results.get(imagePath).words : []
    }))
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function documentSelectionFromToken(token) {
  const record = approvedDocumentSelections.get(String(token || ''))
  if (!record || Date.now() - record.createdAt > 24 * 60 * 60 * 1000) {
    approvedDocumentSelections.delete(String(token || ''))
    throw new Error('文件选择已过期，请重新选择')
  }
  return record.path
}

function isLocalModelConfig(config) {
  return Boolean(config?.providerId === 'bundled-lite' || config?.localOnly || /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(config?.baseUrl || ''))
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
    { label: '打开文件夹…', accelerator: 'CmdOrCtrl+Shift+O', click: async () => { const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] }); if (!r.canceled) { authorizedFolders.add(r.filePaths[0]); mainWindow?.webContents.send('menu:openFolder', r.filePaths[0]) } } },
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
    { label: '自动翻译字幕', click: () => sendAction('bilingual-subtitle') },
    { label: '播放速度', submenu: [0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => ({ label: `${rate}×`, click: () => sendAction(`speed-${rate}`) })) },
    { type: 'separator' },
    { label: '截取当前画面', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendAction('screenshot') }
  ] },
  { label: '功能', submenu: [
    { label: 'AI 对话窗', accelerator: 'CmdOrCtrl+D', click: () => sendAction('agent') },
    { label: '模型接入中心…', click: () => sendAction('model-center') },
    { label: '拉片（AI 对话解剖）…', accelerator: 'CmdOrCtrl+L', click: () => sendAction('analysis-studio') },
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
    { label: '关于 AgentPlay', click: () => dialog.showMessageBox(mainWindow, { type: 'info', title: '关于 AgentPlay', message: 'AgentPlay', detail: `版本 ${app.getVersion()}\n一个入口，完成媒体、文档与 AI 任务。` }) }
  ] }
]
Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate))

log.info('AgentPlay 启动')

app.whenReady().then(async () => {
  const win = createWindow()

  // 全局热键：随叫随到——任何场景下唤起主窗口并直接开麦克风；主键被占用时回退备选
  const wakeApp = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('menu:action', 'agent-voice')
  }
  const hotkeyRegistered = globalShortcut.register('CmdOrCtrl+Shift+A', wakeApp)
    || globalShortcut.register('CmdOrCtrl+Shift+Q', wakeApp)
  log.info(`全局唤醒热键注册${hotkeyRegistered ? '成功（Ctrl+Shift+A，被占用时回退 Ctrl+Shift+Q）' : '失败：可能被其他软件占用'}`)


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
  modelPerformanceRouter = new ModelPerformanceRouter({ rootDir: path.join(app.getPath('userData'), 'model-performance') })
  serviceCredentialStore = new ServiceCredentialStore(app.getPath('userData'), safeStorage)
  unlimitedOcrConfigStore = new UnlimitedOcrConfigStore(app.getPath('userData'), safeStorage)
  unlimitedOcrService = new UnlimitedOcrService({
    configStore: unlimitedOcrConfigStore,
    rasterizePdf: async (filePath) => rasterizePdfPages({
      pdfPath: filePath,
      pageCount: await pdfPageCount(filePath),
      createWindow: createHiddenWindow
    }),
    fallbackRecognizePdf: recognizePdfWithLightOcr
  })
  modelCatalog = new ModelCatalog(app.getPath('userData'))
  bundledRuntime = new BundledLocalRuntime({
    resourceRoot: app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources'),
    userDataRoot: path.join(app.getPath('userData'), 'local-ai')
  })
  localAiDownload = new LocalAiDownloadService({
    installRoot: path.join(app.getPath('userData'), 'local-ai'),
    manifest: LOCAL_AI_PACK,
    logger: log
  })
  pluginService = new PluginSkillService({
    rootDir: path.join(app.getPath('userData'), 'plugins'),
    legacyDir: PLUGIN_DIR,
    onContributions: replacePluginContributions
  })
  pluginService.refresh()
  agentEngine = new AgentEngine(mpv)
  const selectConfiguredModel = ({ taskKind = 'general-text', requirements = {}, modelConfig = null, cloudAllowed = null } = {}) => {
    if (modelConfig) {
      const eligibility = modelPerformanceRouter.validate(modelConfig, {
        requirements,
        cloudAllowed: typeof cloudAllowed === 'boolean' ? cloudAllowed : true
      })
      return eligibility.eligible
        ? { selected: modelConfig, reason: '任务已冻结模型配置', ranking: [] }
        : { selected: null, reason: `任务冻结模型${eligibility.reason}，未改用其他模型`, ranking: [] }
    }
    const active = modelConfigStore.resolved('chat')
    const candidates = modelConfigStore.resolvedCandidates('chat')
    const routingSettings = modelPerformanceRouter.status([]).settings
    const effectiveCloudAllowed = typeof cloudAllowed === 'boolean'
      ? cloudAllowed
      : routingSettings.preference === 'cloud' || !isLocalModelConfig(active)
    const decision = modelPerformanceRouter.select({
      taskKind,
      candidates: candidates.length ? candidates : [active],
      activeKey: modelKey(active),
      requirements,
      cloudAllowed: effectiveCloudAllowed
    })
    return decision
  }
  const selectModelForTaskPlan = ({ taskKind, requirements = {}, candidates = null } = {}) => {
    const active = modelConfigStore.resolved('chat')
    const pool = (candidates || modelConfigStore.resolvedCandidates('chat')).map((config) => ({
      ...config,
      contextWindow: contextWindowForConfig(config)
    }))
    return modelPerformanceRouter.select({
      taskKind,
      candidates: pool,
      activeKey: modelKey(active),
      requirements,
      // 这里只生成带模型身份的审批计划；真正执行仍必须先消费 approval。
      cloudAllowed: true
    })
  }
  llmComplete = async ({ systemPrompt, prompt, signal, timeoutMs, maxTokens, modelConfig, taskKind = 'general-text' }) => {
    const decision = selectConfiguredModel({ taskKind, modelConfig })
    let config = decision.selected
    if (!config) throw new Error(decision.reason || '没有满足当前 AI 使用方式的模型')
    let usesBundledRuntime = false
    const startedAt = Date.now()
    try {
      if (config.providerId === 'bundled-lite') {
        const status = await bundledRuntime.start()
        bundledRuntime.retain()
        usesBundledRuntime = true
        config = { ...config, model: status.model, baseUrl: status.baseUrl }
      }
      const result = await agentEngine.completeText([{ role: 'user', content: prompt }], config, { systemPrompt, signal, timeoutMs, maxTokens })
      modelPerformanceRouter.recordCall({ taskKind, config, startedAt, completedAt: Date.now(), success: true, usage: result.usage })
      return { ...result, routeReason: decision.reason }
    } catch (error) {
      modelPerformanceRouter.recordCall({ taskKind, config, startedAt, completedAt: Date.now(), success: false, errorCode: error?.code || error?.name })
      throw error
    } finally {
      if (usesBundledRuntime) bundledRuntime.release()
    }
  }
  // 多图视觉调用（拉片关键帧）：images = [{ dataUrl, label }]，必须带当前配置，否则会落到引擎默认端点
  llmCompleteVisionMulti = async ({ systemPrompt, prompt, images, signal, timeoutMs, modelConfig, taskKind = 'analysis-vision' }) => {
    const decision = selectConfiguredModel({ taskKind, requirements: { vision: true }, modelConfig })
    const config = decision.selected
    if (!config) throw new Error(decision.reason || '没有满足看图能力与授权边界的模型')
    const startedAt = Date.now()
    try {
      const result = await agentEngine.completeVisionMulti({
        prompt,
        systemPrompt,
        imageDataUrls: images.map((image) => image.dataUrl),
        labels: images.map((image) => image.label),
        apiKey: config,
        signal,
        timeoutMs: timeoutMs || 300000
      })
      modelPerformanceRouter.recordCall({ taskKind, config, startedAt, completedAt: Date.now(), success: true, usage: result.usage })
      return { ...result, routeReason: decision.reason }
    } catch (error) {
      modelPerformanceRouter.recordCall({ taskKind, config, startedAt, completedAt: Date.now(), success: false, errorCode: error?.code || error?.name })
      throw error
    }
  }
  const generateVideoWithReceipt = async (config, input = {}) => {
    const observedConfig = { ...config, model: String(input.model || 'agnes-video-v2.0') }
    const startedAt = Date.now()
    try {
      const result = await generateVideoAsset(config, input)
      modelPerformanceRouter.recordCall({ taskKind: 'creative-video', config: observedConfig, startedAt, completedAt: Date.now(), success: true })
      return result
    } catch (error) {
      modelPerformanceRouter.recordCall({ taskKind: 'creative-video', config: observedConfig, startedAt, completedAt: Date.now(), success: false, errorCode: error?.code || error?.name })
      throw error
    }
  }
  // 图片理解：优先已配置云端视觉模型；不行就本机 WinRT OCR 兜底（本地模型与零配置场景也能答）
  const describeImage = async (imagePath, instruction, { signal, modelConfig } = {}) => {
    const localOnly = modelPerformanceRouter.status([]).settings.preference === 'local'
    let config = modelConfig || (localOnly ? null : cloudConfigForExplicitFeature())
    if (!modelConfig && !isLocalModelConfig(config)) {
      const approved = await ensureCloudConsent('所选图片将发送给云端视觉模型，用于理解图片内容。')
      if (!approved) config = null
    }
    const requiresKey = config?.requiresKey !== false
    const visionReady = Boolean(config && config.providerId !== 'bundled-lite' && config.baseUrl && config.model && (!requiresKey || config.apiKey))
    if (visionReady) {
      const ext = path.extname(imagePath).toLowerCase().slice(1)
      try {
        const dataUrl = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${fs.readFileSync(imagePath).toString('base64')}`
        if (dataUrl.length > 20 * 1024 * 1024) throw new Error('图片超过 15MB，请先压缩')
        const result = await agentEngine.completeVision({ prompt: instruction, imageDataUrl: dataUrl, apiKey: config, signal, timeoutMs: 120000 })
        return result.text
      } catch (error) {
        log.warn('视觉模型图片理解失败，回落 OCR', error)
      }
    }
    const availability = await ocrService.availability()
    if (availability.available) {
      const results = await ocrService.recognize([imagePath])
      const entry = results.get(imagePath)
      if (entry?.ok && String(entry.text || '').trim()) {
        return `${visionReady ? '（视觉模型暂不可用，已用本机 OCR 识别图中文字）' : '（当前模型不支持看图，已用本机 OCR 识别图中文字）'}\n${String(entry.text).trim()}`
      }
    }
    throw new Error(visionReady ? '图片理解失败：视觉模型与 OCR 都没有给出结果' : '没有可用的图片理解方式：云端视觉模型未配置，本机 OCR 不可用或未识别到文字')
  }
  documentWorkspace = new DocumentWorkspaceService({
    outputRoot: path.join(app.getPath('documents'), 'AgentPlay 输出'),
    historyRoot: path.join(app.getPath('userData'), 'document-workspace'),
    renderPdf: renderHtmlToPdf,
    ocr: { recognizePdf: recognizePdfWithOcr },
    tableOcr: { wordsForPdf, wordsForImage },
    officeConvert,
    imageWindow: createHiddenWindow,
    transcriber: { transcribeToFile },
    describeImage,
    complete: (input) => llmComplete({ ...input, taskKind: 'document' })
  })
  const screenCapture = new ScreenCaptureService(() => mainWindow)
  computerUseOrchestrator = new ComputerUseOrchestrator({
    capture: () => screenCapture.capture(),
    provider: new ComputerUseProvider()
  })

  const publishTaskRuntimeEvent = (task) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('task-runtime:event', task)
    if (String(task.type || '').startsWith('download.')) {
      mainWindow.webContents.send('media:download-status', { requestId: task.id, status: task.status || '' })
    }
    if (task.type === 'document.run') {
      mainWindow.webContents.send('documents:status', { requestId: task.id, status: task.status || '' })
    }
    if (task.type === 'analysis.run') {
      mainWindow.webContents.send('analysis:status', { requestId: task.id, status: task.status || '' })
    }
    if (task.type === 'outcome.workflow') {
      mainWindow.webContents.send('outcome:status', { requestId: task.id, status: task.status || '' })
    }
    if (task.type === 'project.evidence-qa') {
      mainWindow.webContents.send('cross-material:status', { requestId: task.id, status: task.status || '' })
    }
    if (task.type === 'subtitle.generate') {
      mainWindow.webContents.send('subtitle:bilingual-status', { requestId: task.id, status: task.status || '' })
    }
    if (task.type === 'creative.recut-short') {
      mainWindow.webContents.send('studio:recut-progress', { requestId: task.id, stage: task.status || '' })
    }
  }
  const fixedDownloadDir = () => path.join(app.getPath('videos'), 'AgentPlay 下载')
  const prepareQualityRepair = ({ task, result, quality }) => {
    if (!Array.isArray(quality?.reasons) || !quality.reasons.some((item) => item?.repairable)) return null
    const type = String(task.type || '')
    // 语义模型和付费创作不得由技术质量门重新发起云端调用；拉片内部已有一次获批范围内的精修。
    if (type === 'analysis.run' || type.startsWith('creative.')) return null
    if ((type === 'document.run' || type === 'subtitle.generate') && task.spec?.modelRoute && !task.spec.modelRoute.local) return null
    let nextCheckpoint = { ...(task.checkpoint || {}), stage: 'quality-repair', result: null }
    let action = '重新执行未通过的本地质量步骤'
    if (type === 'media.batch') {
      const results = Array.isArray(result?.results) ? result.results : []
      let failedIndex = results.findIndex((item) => !item?.success || !item?.outputPath)
      if (failedIndex < 0) failedIndex = 0
      for (let index = failedIndex; index < (task.spec?.plannedOutputs || []).length; index += 1) {
        const outputPath = path.resolve(String(task.spec.plannedOutputs[index] || ''))
        const expected = path.resolve(String(task.spec.plannedOutputs[index] || ''))
        if (outputPath === expected && fs.existsSync(outputPath) && (!results[index]?.success || quality.reasons.some((item) => path.resolve(String(item?.detail || '')) === outputPath))) {
          fs.rmSync(outputPath, { force: true })
        }
      }
      nextCheckpoint = { ...nextCheckpoint, nextIndex: failedIndex, results: results.slice(0, failedIndex) }
      action = `从第 ${failedIndex + 1} 项重新执行批量任务`
    } else if (type === 'media.compress') {
      const frozenValue = String(task.spec?.outputPath || '')
      const actualValue = String(result?.outputPath || result?.outputs?.[0] || '')
      const frozenOutput = frozenValue ? path.resolve(frozenValue) : ''
      const actualOutput = actualValue ? path.resolve(actualValue) : ''
      if (frozenOutput && actualOutput === frozenOutput && fs.existsSync(frozenOutput) && fs.statSync(frozenOutput).isFile()) fs.rmSync(frozenOutput, { force: true })
      action = '清理不合格的任务自产物并重新压缩'
    } else if (type === 'media.edit-trim' || type === 'media.edit-remove' || type === 'media.edit-concat' || type === 'media.edit-music' || type === 'media.edit-concat-sources' || type === 'media.edit-burn-subtitles' || type === 'media.edit-mux-subtitles' || type === 'media.shift-subtitles' || type === 'media.translate-subtitles' || type === 'media.edit-subtitle-cues') {
      const frozenValue = String(task.spec?.outputPath || '')
      const actualValue = String(result?.outputPath || result?.outputs?.[0] || '')
      const frozenOutput = frozenValue ? path.resolve(frozenValue) : ''
      const actualOutput = actualValue ? path.resolve(actualValue) : ''
      if (frozenOutput && actualOutput === frozenOutput && fs.existsSync(frozenOutput) && fs.statSync(frozenOutput).isFile()) fs.rmSync(frozenOutput, { force: true })
      action = '清理不合格的剪辑产物并从冻结时间线重新执行'
    } else if (type === 'media.dedup') {
      action = '保留哈希缓存并重新汇总扫描结果'
    } else if (type.startsWith('download.')) {
      action = '沿用下载检查点重新校验成果'
    } else if (type === 'subtitle.generate') {
      action = '沿用识别检查点重新生成字幕成果'
    } else if (type === 'document.run') {
      action = '重新执行本地文档写出与验证'
    } else {
      return null
    }
    return { checkpoint: nextCheckpoint, action }
  }
  persistentTaskRuntime = new PersistentTaskRuntime({
    rootDir: path.join(app.getPath('userData'), 'task-runtime'),
    logger: log,
    onChange: publishTaskRuntimeEvent,
    qualityEvaluator: evaluateTaskResult,
    onQuality: ({ task, quality }) => {
      const route = task?.spec?.modelRoute
      const taskKind = route?.taskKind || taskKindForPersistentType(task?.type)
      if (!taskKind || !route || !quality) return
      const config = modelConfigStore.resolvedCandidates('chat').find((candidate) => (
        candidate.providerId === route.providerId
        && candidate.model === route.model
        && candidate.baseUrl === route.baseUrl
      ))
      if (config) {
        const observedConfig = route.metricModel ? { ...config, model: route.metricModel } : config
        modelPerformanceRouter.recordQuality({ taskKind, config: observedConfig, score: quality.score, passed: quality.passed })
      }
    },
    failureClassifier: classifyTaskFailure,
    prepareRepair: prepareQualityRepair,
    maxQualityRepairs: 1
  })
  const freezeTaskModelRoute = (config, { taskKind = '', metricModel = '' } = {}) => ({
    providerId: String(config.providerId || ''),
    providerName: String(config.providerName || config.providerId || ''),
    model: String(config.model || ''),
    baseUrl: String(config.baseUrl || ''),
    local: isLocalModelConfig(config),
    ...(taskKind ? { taskKind: String(taskKind) } : {}),
    ...(metricModel ? { metricModel: String(metricModel) } : {})
  })
  const resolveTaskModelRoute = (route) => {
    if (!route) return null
    const config = modelConfigStore.resolvedCandidates('chat').find((item) =>
      String(item.providerId || '') === route.providerId &&
      String(item.model || '') === route.model &&
      String(item.baseUrl || '') === route.baseUrl)
    if (!config) throw new Error('任务原先使用的模型配置已变化，请确认后重新执行')
    const requiresKey = config?.requiresKey !== false
    if (requiresKey && !config.apiKey) throw new Error('任务原先使用的模型凭证已不可用，请重新配置')
    return config
  }
  const textEvidence = (source, text) => {
    const value = String(text || '').trim()
    if (!value) return []
    const sections = value.split(/(?=^## 第 \d+ 页\s*$)/m).filter((item) => item.trim())
    const evidence = []
    for (const section of sections) {
      const page = Math.max(1, Number(section.match(/^## 第 (\d+) 页/m)?.[1]) || 1)
      const body = section.replace(/^## 第 \d+ 页\s*/m, '').trim()
      const paragraphs = body.split(/\n\s*\n|(?<=[。！？.!?])\s+(?=[^。！？.!?])/).map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean)
      for (const paragraph of paragraphs) {
        for (let offset = 0; offset < paragraph.length; offset += 480) {
          evidence.push(documentPage(source, page, paragraph.slice(offset, offset + 480)))
          if (evidence.length >= 80) return evidence
        }
      }
    }
    return evidence
  }
  const inspectEvidencePath = async (filePath) => {
    const resolved = path.resolve(String(filePath || ''))
    const ext = path.extname(resolved).toLowerCase()
    if (ext === '.xlsx') {
      const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(resolved); const evidence = []
      workbook.eachSheet((sheet) => sheet.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (cell) => {
        if (evidence.length < 120 && String(cell.text || '').trim()) evidence.push(sheetCell(resolved, sheet.name, cell.address, cell.text))
      })))
      return evidence
    }
    if (['.jpg', '.jpeg', '.png', '.bmp'].includes(ext)) {
      const size = imageSize(fs.readFileSync(resolved), ext)
      let excerpt = ''
      try {
        const useRapid = rapidOcr.availability().available
        const status = useRapid ? { available: true } : await ocrService.detect()
        if (status.available) {
          const results = useRapid ? await rapidOcr.recognize([resolved]) : await ocrService.recognize([resolved])
          const entry = results.get(resolved)
          if (entry?.ok) excerpt = String(entry.text || '').replace(/\s+/g, ' ').trim()
        }
      } catch { /* 图片无OCR时仍可引用完整区域和尺寸 */ }
      return [imageRegion(resolved, { x: 0, y: 0, width: size.width, height: size.height }, excerpt || `${size.width}×${size.height}`)]
    }
    if (getType(ext) === 'video') {
      const subtitlePath = findAdjacentSubtitle(resolved)
      const cues = subtitlePath ? parseSubtitleCues(decodeSubtitleText(fs.readFileSync(subtitlePath)), path.extname(subtitlePath)) : []
      return cues.slice(0, 120).map((cue) => videoTime(resolved, cue.start, cue.end, cue.text))
    }
    try {
      const content = await extractText(resolved, { recognizePdf: recognizePdfWithOcr })
      return textEvidence(resolved, content)
    } catch {
      return []
    }
  }
  const resolveCrossMaterialContext = (paths) => {
    const seedPaths = [...new Set((Array.isArray(paths) ? paths : []).map((item) => path.resolve(String(item || ''))).filter((item) => fs.existsSync(item) && !SENSITIVE_FILE.test(item)))]
    const projectId = projectCapsules.resolveProjectId(seedPaths)
    const project = projectId ? projectCapsules.get(projectId) : null
    const projectPaths = project ? [
      ...project.materials.flatMap((item) => item.locations || []),
      ...project.artifacts.map((item) => item.path)
    ] : []
    const sourcePaths = [...new Set([...seedPaths, ...projectPaths].map((item) => path.resolve(String(item || ''))).filter((item) => fs.existsSync(item) && fs.statSync(item).isFile() && !SENSITIVE_FILE.test(item)))].slice(0, 20)
    const referenceEvidence = (project?.revisions || []).flatMap((revision) => [
      ...(Array.isArray(revision?.result?.preview?.evidence) ? revision.result.preview.evidence : []),
      ...(Array.isArray(revision?.result?.evidence) ? revision.result.evidence : [])
    ]).slice(-100)
    return { projectId: projectId || projectCapsules.newProjectId(), project, sourcePaths, referenceEvidence }
  }
  const preparePersistentCrossMaterialTask = (paths, input) => {
    const context = resolveCrossMaterialContext(paths)
    const sourceCount = new Set([...context.sourcePaths, ...context.referenceEvidence.map((item) => String(item?.source || '')).filter(Boolean)]).size
    if (sourceCount < 2) throw new Error('跨素材问答至少需要两个来源；请再添加一份文件或进入已有混合项目')
    const planned = selectModelForTaskPlan({ taskKind: 'cross-material-qa', requirements: { text: true } })
    const config = planned.selected || modelConfigStore.resolved('chat')
    const requiresKey = config?.requiresKey !== false
    if (!config?.baseUrl || !config?.model || (requiresKey && !config.apiKey)) throw new Error('跨素材问答需要可用模型，请先在模型接入中心完成连接')
    const modelRoute = freezeTaskModelRoute(config, { taskKind: 'cross-material-qa' })
    const sources = snapshotDocumentSources(context.sourcePaths)
    const question = String(input.question || '').trim().slice(0, 2000)
    const operationKey = crypto.createHash('sha256').update(JSON.stringify({ type: 'project.evidence-qa', question, sources: sources.map((item) => item.sha256), references: context.referenceEvidence })).digest('hex')
    return {
      matched: detectCrossMaterialQuestion(question),
      spec: { question, sources, referenceEvidence: context.referenceEvidence, projectId: context.projectId, operationKey, modelRoute },
      approval: modelRoute.local ? null : { action: 'cloud', summary: `把 ${sourceCount} 份素材的本地提取片段和定位发送给 ${modelRoute.providerName} · ${modelRoute.model}；不上传原文件` }
    }
  }
  persistentTaskRuntime.register('project.evidence-qa', async ({ task, signal, checkpoint, status }) => {
    const paths = validateDocumentSources(task.spec.sources)
    for (const sourcePath of paths) userAuthorizedPaths.add(sourcePath)
    if (task.checkpoint?.stage === 'answer-ready' && task.checkpoint?.result) {
      const projectCapsule = projectCapsules.recordTask({ projectId: task.spec.projectId, taskId: task.id, type: task.type, instruction: task.spec.question, sources: task.spec.sources, references: (task.spec.referenceEvidence || []).map((item) => ({ kind: item.evidenceKind, uri: item.source })), outputs: [], operationKey: task.spec.operationKey, result: task.checkpoint.result })
      return { ...task.checkpoint.result, projectCapsule }
    }
    status('正在读取并定位多份素材')
    let references = Array.isArray(task.checkpoint?.references) ? task.checkpoint.references : null
    if (!references) {
      const groups = []
      for (const sourcePath of paths) {
        if (signal.aborted) throw new DOMException('跨素材问答已停止', 'AbortError')
        groups.push(...await inspectEvidencePath(sourcePath))
      }
      references = [...groups, ...(task.spec.referenceEvidence || [])].slice(0, 200)
      checkpoint({ stage: 'evidence-collected', references })
    }
    status('正在逐条核对结论与来源')
    const config = resolveTaskModelRoute(task.spec.modelRoute)
    const service = new CrossMaterialQaService({ complete: (call) => llmComplete({ ...call, modelConfig: config, taskKind: 'cross-material-qa' }) })
    const result = await service.answer({ question: task.spec.question, references, signal, modelConfig: config, allowRepair: isLocalModelConfig(config) })
    checkpoint({ stage: 'answer-ready', result })
    const projectCapsule = projectCapsules.recordTask({ projectId: task.spec.projectId, taskId: task.id, type: task.type, instruction: task.spec.question, sources: task.spec.sources, references: (task.spec.referenceEvidence || []).map((item) => ({ kind: item.evidenceKind, uri: item.source })), outputs: [], operationKey: task.spec.operationKey, result })
    return { ...result, projectCapsule }
  }, { autoResume: true })
  const preparePersistentDocumentTask = async (paths, input) => {
    const plan = documentWorkspace.plan(paths, input.instruction, input.outputFormat)
    let modelRoute = null
    const advancedOcr = plan.kind === 'text-extract' ? unlimitedOcrConfigStore.publicConfig() : null
    const ocrRemote = Boolean(advancedOcr?.enabled && !advancedOcr.local)
    const ocrRoute = advancedOcr?.enabled
      ? { baseUrl: advancedOcr.baseUrl, model: advancedOcr.model, local: advancedOcr.local }
      : null
    if (plan.requiresAi) {
      const planned = selectModelForTaskPlan({ taskKind: 'document', requirements: { text: true } })
      const current = planned.selected || modelConfigStore.resolved('chat')
      const currentWithPolicy = { ...current, local: isLocalModelConfig(current), contextWindow: contextWindowForConfig(current) }
      const cloudCandidates = modelConfigStore.resolvedCandidates('chat').filter((candidate) => !isLocalModelConfig(candidate) && candidate.protocol !== 'cli')
      const fallbackDecision = input.preferLocal === true ? null : selectModelForTaskPlan({ taskKind: 'document', requirements: { text: true }, candidates: cloudCandidates })
      const fallback = fallbackDecision?.selected || cloudFallbackFromStore(modelConfigStore, 'chat')
      const fallbackWithPolicy = fallback ? { ...fallback, local: isLocalModelConfig(fallback), contextWindow: contextWindowForConfig(fallback) } : null
      const preflight = await documentWorkspace.preflight(paths, input.instruction, input.outputFormat, {
        contextWindow: currentWithPolicy.contextWindow,
        maxOutputTokens: maxOutputTokensForConfig(currentWithPolicy)
      })
      let routing = chooseDocumentModel({
        current: currentWithPolicy,
        fallback: input.preferLocal === true ? null : fallbackWithPolicy,
        preflight,
        cloudApproved: input.cloudApproved === true
      })
      if (routing.requiresCloudApproval) {
        routing = chooseDocumentModel({
          current: currentWithPolicy,
          fallback: fallbackWithPolicy,
          preflight,
          cloudApproved: true
        })
      }
      const config = routing.config
      const requiresKey = config.requiresKey !== false
      if (!config.baseUrl || !config.model || (requiresKey && !config.apiKey)) {
        throw new Error('这个任务需要模型理解内容，请先在“模型接入中心”配置模型')
      }
      modelRoute = {
        providerId: String(config.providerId || ''),
        providerName: String(config.providerName || ''),
        model: String(config.model || ''),
        baseUrl: String(config.baseUrl || ''),
        local: isLocalModelConfig(config),
        contextWindow: contextWindowForConfig(config),
        maxOutputTokens: maxOutputTokensForConfig(config)
      }
    }
    const sources = snapshotDocumentSources(paths)
    const projectId = projectCapsules.resolveProjectId(paths) || projectCapsules.newProjectId()
    const operationKey = crypto.createHash('sha256').update(JSON.stringify({ type: 'document.run', instruction: String(input.instruction || ''), outputFormat: String(input.outputFormat || 'auto'), sources: sources.map((item) => item.sha256) })).digest('hex')
    return {
      spec: {
        sources,
        instruction: String(input.instruction || ''),
        outputFormat: String(input.outputFormat || 'auto'),
        projectId,
        operationKey,
        modelRoute,
        ocrRemote,
        ocrRoute
      },
      approval: ocrRemote
        ? { action: 'cloud', summary: `把所选扫描文档页面发送给远端高级 OCR · ${advancedOcr.model}` }
        : modelRoute && !modelRoute.local
        ? { action: 'cloud', summary: `把所选文件正文发送给 ${modelRoute.providerName} · ${modelRoute.model}` }
        : null
    }
  }
  persistentTaskRuntime.register('document.run', async ({ task, signal, checkpoint, status }) => {
    if (task.checkpoint?.stage === 'history-written' && task.checkpoint?.result && outputsStillExist(task.checkpoint.result)) {
      const checkpointResult = task.checkpoint.result
      const projectCapsule = checkpointResult.projectCapsule || projectCapsules.recordTask({ projectId: task.spec.projectId, taskId: task.id, type: task.type, instruction: task.spec.instruction, sources: task.spec.sources, outputs: checkpointResult.outputs || [], historyId: checkpointResult.historyId, operationKey: task.spec.operationKey, result: checkpointResult })
      return { ...checkpointResult, projectCapsule }
    }
    const reusable = projectCapsules.findReusable(task.spec.projectId, task.spec.operationKey)
    if (reusable) return reusable
    const paths = validateDocumentSources(task.spec.sources)
    for (const sourcePath of paths) userAuthorizedPaths.add(sourcePath)
    let documentOptions = {
      signal,
      onStatus: status,
      onCheckpoint: checkpoint,
      resumeCheckpoint: task.checkpoint,
      cloudApproved: task.spec.ocrRemote === true
    }
    if (task.spec.ocrRoute) {
      const currentOcr = unlimitedOcrConfigStore.publicConfig()
      if (!currentOcr.enabled
        || currentOcr.baseUrl !== task.spec.ocrRoute.baseUrl
        || currentOcr.model !== task.spec.ocrRoute.model
        || currentOcr.local !== task.spec.ocrRoute.local) {
        throw new Error('任务原先使用的高级 OCR 配置已变化，请确认后重新执行')
      }
    }
    if (task.spec.modelRoute) {
      const config = resolveTaskModelRoute(task.spec.modelRoute)
      documentOptions = {
        ...documentOptions,
        contextWindow: task.spec.modelRoute.contextWindow,
        maxOutputTokens: task.spec.modelRoute.maxOutputTokens,
        modelLabel: `${task.spec.modelRoute.providerName} · ${task.spec.modelRoute.model}`,
        modelConfig: config
      }
    }
    const plan = documentWorkspace.plan(paths, task.spec.instruction, task.spec.outputFormat)
    status(plan.requiresAi ? '正在理解要求和生成内容' : '正在执行本地文档操作')
    const result = await documentWorkspace.run(paths, task.spec.instruction, task.spec.outputFormat, documentOptions)
    for (const outputPath of result.outputs || []) userAuthorizedPaths.add(path.resolve(outputPath))
    const projectCapsule = projectCapsules.recordTask({ projectId: task.spec.projectId, taskId: task.id, type: task.type, instruction: task.spec.instruction, sources: task.spec.sources, outputs: result.outputs || [], historyId: result.historyId, operationKey: task.spec.operationKey, result })
    status('正在验证并保存结果')
    return { ...result, projectCapsule }
  }, { autoResume: true })
  const preparePersistentAnalysisTask = (input) => {
    const resolvedSource = assertAllowedPath(input.sourcePath)
    const visionDecision = selectModelForTaskPlan({ taskKind: 'analysis-vision', requirements: { vision: true } })
    const textDecision = visionDecision.selected ? null : selectModelForTaskPlan({ taskKind: 'analysis', requirements: { text: true } })
    const config = visionDecision.selected || textDecision?.selected || null
    const requiresKey = config?.requiresKey !== false
    const modelConfigured = Boolean(config && config.baseUrl && config.model && (!requiresKey || config.apiKey))
    const modelRoute = modelConfigured
      ? freezeTaskModelRoute(config, { taskKind: visionDecision.selected ? 'analysis-vision' : 'analysis' })
      : null
    return {
      spec: {
        sources: snapshotDocumentSources([resolvedSource]),
        mediaName: String(input.mediaName || path.basename(resolvedSource)),
        duration: Number(input.duration) || 0,
        instruction: String(input.instruction || ''),
        outputFormat: String(input.outputFormat || 'docx'),
        modelRoute
      },
      approval: modelRoute && !modelRoute.local
        ? { action: 'cloud', summary: `把视频关键画面与字幕证据发送给 ${modelRoute.providerName} · ${modelRoute.model} 做深度解剖` }
        : null
    }
  }
  persistentTaskRuntime.register('analysis.run', async ({ task, signal, checkpoint, status }) => {
    if (task.checkpoint?.stage === 'history-written' && task.checkpoint?.result && outputsStillExist(task.checkpoint.result)) return task.checkpoint.result
    const [sourcePath] = validateDocumentSources(task.spec.sources)
    userAuthorizedPaths.add(sourcePath)
    const config = resolveTaskModelRoute(task.spec.modelRoute)
    const result = await runChatAnalysis({
      sourcePath,
      mediaName: task.spec.mediaName,
      duration: task.spec.duration,
      instruction: task.spec.instruction,
      outputFormat: task.spec.outputFormat,
      cloudApproved: Boolean(config && !isLocalModelConfig(config)),
      signal,
      onStatus: status,
      onCheckpoint: checkpoint,
      resumeCheckpoint: task.checkpoint,
      workspace: documentWorkspace,
      complete: (input) => llmComplete({ ...input, modelConfig: config, taskKind: 'analysis' }),
      completeVisionMulti: (input) => llmCompleteVisionMulti({ ...input, modelConfig: config, taskKind: 'analysis-vision' }),
      frames: videoFrames,
      translateToChinese: translateAnalysisCuesToChinese,
      model: {
        configured: Boolean(config),
        local: config ? isLocalModelConfig(config) : false,
        provider: config?.providerName || config?.providerId || '',
        model: config?.model || ''
      }
    })
    for (const outputPath of result.outputs || []) userAuthorizedPaths.add(path.resolve(outputPath))
    return result
  }, { autoResume: true })
  const preparePersistentOutcomeTask = (input) => {
    const sourcePath = assertAllowedPath(input.sourcePath)
    const workflow = compileOutcomeWorkflow({ sourcePath, instruction: input.instruction })
    if (!workflow) throw new Error('当前要求不是可执行的多成果视频工作流；请至少明确两个最终格式')
    const visionDecision = selectModelForTaskPlan({ taskKind: 'analysis-vision', requirements: { vision: true } })
    const textDecision = visionDecision.selected ? null : selectModelForTaskPlan({ taskKind: 'analysis', requirements: { text: true } })
    const config = visionDecision.selected || textDecision?.selected || modelConfigStore.resolved('chat')
    const requiresKey = config?.requiresKey !== false
    if (config?.configured === false || !config?.baseUrl || !config?.model || (requiresKey && !config.apiKey)) {
      throw new Error('这个成果工作流需要模型理解视频并生成多格式内容，请先在模型接入中心配置模型')
    }
    const modelRoute = freezeTaskModelRoute(config, { taskKind: visionDecision.selected ? 'analysis-vision' : 'analysis' })
    const sources = snapshotDocumentSources([sourcePath])
    const projectId = projectCapsules.resolveProjectId([sourcePath]) || projectCapsules.newProjectId()
    const operationKey = crypto.createHash('sha256').update(JSON.stringify({ type: 'outcome.workflow', workflow, sources: sources.map((item) => item.sha256) })).digest('hex')
    return {
      spec: {
        sources,
        workflow,
        mediaName: String(input.mediaName || path.basename(sourcePath)),
        duration: Number(input.duration) || 0,
        modelRoute,
        projectId,
        operationKey
      },
      approval: modelRoute.local ? null : {
        action: 'cloud',
        summary: `把视频关键画面、字幕证据和成果底稿发送给 ${modelRoute.providerName} · ${modelRoute.model}，生成 ${workflow.deliverables.formats.map((item) => item.toUpperCase()).join('、')}`
      }
    }
  }
  const outcomeWorkflowRunner = new OutcomeWorkflowRunner({ outputsStillExist })
  persistentTaskRuntime.register('outcome.workflow', async ({ task, signal, checkpoint, status }) => {
    const reusable = projectCapsules.findReusable(task.spec.projectId, task.spec.operationKey)
    if (reusable) return reusable
    const [sourcePath] = validateDocumentSources(task.spec.sources)
    userAuthorizedPaths.add(sourcePath)
    const workflow = assertOutcomeWorkflow(task.spec.workflow)
    if (path.resolve(workflow.source.path) !== path.resolve(sourcePath)) throw new Error('成果工作流来源与冻结素材不一致')
    const config = resolveTaskModelRoute(task.spec.modelRoute)
    const workflowRoot = path.join(app.getPath('documents'), 'AgentPlay 输出', `视频成果包-${task.id}`)
    fs.mkdirSync(workflowRoot, { recursive: true })

    const formatNames = { docx: 'Word 报告', pptx: 'PPT 汇报', xlsx: 'Excel 分析表', pdf: 'PDF 交付版', md: 'Markdown 文档' }
    const bundleInstruction = `严格依据这份视频解剖底稿，生成一套相互一致的中文成果：${workflow.deliverables.formats.map((format) => formatNames[format] || format.toUpperCase()).join(' + ')}。不得补写底稿没有的事实。`
    const result = await outcomeWorkflowRunner.run({
      workflow,
      sourceReceipt: task.spec.sources[0],
      checkpoint: task.checkpoint,
      status,
      saveCheckpoint: checkpoint,
      runAnalysis: ({ resumeCheckpoint, onCheckpoint }) => runChatAnalysis({
        sourcePath, mediaName: task.spec.mediaName, duration: task.spec.duration,
        instruction: workflow.instruction, outputFormat: 'md', outputDir: workflowRoot,
        cloudApproved: !isLocalModelConfig(config), signal,
        onStatus: (value) => status(`（1/2）${value}`), onCheckpoint, resumeCheckpoint,
        workspace: documentWorkspace,
        complete: (call) => llmComplete({ ...call, modelConfig: config, taskKind: 'analysis' }),
        completeVisionMulti: (call) => llmCompleteVisionMulti({ ...call, modelConfig: config, taskKind: 'analysis-vision' }),
        frames: videoFrames, translateToChinese: translateAnalysisCuesToChinese,
        model: { configured: true, local: isLocalModelConfig(config), provider: config.providerName || config.providerId || '', model: config.model }
      }),
      runPackage: async ({ analysisResult, resumeCheckpoint, onCheckpoint }) => {
        const analysisPath = String(analysisResult.outputs?.[0] || '')
        if (!analysisPath || !fs.existsSync(analysisPath)) throw new Error('成果工作流缺少可复用的视频分析底稿')
        return documentWorkspace.run([analysisPath], bundleInstruction, 'auto', {
          signal, onStatus: (value) => status(`（2/2）${value}`), onCheckpoint, resumeCheckpoint,
          modelConfig: config, contextWindow: contextWindowForConfig(config), maxOutputTokens: maxOutputTokensForConfig(config),
          modelLabel: `${config.providerName || config.providerId} · ${config.model}`
        })
      }
    })
    for (const outputPath of result.outputs || []) userAuthorizedPaths.add(path.resolve(outputPath))
    const subtitlePath = findAdjacentSubtitle(sourcePath)
    const intermediateOutputs = result.workflowReceipt?.steps?.find((item) => item.id === 'evidence-analysis')?.outputs || []
    const projectCapsule = projectCapsules.recordTask({ projectId: task.spec.projectId, taskId: task.id, type: task.type, instruction: workflow.instruction, sources: [...task.spec.sources, ...(subtitlePath ? [subtitlePath] : [])], outputs: result.outputs || [], intermediateOutputs, historyId: result.historyId, operationKey: task.spec.operationKey, result })
    return { ...result, projectCapsule }
  }, { autoResume: true })
  persistentTaskRuntime.register('project.trash', async ({ task, checkpoint }) => {
    if (task.checkpoint?.stage === 'trashed' && task.checkpoint?.result) return task.checkpoint.result
    const projectCapsule = projectCapsules.trash(task.spec.projectId)
    const result = { success: true, chatOnly: true, summary: `项目《${projectCapsule.name}》已移入可恢复区；素材与成果文件均未删除`, projectCapsule }
    checkpoint({ stage: 'trashed', result })
    return result
  }, { autoResume: true })
  persistentTaskRuntime.register('download.direct', async ({ task, signal, checkpoint, status }) => {
    let lastCheckpointAt = 0
    let lastCheckpointBytes = Number(task.checkpoint?.received || 0)
    let lastStatusAt = 0
    const saveCheckpoint = (patch) => {
      const now = Date.now()
      const received = Number(patch?.received || 0)
      if (lastCheckpointAt && now - lastCheckpointAt < 1000 && received - lastCheckpointBytes < 1024 * 1024) return
      lastCheckpointAt = now
      lastCheckpointBytes = received
      checkpoint(patch)
    }
    const reportProgress = ({ received, total }) => {
      const now = Date.now()
      if (lastStatusAt && now - lastStatusAt < 500) return
      lastStatusAt = now
      const mb = (value) => (value / 1024 / 1024).toFixed(1)
      status(total ? `正在下载 ${mb(received)}/${mb(total)}MB` : `已下载 ${mb(received)}MB`)
    }
    status('正在校验链接')
    const result = await downloadRemoteMedia(task.spec.url, {
      destDir: fixedDownloadDir(),
      signal,
      checkpoint: task.checkpoint,
      onCheckpoint: saveCheckpoint,
      onProgress: reportProgress
    })
    userAuthorizedPaths.add(path.resolve(result.outputPath))
    return result
  }, { autoResume: true })
  persistentTaskRuntime.register('download.site', async ({ task, signal, checkpoint, status }) => {
    let lastStatusAt = 0
    const reportStatus = (value, force = false) => {
      const now = Date.now()
      if (!force && lastStatusAt && now - lastStatusAt < 500) return
      lastStatusAt = now
      status(value)
    }
    if (!siteVideo.availability().available) {
      reportStatus('首次使用站点视频，正在准备解析组件', true)
      await ytdlpDownload.start({})
    }
    let info = task.checkpoint?.info || null
    if (!info) {
      reportStatus('正在解析视频页', true)
      info = await siteVideo.resolve(task.spec.url, { signal, onRetryNote: (note) => reportStatus(note, true) })
      checkpoint({ info })
    }
    reportStatus(`正在下载：${String(info.title || '').slice(0, 40)}`, true)
    const result = await siteVideo.download(task.spec.url, {
      destDir: fixedDownloadDir(),
      signal,
      onRetryNote: (note) => reportStatus(note, true),
      onProgress: (progress) => reportStatus(`正在下载 ${progress.percent}%`)
    })
    userAuthorizedPaths.add(path.resolve(result.outputPath))
    return { info, ...result }
  }, { autoResume: true })

  // LAN-facing services are instantiated but remain stopped until the user
  // explicitly enables them from “设备、投屏与同步”.
  wifiTransfer = new WifiTransfer()

  castService = new CastService({ stateFile: path.join(app.getPath('userData'), 'cast-last-device.json') })

  syncService = new SyncService(path.join(app.getPath('userData'), 'sync-progress.json'))

  dlnaServer = new DlnaServer()

  dlnaReceiver = new DlnaReceiver()
  dlnaReceiver.onPlay = (url) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('receiver:play', url)

  }
  // AgentPlay 互投（屏幕镜像）：接收端开 TCP+UDP 广播并弹镜像窗；发送端采集全屏推流
  const closeMirrorWindow = () => {
    try { mirrorWindow?.close() } catch { /* 忽略 */ }
    mirrorWindow = null
  }
  const stopMirrorReceiver = () => {
    mirrorReceiver?.stop()
    mirrorReceiver = null
    closeMirrorWindow()
  }
  const stopMirrorSender = async () => {
    if (mirrorCaptureTimer) clearInterval(mirrorCaptureTimer)
    mirrorCaptureTimer = null
    mirrorSender?.close()
    mirrorSender = null
  }
  const openMirrorWindow = (pin, name) => {
    closeMirrorWindow()
    mirrorWindow = new BrowserWindow({
      width: 960,
      height: 600,
      backgroundColor: '#000000',
      autoHideMenuBar: true,
      title: `AgentPlay 互投接收 - ${name}`,
      webPreferences: { preload: path.join(__dirname, 'mirror-preload.js'), sandbox: true }
    })
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;background:#000;overflow:hidden}
      #v{width:100%;height:100%;object-fit:contain;display:block}
      #pin{position:fixed;top:12px;right:12px;background:rgba(0,0,0,.72);color:#4ade80;font:600 22px/1.5 monospace;padding:8px 14px;border-radius:8px;letter-spacing:4px}
      #tip{position:fixed;left:12px;top:12px;background:rgba(0,0,0,.72);color:#aaa;font:13px/1.5 system-ui;padding:8px 12px;border-radius:8px}
    </style></head><body>
    <img id="v" alt="">
    <div id="pin">PIN ${pin}</div>
    <div id="tip">等待发送端连接…（在另一台电脑的 AgentPlay「设备、投屏与同步」里扫描并输入 PIN）</div>
    <script>
      const img = document.getElementById('v')
      window.mirrorView.onFrame((b64) => {
        img.src = 'data:image/jpeg;base64,' + b64
        const tip = document.getElementById('tip')
        if (tip) tip.remove()
      })
    </script></body></html>`
    mirrorWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    mirrorWindow.on('closed', () => {
      mirrorWindow = null
      stopMirrorReceiver()
    })
  }

  ipcMain.handle('mirror:start-receiver', async (event) => {
    assertTrustedSender(event)
    stopMirrorReceiver()
    const receiver = new MirrorReceiver({
      name: os.hostname(),
      onFrame: (jpeg) => {
        if (mirrorWindow && !mirrorWindow.isDestroyed()) mirrorWindow.webContents.send('mirror:frame', jpeg.toString('base64'))
      }
    })
    const info = await receiver.start()
    mirrorReceiver = receiver
    openMirrorWindow(info.pin, info.name)
    return { success: true, ...info }
  })
  ipcMain.handle('mirror:stop-receiver', (event) => {
    assertTrustedSender(event)
    stopMirrorReceiver()
    return true
  })
  ipcMain.handle('mirror:scan', async (event) => {
    assertTrustedSender(event)
    mirrorDiscovery?.stop()
    mirrorDiscovery = new MirrorDiscovery()
    return mirrorDiscovery.listen(2500)
  })
  ipcMain.handle('mirror:start-sender', async (event, input = {}) => {
    assertTrustedSender(event)
    const host = String(input.host || '').trim()
    const port = Number(input.port)
    const pin = String(input.pin || '').trim()
    if (!host || !Number.isInteger(port) || port <= 0 || !/^\d{6}$/.test(pin)) return { success: false, error: '目标地址或 PIN 无效' }
    await stopMirrorSender()
    const sender = new MirrorSender({ host, port, pin })
    try {
      await sender.connect()
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    mirrorSender = sender
    mirrorCaptureTimer = setInterval(async () => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } })
        const shot = sources[0]?.thumbnail
        if (shot && !shot.isEmpty()) sender.sendJpeg(shot.toJPEG(70))
      } catch { /* 单帧失败不中断推流 */ }
    }, 350)
    return { success: true }
  })
  ipcMain.handle('mirror:stop-sender', async (event) => {
    assertTrustedSender(event)
    await stopMirrorSender()
    return true
  })
  ipcMain.handle('mirror:status', (event) => {
    assertTrustedSender(event)
    return {
      receiving: mirrorReceiver ? mirrorReceiver.info() : null,
      sending: mirrorSender ? { host: mirrorSender.host, port: mirrorSender.port } : null
    }
  })

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
  win.on('enter-full-screen', () => {
    win.webContents.send('window:fullscreen-changed', true)
    win.webContents.send('mpv:remeasure')
  })
  win.on('leave-full-screen', () => {
    win.webContents.send('window:fullscreen-changed', false)
    win.webContents.send('mpv:remeasure')
  })

  // IPC：渲染进程 -> mpv
  ipcMain.on('mpv:playerArea', (_e, rect) => {
    assertTrustedSender(_e)
    playerArea = rect
    updateContainerBounds()
  })
  ipcMain.on('mpv:showContainer', (event) => {
    assertTrustedSender(event)
    if (mpvContainer && !mpvContainer.isDestroyed()) mpvContainer.show()
  })
  ipcMain.on('mpv:hideContainer', (event) => {
    assertTrustedSender(event)
    if (mpvContainer && !mpvContainer.isDestroyed()) mpvContainer.hide()
  })
  ipcMain.handle('mpv:info', (event) => { assertTrustedSender(event); return ({ ready: mpvReady, embedded: mpvReady && !!mpvContainer, available: mpv.isAvailable() }) })
  ipcMain.handle('mpv:load', (_e, p) => { assertTrustedSender(_e); return mpvReady && mpv.loadFile(p) })
  ipcMain.handle('mpv:play', (event) => { assertTrustedSender(event); return mpvReady && mpv.play() })
  ipcMain.handle('mpv:pause', (event) => { assertTrustedSender(event); return mpvReady && mpv.pause() })
  ipcMain.handle('mpv:seek', (_e, s) => { assertTrustedSender(_e); return mpvReady && mpv.seek(s) })
  ipcMain.handle('mpv:volume', (_e, v) => { assertTrustedSender(_e); return mpvReady && mpv.setVolume(v) })
  ipcMain.handle('mpv:speed', (_e, v) => { assertTrustedSender(_e); return mpvReady && mpv.setSpeed(v) })
  ipcMain.handle('mpv:picture-mode', (_e, mode) => { assertTrustedSender(_e); return mpvReady && mpv.setPictureMode(mode) })
  ipcMain.handle('mpv:subtitle', (_e, p) => { assertTrustedSender(_e); return mpvReady && mpv.loadSubtitle(p) })
  ipcMain.handle('mpv:subtitle-visible', (_e, v) => { assertTrustedSender(_e); return mpvReady && mpv.setSubtitleVisible(v) })
  ipcMain.handle('mpv:subtitle-position', (_e, position) => { assertTrustedSender(_e); return mpvReady && mpv.setSubtitlePosition(position) })
  ipcMain.handle('mpv:stop', (event) => { assertTrustedSender(event); return mpvReady && mpv.stopPlayback() })
  ipcMain.handle('mpv:screenshot', async (_e, suggestedName) => {
    assertTrustedSender(_e)
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('pictures'), String(suggestedName || 'AgentPlay截图.png')),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }]
    })
    return result.canceled || !result.filePath ? false : mpvReady && mpv.screenshot(result.filePath)
  })

  // 可编辑区域与选中文字的系统右键菜单（复制/粘贴/剪切/全选），播放器菜单之外的通用编辑入口
  mainWindow.webContents.on('context-menu', (_e, params) => {
    if (params.isEditable) {
      Menu.buildFromTemplate([
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' }
      ]).popup({ window: mainWindow })
    } else if (String(params.selectionText || '').trim()) {
      Menu.buildFromTemplate([{ role: 'copy', label: '复制' }]).popup({ window: mainWindow })
    }
  })
  ipcMain.on('context:show', (_event, state = {}) => {
    assertTrustedSender(_event)
    const item = (label, action, extra = {}) => ({ label, click: () => sendAction(action), ...extra })
    const contextMenu = Menu.buildFromTemplate([
      item(state.isPlaying ? '暂停' : '播放', 'play-toggle', { enabled: !!state.hasMedia }),
      item('后退 10 秒', 'seek-backward', { enabled: !!state.hasMedia }),
      item('前进 10 秒', 'seek-forward', { enabled: !!state.hasMedia }),
      { type: 'separator' },
      item('截取当前画面…', 'screenshot', { enabled: !!state.hasMedia }),
      item(state.subtitleVisible ? '关闭字幕' : '打开字幕', 'subtitle-toggle', { enabled: !!state.hasMedia }),
      item('自动翻译字幕', 'bilingual-subtitle', { enabled: !!state.hasMedia }),
      { label: '字幕高级选项', enabled: !!state.hasMedia, submenu: [
        item(state.liveTranslate ? '停止实时翻译' : '翻译已加载字幕（边播边译）', 'live-translate-subtitle'),
        item('仅实时识别原文（无字幕视频）', 'live-transcribe-subtitle'),
        item('搜索 OpenSubtitles 字幕库…', 'online-subtitle')
      ] },
      item('拉片（AI 对话解剖）', 'analysis-studio', { enabled: !!state.hasMedia }),
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
  ipcMain.handle('window:setPreset', (_e, preset, mediaSize) => { assertTrustedSender(_e); return setWindowPreset(preset, mediaSize) })
  ipcMain.handle('window:setPlaybackChromeVisible', (_e, _visible) => {
    assertTrustedSender(_e)
    if (!mainWindow || mainWindow.isDestroyed()) return false
    if (process.platform !== 'darwin') {
      // AI-native 工作区默认不占一整行展示旧菜单；功能仍由快捷键、右键菜单和 Alt 临时菜单保留。
      mainWindow.setAutoHideMenuBar(true)
      mainWindow.setMenuBarVisibility(false)
    }
    return true
  })
  ipcMain.handle('window:isPlaybackChromeVisible', (event) => {
    assertTrustedSender(event)
    if (!mainWindow || mainWindow.isDestroyed()) return false
    return process.platform === 'darwin' ? true : mainWindow.isMenuBarVisible()
  })
  ipcMain.handle('guide:annotate', async (event, question) => {
    assertTrustedSender(event)
    try {
      const config = cloudConfigForExplicitFeature()
      const approved = await ensureCloudConsent('当前屏幕截图将发送给云端视觉模型，用于生成操作指引。')
      if (!approved) return { success: false, error: '已取消：未授权发送云端' }
      const ask = () => requestScreenGuide(config, String(question || ''))
      // 网络抖动自动重试一次（实测云端视觉偶发 fetch failed）
      const result = await ask().catch((firstError) => {
        if (!/fetch failed|network|timed ?out|abort|econn|socket/i.test(firstError.message)) throw firstError
        return ask()
      })
      if (result.marks.length) showGuideOverlay(result.marks)
      return { success: true, steps: result.steps, annotated: result.marks.length > 0 }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  // 单文件压缩/转码核心：返回 { success, outputPath, beforeBytes, afterBytes, error? }
  async function compressOne(sourcePath, targetMb, mode, { signal, outputPath: requestedOutputPath } = {}) {
    const parsed = path.parse(sourcePath)
    const outputPath = requestedOutputPath || path.join(parsed.dir, `${parsed.name}-AgentPlay${mode === 'remux' ? '转码' : '压缩'}版.mp4`)
    const tempPath = `${outputPath}.agentplay-${process.pid}-${Date.now()}.mp4`
    try {
      if (signal?.aborted) throw new Error('已取消')
      const args = ['-i', sourcePath]
      if (mode === 'remux') {
        args.push('-c', 'copy', '-movflags', '+faststart', '-y', tempPath)
      } else {
        let duration = 0
        try {
          duration = await videoFrames.probeDuration(sourcePath, { signal })
        } catch (error) {
          if (signal?.aborted) throw error
        }
        if (duration > 0) {
          const totalKbps = Math.max(300, Math.floor((targetMb * 8 * 1024) / duration) - 96)
          args.push('-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${totalKbps}k`, '-maxrate', `${totalKbps}k`, '-bufsize', `${totalKbps * 2}k`)
        } else {
          args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28')
        }
        args.push('-vf', "scale='min(1280,iw)':-2", '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-y', tempPath)
      }
      await videoFrames.run(args, { timeoutMs: 30 * 60 * 1000, signal })
      if (signal?.aborted) throw new Error('已取消')
      fs.renameSync(tempPath, outputPath)
      return { success: true, outputPath, beforeBytes: fs.statSync(sourcePath).size, afterBytes: fs.statSync(outputPath).size }
    } catch (error) {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })
      throw error
    }
  }

  const taskSuffix = (requestId) => String(requestId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(-12) || crypto.randomUUID().slice(0, 8)
  const plannedMediaOutput = (sourcePath, label, extension, requestId, index = 0) => {
    const parsed = path.parse(sourcePath)
    const ordinal = index > 0 ? `-${index + 1}` : ''
    return path.join(parsed.dir, `${parsed.name}-AgentPlay${label}-${taskSuffix(requestId)}${ordinal}${extension}`)
  }
  const validatePlannedMediaOutput = (actualPath, sourcePath, label, extension, requestId, index = 0) => {
    const expected = plannedMediaOutput(sourcePath, label, extension, requestId, index)
    if (path.resolve(String(actualPath || '')) !== path.resolve(expected)) throw new Error('任务成果路径完整性校验失败')
    return expected
  }
  const quickMediaFingerprint = (filePath, stat = fs.statSync(filePath)) => {
    const handle = fs.openSync(filePath, 'r')
    const sampleSize = Math.min(128 * 1024, stat.size)
    const first = Buffer.allocUnsafe(sampleSize)
    const last = Buffer.allocUnsafe(sampleSize)
    try {
      fs.readSync(handle, first, 0, sampleSize, 0)
      fs.readSync(handle, last, 0, sampleSize, Math.max(0, stat.size - sampleSize))
    } finally {
      fs.closeSync(handle)
    }
    return crypto.createHash('sha256').update(first).update(last).update(String(stat.size)).digest('hex')
  }
  const snapshotMediaSources = (filePaths) => (Array.isArray(filePaths) ? filePaths : []).slice(0, 20).map((filePath) => {
    const resolved = fs.realpathSync(path.resolve(String(filePath || '')))
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) throw new Error(`媒体源不是文件：${path.basename(resolved)}`)
    return { path: resolved, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs), dev: Number(stat.dev) || 0, ino: Number(stat.ino) || 0, fingerprint: quickMediaFingerprint(resolved, stat) }
  })
  const validateMediaSources = (sources) => (Array.isArray(sources) ? sources : []).map((expected) => {
    let resolved
    try { resolved = fs.realpathSync(path.resolve(String(expected?.path || ''))) } catch { throw new Error(`媒体源文件已不存在：${path.basename(String(expected?.path || ''))}`) }
    const stat = fs.statSync(resolved)
    const unchanged = stat.isFile() && stat.size === Number(expected.size) && Math.trunc(stat.mtimeMs) === Number(expected.mtimeMs) && quickMediaFingerprint(resolved, stat) === expected.fingerprint
    if (!unchanged) throw new Error(`媒体源文件已发生变化，请重新选择：${path.basename(resolved)}`)
    if (Number(expected.dev) && Number(stat.dev) !== Number(expected.dev)) throw new Error(`媒体源磁盘已变化，请重新选择：${path.basename(resolved)}`)
    if (Number(expected.ino) && Number(stat.ino) !== Number(expected.ino)) throw new Error(`媒体源文件身份已变化，请重新选择：${path.basename(resolved)}`)
    return resolved
  })
  const frozenDirectoryRoot = (root) => {
    const resolved = fs.realpathSync(assertAllowedPath(root))
    const stat = fs.statSync(resolved)
    if (!stat.isDirectory()) throw new Error('重复文件检查目标不是文件夹')
    return { path: resolved, dev: Number(stat.dev) || 0, ino: Number(stat.ino) || 0 }
  }
  const validateFrozenDirectoryRoot = (snapshot) => {
    const resolved = fs.realpathSync(path.resolve(String(snapshot?.path || '')))
    const stat = fs.statSync(resolved)
    if (!stat.isDirectory()) throw new Error('重复文件检查目标已不是文件夹')
    if (path.resolve(resolved) !== path.resolve(String(snapshot?.path || ''))) throw new Error('重复文件检查目标路径已变化')
    if (Number(snapshot?.dev) && Number(stat.dev) !== Number(snapshot.dev)) throw new Error('重复文件检查目标磁盘已变化')
    if (Number(snapshot?.ino) && Number(stat.ino) !== Number(snapshot.ino)) throw new Error('重复文件检查目标文件夹已变化')
    return resolved
  }

  const publishBatchProgress = (requestId, done, total, name) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('media:batch-progress', { requestId, done, total, name })
  }
  const publishDedupProgress = (requestId, progress) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('media:dedup-progress', { requestId, ...progress })
  }

  persistentTaskRuntime.register('media.batch', async ({ task, signal, checkpoint, status }) => {
    if (task.checkpoint?.stage === 'artifact-written' && task.checkpoint?.result) return task.checkpoint.result
    const sources = validateMediaSources(task.spec.sources)
    const kind = task.spec.kind === 'transcribe' ? 'transcribe' : 'compress'
    const total = sources.length
    const savedResults = Array.isArray(task.checkpoint?.results) ? task.checkpoint.results : []
    const startIndex = Math.max(0, Math.min(total, Number(task.checkpoint?.nextIndex) || 0))
    const results = savedResults.slice(0, startIndex)
    for (let index = startIndex; index < total; index += 1) {
      if (signal.aborted) throw new DOMException('批量任务已停止', 'AbortError')
      const sourcePath = sources[index]
      const token = String(task.spec.items?.[index]?.token || '')
      const label = kind === 'transcribe' ? '转写' : '压缩版'
      const extension = kind === 'transcribe' ? '.srt' : '.mp4'
      const outputPath = validatePlannedMediaOutput(task.spec.plannedOutputs?.[index], sourcePath, label, extension, task.id, index)
      publishBatchProgress(task.id, index, total, path.basename(sourcePath))
      status(`（${index + 1}/${total}）正在${kind === 'transcribe' ? '转写' : '压缩'} ${path.basename(sourcePath)}`)
      let itemResult
      try {
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          if (kind === 'transcribe') authorizeDerivedSubtitle(outputPath)
          else userAuthorizedPaths.add(path.resolve(outputPath))
          itemResult = { token, success: true, outputPath }
        } else if (kind === 'transcribe') {
          const transcription = await transcriptionService.transcribe({ sourcePath, lang: 'auto', timestamps: true, timeoutMs: 60 * 60 * 1000, noSpeechThold: 0.72, logprobThold: -0.6, signal })
          if (signal.aborted) throw new DOMException('批量转写已停止', 'AbortError')
          const text = String(transcription.text || '').trim()
          if (!text) throw new Error('没有识别到可写入的字幕内容')
          const tempPath = `${outputPath}.agentplay-${process.pid}-${Date.now()}.tmp`
          try {
            fs.writeFileSync(tempPath, `${text}\n`, 'utf8')
            fs.renameSync(tempPath, outputPath)
          } finally {
            if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })
          }
          authorizeDerivedSubtitle(outputPath)
          itemResult = { token, success: true, outputPath }
        } else {
          const compressed = await compressOne(sourcePath, task.spec.targetMb, 'compress', { signal, outputPath })
          userAuthorizedPaths.add(path.resolve(outputPath))
          itemResult = { token, ...compressed }
        }
      } catch (error) {
        if (signal.aborted || error?.name === 'AbortError') throw error
        itemResult = { token, success: false, error: error instanceof Error ? error.message : String(error) }
      }
      results.push(itemResult)
      checkpoint({ stage: 'item-complete', nextIndex: index + 1, results })
    }
    publishBatchProgress(task.id, total, total, '')
    const outputs = results.filter((item) => item.success && item.outputPath).map((item) => item.outputPath)
    const result = { success: true, requestId: task.id, kind, results, outputs, summary: `批量${kind === 'transcribe' ? '转写' : '压缩'}完成：成功 ${outputs.length}/${total}` }
    checkpoint({ stage: 'artifact-written', nextIndex: total, results, result })
    return result
  }, { autoResume: true })

  persistentTaskRuntime.register('media.compress', async ({ task, signal, checkpoint, status }) => {
    if (task.checkpoint?.stage === 'artifact-written' && task.checkpoint?.result && outputsStillExist(task.checkpoint.result)) return task.checkpoint.result
    const [sourcePath] = validateMediaSources(task.spec.sources)
    const mode = task.spec.mode === 'remux' ? 'remux' : 'compress'
    const label = mode === 'remux' ? '转码' : '压缩版'
    const outputPath = validatePlannedMediaOutput(task.spec.outputPath, sourcePath, label, '.mp4', task.id)
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      const result = { success: true, outputPath, outputs: [outputPath], beforeBytes: fs.statSync(sourcePath).size, afterBytes: fs.statSync(outputPath).size, mode }
      checkpoint({ stage: 'artifact-written', result })
      userAuthorizedPaths.add(path.resolve(outputPath))
      return result
    }
    status(mode === 'remux' ? '正在转封装为 MP4' : `正在压缩到约 ${task.spec.targetMb}MB`)
    const result = await compressOne(sourcePath, task.spec.targetMb, mode, { signal, outputPath })
    const completed = { ...result, outputs: [outputPath], mode }
    checkpoint({ stage: 'artifact-written', result: completed })
    userAuthorizedPaths.add(path.resolve(outputPath))
    return completed
  }, { autoResume: true })

  persistentTaskRuntime.register('media.edit-trim', async ({ task, signal, checkpoint, status }) => {
    const [sourcePath] = validateMediaSources(task.spec.sources)
    const decision = task.spec.decision
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.trim') throw new Error('冻结的剪辑决策无效')
    assertEditDecisionList(decision)
    if (path.resolve(String(decision.source?.path || '')) !== path.resolve(sourcePath)) throw new Error('冻结的剪辑决策与源视频不一致')
    const outputPath = validatePlannedMediaOutput(task.spec.outputPath, sourcePath, decision.output.suffix, '.mp4', task.id)
    status(`正在剪辑 ${decision.timeline.startSeconds}–${decision.timeline.endSeconds} 秒`)
    const result = fs.existsSync(outputPath)
      ? await mediaEditService.verify({ sourcePath, outputPath, decision: task.spec.decision, signal })
      : await mediaEditService.trim({ sourcePath, outputPath, decision: task.spec.decision, signal })
    validateMediaSources(task.spec.sources)
    const projectCapsule = mediaEditProjects.recordEdit({ taskId: task.id, sourcePath, outputPath, decision: task.spec.decision, repairing: task.checkpoint?.stage === 'quality-repair' })
    const completed = { ...result, projectCapsule }
    checkpoint({ stage: 'artifact-written', result: completed })
    userAuthorizedPaths.add(path.resolve(outputPath))
    return completed
  }, { autoResume: true })

  persistentTaskRuntime.register('media.edit-remove', async ({ task, signal, checkpoint, status }) => {
    const [sourcePath] = validateMediaSources(task.spec.sources)
    const decision = task.spec.decision
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.remove-segment') throw new Error('冻结的删除片段决策无效')
    assertEditDecisionList(decision)
    if (path.resolve(String(decision.source?.path || '')) !== path.resolve(sourcePath)) throw new Error('冻结的删除片段决策与源视频不一致')
    const outputPath = validatePlannedMediaOutput(task.spec.outputPath, sourcePath, decision.output.suffix, '.mp4', task.id)
    status(`正在删除 ${decision.timeline.startSeconds}–${decision.timeline.endSeconds} 秒并重建连续时间线`)
    const result = fs.existsSync(outputPath)
      ? await mediaEditService.verify({ sourcePath, outputPath, decision, signal })
      : await mediaEditService.removeSegment({ sourcePath, outputPath, decision, signal })
    validateMediaSources(task.spec.sources)
    const projectCapsule = mediaEditProjects.recordEdit({ taskId: task.id, sourcePath, outputPath, decision, repairing: task.checkpoint?.stage === 'quality-repair' })
    const completed = { ...result, projectCapsule }
    checkpoint({ stage: 'artifact-written', result: completed })
    userAuthorizedPaths.add(path.resolve(outputPath))
    return completed
  }, { autoResume: true })

  persistentTaskRuntime.register('media.edit-music', async ({ task, signal, checkpoint, status }) => {
    const [sourcePath, frozenAudioPath] = validateMediaSources(task.spec.sources)
    const decision = task.spec.decision
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.add-music') throw new Error('冻结的配乐决策无效')
    assertEditDecisionList(decision)
    if (path.resolve(String(decision.source?.path || '')) !== path.resolve(sourcePath)) throw new Error('冻结的配乐决策与源视频不一致')
    const audioPath = assertAllowedPath(decision.audio?.path || '')
    if (!frozenAudioPath || (path.resolve(audioPath) !== path.resolve(frozenAudioPath) && path.resolve(audioPath).toLowerCase() !== path.resolve(frozenAudioPath).toLowerCase())) throw new Error('冻结的配乐任务缺少音乐文件快照或路径不一致')
    const outputPath = validatePlannedMediaOutput(task.spec.outputPath, sourcePath, decision.output.suffix, '.mp4', task.id)
    const loudnessStatus = decision.audio?.loudness?.enabled === true
      ? `、响度两遍测量并归一到 ${Number(decision.audio.loudness.targetLufs)} LUFS`
      : '、不做响度归一'
    status(`正在配乐（音量 ${Math.round((Number(decision.audio?.volume) || 0.15) * 100)}%${decision.audio?.duck !== false ? '、对白闪避' : ''}${loudnessStatus}）`)
    const result = fs.existsSync(outputPath)
      ? await mediaEditService.verify({ sourcePath, outputPath, decision, signal })
      : await mediaEditService.addMusic({ sourcePath, outputPath, decision: { ...decision, audio: { ...decision.audio, path: audioPath } }, signal })
    validateMediaSources(task.spec.sources)
    const projectCapsule = mediaEditProjects.recordEdit({ taskId: task.id, sourcePath, outputPath, decision, repairing: task.checkpoint?.stage === 'quality-repair' })
    const completed = { ...result, projectCapsule }
    checkpoint({ stage: 'artifact-written', result: completed })
    userAuthorizedPaths.add(path.resolve(outputPath))
    return completed
  }, { autoResume: true })

  persistentTaskRuntime.register('media.edit-concat', async ({ task, signal, checkpoint, status }) => {
    const [sourcePath] = validateMediaSources(task.spec.sources)
    const decision = task.spec.decision
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.concat-segments') throw new Error('冻结的多片段拼接决策无效')
    assertEditDecisionList(decision)
    if (path.resolve(String(decision.source?.path || '')) !== path.resolve(sourcePath)) throw new Error('冻结的多片段拼接决策与源视频不一致')
    const outputPath = validatePlannedMediaOutput(task.spec.outputPath, sourcePath, decision.output.suffix, '.mp4', task.id)
    status(`正在按指定顺序拼接 ${decision.timeline.segments.length} 个片段`)
    const result = fs.existsSync(outputPath)
      ? await mediaEditService.verify({ sourcePath, outputPath, decision, signal })
      : await mediaEditService.concatSegments({ sourcePath, outputPath, decision, signal })
    validateMediaSources(task.spec.sources)
    const projectCapsule = mediaEditProjects.recordEdit({ taskId: task.id, sourcePath, outputPath, decision, repairing: task.checkpoint?.stage === 'quality-repair' })
    const completed = { ...result, projectCapsule }
    checkpoint({ stage: 'artifact-written', result: completed })
    userAuthorizedPaths.add(path.resolve(outputPath))
    return completed
  }, { autoResume: true })

  persistentTaskRuntime.register('media.edit-concat-sources', async ({ task, signal, checkpoint, status }) => {
    const sourcePaths = validateMediaSources(task.spec.sources)
    const [sourcePath] = sourcePaths
    const decision = task.spec.decision
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.concat-sources') throw new Error('冻结的跨素材拼接决策无效')
    assertEditDecisionList(decision)
    const decisionSources = (Array.isArray(decision.sources) ? decision.sources : []).map((item) => path.resolve(String(item?.path || '')))
    if (decisionSources.length < 2 || decisionSources.length > 20) throw new Error('冻结的跨素材拼接决策素材数量无效')
    if (decisionSources[0] !== path.resolve(sourcePath)) throw new Error('冻结的跨素材拼接决策与源视频不一致')
    if (decisionSources.length !== sourcePaths.length) throw new Error('冻结的跨素材拼接素材快照不完整')
    decisionSources.forEach((item, index) => {
      assertAllowedPath(item)
      const snapshotPath = path.resolve(sourcePaths[index])
      if (item !== snapshotPath && item.toLowerCase() !== snapshotPath.toLowerCase()) throw new Error(`冻结的跨素材拼接素材顺序不一致：${path.basename(item)}`)
    })
    const outputPath = validatePlannedMediaOutput(task.spec.outputPath, sourcePath, decision.output.suffix, '.mp4', task.id)
    status(`正在按顺序拼接 ${decisionSources.length} 个素材`)
    const result = fs.existsSync(outputPath)
      ? await mediaEditService.verify({ sourcePath, outputPath, decision, signal })
      : await mediaEditService.concatSources({ sourcePath, outputPath, decision, signal })
    validateMediaSources(task.spec.sources)
    const projectCapsule = mediaEditProjects.recordEdit({ taskId: task.id, sourcePath, outputPath, decision, repairing: task.checkpoint?.stage === 'quality-repair' })
    const completed = { ...result, projectCapsule }
    checkpoint({ stage: 'artifact-written', result: completed })
    userAuthorizedPaths.add(path.resolve(outputPath))
    return completed
  }, { autoResume: true })

  persistentTaskRuntime.register('media.edit-burn-subtitles', async ({ task, signal, checkpoint, status }) => {
    const [sourcePath] = validateMediaSources(task.spec.sources)
    const decision = task.spec.decision
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.burn-subtitles') throw new Error('冻结的烧录字幕决策无效')
    assertEditDecisionList(decision)
    if (path.resolve(String(decision.source?.path || '')) !== path.resolve(sourcePath)) throw new Error('冻结的烧录字幕决策与源视频不一致')
    assertAllowedPath(decision.subtitle?.path || '')
    const outputPath = validatePlannedMediaOutput(task.spec.outputPath, sourcePath, decision.output.suffix, '.mp4', task.id)
    status(`正在把字幕《${path.basename(String(decision.subtitle?.path || ''))}》烧录进画面`)
    const result = fs.existsSync(outputPath)
      ? await mediaEditService.verify({ sourcePath, outputPath, decision, signal })
      : await mediaEditService.burnSubtitles({ sourcePath, outputPath, decision, signal })
    validateMediaSources(task.spec.sources)
    const projectCapsule = mediaEditProjects.recordEdit({ taskId: task.id, sourcePath, outputPath, decision, repairing: task.checkpoint?.stage === 'quality-repair' })
    const completed = { ...result, projectCapsule }
    checkpoint({ stage: 'artifact-written', result: completed })
    userAuthorizedPaths.add(path.resolve(outputPath))
    return completed
  }, { autoResume: true })

  persistentTaskRuntime.register('media.edit-mux-subtitles', async ({ task, signal, checkpoint, status }) => {
    const [sourcePath] = validateMediaSources(task.spec.sources)
    const decision = task.spec.decision
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.mux-subtitles') throw new Error('冻结的软字幕封装决策无效')
    assertEditDecisionList(decision)
    if (path.resolve(String(decision.source?.path || '')) !== path.resolve(sourcePath)) throw new Error('冻结的软字幕封装决策与源视频不一致')
    assertAllowedPath(decision.subtitle?.path || '')
    const outputPath = validatePlannedMediaOutput(task.spec.outputPath, sourcePath, decision.output.suffix, '.mp4', task.id)
    status(`正在把字幕《${path.basename(String(decision.subtitle?.path || ''))}》封装成软字幕轨`)
    const result = fs.existsSync(outputPath)
      ? await mediaEditService.verify({ sourcePath, outputPath, decision, signal })
      : await mediaEditService.muxSubtitles({ sourcePath, outputPath, decision, signal })
    validateMediaSources(task.spec.sources)
    const projectCapsule = mediaEditProjects.recordEdit({ taskId: task.id, sourcePath, outputPath, decision, repairing: task.checkpoint?.stage === 'quality-repair' })
    const completed = { ...result, projectCapsule }
    checkpoint({ stage: 'artifact-written', result: completed })
    userAuthorizedPaths.add(path.resolve(outputPath))
    return completed
  }, { autoResume: true })

  persistentTaskRuntime.register('media.shift-subtitles', async ({ task, signal, checkpoint, status }) => {
    const [subtitlePath] = validateMediaSources(task.spec.sources)
    const decision = task.spec.decision
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.shift-subtitles') throw new Error('冻结的字幕调时决策无效')
    assertEditDecisionList(decision)
    if (path.resolve(String(decision.subtitle?.path || '')) !== path.resolve(subtitlePath)) throw new Error('冻结的字幕调时决策与字幕文件不一致')
    assertAllowedPath(decision.subtitle?.path || '')
    const outputPath = validatePlannedMediaOutput(task.spec.outputPath, subtitlePath, decision.output.suffix, decision.output?.container === 'vtt' ? '.vtt' : '.srt', task.id)
    status(`正在把字幕《${path.basename(subtitlePath)}》整体${decision.shift?.direction === 'earlier' ? '提前' : '延后'} ${Number(decision.shift?.offsetSeconds || 0).toFixed(3)} 秒`)
    const result = fs.existsSync(outputPath)
      ? await mediaEditService.verify({ sourcePath: subtitlePath, outputPath, decision, signal })
      : await mediaEditService.shiftSubtitles({ sourcePath: subtitlePath, outputPath, decision, signal })
    validateMediaSources(task.spec.sources)
    const projectCapsule = mediaEditProjects.recordEdit({ taskId: task.id, sourcePath: subtitlePath, outputPath, decision, repairing: task.checkpoint?.stage === 'quality-repair' })
    const completed = { ...result, projectCapsule }
    checkpoint({ stage: 'artifact-written', result: completed })
    userAuthorizedPaths.add(path.resolve(outputPath))
    return completed
  }, { autoResume: true })

  persistentTaskRuntime.register('media.translate-subtitles', async ({ task, signal, checkpoint, status }) => {
    const [subtitlePath] = validateMediaSources(task.spec.sources)
    const decision = task.spec.decision
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.translate-subtitles') throw new Error('冻结的字幕翻译决策无效')
    assertEditDecisionList(decision)
    if (path.resolve(String(decision.subtitle?.path || '')) !== path.resolve(subtitlePath)) throw new Error('冻结的字幕翻译决策与字幕文件不一致')
    assertAllowedPath(decision.subtitle?.path || '')
    const outputPath = validatePlannedMediaOutput(task.spec.outputPath, subtitlePath, decision.output.suffix, '.srt', task.id)
    // 冻结引擎重建：离线组件或冻结的云端路由；路由变化/凭证失效即故障关闭
    const engineChoice = String(task.spec.engineChoice || '')
    let engine = null
    if (engineChoice === 'offline') {
      if (!offlineTranslate.availability().available) throw new Error('本地离线翻译组件已不可用，请重新安装或改配云端模型')
      engine = { complete: (input) => offlineTranslate.jsonComplete(input), label: '本地离线翻译' }
    } else if (engineChoice === 'cloud') {
      const routeConfig = resolveTaskModelRoute(task.spec.modelRoute)
      engine = {
        complete: ({ systemPrompt, prompt, signal: callSignal, timeoutMs }) => llmComplete({ systemPrompt, prompt, signal: callSignal, timeoutMs, modelConfig: routeConfig, taskKind: 'subtitle-translation' }),
        label: `${routeConfig.providerName} · ${routeConfig.model}`
      }
    } else {
      throw new Error('冻结的翻译引擎无效，请重新发起翻译')
    }
    status(`正在把字幕《${path.basename(subtitlePath)}》翻译成${decision.translate?.mode === 'bilingual' ? '双语对照' : (decision.translate?.targetLang || '目标语言')}（${engine.label}）`)
    const result = fs.existsSync(outputPath)
      ? await mediaEditService.verify({ sourcePath: subtitlePath, outputPath, decision, signal })
      : await mediaEditService.translateSubtitles({
        sourcePath: subtitlePath,
        outputPath,
        decision,
        engine,
        signal,
        onProgress: ({ done, total }) => status(`正在翻译 ${done}/${total} 条`)
      })
    validateMediaSources(task.spec.sources)
    const projectCapsule = mediaEditProjects.recordEdit({ taskId: task.id, sourcePath: subtitlePath, outputPath, decision, repairing: task.checkpoint?.stage === 'quality-repair' })
    const completed = { ...result, projectCapsule }
    checkpoint({ stage: 'artifact-written', result: completed })
    userAuthorizedPaths.add(path.resolve(outputPath))
    return completed
  }, { autoResume: true })

  persistentTaskRuntime.register('media.edit-subtitle-cues', async ({ task, signal, checkpoint, status }) => {
    const [subtitlePath] = validateMediaSources(task.spec.sources)
    const decision = task.spec.decision
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.edit-subtitle-cues') throw new Error('冻结的字幕校对决策无效')
    assertEditDecisionList(decision)
    if (path.resolve(String(decision.subtitle?.path || '')) !== path.resolve(subtitlePath)) throw new Error('冻结的字幕校对决策与字幕文件不一致')
    assertAllowedPath(decision.subtitle?.path || '')
    const outputPath = validatePlannedMediaOutput(task.spec.outputPath, subtitlePath, decision.output.suffix, decision.output?.container === 'vtt' ? '.vtt' : '.srt', task.id)
    status(`正在校对字幕《${path.basename(subtitlePath)}》`)
    const result = fs.existsSync(outputPath)
      ? await mediaEditService.verify({ sourcePath: subtitlePath, outputPath, decision, signal })
      : await mediaEditService.editSubtitleCues({ sourcePath: subtitlePath, outputPath, decision, signal })
    validateMediaSources(task.spec.sources)
    const projectCapsule = mediaEditProjects.recordEdit({ taskId: task.id, sourcePath: subtitlePath, outputPath, decision, repairing: task.checkpoint?.stage === 'quality-repair' })
    const completed = { ...result, projectCapsule }
    checkpoint({ stage: 'artifact-written', result: completed })
    userAuthorizedPaths.add(path.resolve(outputPath))
    return completed
  }, { autoResume: true })

  persistentTaskRuntime.register('media.dedup', async ({ task, signal, checkpoint, status }) => {
    const root = validateFrozenDirectoryRoot(task.spec.root)
    const hashCache = task.checkpoint?.hashCache && typeof task.checkpoint.hashCache === 'object' ? { ...task.checkpoint.hashCache } : {}
    let lastCheckpointAt = 0
    let hashesSinceCheckpoint = 0
    let filesScanned = 0
    const reportProgress = (progress) => {
      filesScanned = Math.max(filesScanned, Number(progress.filesScanned) || 0)
      publishDedupProgress(task.id, { ...progress, filesScanned })
      if (progress.phase === 'scanning') status(`正在扫描媒体库 · 已发现 ${filesScanned} 个文件`)
      if (progress.phase === 'hashing') status(`正在核对文件内容 ${progress.processedFiles || 0}/${progress.totalFiles || 0}`)
    }
    const files = await analyzeDirAsync(root, { signal, onProgress: reportProgress })
    filesScanned = files.length
    const duplicates = await findDuplicates(files, {
      signal,
      hashCache,
      onProgress: (progress) => reportProgress({ ...progress, filesScanned }),
      onFileHashed: (file, hash) => {
        hashCache[file.path] = { hash, size: file.size, mtimeMs: file.mtimeMs }
        hashesSinceCheckpoint += 1
        const now = Date.now()
        if (hashesSinceCheckpoint >= 20 || now - lastCheckpointAt >= 1000) {
          const entries = Object.entries(hashCache).slice(-5000)
          checkpoint({ stage: 'hash-cache', hashCache: Object.fromEntries(entries) })
          lastCheckpointAt = now
          hashesSinceCheckpoint = 0
        }
      }
    })
    publishDedupProgress(task.id, { phase: 'complete', filesScanned, duplicateCount: duplicates.length })
    const result = { success: true, requestId: task.id, duplicates, filesScanned, outputs: duplicates.slice(0, 5).map((item) => item.duplicate), summary: duplicates.length ? `发现 ${duplicates.length} 组内容重复` : `已扫描 ${filesScanned} 个媒体文件，没有发现内容重复` }
    checkpoint({ stage: 'scan-complete', hashCache: Object.fromEntries(Object.entries(hashCache).slice(-5000)), result })
    return result
  }, { autoResume: true })

  // 批量任务：按授权 token 批量压缩或批量转写（附件多选后说「全部压缩/全部转写」）
  // 安全接入：Key 只发送给用户明确选择的一个厂商，绝不拿同一凭证并发试探多家第三方。
  ipcMain.handle('models:cli-status', async (event) => {
    assertTrustedSender(event)
    const { cliModelStatus } = require('./cli-model-service')
    return cliModelStatus()
  })
  ipcMain.handle('models:auto-detect', async (event, input = {}) => {
    assertTrustedSender(event)
    const apiKey = String(input.apiKey || '').trim()
    if (apiKey.length < 8) return { success: false, error: 'Key 太短，请粘贴完整 API Key' }
    const providerId = String(input.providerId || '')
    if (!providerId) return { success: false, needsProvider: true, error: '先选择这个 Key 是从哪家复制的；凭证不会发送给其他厂商' }
    const provider = PROVIDERS.find((item) => item.id === providerId && item.protocol === 'openai' && item.baseUrl && !item.localOnly && !item.bundled)
    if (!provider) return { success: false, error: '请选择一个受支持的云端服务' }
    const started = Date.now()
    try {
      const models = await listModels(
        { providerId: provider.id, baseUrl: provider.baseUrl, model: provider.models[0], apiKey, role: 'chat' },
        { timeoutMs: 8000 }
      )
      if (!models.length) throw new Error('账户没有返回可用模型')
      return { success: true, matches: [{ providerId: provider.id, providerName: provider.name, models, latencyMs: Date.now() - started }] }
    } catch (error) {
      return { success: false, error: `${provider.name} 验证失败：${error instanceof Error ? error.message : String(error)}` }
    }
  })

  ipcMain.handle('media:batch', async (event, input = {}) => {
    assertTrustedSender(event)
    const requestId = normalizeRequestId(input.requestId, 'media-batch')
    const tokens = Array.isArray(input.tokens) ? input.tokens.slice(0, 20).map(String) : []
    const kind = input.kind === 'transcribe' ? 'transcribe' : 'compress'
    try {
      if (!tokens.length) throw new Error('没有可处理的附件')
      const paths = tokens.map(documentSelectionFromToken)
      const label = kind === 'transcribe' ? '转写' : '压缩版'
      const extension = kind === 'transcribe' ? '.srt' : '.mp4'
      persistentTaskRuntime.enqueue({
        id: requestId,
        type: 'media.batch',
        workspaceTaskId: input.workspaceTaskId,
        spec: {
          kind,
          targetMb: Math.max(5, Math.min(500, Number(input.targetMb) || 25)),
          sources: snapshotMediaSources(paths),
          items: tokens.map((token) => ({ token })),
          plannedOutputs: paths.map((sourcePath, index) => plannedMediaOutput(sourcePath, label, extension, requestId, index))
        }
      })
      const task = await persistentTaskRuntime.run(requestId)
      if (task.state !== 'completed') return { ...(task.checkpoint?.result || {}), success: false, requestId, cancelled: task.state === 'cancelled', error: task.error || '批量任务未完成', results: task.checkpoint?.results || [], kind }
      return { ...task.result, requestId }
    } catch (error) {
      return { success: false, requestId, error: error instanceof Error ? error.message : String(error), results: [], kind }
    }
  })

  // 明确时间段剪辑：先冻结唯一时间线，再由主进程另存、探测并回执；询问/否定/举例不会进入写文件路径。
  ipcMain.handle('media:edit-plan', (event, input = {}) => {
    assertTrustedSender(event)
    try {
      const sourcePath = assertAllowedPath(input.sourcePath)
      return mediaEditConversation.plan({ instruction: input.instruction, sourcePath, clarificationId: input.clarificationId })
    } catch (error) {
      return { matched: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('media:edit-history-plan', (event, input = {}) => {
    assertTrustedSender(event)
    try {
      assertAllowedPath(input.currentPath)
      const action = compileEditHistoryAction(input.instruction)
      return action ? { matched: true, action } : { matched: false }
    } catch (error) {
      return { matched: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('media:edit-history', (event, input = {}) => {
    assertTrustedSender(event)
    try {
      const currentPath = assertAllowedPath(input.currentPath)
      const action = compileEditHistoryAction(input.instruction)
      if (!action) return { success: false, matched: false, error: '这句话不是明确的剪辑撤销或重做指令' }
      const result = mediaEditProjects.navigate({ currentPath, direction: action.action })
      if (!result.success) return { ...result, matched: true }
      userAuthorizedPaths.add(path.resolve(result.currentPath))
      const summary = action.action === 'undo'
        ? `已撤销刚才的剪辑，正在打开上一版：${path.basename(result.currentPath)}`
        : `已重做刚才撤销的剪辑，正在打开下一版：${path.basename(result.currentPath)}`
      return { ...result, matched: true, summary }
    } catch (error) {
      return { success: false, matched: true, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('media:trim', async (event, input = {}) => {
    assertTrustedSender(event)
    const requestId = normalizeRequestId(input.requestId, 'media-edit-trim')
    try {
      const sourcePath = assertAllowedPath(input.sourcePath)
      const rawDecision = compileConcatSourcesDecisionList({ instruction: input.instruction, sourcePath }) || compileMusicDecisionList({ instruction: input.instruction, sourcePath }) || compileBurnSubtitlesDecisionList({ instruction: input.instruction, sourcePath }) || compileMuxSubtitlesDecisionList({ instruction: input.instruction, sourcePath }) || compileTranslateSubtitlesDecisionList({ instruction: input.instruction, sourcePath }) || compileCueEditDecisionList({ instruction: input.instruction, sourcePath }) || compileShiftSubtitlesDecisionList({ instruction: input.instruction, sourcePath }) || compileEditDecisionList({ instruction: input.instruction, sourcePath })
      const decision = rawDecision ? attachEditDecisionList(rawDecision) : null
      if (!decision) return { success: false, matched: false, error: '这句话还不能形成唯一剪辑时间线，请明确说“保留第4秒到第20秒”“删除第4秒到第8秒”或“把第8秒到第12秒放前面，再接第0秒到第4秒”' }
      const taskType = decision.kind === 'media.concat-sources'
        ? 'media.edit-concat-sources'
        : decision.kind === 'media.concat-segments'
          ? 'media.edit-concat'
          : decision.kind === 'media.add-music'
            ? 'media.edit-music'
            : decision.kind === 'media.burn-subtitles'
              ? 'media.edit-burn-subtitles'
              : decision.kind === 'media.mux-subtitles'
                ? 'media.edit-mux-subtitles'
                : decision.kind === 'media.translate-subtitles'
                  ? 'media.translate-subtitles'
                  : decision.kind === 'media.edit-subtitle-cues'
                    ? 'media.edit-subtitle-cues'
                    : decision.kind === 'media.shift-subtitles'
                      ? 'media.shift-subtitles'
                      : decision.kind === 'media.remove-segment' ? 'media.edit-remove' : 'media.edit-trim'
      if (taskType !== 'media.shift-subtitles' && taskType !== 'media.translate-subtitles' && taskType !== 'media.edit-subtitle-cues' && !videoFrames.availability().available) return { success: false, error: '缺少 ffmpeg 组件（随 yt-dlp 组件包提供），请先在模型接入中心下载' }
      const allSourcePaths = decision.kind === 'media.concat-sources'
        ? decision.sources.map((item) => assertAllowedPath(item?.path || ''))
        : decision.kind === 'media.add-music'
          ? [sourcePath, assertAllowedPath(decision.audio?.path || '')]
          : decision.kind === 'media.shift-subtitles' || decision.kind === 'media.translate-subtitles' || decision.kind === 'media.edit-subtitle-cues'
            ? [assertAllowedPath(decision.subtitle?.path || '')]
            : [sourcePath]
      const outputExtension = decision.output?.container === 'vtt' ? '.vtt' : decision.output?.container === 'srt' ? '.srt' : '.mp4'
      const outputAnchor = decision.kind === 'media.shift-subtitles' || decision.kind === 'media.translate-subtitles' || decision.kind === 'media.edit-subtitle-cues' ? allSourcePaths[0] : sourcePath
      // 字幕翻译：在入队前冻结引擎与模型路由；云端先过原生同意框，拒绝则回退本地离线组件（仅英译中）
      let engineChoice = ''
      let modelRoute = null
      if (decision.kind === 'media.translate-subtitles') {
        const subtitleText = decodeSubtitleText(fs.readFileSync(allSourcePaths[0]))
        const cueCount = parseSrtCues(subtitleText).length
        if (!cueCount) return { success: false, matched: true, error: '字幕文件里没有可识别的有效条目（需要标准 srt 时间轴）' }
        const entries = parseSrt(subtitleText)
        const targetLang = decision.translate?.targetLang === 'auto' || !decision.translate?.targetLang ? chooseOppositeTarget(entries) : decision.translate.targetLang
        const engine = pickTranslateEngine(entries, targetLang, 'auto')
        if (!engine) return { success: false, matched: true, error: `没有可用的${targetLang}翻译方式：请配置云端模型，或到模型接入中心下载本地离线翻译组件（支持英译中）` }
        if (engine.offline) {
          engineChoice = 'offline'
        } else {
          const approved = await ensureCloudConsent(`把字幕原文发送给 ${engine.label} 翻译成${targetLang}；视频文件不会上传`)
          if (approved) {
            engineChoice = 'cloud'
            modelRoute = freezeTaskModelRoute(creativeConfig(), { taskKind: 'subtitle-translation' })
          } else if (offlineTranslate.availability().available && shouldUseOffline(entries, targetLang)) {
            engineChoice = 'offline'
          } else {
            return { success: false, matched: true, cancelled: true, error: targetLang === '英文' ? '已取消：未授权发送云端；中译英暂无本地离线组件，需要配置云端模型' : '已取消：未授权发送云端；也可以到模型接入中心下载本地离线翻译组件（英译中免费）' }
          }
        }
      }
      persistentTaskRuntime.enqueue({
        id: requestId,
        type: taskType,
        workspaceTaskId: input.workspaceTaskId,
        spec: {
          instruction: decision.instruction,
          decision,
          sources: snapshotMediaSources(allSourcePaths),
          outputPath: plannedMediaOutput(outputAnchor, decision.output.suffix, outputExtension, requestId),
          ...(engineChoice ? { engineChoice } : {}),
          ...(modelRoute ? { modelRoute } : {})
        }
      })
      const task = await persistentTaskRuntime.run(requestId)
      if (task.state !== 'completed') return { success: false, matched: true, requestId, cancelled: task.state === 'cancelled', error: task.error || '视频剪辑未完成' }
      return { ...task.result, matched: true, requestId }
    } catch (error) {
      return { success: false, matched: true, requestId, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // 视频压缩/转码：默认压到微信可发（25MB 目标码率），remux 模式不重编码秒级换封装；原文件不动
  ipcMain.handle('media:compress', async (event, input = {}) => {
    assertTrustedSender(event)
    const requestId = normalizeRequestId(input.requestId, 'media-compress')
    try {
      const sourcePath = assertAllowedPath(input.sourcePath)
      if (!videoFrames.availability().available) return { success: false, error: '缺少 ffmpeg 组件（随 yt-dlp 组件包提供），请先在模型接入中心下载' }
      const mode = input.mode === 'remux' ? 'remux' : 'compress'
      const targetMb = Math.max(5, Math.min(500, Number(input.targetMb) || 25))
      const label = mode === 'remux' ? '转码' : '压缩版'
      persistentTaskRuntime.enqueue({
        id: requestId,
        type: 'media.compress',
        workspaceTaskId: input.workspaceTaskId,
        spec: { sources: snapshotMediaSources([sourcePath]), targetMb, mode, outputPath: plannedMediaOutput(sourcePath, label, '.mp4', requestId) }
      })
      const task = await persistentTaskRuntime.run(requestId)
      if (task.state !== 'completed') return { success: false, requestId, mode, cancelled: task.state === 'cancelled', error: task.error || '视频处理未完成' }
      return { ...task.result, requestId, mode }
    } catch (error) {
      return { success: false, requestId, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('media:task-cancel', (event, requestId) => {
    assertTrustedSender(event)
    const controller = activeMediaTasks.get(String(requestId || ''))
    controller?.abort()
    return persistentTaskRuntime.cancel(String(requestId || '')) || Boolean(controller)
  })
  ipcMain.handle('guide:dismiss', (event) => {
    assertTrustedSender(event)
    dismissGuideOverlay()
    return true
  })
  // 画面问答：视频帧/截图发给视觉模型。mpv 播放时主进程直接截图，HTML5 由渲染端给 dataUrl
  ipcMain.handle('guide:askFrame', async (event, input) => {
    assertTrustedSender(event)
    const fsPromises = require('fs').promises
    let dataUrl = String(input?.dataUrl || '')
    let tmpShot = ''
    try {
      const config = cloudConfigForExplicitFeature()
      const approved = await ensureCloudConsent('当前视频画面截图将发送给云端视觉模型，用于回答画面问题。')
      if (!approved) return { success: false, error: '已取消：未授权发送云端' }
      if (!dataUrl) {
        if (!mpvReady || !mpv) throw new Error('播放器尚未就绪')
        tmpShot = path.join(os.tmpdir(), `agentplay-frame-${Date.now()}.jpg`)
        const ok = await mpv.screenshot(tmpShot)
        if (!ok || !fs.existsSync(tmpShot)) throw new Error('视频帧抓取失败')
        dataUrl = 'data:image/jpeg;base64,' + (await fsPromises.readFile(tmpShot)).toString('base64')
      }
      const result = await askAboutImage(config, {
        dataUrl,
        question: String(input?.question || '')
      })
      return { success: true, answer: result.answer }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      if (tmpShot) await fsPromises.unlink(tmpShot).catch(() => {})
    }
  })
  ipcMain.handle('screenshot:save', async (_e, dataUrl, suggestedName) => {
    assertTrustedSender(_e)
    try {
      const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''))
      if (!match) throw new Error('截图数据格式无效')
      const buffer = Buffer.from(match[1], 'base64')
      if (buffer.length > 50 * 1024 * 1024) throw new Error('截图超过 50MB')
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: path.join(app.getPath('pictures'), String(suggestedName || 'AgentPlay截图.png')),
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
  ipcMain.handle('ai:chat', async (event, messages, context, requestedId, agentOptions = {}) => {
    assertTrustedSender(event)
    const requestId = normalizeRequestId(requestedId, 'chat')
    activeAiRequests.get(requestId)?.abort()
    const controller = new AbortController()
    activeAiRequests.set(requestId, controller)
    let usesBundledRuntime = false
    let chatConfig = null
    const startedAt = Date.now()
    const send = (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai:stream', { requestId, ...payload })
    }
    try {
      send({ status: 'queued' })
      const decision = selectConfiguredModel({ taskKind: 'chat' })
      chatConfig = decision.selected
      if (!chatConfig) throw new Error(decision.reason || '没有满足当前 AI 使用方式的模型')
      if (chatConfig.providerId === 'bundled-lite') {
        send({ status: 'loading-local-model' })
        const localStatus = await bundledRuntime.start()
        bundledRuntime.retain()
        usesBundledRuntime = true
        chatConfig = { ...chatConfig, model: localStatus.model, baseUrl: localStatus.baseUrl }
      }
      const result = await agentEngine.chat(messages, chatConfig, context, {
        requestId,
        mode: agentOptions?.mode,
        signal: controller.signal,
        onStatus: (status) => send({ status }),
        onDelta: (delta) => send({ delta })
      })
      modelPerformanceRouter.recordCall({
        taskKind: 'chat', config: chatConfig, startedAt, completedAt: Date.now(),
        success: !result.cancelled && !/^\[(API|网络|达到)/.test(String(result.text || '')),
        usage: result.usage
      })
      send({ status: result.cancelled ? 'cancelled' : 'done' })
      return { ...result, requestId, routeReason: decision.reason }
    } catch (error) {
      if (chatConfig) modelPerformanceRouter.recordCall({ taskKind: 'chat', config: chatConfig, startedAt, completedAt: Date.now(), success: false, errorCode: error?.code || error?.name })
      throw error
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
  ipcMain.handle('documents:capabilities', (event) => {
    assertTrustedSender(event)
    const config = modelConfigStore.resolved('chat')
    const requiresKey = config.requiresKey !== false
    return {
      formats: ['txt', 'md', 'csv', 'doc', 'docx', 'xlsx', 'pptx', 'pdf', 'odt', 'ods', 'odp', 'rtf', 'html'],
      modelConfigured: Boolean(config.baseUrl && config.model && (!requiresKey || config.apiKey)),
      modelLocal: isLocalModelConfig(config),
      providerName: config.providerName || config.providerId || '未配置',
      model: config.model || '',
      defaultOutputDir: path.join(app.getPath('documents'), 'AgentPlay 输出')
    }
  })
  ipcMain.handle('documents:select-files', async (event) => {
    assertTrustedSender(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要交给 AgentPlay 处理的文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '文档、表格、演示稿和 PDF', extensions: [...SUPPORTED_EXTENSIONS].map((ext) => ext.slice(1)) },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled) return []
    return approveDocumentPaths(result.filePaths.slice(0, 20))
  })
  // 站点视频（B站/YouTube/抖音等公开视频页）：解析组件缺失时先自动下载，再执行下载
  ipcMain.handle('media:site-status', (event) => {
    assertTrustedSender(event)
    return { ...siteVideo.availability(), download: ytdlpDownload.status(), pack: ytdlpDownload.packInfo() }
  })
  ipcMain.handle('media:site-download-component', async (event) => {
    assertTrustedSender(event)
    try {
      await ytdlpDownload.start({
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('media:site-component-progress', progress)
        }
      })
      return { success: true, availability: siteVideo.availability() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('media:site-cancel-component', (event) => {
    assertTrustedSender(event)
    return ytdlpDownload.cancel()
  })
  // 导入浏览器导出的 cookies.txt（站点风控/登录态用；浏览器锁库与 ABE 使直读浏览器库不可行）
  ipcMain.handle('media:site-import-cookies', async (event) => {
    assertTrustedSender(event)
    const picked = await dialog.showOpenDialog({
      title: '选择导出的 Cookies 文件',
      properties: ['openFile'],
      filters: [{ name: 'Cookies 文件 (txt/json)', extensions: ['txt', 'json'] }]
    })
    if (picked.canceled || !picked.filePaths.length) return { success: false, canceled: true }
    try {
      const source = picked.filePaths[0]
      const normalized = normalizeCookiesText(fs.readFileSync(source, 'utf8'))
      if (!normalized) return { success: false, error: '无法识别的 Cookies 文件（支持 Netscape cookies.txt，或 J2TEAM / Cookie-Editor 的 JSON 导出）' }
      const detected = detectCookiesDomain(normalized)
      if (!detected) return { success: false, error: '不是有效的 Cookies 文件（没有识别到任何 Cookie 条目）' }
      const dir = path.join(app.getPath('userData'), 'site-cookies')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${detected.domain}.txt`), normalized)
      return { success: true, domain: detected.domain, count: detected.count }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('media:site-cookies-status', (event) => {
    assertTrustedSender(event)
    const dir = path.join(app.getPath('userData'), 'site-cookies')
    try {
      return fs.readdirSync(dir).filter((name) => name.endsWith('.txt')).map((name) => ({
        domain: name.replace(/\.txt$/, ''),
        updatedAt: fs.statSync(path.join(dir, name)).mtimeMs
      }))
    } catch {
      return []
    }
  })
  // App 内扫码登录（抖音等需要登录态的站点）：一次登录，分区自持+静默续期
  ipcMain.handle('media:site-login', async (event, input = {}) => {
    assertTrustedSender(event)
    const domain = cookiesDomainForUrl(String(input.url || ''))
    if (!domain || !Object.prototype.hasOwnProperty.call(SITE_HOME, domain)) {
      return { success: false, error: '当前链接不支持 App 内登录，请导入该站点的 cookies.txt' }
    }
    return siteLogin.openLogin(domain, siteSessionCookies)
  })
  ipcMain.handle('media:site-download', async (event, input = {}) => {
    assertTrustedSender(event)
    const url = String(input.url || '').trim()
    if (!url) return { success: false, error: '没有找到链接' }
    const requestId = normalizeRequestId(input.requestId, 'site-dl')
    try {
      persistentTaskRuntime.enqueue({
        id: requestId,
        type: 'download.site',
        workspaceTaskId: input.workspaceTaskId,
        spec: { url }
      })
      const task = await persistentTaskRuntime.run(requestId)
      if (task.state !== 'completed') return { success: false, requestId, error: task.error || task.status || '下载未完成' }
      return { success: true, requestId, ...task.result }
    } catch (error) {
      return { success: false, requestId, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('media:link-analysis', async (event, input = {}) => {
    assertTrustedSender(event)
    const requestId = normalizeRequestId(input.requestId, 'link-ana')
    activeMediaDownloads.get(requestId)?.abort()
    const controller = new AbortController()
    activeMediaDownloads.set(requestId, controller)
    const sendStatus = (status) => {
      if (!event.sender.isDestroyed()) event.sender.send('media:download-status', { requestId, status })
    }
    try {
      let videoPath = String(input.videoPath || '').trim()
      let info = null
      const url = extractUrl(input.url || '')
      if (!videoPath && !url) return { success: false, error: '没有找到链接' }
      const destDir = path.join(app.getPath('videos'), 'AgentPlay 下载')
      if (!videoPath) {
        if (isMediaUrl(url)) {
          sendStatus('正在下载视频')
          const result = await downloadRemoteMedia(url, {
            destDir, signal: controller.signal,
            onProgress: ({ received, total }) => sendStatus(total ? `正在下载 ${Math.round((received / total) * 100)}%` : `已下载 ${(received / 1024 / 1024).toFixed(1)}MB`)
          })
          videoPath = result.outputPath
        } else {
          if (!siteVideo.availability().available) {
            sendStatus('首次使用站点视频，正在下载解析组件（约 18MB）')
            await ytdlpDownload.start({})
          }
          sendStatus('正在解析视频页')
          info = await siteVideo.resolve(url, { signal: controller.signal, onRetryNote: (note) => sendStatus(note) })
          sendStatus(`正在下载：${info.title.slice(0, 40)}`)
          const result = await siteVideo.download(url, {
            destDir, signal: controller.signal,
            onRetryNote: (note) => sendStatus(note),
            onProgress: (progress) => sendStatus(`正在下载 ${progress.percent}%`)
          })
          videoPath = result.outputPath
        }
        userAuthorizedPaths.add(path.resolve(videoPath))
      }
      if (!fs.existsSync(videoPath)) throw new Error('视频文件不存在或已被移动')
      // 转写：有组件才做；写出同名字幕，后续解剖与播放器共用
      const whisperStatus = transcriptionService.availability()
      if (whisperStatus.available) {
        const dur = Number(info?.duration) || 0
        if (dur > 45 * 60) {
          // 长视频前置守护：离线转写超 2 小时才跑完的事不硬干（分段转写排期中）
          sendStatus('视频超过 45 分钟，离线转写预计超过 2 小时，本次跳过（分段转写排期中）')
        } else {
          sendStatus('正在离线转写语音（CPU，约为音频时长数倍）')
          const transcription = await transcriptionService.transcribe({
            sourcePath: videoPath,
            lang: 'auto',
            timestamps: true,
            signal: controller.signal,
            timeoutMs: dur > 0 ? Math.max(15 * 60 * 1000, dur * 3000 + 5 * 60 * 1000) : undefined
          })
          if (String(transcription.text || '').trim()) {
            const srtPath = path.join(path.dirname(videoPath), `${path.parse(videoPath).name}.srt`)
            if (!fs.existsSync(srtPath)) fs.writeFileSync(srtPath, transcription.text, 'utf8')
          }
        }
      }
      // 拉片解剖（自动读取同名字幕证据）
      sendStatus('正在生成拉片解剖报告')
      const visionDecision = selectModelForTaskPlan({ taskKind: 'analysis-vision', requirements: { vision: true } })
      const textDecision = visionDecision.selected ? null : selectModelForTaskPlan({ taskKind: 'analysis', requirements: { text: true } })
      const config = visionDecision.selected || textDecision?.selected || null
      const analysisTaskKind = visionDecision.selected ? 'analysis-vision' : 'analysis'
      const requiresKey = config?.requiresKey !== false
       const modelConfigured = Boolean(config && config.baseUrl && config.model && (!requiresKey || config.apiKey))
       const modelLocal = Boolean(config && isLocalModelConfig(config))
       const approved = modelConfigured && !modelLocal
         ? await ensureCloudConsent('视频关键画面截图与口播字幕将发送给云端模型用于拉片分析。')
         : false
      const analysis = await runChatAnalysis({
        sourcePath: videoPath,
        mediaName: info?.title || path.basename(videoPath),
        duration: info?.duration,
        instruction: input.instruction || '深度解剖这个视频',
        outputFormat: input.outputFormat || resolveAnalysisOutput(input.instruction),
        cloudApproved: approved,
        signal: controller.signal,
        onStatus: sendStatus,
        workspace: documentWorkspace,
        complete: (call) => llmComplete({ ...call, modelConfig: config, taskKind: analysisTaskKind }),
         completeVisionMulti: (call) => llmCompleteVisionMulti({ ...call, modelConfig: config, taskKind: analysisTaskKind }),
         frames: videoFrames,
         translateToChinese: translateAnalysisCuesToChinese,
         model: {
           configured: modelConfigured,
           local: modelLocal,
           provider: config?.providerName || config?.providerId || '',
           model: config?.model || ''
        }
      })
      if (analysis.requiresApproval) {
        return { success: false, requiresApproval: true, requestId, videoPath, info }
      }
      return { success: true, requestId, videoPath, info, outputs: analysis.outputs, summary: analysis.summary, usedAi: analysis.usedAi, cueCount: analysis.cueCount, whispered: whisperStatus.available }
    } catch (error) {
      return { success: false, requestId, error: error instanceof Error ? error.message : String(error) }
    } finally {
      activeMediaDownloads.delete(requestId)
    }
  })
  ipcMain.handle('media:download-detect', (event, text) => {
    assertTrustedSender(event)
    const url = extractUrl(text)
    const wantsAnalysis = /拉片|解剖|分析|解读|讲解/.test(String(text || ''))
    const wantsDownloadOnly = /下载|保存/.test(String(text || '')) && !wantsAnalysis
    const mode = wantsAnalysis ? 'analyze' : wantsDownloadOnly ? 'download' : isDownloadIntent(text) ? 'analyze' : null
    return { matched: Boolean(mode), url, direct: isMediaUrl(url), mode }
  })
  ipcMain.handle('media:download', async (event, input = {}) => {
    assertTrustedSender(event)
    const url = extractUrl(input.url || input.text || '')
    if (!url) return { success: false, error: '没有找到可下载的链接' }
    const requestId = normalizeRequestId(input.requestId, 'media-dl')
    try {
      persistentTaskRuntime.enqueue({
        id: requestId,
        type: 'download.direct',
        workspaceTaskId: input.workspaceTaskId,
        spec: { url }
      })
      const task = await persistentTaskRuntime.run(requestId)
      if (task.state !== 'completed') return { success: false, requestId, error: task.error || task.status || '下载未完成' }
      return { success: true, requestId, ...task.result }
    } catch (error) {
      return { success: false, requestId, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('media:download-cancel', (event, requestId) => {
    assertTrustedSender(event)
    const controller = activeMediaDownloads.get(String(requestId || ''))
    controller?.abort()
    return persistentTaskRuntime.cancel(String(requestId || '')) || Boolean(controller)
  })
  ipcMain.handle('taskRuntime:list', (event) => {
    assertTrustedSender(event)
    return persistentTaskRuntime.list()
  })
  ipcMain.handle('taskRuntime:approve', (event, input = {}) => {
    assertTrustedSender(event)
    const task = persistentTaskRuntime.approve(input.approvalId, input.token)
    if (task.state === 'queued') void persistentTaskRuntime.run(task.id)
    return task
  })
  ipcMain.handle('taskRuntime:resume', async (event, input = {}) => {
    assertTrustedSender(event)
    return persistentTaskRuntime.resume(input.id, input.token)
  })
  ipcMain.handle('taskRuntime:cancel', (event, id) => {
    assertTrustedSender(event)
    return persistentTaskRuntime.cancel(String(id || ''))
  })
  ipcMain.handle('documents:attach-paths', (event, filePaths) => {
    assertTrustedSender(event)
    // 拖入/粘贴等同用户显式授权（恢复产品本意）；但敏感凭证类文件永远拒绝附加
    const requested = Array.isArray(filePaths) ? filePaths.slice(0, 20) : []
    if (!requested.length) return []
    const valid = requested.filter((p) => {
      try {
        let real = path.resolve(String(p || ''))
        if (!fs.existsSync(real)) return false
        try { real = fs.realpathSync(real) } catch { /* 按词法路径校验 */ }
        return !SENSITIVE_FILE.test(real)
      } catch {
        return false
      }
    })
    if (!valid.length) return { error: '没有可处理的文件（敏感凭证类文件不允许附加）' }
    try {
      return approveDocumentPaths(valid)
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('documents:preview-text', async (event, filePath) => {
    assertTrustedSender(event)
    try {
      const resolved = assertAllowedPath(filePath)
      const content = await extractText(resolved)
      return { success: true, content: content || '（没有可显示的文字内容）' }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('documents:history', (event) => {
    assertTrustedSender(event)
    const historyFile = path.join(app.getPath('userData'), 'document-workspace', 'history.jsonl')
    try {
      const lines = fs.readFileSync(historyFile, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
      return lines.slice(-10).reverse().map((line) => {
        try {
          const record = JSON.parse(line)
          return { id: record.id, createdAt: record.createdAt, instruction: record.instruction, kind: record.kind, outputs: record.outputs || [], summary: record.summary || '' }
        } catch { return null }
      }).filter(Boolean)
    } catch {
      return []
    }
  })
  ipcMain.handle('documents:plan', async (event, input = {}) => {
    assertTrustedSender(event)
    const tokens = Array.isArray(input.tokens) ? input.tokens.slice(0, 20) : []
    const paths = tokens.map(documentSelectionFromToken)
    const plan = documentWorkspace.plan(paths, input.instruction, input.outputFormat)
    const current = modelConfigStore.resolved('chat')
    const currentWithPolicy = { ...current, local: isLocalModelConfig(current), contextWindow: contextWindowForConfig(current) }
    const fallback = cloudFallbackFromStore(modelConfigStore, 'chat')
    const fallbackWithPolicy = fallback ? { ...fallback, local: isLocalModelConfig(fallback), contextWindow: contextWindowForConfig(fallback) } : null
    const preflight = plan.requiresAi
      ? await documentWorkspace.preflight(paths, input.instruction, input.outputFormat, {
          contextWindow: currentWithPolicy.contextWindow,
          maxOutputTokens: maxOutputTokensForConfig(currentWithPolicy)
        })
      : { estimatedTokens: 0, exceedsSingleCall: false }
    const routing = chooseDocumentModel({ current: currentWithPolicy, fallback: fallbackWithPolicy, preflight, cloudApproved: false })
    return {
      kind: plan.kind,
      requiresAi: plan.requiresAi,
      outputFormat: plan.outputFormat,
      summary: plan.summary,
      estimatedTokens: preflight.estimatedTokens,
      contextWindow: currentWithPolicy.contextWindow,
      processingMode: routing.mode,
      requiresCloudApproval: routing.requiresCloudApproval,
      fallbackModel: routing.requiresCloudApproval ? `${fallbackWithPolicy.providerName} · ${fallbackWithPolicy.model}` : '',
      files: plan.files.map(({ name, ext, size }) => ({ name, ext, size }))
    }
  })
  ipcMain.handle('documents:run', async (event, input = {}) => {
    assertTrustedSender(event)
    const requestId = normalizeRequestId(input.requestId, 'document')
    try {
      const tokens = Array.isArray(input.tokens) ? input.tokens.slice(0, 20) : []
      const paths = tokens.map(documentSelectionFromToken)
      const prepared = await preparePersistentDocumentTask(paths, input)
      let task = persistentTaskRuntime.enqueue({
        id: requestId,
        type: 'document.run',
        workspaceTaskId: input.workspaceTaskId,
        spec: prepared.spec,
        approval: prepared.approval
      })
      if (task.state === 'waiting_approval') {
        if (input.cloudApproved === true) {
          task = persistentTaskRuntime.approve(task.approval.id, task.approval.token)
        } else {
          return { success: false, requiresApproval: true, requestId, approval: task.approval }
        }
      }
      task = await persistentTaskRuntime.run(requestId)
      if (task.state !== 'completed') {
        return {
          success: false,
          requestId,
          error: task.failure?.message || task.error || '文档处理未完成',
          outputs: task.result?.outputs || [],
          summary: task.result?.summary || '',
          failures: task.result?.failures || {},
          deliveryReceipt: task.result?.deliveryReceipt,
          quality: task.quality || null,
          repairHistory: task.repairHistory || [],
          failure: task.failure || null
        }
      }
      return { ...task.result, requestId }
    } catch (error) {
      return { success: false, requestId, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('documents:cancel', (event, requestId) => {
    assertTrustedSender(event)
    const normalizedRequestId = String(requestId || '')
    const controller = activeDocumentRequests.get(normalizedRequestId)
    controller?.abort()
    return persistentTaskRuntime.cancel(String(requestId || '')) || Boolean(controller)
  })
  // “打开任意文件”统一分流：媒体进播放器、文档进授权附件（chat:open-any 与 home:open 共用）
  const splitAndApproveAny = (filePaths) => {
    const split = splitOpenAnyPaths(filePaths, {
      inspectDocuments: (paths) => {
        const ext = path.extname(paths[0]).toLowerCase()
        if (AUDIO_MEDIA_EXTS.includes(ext)) throw new Error('音视频走播放器')
        return documentWorkspace.inspect(paths)
      },
      isMediaPath: (filePath, ext) => ALL_EXTS.includes(ext),
      approveDocument: (file) => {
        const token = crypto.randomUUID()
        approvedDocumentSelections.set(token, { path: file.path, createdAt: Date.now() })
        userAuthorizedPaths.add(file.path)
        return { token, name: file.name, ext: file.ext, size: file.size, previewPath: file.path }
      }
    })
    for (const mediaPath of split.media) userAuthorizedPaths.add(mediaPath)
    return split
  }

  ipcMain.handle('chat:open-any', async (event) => {
    assertTrustedSender(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '打开文件（视频、音频、图片或文档）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '所有支持的文件', extensions: [...new Set([...ALL_EXTS, ...SUPPORTED_EXTENSIONS].map((ext) => ext.slice(1)))] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled) return { media: [], documents: [] }
    return splitAndApproveAny(result.filePaths)
  })
  // 首页“打开”：一个对话框同时接受文件与文件夹；文件按类型分流，文件夹授权并回报给媒体库
  // 两段式「打开」的文件夹半段：Windows 上 openFile+openDirectory 同用会退化成目录选择器，
  // 必须分开弹窗——文件走 chat:open-any，文件夹走这里
  ipcMain.handle('home:open-folder', async (event) => {
    assertTrustedSender(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要加入媒体库的文件夹',
      properties: ['openDirectory', 'multiSelections']
    })
    if (result.canceled) return { folders: [] }
    const folders = result.filePaths.slice(0, 10).map((folder) => path.resolve(folder))
    for (const folder of folders) authorizedFolders.add(folder)
    return { folders }
  })

  ipcMain.handle('home:open', async (event) => {
    assertTrustedSender(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '打开（可选择文件或文件夹）',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [
        { name: '所有支持的文件', extensions: [...new Set([...ALL_EXTS, ...SUPPORTED_EXTENSIONS].map((ext) => ext.slice(1)))] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled) return { media: [], documents: [], folders: [] }
    const folders = []
    const files = []
    for (const filePath of result.filePaths.slice(0, 20)) {
      try {
        if (fs.statSync(filePath).isDirectory()) folders.push(path.resolve(filePath))
        else files.push(filePath)
      } catch { /* 路径失效时跳过 */ }
    }
    for (const folder of folders) authorizedFolders.add(folder)
    const split = splitAndApproveAny(files)
    return { ...split, folders }
  })
  ipcMain.handle('chat:attach-paths', (event, filePaths) => {
    assertTrustedSender(event)
    const roots = [...authorizedFolders]
    const requested = Array.isArray(filePaths) ? filePaths.slice(0, 20) : []
    const valid = requested.filter((filePath) => isPathInsideRoots(filePath, roots, { realpathSync: (value) => fs.realpathSync(value) }))
    if (valid.length === 0) return { documents: [], skipped: requested.length }
    return { documents: approveDocumentPaths(valid), skipped: requested.length - valid.length }
  })
  ipcMain.handle('models:providers', (event) => {
    assertTrustedSender(event)
    // catalog 覆盖静态清单（每周自动刷新：淘汰下架旧型号、上新型号）
    return PROVIDERS.map((provider) => ({
      ...provider,
      models: normalizeProviderModels(provider, modelCatalog ? modelCatalog.modelsFor(provider.id, provider.models) : provider.models)
    }))
  })

  // 手动刷新模型清单（模型中心「更新模型列表」按钮）；启动时若超过一周未刷也会后台自动刷
  ipcMain.handle('models:refresh-catalog', async (event) => {
    assertTrustedSender(event)
    const listModelsForProvider = async () => {
      const results = []
      // 当前 chat 配置与 stash 云配置两份 Key 都可用于刷新各自厂商
      const chatConfig = modelConfigStore.resolved('chat')
      const stashConfig = (() => {
        const stashed = modelConfigStore.readDocument().stash?.chat
        return stashed ? normalizeConfig({ ...stashed, role: 'chat', apiKey: modelConfigStore.decrypt(stashed.encryptedApiKey) }, 'chat') : null
      })()
      for (const config of [chatConfig, stashConfig]) {
        if (!config || !config.apiKey || config.providerId === 'bundled-lite' || config.protocol !== 'openai') continue
        try {
          const models = await listModels(config, { timeoutMs: 12000 })
          if (models.length) results.push({ providerId: config.providerId, models })
        } catch { /* 该厂商刷新失败，保留旧清单 */ }
      }
      return results
    }
    try {
      return await modelCatalog.refresh({ listModelsForProvider, onLog: (message) => log.info(`模型清单刷新: ${message}`) })
    } catch (error) {
      return { updated: 0, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('models:config', (event, role = 'chat') => {
    assertTrustedSender(event)
    return modelConfigStore.publicConfig(role)
  })
  ipcMain.handle('models:routing-status', (event) => {
    assertTrustedSender(event)
    const candidates = modelConfigStore.publicCandidates('chat')
    return { ...modelPerformanceRouter.status(candidates), candidates }
  })
  ipcMain.handle('models:routing-settings', (event, input = {}) => {
    assertTrustedSender(event)
    const settings = modelPerformanceRouter.updateSettings({
      preference: input.preference,
      objective: input.objective,
      mode: input.mode
    })
    const candidates = modelConfigStore.publicCandidates('chat')
    return { ...modelPerformanceRouter.status(candidates), settings, candidates }
  })
  ipcMain.handle('models:save', (event, config) => {
    assertTrustedSender(event)
    return modelConfigStore.save(config)
  })
  ipcMain.handle('models:disconnect', (event, input = {}) => {
    assertTrustedSender(event)
    return (async () => {
      const providerId = String(input.providerId || '')
      const candidate = modelConfigStore.publicCandidates(input.role || 'chat').find((item) => item.providerId === providerId && item.baseUrl === String(input.baseUrl || ''))
      if (!candidate) return { disconnected: false, candidates: modelConfigStore.publicCandidates(input.role || 'chat') }
      const approved = await ensurePersistentApproval({ action: 'credential', summary: `删除 ${candidate.providerName} 的本机加密凭证；以后如需使用必须重新粘贴 Key` })
      if (!approved) return { disconnected: false, candidates: modelConfigStore.publicCandidates(input.role || 'chat') }
      return { disconnected: true, candidates: modelConfigStore.disconnect(input.role || 'chat', providerId, String(input.baseUrl || '')) }
    })()
  })
  ipcMain.handle('models:quick-switch', async (event, input = {}) => {
    assertTrustedSender(event)
    const target = input.target === 'cloud' ? 'cloud' : 'bundled'
    if (target === 'bundled') {
      const status = await bundledRuntime.status()
      if (!status.assetsPresent) return { switched: false, needDownload: true, reason: '本地 AI 组件未下载' }
    }
    const result = modelConfigStore.quickSwitchRole(input.role || 'chat', target)
    return { ...result, bundled: await bundledRuntime.status() }
  })
  ipcMain.handle('models:list', async (event, config = {}) => {
    assertTrustedSender(event)
    try {
      const saved = modelConfigStore.resolved(config.role || 'chat')
      const apiKey = config.apiKey || (config.useSavedKey && config.providerId === saved.providerId ? saved.apiKey : '')
      // 用已存 Key 时必须钉死已存地址，防止渲染器把 Key 带到任意 baseUrl（Key 外泄面）
      if (!config.apiKey && config.useSavedKey && config.providerId === saved.providerId) config = { ...config, baseUrl: saved.baseUrl }
      const localStatus = config.providerId === 'bundled-lite' ? await bundledRuntime.start() : null
      return { success: true, models: await listModels({ ...config, apiKey, ...(localStatus ? { model: localStatus.model, baseUrl: localStatus.baseUrl } : {}) }) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), models: [] }
    }
  })
  ipcMain.handle('models:test', async (event, config = {}) => {
    assertTrustedSender(event)
    try {
      // 订阅类厂商（cli）：没有 URL 可探测，直接真实聊一句验证 CLI 登录态与模型可用性
      if (config.providerId === 'codex-chatgpt' || config.providerId === 'claude-code') {
        try {
          const result = await agentEngine.completeText(
            [{ role: 'user', content: '只回复两个字：OK' }],
            { providerId: config.providerId, model: config.model, baseUrl: '', apiKey: '', requiresKey: false },
            { timeoutMs: 180000 }
          )
          return { success: true, message: `订阅通道正常（${config.providerId === 'codex-chatgpt' ? 'Codex CLI' : 'Claude Code'} · ${config.model}）：${String(result.text || '').slice(0, 20)}` }
        } catch (error) {
          return { success: false, message: error instanceof Error ? error.message : String(error) }
        }
      }
      const saved = modelConfigStore.resolved(config.role || 'chat')
      const apiKey = config.apiKey || (config.useSavedKey && config.providerId === saved.providerId ? saved.apiKey : '')
      // 用已存 Key 时必须钉死已存地址，防止渲染器把 Key 带到任意 baseUrl（Key 外泄面）
      if (!config.apiKey && config.useSavedKey && config.providerId === saved.providerId) config = { ...config, baseUrl: saved.baseUrl }
      const localStatus = config.providerId === 'bundled-lite' ? await bundledRuntime.start() : null
      // 火山方舟：先探测 Key 是否属于 Coding Plan 套餐，是则按套餐专用地址验证并给出修正建议
      if (config.providerId === 'volcengine' && apiKey) {
        const plan = await detectVolcenginePlan(apiKey)
        if (plan.isPlan) {
          const models = plan.models.length ? plan.models : VOLCENGINE_CODING_MODELS
          return {
            success: true,
            planDetected: true,
            upgrade: {
              providerId: 'volcengine-coding',
              baseUrl: VOLCENGINE_CODING_BASE_URL,
              model: models.includes('ark-code-latest') ? 'ark-code-latest' : models[0],
              models
            },
            message: `检测到你的 Key 属于 Coding Plan 套餐：必须用套餐专用地址（/api/coding/v3），用通用地址会失败或产生额外费用。套餐内可用 ${models.length} 个模型，点「按套餐接入」一键修正。`
          }
        }
      }
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
  ipcMain.handle('localai:status', (event) => {
    assertTrustedSender(event)
    return { ...bundledRuntime.status(), download: localAiDownload.status(), pack: localAiDownload.packInfo() }
  })
  ipcMain.handle('localai:download', async (event) => {
    assertTrustedSender(event)
    try {
      await localAiDownload.start({
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('localai:progress', progress)
        }
      })
      return { success: true, status: bundledRuntime.status() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('localai:cancel', (event) => {
    assertTrustedSender(event)
    return localAiDownload.cancel()
  })
  ipcMain.handle('transcribe:status', (event) => {
    assertTrustedSender(event)
    const availability = transcriptionService.availability()
    return {
      ...availability,
      download: whisperDownload.status(),
      pack: whisperDownload.packInfo(),
      smallDownload: whisperSmallDownload.status(),
      smallPack: whisperSmallDownload.packInfo()
    }
  })
  // 对话窗麦克风：接收录音二进制 → 暂存 → 本地 whisper 离线转写 → 文本返回（不出机）
  ipcMain.handle('transcribe:blob', async (event, input = {}) => {
    assertTrustedSender(event)
    const status = transcriptionService.availability()
    if (!status.available) return { success: false, error: '语音转写组件未下载：请到「模型接入中心」下载转写组件' }
    const data = input.data
    const isBinary = Boolean(data) && (ArrayBuffer.isView(data) || data instanceof ArrayBuffer)
    if (!isBinary) return { success: false, error: '音频数据格式无效' }
    const buffer = Buffer.from(data)
    // 大小以转换后的真实字节数为准（byteLength/length 属性可被伪造）
    if (!buffer.length) return { success: false, error: '没有收到音频数据' }
    if (buffer.length > 25 * 1024 * 1024) return { success: false, error: '录音超过 25MB 上限' }
    const ext = /^\.(webm|ogg|wav|mp3|m4a)$/.test(String(input.ext || '')) ? String(input.ext) : '.webm'
    const tmp = path.join(app.getPath('temp'), `agentplay-mic-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${ext}`)
    try {
      fs.writeFileSync(tmp, buffer)
      const transcription = await transcriptionService.transcribe({ sourcePath: tmp, lang: 'auto' })
      return { success: true, text: String(transcription.text || '').trim() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      try { fs.unlinkSync(tmp) } catch { /* 忽略 */ }
    }
  })
  ipcMain.handle('transcribe:download', async (event) => {
    assertTrustedSender(event)
    try {
      await whisperDownload.start({
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('transcribe:progress', progress)
        }
      })
      return { success: true, availability: transcriptionService.availability() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('transcribe:download-small', async (event) => {
    assertTrustedSender(event)
    try {
      await whisperSmallDownload.start({
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('transcribe:progress', progress)
        }
      })
      return { success: true, status: transcriptionService.availability() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('transcribe:cancel-download-small', (event) => {
    assertTrustedSender(event)
    return whisperSmallDownload.cancel()
  })
  ipcMain.handle('transcribe:cancel-download', (event) => {
    assertTrustedSender(event)
    return whisperDownload.cancel()
  })
  ipcMain.handle('translatePack:status', (event) => {
    assertTrustedSender(event)
    return {
      ...offlineTranslate.availability(),
      download: translateDownload.status(),
      pack: translateDownload.packInfo()
    }
  })
  ipcMain.handle('translatePack:download', async (event) => {
    assertTrustedSender(event)
    try {
      await translateDownload.start({
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('translatePack:progress', progress)
        }
      })
      return { success: true, availability: offlineTranslate.availability() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('translatePack:cancel-download', (event) => {
    assertTrustedSender(event)
    return translateDownload.cancel()
  })
  ipcMain.handle('rapidocrPack:status', (event) => {
    assertTrustedSender(event)
    return {
      ...rapidOcr.availability(),
      download: rapidocrDownload.status(),
      pack: rapidocrDownload.packInfo()
    }
  })
  ipcMain.handle('rapidocrPack:download', async (event) => {
    assertTrustedSender(event)
    try {
      await rapidocrDownload.start({
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('rapidocrPack:progress', progress)
        }
      })
      return { success: true, availability: rapidOcr.availability() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('rapidocrPack:cancel-download', (event) => {
    assertTrustedSender(event)
    return rapidocrDownload.cancel()
  })
  ipcMain.handle('unlimitedOcr:status', async (event, input = {}) => {
    assertTrustedSender(event)
    return unlimitedOcrService.status({ probe: input.probe === true })
  })
  ipcMain.handle('unlimitedOcr:save', async (event, input = {}) => {
    assertTrustedSender(event)
    try {
      const candidateUrl = input.baseUrl === undefined
        ? unlimitedOcrConfigStore.publicConfig().baseUrl
        : String(input.baseUrl || '')
      let remoteApproved = false
      if (!isLoopbackEndpoint(candidateUrl)) {
        remoteApproved = await ensurePersistentApproval({
          action: 'cloud',
          summary: '保存远端高级文档 OCR 服务地址；只有另行批准具体文档任务后，扫描页才会发送到该服务'
        })
        if (!remoteApproved) return { success: false, cancelled: true, status: unlimitedOcrConfigStore.publicConfig() }
      }
      if (input.clearApiKey === true) {
        const approved = await ensurePersistentApproval({ action: 'credential', summary: '删除高级文档 OCR 的本机加密凭证' })
        if (!approved) return { success: false, cancelled: true, status: unlimitedOcrConfigStore.publicConfig() }
      }
      const saved = unlimitedOcrConfigStore.save(input, { remoteApproved })
      const status = input.enabled === true ? await unlimitedOcrService.status({ probe: true }) : { ...saved, ready: false, reason: '高级文档 OCR 未启用' }
      return { success: input.enabled !== true || status.ready === true, status }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), status: unlimitedOcrConfigStore.publicConfig() }
    }
  })
  ipcMain.handle('onlineMedia:search', async (event, input = {}) => {
    assertTrustedSender(event)
    try {
      const kind = ['audio', 'book'].includes(input.kind) ? input.kind : 'movie'
      const result = await onlineMedia.searchMedia(input.query, kind, { page: input.page || 1 })
      // 书籍：合并维基文库中文公版书（IA 公版书以英文为主，中文书走维基文库）
      if (kind === 'book') {
        try {
          const wsItems = await wikisource.searchBooks(input.query)
          result.items = [...result.items, ...wsItems]
          result.total += wsItems.length
        } catch { /* 维基文库不可用时只用 IA 结果 */ }
      }
      return { success: true, ...result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), items: [], total: 0 }
    }
  })
  ipcMain.handle('onlineMedia:files', async (event, input = {}) => {
    assertTrustedSender(event)
    try {
      const kind = input.kind === 'audio' ? 'audio' : 'movie'
      return { success: true, ...(await onlineMedia.listPlayableFiles(input.identifier, kind)) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), files: [] }
    }
  })
  ipcMain.handle('onlineMedia:download', async (event, input = {}) => {
    assertTrustedSender(event)
    const requestId = normalizeRequestId(input.requestId, 'omdl')
    const controller = new AbortController()
    activeAiRequests.get(requestId)?.abort()
    activeAiRequests.set(requestId, controller)
    try {
      const url = onlineMedia.assertArchiveUrl(input.url)
      const result = await downloadRemoteMedia(url, {
        destDir: path.join(app.getPath('videos'), 'AgentPlay 下载'),
        signal: controller.signal,
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('onlineMedia:progress', { requestId, ...progress })
        }
      })
      return { success: true, ...result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      activeAiRequests.delete(requestId)
    }
  })
  ipcMain.handle('onlineMedia:cancel', (event, requestId) => {
    assertTrustedSender(event)
    const controller = activeAiRequests.get(String(requestId || ''))
    controller?.abort()
    return Boolean(controller)
  })
  ipcMain.handle('onlineMedia:bookFiles', async (event, input = {}) => {
    assertTrustedSender(event)
    try {
      return { success: true, ...(await onlineMedia.listBookFiles(input.identifier)) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), files: [] }
    }
  })
  ipcMain.handle('ebook:open', async (event, input = {}) => {
    assertTrustedSender(event)
    try {
      const chapters = await loadEbookChapters(input.identifier, input.fileName)
      return { success: true, chapters: chapters.map((chapter) => chapter.title), count: chapters.length }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('ebook:chapter', async (event, input = {}) => {
    assertTrustedSender(event)
    try {
      const chapters = await loadEbookChapters(input.identifier, input.fileName)
      const index = Number(input.index) || 0
      const chapter = chapters[index]
      if (!chapter) throw new Error(`没有第 ${index + 1} 节（共 ${chapters.length} 节）`)
      // 维基文库：正文按页现取（缓存零重复请求）；IA：解析时已有全文
      const text = chapter.wsBook ? await wikisource.fetchChapterText(ebookCacheRoot(), chapter.wsBook, chapter.page) : chapter.text
      return { success: true, title: chapter.title, text, index }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('ebook:translate', async (event, input = {}) => {
    assertTrustedSender(event)
    try {
      const engine = input.engine === 'cloud' ? 'cloud' : 'offline'
      // 目标语言：zh 中文（IA 英文书默认）/ vernacular 白话文（古籍适用）/ en 英文；缓存按目标隔离
      const target = ['zh', 'vernacular', 'en'].includes(input.target) ? input.target : 'zh'
      if (engine === 'offline' && target !== 'zh') throw new Error('离线翻译组件只支持英译中；翻白话文/英文请用云模型')
      const cached = ebookService.readTranslationCache(ebookCacheRoot(), input.identifier, `${engine}-${target}`, Number(input.index) || 0)
      if (cached) return { success: true, text: cached, cached: true }
      const chapters = await loadEbookChapters(input.identifier, input.fileName)
      const index = Number(input.index) || 0
      const chapter = chapters[index]
      if (!chapter) throw new Error(`没有第 ${index + 1} 节`)
      if (chapter.wsBook) chapter.text = await wikisource.fetchChapterText(ebookCacheRoot(), chapter.wsBook, chapter.page)
      // 分块翻译：按段落打包，每块约 2000 字
      const blocks = []
      let current = ''
      for (const para of chapter.text.split(/\n+/)) {
        if (current.length + para.length > 2000 && current) { blocks.push(current); current = '' }
        current += (current ? '\n' : '') + para
      }
      if (current) blocks.push(current)
      const send = (status) => { if (!event.sender.isDestroyed()) event.sender.send('ebook:translate-status', { index, status }) }
      const translated = []
      for (let i = 0; i < blocks.length; i += 1) {
        send(`正在翻译本章（${i + 1}/${blocks.length} 块）…`)
        if (engine === 'offline') {
          if (!offlineTranslate.availability().available) throw new Error('离线翻译组件未安装：到模型接入中心下载，或改用云模型翻译')
          const lines = await offlineTranslate.translateLines(blocks[i].split('\n'))
          translated.push(lines.join('\n'))
        } else {
          const approved = await ensureCloudConsent('电子书章节原文将发送给云端模型用于翻译。')
          if (!approved) throw new Error('已取消：未授权发送云端')
          const PROMPTS = {
            zh: '你是文学翻译助手。把内容翻成通顺的中文，保留段落结构与文学性，只输出译文。',
            vernacular: '你是古文今译助手。把内容翻成通顺易懂的现代白话文，准确实在、不发挥、保留段落结构，只输出译文。',
            en: 'You are a literary translator. Translate the following into natural, fluent English, preserving paragraph structure. Output the translation only.'
          }
          const result = await llmComplete({
            systemPrompt: PROMPTS[target],
            prompt: blocks[i],
            timeoutMs: 120000,
            taskKind: 'document'
          })
          translated.push(result.text)
        }
      }
      const text = translated.join('\n\n')
      ebookService.writeTranslationCache(ebookCacheRoot(), input.identifier, `${engine}-${target}`, index, text)
      return { success: true, text, cached: false }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  const preparePersistentSubtitleTask = (input) => {
    const resolvedMediaPath = assertAllowedPath(input.path)
    const requestedTarget = ['中文', '英文'].includes(String(input.targetLang || '')) ? String(input.targetLang) : ''
    const sourceTranscriptPath = path.join(path.dirname(resolvedMediaPath), `${path.parse(resolvedMediaPath).name}-AgentPlay原文.srt`)
    const adjacent = findAdjacentSubtitle(resolvedMediaPath)
    const subtitleSourcePath = adjacent || (fs.existsSync(sourceTranscriptPath) ? sourceTranscriptPath : '')
    const cloudCandidates = String(input.engine || 'auto') === 'local'
      ? []
      : modelConfigStore.resolvedCandidates('chat').filter((candidate) => !isLocalModelConfig(candidate) && candidate.protocol !== 'cli')
    const decision = cloudCandidates.length
      ? selectModelForTaskPlan({ taskKind: 'subtitle-translation', requirements: { text: true }, candidates: cloudCandidates })
      : { selected: null }
    const config = decision.selected
    const requiresKey = config?.requiresKey !== false
    const cloudReady = Boolean(config && config.baseUrl && config.model && (!requiresKey || config.apiKey))
    const modelRoute = cloudReady ? freezeTaskModelRoute(config, { taskKind: 'subtitle-translation' }) : null
    return {
      spec: {
        sources: snapshotDocumentSources([resolvedMediaPath, ...(subtitleSourcePath ? [subtitleSourcePath] : [])]),
        subtitleSourceKind: adjacent ? 'adjacent' : subtitleSourcePath ? 'transcript-cache' : '',
        targetLang: requestedTarget,
        engine: String(input.engine || 'auto'),
        durationSeconds: Number(input.durationSeconds) || 0,
        modelRoute
      },
      approval: modelRoute
        ? { action: 'cloud', summary: `把字幕原文发送给 ${modelRoute.providerName} · ${modelRoute.model} 翻译成${requestedTarget || '目标语言'}；视频文件不会上传` }
        : null
    }
  }
  const executePersistentSubtitleTask = async ({ task, signal, checkpoint, status }) => {
    if (task.checkpoint?.stage === 'artifact-written' && task.checkpoint?.result && outputsStillExist(task.checkpoint.result)) return task.checkpoint.result
    const sourcePaths = validateDocumentSources(task.spec.sources)
    const mediaPath = sourcePaths[0]
    const frozenSubtitlePath = sourcePaths[1] || ''
    userAuthorizedPaths.add(mediaPath)
    if (frozenSubtitlePath) userAuthorizedPaths.add(frozenSubtitlePath)
    const requestId = task.id
    const requestedTarget = ['中文', '英文'].includes(String(task.spec.targetLang || '')) ? String(task.spec.targetLang) : ''
    const cachePathFor = (targetLang) => path.join(path.dirname(mediaPath), `${path.parse(mediaPath).name}-AgentPlay${targetLang}.srt`)
    const sourceTranscriptPath = path.join(path.dirname(mediaPath), `${path.parse(mediaPath).name}-AgentPlay原文.srt`)
    let sourceTranscriptSnapshot = task.checkpoint?.sourceTranscript || null
    if (sourceTranscriptSnapshot) {
      const [checkpointTranscriptPath] = validateDocumentSources([sourceTranscriptSnapshot])
      if (path.resolve(checkpointTranscriptPath) !== path.resolve(sourceTranscriptPath)) {
        throw new Error('字幕识别检查点与当前视频不匹配，请重新执行')
      }
      userAuthorizedPaths.add(checkpointTranscriptPath)
    }
    const readCached = (targetLang) => {
      if (!targetLang) return null
      const cachedPath = cachePathFor(targetLang)
      if (!fs.existsSync(cachedPath)) return null
      const cachedContent = fs.readFileSync(cachedPath, 'utf8')
      const cachedEntries = parseSrt(cachedContent)
      const hasTargetText = targetLang === '英文'
        ? /[A-Za-z]/.test(cachedContent)
        : /[\u3400-\u9fff]/.test(cachedContent)
      if (!cachedEntries.length || !hasTargetText) return null
      authorizeDerivedSubtitle(cachedPath)
      return { success: true, srtPath: cachedPath, outputs: [cachedPath], count: cachedEntries.length, failed: 0, cached: true, engine: 'cache', targetLang }
    }
    const earlyCache = readCached(requestedTarget)
    if (earlyCache) {
      checkpoint({ stage: 'artifact-written', result: earlyCache, ...(sourceTranscriptSnapshot ? { sourceTranscript: sourceTranscriptSnapshot } : {}) })
      return earlyCache
    }
    const mediaJobKey = subtitleMediaKey(mediaPath)
    const existingMediaJob = activeSubtitleMediaJobs.get(mediaJobKey)
    if (existingMediaJob) {
      throw new Error('这个视频已有字幕任务正在识别或翻译，请等待当前任务完成；不会重复占用 CPU')
    }
    activeSubtitleMediaJobs.set(mediaJobKey, { requestId, cancelKey: requestId })
    const reportStatus = (value) => {
      log.info(`[中文字幕 ${requestId}] ${value}`)
      status(value)
    }
    const failWithResult = (result) => {
      checkpoint({ stage: 'blocked', result, ...(sourceTranscriptSnapshot ? { sourceTranscript: sourceTranscriptSnapshot } : {}) })
      throw new Error(result.error || '字幕任务未完成')
    }
    const routeConfig = resolveTaskModelRoute(task.spec.modelRoute)
    const resolveEngine = async (entries, targetLang) => {
      if (routeConfig) {
        return {
        complete: ({ systemPrompt, prompt, signal: callSignal, timeoutMs }) => llmComplete({
          systemPrompt,
          prompt,
          signal: callSignal,
          timeoutMs,
          modelConfig: routeConfig,
          taskKind: 'subtitle-translation'
        }),
          label: `${routeConfig.providerName} · ${routeConfig.model}`,
          providerId: routeConfig.providerId,
          model: routeConfig.model,
          offline: false
        }
      }
      return pickTranslateEngine(entries, targetLang, 'local')
    }
    const translateAndWrite = async (entries, { fastPath = false } = {}) => {
      const targetLang = chooseOppositeTarget(entries)
      const sourceLang = targetLang === '英文' ? 'zh' : 'en'
      const cached = readCached(targetLang)
      if (cached) {
        const result = { ...cached, sourceLang, fastPath }
        checkpoint({ stage: 'artifact-written', result, ...(sourceTranscriptSnapshot ? { sourceTranscript: sourceTranscriptSnapshot } : {}) })
        return result
      }
      const engine = await resolveEngine(entries, targetLang)
      if (!engine) {
        const localHint = targetLang === '英文' ? '中译英需要配置 Agnes 等云端模型' : '请配置 Agnes 等云端模型，或安装本地离线翻译组件'
        const recovery = targetLang === '英文'
          ? buildCloudTranslateRecovery({ entryCount: entries.length, targetLang })
          : buildOfflineTranslateRecovery({ packBytes: translateDownload.packInfo().totalBytes, entryCount: entries.length, targetLang })
        return failWithResult({ success: false, error: `没有可用的${targetLang}字幕翻译方式：${localHint}`, recovery })
      }
      reportStatus(`共 ${entries.length} 段，正在翻译成${targetLang}（${engine.label}）`)
      const { translations, failed } = await translateEntries(entries, engine.complete, {
        targetLang,
        signal,
        initialTranslations: task.checkpoint?.translationTarget === targetLang ? task.checkpoint?.translations : [],
        onProgress: ({ done, total, failed: failedCount }) => {
          reportStatus(`正在翻译成${targetLang} ${done}/${total}${failedCount ? `（${failedCount} 段待重试）` : ''}`)
        },
        onCheckpoint: ({ translations: savedTranslations, done, total, failed: failedCount }) => checkpoint({
          stage: 'translation-progress', translations: savedTranslations, translationTarget: targetLang,
          translationDone: done, translationTotal: total, translationFailed: failedCount,
          ...(sourceTranscriptSnapshot ? { sourceTranscript: sourceTranscriptSnapshot } : {})
        })
      })
      if (translations.size === 0) return failWithResult({ success: false, error: `翻译没有返回可用${targetLang}（${engine.label}），未写出无效字幕` })
      const translatedSrt = buildTranslationOnlySrt(entries, translations, { targetLang })
      const outputEntries = parseSrt(translatedSrt)
      if (!outputEntries.length) return failWithResult({ success: false, error: '翻译结果无法排成有效字幕，未写出文件' })
      const srtPath = cachePathFor(targetLang)
      fs.writeFileSync(srtPath, translatedSrt, 'utf8')
      authorizeDerivedSubtitle(srtPath)
      reportStatus(`${targetLang}字幕已生成（每屏最多两行）`)
      const result = { success: true, srtPath, outputs: [srtPath], count: outputEntries.length, sourceCount: entries.length, failed, fastPath, engine: engine.label, sourceLang, targetLang }
      checkpoint({ stage: 'artifact-written', result, ...(sourceTranscriptSnapshot ? { sourceTranscript: sourceTranscriptSnapshot } : {}) })
      return result
    }
    try {
      if (task.spec.subtitleSourceKind && frozenSubtitlePath) {
        reportStatus(`检测到现成字幕 ${path.basename(frozenSubtitlePath)}，跳过语音识别，直接翻译`)
        const rawCues = parseSubtitleCues(fs.readFileSync(frozenSubtitlePath, 'utf8'), path.extname(frozenSubtitlePath))
        const entries = cuesToEntries(rawCues)
        if (entries.length === 0) return failWithResult({ success: false, error: '现成字幕内容为空，无法翻译' })
        return await translateAndWrite(entries, { fastPath: true })
      }
      if (sourceTranscriptSnapshot && fs.existsSync(sourceTranscriptPath)) {
        const sourceTranscript = fs.readFileSync(sourceTranscriptPath, 'utf8')
        const entries = parseSrt(sourceTranscript)
        if (entries.length > 0) {
          authorizeDerivedSubtitle(sourceTranscriptPath)
          reportStatus(`检测到上次识别的原文字幕 ${path.basename(sourceTranscriptPath)}，跳过语音识别`)
          return await translateAndWrite(entries, { fastPath: true })
        }
      }
      const whisperStatus = transcriptionService.availability()
      if (!whisperStatus.available) {
        return failWithResult({
          success: false,
          error: `${whisperStatus.reason}，请先下载转写组件`,
          needDownload: true,
          recovery: buildWhisperRecovery({
            packBytes: whisperDownload.packInfo().totalBytes,
            durationSeconds: Number(task.spec.durationSeconds) || 0,
            targetLang: requestedTarget || '中文'
          })
        })
      }
      reportStatus(buildTranscriptionStatus(task.spec.durationSeconds))
      const transcription = await transcriptionService.transcribe({ sourcePath: mediaPath, lang: 'auto', timestamps: true, signal })
      const entries = parseSrt(transcription.text)
      if (entries.length === 0) return failWithResult({ success: false, error: '没有识别到语音内容（可能是纯音乐或音量过低）' })
      if (signal.aborted) throw new DOMException('已取消', 'AbortError')
      const sourceTempPath = `${sourceTranscriptPath}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(sourceTempPath, `${String(transcription.text || '').trim()}\n`, 'utf8')
      fs.rmSync(sourceTranscriptPath, { force: true })
      fs.renameSync(sourceTempPath, sourceTranscriptPath)
      authorizeDerivedSubtitle(sourceTranscriptPath)
      sourceTranscriptSnapshot = snapshotDocumentSources([sourceTranscriptPath])[0]
      checkpoint({ stage: 'source-transcribed', sourceTranscript: sourceTranscriptSnapshot })
      reportStatus(`识别到 ${entries.length} 段，正在判断翻译方向`)
      return await translateAndWrite(entries)
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError') throw new DOMException('字幕翻译已停止', 'AbortError')
      throw error
    } finally {
      if (activeSubtitleMediaJobs.get(mediaJobKey)?.requestId === requestId) activeSubtitleMediaJobs.delete(mediaJobKey)
    }
  }
  persistentTaskRuntime.register('subtitle.generate', executePersistentSubtitleTask, { autoResume: true })
  ipcMain.handle('subtitle:bilingual-generate', async (event, input = {}) => {
    assertTrustedSender(event)
    const requestId = normalizeRequestId(input.requestId, 'bilingual')
    try {
      const effectiveInput = { ...input }
      const requestedEngine = String(input.engine || 'auto')
      const candidateConfig = creativeConfig()
      const requiresKey = candidateConfig.requiresKey !== false
      const cloudCandidate = requestedEngine !== 'local' && !isLocalModelConfig(candidateConfig) && candidateConfig.protocol !== 'cli' && Boolean(candidateConfig.baseUrl && candidateConfig.model && (!requiresKey || candidateConfig.apiKey))
      if (cloudCandidate && input.cloudApproved !== true) {
        const route = freezeTaskModelRoute(candidateConfig)
        const approved = await ensureCloudConsent(`把字幕原文发送给 ${route.providerName} · ${route.model} 翻译；视频文件不会上传`)
        if (approved) effectiveInput.cloudApproved = true
        else effectiveInput.engine = 'local'
      }
      const prepared = preparePersistentSubtitleTask(effectiveInput)
      let task = persistentTaskRuntime.enqueue({
        id: requestId,
        type: 'subtitle.generate',
        workspaceTaskId: input.workspaceTaskId || `workspace-${requestId}`,
        spec: prepared.spec,
        approval: prepared.approval
      })
      if (task.state === 'waiting_approval') {
        const approved = effectiveInput.cloudApproved === true || await ensureCloudConsent(task.approval.summary)
        if (!approved) throw new Error('已取消：未授权发送云端')
        task = persistentTaskRuntime.approve(task.approval.id, task.approval.token)
      }
      task = await persistentTaskRuntime.run(requestId)
      if (task.state !== 'completed') return { ...(task.checkpoint?.result || {}), success: false, requestId, cancelled: task.state === 'cancelled', error: task.error || task.checkpoint?.result?.error || '字幕任务未完成' }
      return { ...task.result, requestId }
    } catch (error) {
      return { success: false, requestId, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('subtitle:bilingual-cancel', (event, requestId) => {
    assertTrustedSender(event)
    const controller = activeAnalysisRequests.get(String(requestId || ''))
    controller?.abort()
    return persistentTaskRuntime.cancel(String(requestId || '')) || Boolean(controller)
  })
  // 轻量语言探测：抽前 12 秒音频转写判定 zh/en，给"要不要弹翻译提示"用
  ipcMain.handle('media:detect-language', async (event, filePath) => {
    assertTrustedSender(event)
    if (typeof filePath !== 'string' || !/\.(mp4|mkv|avi|mov|flv|webm|ts|m4v|wmv|mp3|flac|wav|aac|m4a|ogg|wma)$/i.test(filePath)) {
      return { lang: 'unknown', reason: '不是可探测的媒体文件' }
    }
    try {
      const resolved = assertAllowedPath(filePath)
      return await languageDetect.detect(resolved)
    } catch (error) {
      return { lang: 'unknown', reason: error instanceof Error ? error.message : String(error) }
    }
  })
  // 实时翻译字幕：从当前位置逐批翻译，只显示目标语言；完成后保存为按阅读节奏重排的目标语言 SRT。
  ipcMain.handle('subtitle:live-start', async (event, input = {}) => {
    assertTrustedSender(event)
    const mediaPath = String(input.mediaPath || '').trim()
    if (!mediaPath || /^(https?|blob):/i.test(mediaPath) || !fs.existsSync(mediaPath)) {
      return { success: false, error: '实时翻译只支持本地媒体文件' }
    }
    if (!userAuthorizedPaths.has(path.resolve(mediaPath)) && !isPathInsideRoots(mediaPath, allowedRoots(), { realpathSync: (value) => fs.realpathSync(value) })) {
      return { success: false, error: '只允许处理你明确打开过或媒体库内的文件' }
    }
    const requestedSubtitle = String(input.subtitlePath || '').trim()
    const subtitlePath = requestedSubtitle && fs.existsSync(requestedSubtitle) ? requestedSubtitle : findAdjacentSubtitle(mediaPath)
    if (!subtitlePath) return { success: false, error: '没有找到可翻译的字幕：请先加载字幕，或用“自动翻译字幕”先识别' }
    // 显式指定的字幕文件与媒体文件同权校验，防止借字幕通道读任意文本送云端
    if (requestedSubtitle && !userAuthorizedPaths.has(path.resolve(subtitlePath)) && !isPathInsideRoots(subtitlePath, allowedRoots(), { realpathSync: (value) => fs.realpathSync(value) })) {
      return { success: false, error: '字幕文件不在授权范围内' }
    }
    const ext = path.extname(subtitlePath).toLowerCase()
    if (!['.srt', '.vtt', '.ass', '.ssa'].includes(ext)) return { success: false, error: '字幕格式不支持（仅 srt/vtt/ass/ssa）' }
    const rawCues = parseSubtitleCues(fs.readFileSync(subtitlePath, 'utf8'), ext)
    if (!rawCues.length) return { success: false, error: '字幕内容为空，无法翻译' }
    const sourceEntries = rawCues.map((text, order) => ({ index: order + 1, text: text.text }))
    const requestedLiveTarget = ['中文', '英文'].includes(String(input.targetLang || '')) ? String(input.targetLang) : ''
    const targetLang = requestedLiveTarget || chooseOppositeTarget(sourceEntries)
    let engine = pickTranslateEngine(sourceEntries, targetLang, String(input.engine || 'auto'))
    if (!engine) return { success: false, error: '没有可用的字幕翻译方式：请配置 Agnes 等云端模型，或安装本地离线翻译组件' }
    if (!engine.offline) {
      const approved = await ensureCloudConsent(`字幕原文将发送给 ${engine.label} 做实时${targetLang}翻译；视频文件本身不会上传。`)
      if (!approved) engine = pickTranslateEngine(sourceEntries, targetLang, 'local')
      if (!engine) return { success: false, error: '已取消云端发送，本机也没有可用的离线翻译组件' }
    }
    liveSubtitleSession?.controller.abort()
    const requestId = normalizeRequestId(input.requestId, 'live-sub')
    const controller = new AbortController()
    const cues = rawCues.map((cue, order) => ({ index: order + 1, startSeconds: cue.start, endSeconds: cue.end, text: cue.text }))
    const entries = cuesToEntries(rawCues)
    liveSubtitleSession = { requestId, controller, position: Number(input.currentTime) || 0 }
    const send = (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send('subtitle:live-event', { requestId, ...payload })
    }
    ;(async () => {
      try {
        const result = await runLiveTranslation({
          cues, complete: engine.complete, signal: controller.signal, targetLang,
          getPosition: () => (liveSubtitleSession?.requestId === requestId ? liveSubtitleSession.position : 0),
          onBatch: async ({ batch, translations, failed }) => {
            send({
              type: 'progress', done: translations.size, failed: failed.size, total: cues.length,
              batch: batch.map((entry) => ({ index: entry.index, text: translations.get(entry.index) || '' })).filter((item) => item.text)
            })
          }
        })
        let srtPath = null
        if (result.translations.size) {
          const candidate = path.join(path.dirname(mediaPath), `${path.parse(mediaPath).name}-AgentPlay${targetLang}.srt`)
          try {
            fs.writeFileSync(candidate, buildTranslationOnlySrt(entries, result.translations, { targetLang }), 'utf8')
            authorizeDerivedSubtitle(candidate)
            srtPath = candidate
          } catch (error) { log.error('实时翻译字幕写盘失败', error) }
        }
        send({ type: 'finish', done: result.translations.size, failed: result.failed, total: cues.length, srtPath, targetLang, cancelled: result.cancelled })
      } catch (error) {
        send({ type: 'error', error: error instanceof Error ? error.message : String(error) })
      } finally {
        if (liveSubtitleSession?.requestId === requestId) liveSubtitleSession = null
      }
    })()
    return { success: true, requestId, total: cues.length, subtitlePath, engine: engine.label, targetLang, cues: cues.map((cue) => ({ index: cue.index, start: cue.startSeconds, end: cue.endSeconds, text: cue.text })) }
  })
  ipcMain.handle('subtitle:live-seek', (event, input = {}) => {
    assertTrustedSender(event)
    const target = String(input.requestId || '')
    const position = Number(input.currentTime) || 0
    let handled = false
    if (liveSubtitleSession && liveSubtitleSession.requestId === target) {
      liveSubtitleSession.position = position
      handled = true
    }
    if (liveTranscribeSession && liveTranscribeSession.requestId === target) {
      liveTranscribeSession.position = position
      handled = true
    }
    return handled
  })
  ipcMain.handle('subtitle:live-stop', (event, requestId) => {
    assertTrustedSender(event)
    const target = String(requestId || '')
    let handled = false
    if (liveSubtitleSession && (!target || liveSubtitleSession.requestId === target)) {
      liveSubtitleSession.controller.abort()
      liveSubtitleSession = null
      handled = true
    }
    if (liveTranscribeSession && (!target || liveTranscribeSession.requestId === target)) {
      liveTranscribeSession.controller.abort()
      liveTranscribeSession = null
      handled = true
    }
    return handled
  })

  // 实时识别字幕：无字幕视频边播边转写（分段抽音 → whisper 带时间戳 → 增量推送 cue）
  ipcMain.handle('subtitle:live-transcribe-start', async (event, input = {}) => {
    assertTrustedSender(event)
    const mediaPath = String(input.mediaPath || '')
    if (/^(https?|blob):/i.test(mediaPath)) return { success: false, error: '实时识别只支持本地视频文件' }
    if (!mediaPath || !fs.existsSync(mediaPath)) return { success: false, error: '视频文件不存在或已被移动' }
    const whisperStatus = transcriptionService.availability()
    if (!whisperStatus.available) return { success: false, error: `${whisperStatus.reason}，请先在模型接入中心下载转写组件` }
    if (!videoFrames.availability().available) return { success: false, error: '缺少 ffmpeg 组件（随 yt-dlp 组件包提供），请先在模型接入中心下载' }
    let durationSec = Number(input.duration) || 0
    if (!(durationSec > 0)) {
      try { durationSec = await videoFrames.probeDuration(mediaPath) } catch { /* 保留 0 */ }
    }
    if (!(durationSec > 0)) return { success: false, error: '无法读取视频时长' }
    liveTranscribeSession?.controller.abort()
    const requestId = normalizeRequestId(input.requestId, 'live-tr')
    const controller = new AbortController()
    liveTranscribeSession = {
      requestId, controller,
      position: Number(input.currentTime) || 0,
      cues: [],
      liveSrtPath: path.join(app.getPath('temp'), `agentplay-live-tr-${requestId}.srt`),
      liveSrtAttached: false
    }
    const send = (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send('subtitle:live-event', { requestId, ...payload })
    }
    ;(async () => {
      try {
        // 语言探测放后台：首段立即开跑，探测完成（中文强制 zh 出简体）从后续段生效，不再阻塞启动
        let whisperLang = 'auto'
        void Promise.race([
          languageDetect.detect(mediaPath),
          new Promise((resolve) => setTimeout(() => resolve(null), 60000))
        ]).then((detected) => {
          if (detected?.lang === 'zh') whisperLang = 'zh'
        }).catch(() => { /* 保持 auto */ })
        const result = await runLiveTranscribe({
          mediaPath, durationSec, startPosition: liveTranscribeSession.position, getLang: () => whisperLang,
          ffmpegPath: videoFrames.ffmpegPath, transcription: transcriptionService,
          getPosition: () => (liveTranscribeSession?.requestId === requestId ? liveTranscribeSession.position : 0),
          signal: controller.signal,
          onCues: (cues) => {
            send({ type: 'transcribe-cues', cues })
            // mpv 即时可见：渲染层只在非 mpv 时直接叠显；mpv 走累积 srt + sub-add/sub-reload
            const session = liveTranscribeSession
            if (!session || session.requestId !== requestId || !mpvReady || !mpv) return
            try {
              session.cues.push(...cues)
              fs.writeFileSync(session.liveSrtPath, cuesToSrt(session.cues), 'utf8')
              if (!session.liveSrtAttached) {
                session.liveSrtAttached = true
                void mpv.loadSubtitle(session.liveSrtPath)
              } else {
                void mpv.send({ command: ['sub-reload'] })
              }
            } catch (error) { log.error('实时识别字幕即时加载失败', error) }
          }
        })
        let srtPath = null
        if (result.cues.length) {
          const candidate = path.join(path.dirname(mediaPath), `${path.parse(mediaPath).name}-AgentPlay识别.srt`)
          try {
            if (!fs.existsSync(candidate)) fs.writeFileSync(candidate, cuesToSrt(result.cues), 'utf8')
            authorizeDerivedSubtitle(candidate)
            srtPath = candidate
          } catch (error) { log.error('实时识别字幕写盘失败', error) }
        }
        send({ type: 'finish', done: result.cues.length, failed: 0, total: result.cues.length, srtPath, cancelled: result.cancelled })
        // 双轨：tiny 初稿完成后，small 精修模型在位且任务完整 → 后台 small 整片精修并落盘替换
        if (!result.cancelled && result.cues.length && srtPath && transcriptionService.availability().smallAvailable) {
          ;(async () => {
            try {
              send({ type: 'refining' })
              const refined = await transcriptionService.transcribe({
                sourcePath: mediaPath, lang: whisperLang, timestamps: true,
                model: 'ggml-small.bin', timeoutMs: 3 * 60 * 60 * 1000
              })
              const refinedCues = parseSubtitleCues(refined.text, '.srt')
                .map((cue, index) => ({ index: index + 1, start: cue.start, end: cue.end, text: cue.text }))
              if (!refinedCues.length) throw new Error('精修没有识别到内容')
              fs.writeFileSync(srtPath, cuesToSrt(refinedCues), 'utf8')
              authorizeDerivedSubtitle(srtPath)
              send({ type: 'refined', srtPath, cueCount: refinedCues.length })
            } catch (refineError) {
              send({ type: 'refine-failed', error: refineError instanceof Error ? refineError.message : String(refineError) })
            }
          })()
        }
      } catch (error) {
        send({ type: 'error', error: error instanceof Error ? error.message : String(error) })
      } finally {
        if (liveTranscribeSession?.requestId === requestId) {
          try { fs.rmSync(liveTranscribeSession.liveSrtPath, { force: true }) } catch { /* 忽略 */ }
          liveTranscribeSession = null
        }
      }
    })()
    return { success: true, requestId, durationSec }
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
  ipcMain.handle('outcome:detect', (event, input = {}) => {
    assertTrustedSender(event)
    try {
      const sourcePath = assertAllowedPath(input.sourcePath)
      const workflow = compileOutcomeWorkflow({ sourcePath, instruction: input.instruction })
      return workflow ? { matched: true, formats: workflow.deliverables.formats, steps: workflow.steps.map((step) => step.id) } : { matched: false, formats: [], steps: [] }
    } catch {
      return { matched: false, formats: [], steps: [] }
    }
  })
  ipcMain.handle('outcome:run', async (event, input = {}) => {
    assertTrustedSender(event)
    const requestId = normalizeRequestId(input.requestId, 'outcome')
    try {
      const prepared = preparePersistentOutcomeTask(input)
      let task = persistentTaskRuntime.enqueue({
        id: requestId,
        type: 'outcome.workflow',
        workspaceTaskId: input.workspaceTaskId,
        spec: prepared.spec,
        approval: prepared.approval
      })
      if (task.state === 'waiting_approval') {
        if (input.cloudApproved === true) task = persistentTaskRuntime.approve(task.approval.id, task.approval.token)
        else return { success: false, requiresApproval: true, requestId, approval: task.approval }
      }
      task = await persistentTaskRuntime.run(requestId)
      if (task.state !== 'completed') {
        return { success: false, requestId, error: task.failure?.message || task.error || '成果工作流未完成', outputs: task.result?.outputs || [], quality: task.quality || null, failure: task.failure || null }
      }
      return { ...task.result, requestId }
    } catch (error) {
      return { success: false, requestId, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('outcome:cancel', (event, requestId) => {
    assertTrustedSender(event)
    return persistentTaskRuntime.cancel(String(requestId || ''))
  })
  ipcMain.handle('projects:list', (event) => {
    assertTrustedSender(event)
    return projectCapsules.list()
  })
  ipcMain.handle('projects:get', (event, projectId) => {
    assertTrustedSender(event)
    return projectCapsules.get(String(projectId || ''))
  })
  ipcMain.handle('projects:list-trash', (event) => { assertTrustedSender(event); return projectCapsules.listTrash() })
  ipcMain.handle('projects:archive', (event, input = {}) => { assertTrustedSender(event); return projectCapsules.archive(String(input.projectId || ''), input.archived !== false) })
  ipcMain.handle('projects:copy', (event, projectId) => { assertTrustedSender(event); return projectCapsules.copy(String(projectId || '')) })
  ipcMain.handle('projects:restore', (event, projectId) => { assertTrustedSender(event); return projectCapsules.restore(String(projectId || '')) })
  ipcMain.handle('projects:trash', async (event, input = {}) => {
    assertTrustedSender(event)
    const projectId = String(input.projectId || '')
    const project = projectCapsules.get(projectId)
    if (!project) return { success: false, error: '项目不存在' }
    const taskId = normalizeRequestId(input.requestId, 'project-trash')
    let task = persistentTaskRuntime.enqueue({ id: taskId, type: 'project.trash', spec: { projectId }, approval: { action: 'delete', summary: `把项目《${project.name || projectId}》移入可恢复区；不会删除任何素材或成果文件` } })
    if (task.state === 'waiting_approval') {
      if (input.approvalId && input.approvalToken) task = persistentTaskRuntime.approve(input.approvalId, input.approvalToken)
      else return { success: false, requiresApproval: true, requestId: taskId, approval: task.approval }
    }
    task = await persistentTaskRuntime.run(taskId)
    return task.state === 'completed' ? { ...task.result, requestId: taskId } : { success: false, error: task.error || '项目未移入回收区' }
  })
  ipcMain.handle('links:detect', (event, text) => {
    assertTrustedSender(event)
    return publicLinkService.detect(text)
  })
  ipcMain.handle('links:handle', async (event, input = {}) => {
    assertTrustedSender(event)
    try {
      const inspected = await publicLinkService.inspect(input.url)
      if (inspected.access !== 'public') return { success: false, controlled: true, ...inspected }
      const instruction = String(input.instruction || '')
      if (/下载|保存/.test(instruction)) {
        const downloaded = await publicLinkService.download(inspected.url, path.join(app.getPath('documents'), 'AgentPlay 输出', '公开内容'))
        userAuthorizedPaths.add(path.resolve(downloaded.outputPath))
        return { success: true, action: 'download', ...downloaded }
      }
      if (/加入项目|保存到项目|放进项目/.test(instruction)) {
        const projectId = projectCapsules.newProjectId()
        const projectCapsule = projectCapsules.recordTask({ projectId, taskId: `link-${crypto.randomUUID()}`, type: 'link.reference', instruction, references: [{ kind: inspected.kind, uri: inspected.url }], outputs: [], result: { success: true, preview: inspected } })
        return { success: true, action: 'project', ...inspected, projectCapsule }
      }
      if (/翻译/.test(instruction) && inspected.excerpt) {
        const config = modelConfigStore.resolved('chat')
        const requiresKey = config?.requiresKey !== false
        if (config?.configured === false || !config?.baseUrl || !config?.model || (requiresKey && !config.apiKey)) throw new Error('翻译公开内容需要先配置可用模型')
        if (!isLocalModelConfig(config)) {
          const approved = await ensureCloudConsent(`把公开网页摘录发送给 ${config.providerName || config.providerId} · ${config.model} 翻译；不发送浏览器Cookie或登录信息`)
          if (!approved) return { success: false, cancelled: true, error: '已取消：未授权云端翻译' }
        }
        const translated = await llmComplete({ systemPrompt: '你是忠实翻译器，只翻译提供的公开内容，不补充事实。', prompt: `翻译成中文：\n${inspected.excerpt}`, modelConfig: config, taskKind: 'document' })
        return { success: true, action: 'translate', ...inspected, translated: translated.text }
      }
      return { success: true, action: 'preview', ...inspected }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('evidence:inspect-file', async (event, filePath) => {
    assertTrustedSender(event)
    const resolved = assertAllowedPath(filePath)
    return { source: resolved, evidence: await inspectEvidencePath(resolved) }
  })
  ipcMain.handle('cross-material:detect', (event, input = {}) => {
    assertTrustedSender(event)
    try {
      const tokens = Array.isArray(input.tokens) ? input.tokens.slice(0, 20) : []
      const paths = tokens.map(documentSelectionFromToken)
      if (input.currentPath) paths.push(assertAllowedPath(input.currentPath))
      const context = resolveCrossMaterialContext(paths)
      const sourceCount = new Set([...context.sourcePaths, ...context.referenceEvidence.map((item) => String(item?.source || '')).filter(Boolean)]).size
      return { matched: detectCrossMaterialQuestion(input.question) && sourceCount >= 2, sourceCount, projectId: context.projectId }
    } catch (error) {
      return { matched: false, sourceCount: 0, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('cross-material:ask', async (event, input = {}) => {
    assertTrustedSender(event)
    const requestId = normalizeRequestId(input.requestId, 'cross-material')
    try {
      const tokens = Array.isArray(input.tokens) ? input.tokens.slice(0, 20) : []
      const paths = tokens.map(documentSelectionFromToken)
      if (input.currentPath) paths.push(assertAllowedPath(input.currentPath))
      const prepared = preparePersistentCrossMaterialTask(paths, input)
      if (!prepared.matched) return { success: false, matched: false, requestId, error: '当前指令不是跨素材问答' }
      let task = persistentTaskRuntime.enqueue({ id: requestId, type: 'project.evidence-qa', workspaceTaskId: input.workspaceTaskId, spec: prepared.spec, approval: prepared.approval })
      if (task.state === 'waiting_approval') {
        if (input.cloudApproved === true) task = persistentTaskRuntime.approve(task.approval.id, task.approval.token)
        else return { success: false, matched: true, requiresApproval: true, requestId, approval: task.approval }
      }
      task = await persistentTaskRuntime.run(requestId)
      if (task.state !== 'completed') return { success: false, matched: true, requestId, error: task.failure?.message || task.error || '跨素材问答未完成', quality: task.quality || null, failure: task.failure || null }
      return { ...task.result, matched: true, requestId, quality: task.quality || null }
    } catch (error) {
      return { success: false, matched: true, requestId, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('cross-material:cancel', (event, requestId) => {
    assertTrustedSender(event)
    return persistentTaskRuntime.cancel(String(requestId || ''))
  })
  // 对话流视频解剖：AI 助手面板直接对当前视频发起，报告经文档工作台另存，原文件不动
  ipcMain.handle('analysis:detect', (event, text) => {
    assertTrustedSender(event)
    return { matched: detectAnalysisIntent(text), outputFormat: resolveAnalysisOutput(text) }
  })
  ipcMain.handle('analysis:run', async (event, input = {}) => {
    assertTrustedSender(event)
    const requestId = normalizeRequestId(input.requestId, 'analysis')
    try {
      const prepared = preparePersistentAnalysisTask(input)
      let task = persistentTaskRuntime.enqueue({
        id: requestId,
        type: 'analysis.run',
        workspaceTaskId: input.workspaceTaskId,
        spec: prepared.spec,
        approval: prepared.approval
      })
      if (task.state === 'waiting_approval') {
        if (input.cloudApproved === true) {
          task = persistentTaskRuntime.approve(task.approval.id, task.approval.token)
        } else {
          return { success: false, requiresApproval: true, requestId, approval: task.approval }
        }
      }
      task = await persistentTaskRuntime.run(requestId)
      if (task.state !== 'completed') return { success: false, requestId, error: task.error || '视频解剖未完成' }
      return { ...task.result, requestId }
    } catch (error) {
      return { success: false, requestId, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('analysis:cancel', (event, requestId) => {
    assertTrustedSender(event)
    const controller = activeAnalysisRequests.get(String(requestId || ''))
    controller?.abort()
    return persistentTaskRuntime.cancel(String(requestId || '')) || Boolean(controller)
  })
  ipcMain.handle('studio:export-project', async (event, project = {}) => {
    assertTrustedSender(event)
    const serialized = JSON.stringify(project, null, 2)
    if (Buffer.byteLength(serialized, 'utf8') > 10 * 1024 * 1024) throw new Error('项目文件超过 10MB')
    const safeName = String(project.mediaName || '视频').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\.[^.]+$/, '')
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('documents'), `${safeName}-AI拉片项目.aiproj.json`),
      filters: [{ name: 'AgentPlay 拉片项目', extensions: ['aiproj.json', 'json'] }]
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
    const config = cloudConfigForExplicitFeature()
    const approved = await ensureCloudConsent('创作主题、拉片报告或素材说明将发送给云端模型，用于生成创作方案。')
    if (!approved) return { success: false, cancelled: true, error: '已取消：未授权发送云端' }
    return requestCreativePlan(config, input)
  })
  ipcMain.handle('studio:generate-image', async (event, input = {}) => {
    assertTrustedSender(event)
    const config = cloudConfigForExplicitFeature()
    const approved = await ensurePersistentApproval({ action: 'paid', summary: `把生图提示词发送给 ${config.providerName || config.providerId} · ${config.model}；可能消耗你的云端额度或产生费用` })
    if (!approved) return { success: false, cancelled: true, error: '已取消：未授权付费云端任务' }
    return generateImageAsset(config, {
      ...input,
      outputDir: path.join(app.getPath('userData'), 'creative-assets', 'images')
    })
  })
  const creativeTaskRoute = (taskKind, metricModel = '') => {
    const cloudCandidates = modelConfigStore.resolvedCandidates('chat').filter((candidate) => (
      !isLocalModelConfig(candidate) && candidate.protocol !== 'cli' && candidate.providerId === 'agnes'
    ))
    const decision = selectModelForTaskPlan({ taskKind, requirements: { text: true, providerId: 'agnes' }, candidates: cloudCandidates })
    const config = decision.selected
    const requiresKey = config?.requiresKey !== false
    if (!config || !config.baseUrl || !config.model || (requiresKey && !config.apiKey)) {
      throw new Error('AI 视频创作需要先在模型接入中心配置可用的 Agnes 云端模型与 API Key')
    }
    return freezeTaskModelRoute(config, { taskKind, metricModel })
  }
  const preparePersistentVideoGeneration = (input) => {
    const prompt = String(input.prompt || '').trim().slice(0, 4000)
    if (!prompt) throw new Error('视频提示词不能为空')
    const imageBase64 = String(input.imageBase64 || '')
    if (imageBase64.length > 12 * 1024 * 1024) throw new Error('图生视频参考图超过 12MB，请先压缩')
    const videoModel = String(input.model || 'agnes-video-v2.0').slice(0, 200)
    const modelRoute = creativeTaskRoute('creative-video', videoModel)
    return {
      spec: {
        instruction: String(input.instruction || prompt).slice(0, 4000), prompt,
        model: videoModel, duration: Math.max(1, Math.min(8, Number(input.duration) || 4)),
        fps: Math.max(1, Math.min(60, Number(input.fps) || 24)), size: String(input.size || '1280x720').slice(0, 40),
        ...(imageBase64 ? { imageBase64 } : {}), modelRoute
      },
      approval: { action: 'paid', summary: `把视频提示词发送给 ${modelRoute.providerName} · ${modelRoute.model} 生成视频；可能消耗你的云端额度或产生费用` }
    }
  }
  const executePersistentVideoGeneration = async ({ task, signal, checkpoint, status }) => {
    if (task.checkpoint?.stage === 'artifact-written' && task.checkpoint?.result && outputsStillExist(task.checkpoint.result)) return task.checkpoint.result
    const outputDir = path.join(app.getPath('userData'), 'creative-assets', 'videos')
    const expectedPath = path.join(outputDir, `${task.id}.mp4`)
    if (fs.existsSync(expectedPath) && fs.statSync(expectedPath).size > 0) {
      const result = { success: true, outputPath: expectedPath, outputs: [expectedPath], bytes: fs.statSync(expectedPath).size, videoId: task.checkpoint?.videoId || '', numFrames: task.checkpoint?.numFrames || 0 }
      checkpoint({ stage: 'artifact-written', result })
      return result
    }
    status(task.checkpoint?.videoId ? '正在恢复云端视频任务' : '正在创建云端视频任务')
    const config = resolveTaskModelRoute(task.spec.modelRoute)
    const result = await generateVideoWithReceipt(config, {
      prompt: task.spec.prompt, model: task.spec.model, duration: task.spec.duration, fps: task.spec.fps,
      size: task.spec.size, imageBase64: task.spec.imageBase64, id: task.id, signal, outputDir,
      resumeVideoId: task.checkpoint?.videoId,
      onCheckpoint: (remote) => checkpoint(remote)
    })
    const completed = { ...result, outputs: [result.outputPath] }
    checkpoint({ stage: 'artifact-written', result: completed })
    return completed
  }
  const preparePersistentRecut = (input) => {
    const mediaName = String(input.mediaName || '视频').trim().slice(0, 80) || '视频'
    const reportText = String(input.reportText || '').slice(0, 3000)
    const modelRoute = creativeTaskRoute('creative-planning')
    return {
      spec: {
        instruction: '生成重构短片', reportText, mediaName,
        count: Math.max(2, Math.min(4, Number(input.count) || 3)),
        seconds: Math.max(2, Math.min(8, Number(input.seconds) || 4)), modelRoute
      },
      approval: { action: 'paid', summary: `把拉片报告发送给 ${modelRoute.providerName} · ${modelRoute.model} 并生成多个 AI 视频镜头；可能多次消耗云端额度或产生费用` }
    }
  }
  const executePersistentRecut = async ({ task, signal, checkpoint, status }) => {
    if (task.checkpoint?.stage === 'artifact-written' && task.checkpoint?.result && outputsStillExist(task.checkpoint.result)) return task.checkpoint.result
    const config = resolveTaskModelRoute(task.spec.modelRoute)
    const reportText = String(task.spec.reportText || '')
    const mediaName = String(task.spec.mediaName || '视频')
    const count = Number(task.spec.count) || 3
    const seconds = Number(task.spec.seconds) || 4
    let shots = Array.isArray(task.checkpoint?.shots) ? task.checkpoint.shots.map(String) : []
    if (!shots.length) {
      status('正在把报告浓缩成镜头脚本')
      const shotPlan = await llmComplete({
        systemPrompt: '你是短视频导演，只返回 JSON。', modelConfig: config,
        prompt: `根据这份视频拉片报告，为《${mediaName}》设计 ${count} 个重构镜头，每个镜头一句中文画面提示词（适合 AI 生视频：具象场景、动作、光线；不要人物正脸特写，不要画面文字）。返回 {"shots":["提示词1","提示词2","提示词3"]}，正好 ${count} 条。\n\n报告：\n${reportText || `主题：${mediaName}`}`,
        timeoutMs: 90000, signal, taskKind: 'creative-planning'
      })
      const planJson = JSON.parse(/\{[\s\S]*\}/.exec(shotPlan.text || '')?.[0] || '{}')
      shots = (Array.isArray(planJson.shots) ? planJson.shots : []).map((shot) => String(shot || '').trim()).filter(Boolean).slice(0, count)
      if (!shots.length) throw new Error('镜头脚本生成失败，请重试')
      checkpoint({ stage: 'shots-planned', shots })
    }
    const clipPaths = Array.isArray(task.checkpoint?.clipPaths) ? [...task.checkpoint.clipPaths] : []
    const clipJobs = Array.isArray(task.checkpoint?.clipJobs) ? [...task.checkpoint.clipJobs] : []
    const outputDir = path.join(app.getPath('userData'), 'creative-assets', 'videos')
    for (let index = 0; index < shots.length; index += 1) {
      if (clipPaths[index] && fs.existsSync(clipPaths[index]) && fs.statSync(clipPaths[index]).size > 0) continue
      status(`正在生成镜头 ${index + 1}/${shots.length}（每个约 1-2 分钟）`)
      const clip = await generateVideoWithReceipt(config, {
        prompt: shots[index], duration: seconds, id: `${task.id}-clip-${index + 1}`, signal, outputDir,
        resumeVideoId: clipJobs[index]?.videoId,
        onCheckpoint: (remote) => {
          clipJobs[index] = { ...clipJobs[index], ...remote }
          checkpoint({ stage: 'clip-remote-created', shots, clipPaths, clipJobs })
        }
      })
      clipPaths[index] = clip.outputPath
      clipJobs[index] = { ...clipJobs[index], videoId: clip.videoId, outputPath: clip.outputPath }
      checkpoint({ stage: 'clips-generated', shots, clipPaths, clipJobs })
    }
    status('正在拼接成片')
    if (!videoFrames.availability().available) throw new Error('缺少 ffmpeg 组件（随 yt-dlp 组件包提供）')
    const safeName = mediaName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\.[^.]+$/, '')
    const outputPath = path.join(app.getPath('documents'), 'AgentPlay 输出', `${safeName}-AgentPlay重构短片-${task.id}.mp4`)
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      const result = { success: true, outputPath, outputs: [outputPath], shots, clips: clipPaths.length }
      checkpoint({ stage: 'artifact-written', result, shots, clipPaths, clipJobs })
      return result
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    const listFile = path.join(app.getPath('temp'), `recut-list-${task.id}.txt`)
    try {
      fs.writeFileSync(listFile, clipPaths.map((clipPath) => `file '${String(clipPath).replace(/\\/g, '/')}'`).join('\n'), 'utf8')
      await videoFrames.run(['-f', 'concat', '-safe', '0', '-i', listFile, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', outputPath], { timeoutMs: 300000, signal })
    } finally {
      if (fs.existsSync(listFile)) fs.rmSync(listFile, { force: true })
    }
    const result = { success: true, outputPath, outputs: [outputPath], shots, clips: clipPaths.length }
    checkpoint({ stage: 'artifact-written', result, shots, clipPaths, clipJobs })
    return result
  }
  persistentTaskRuntime.register('creative.video-generate', executePersistentVideoGeneration, { autoResume: true })
  persistentTaskRuntime.register('creative.recut-short', executePersistentRecut, { autoResume: true })
  const runCreativeTask = async (requestId, type, workspaceTaskId, prepared) => {
    let task = persistentTaskRuntime.enqueue({ id: requestId, type, workspaceTaskId, spec: prepared.spec, approval: prepared.approval })
    if (task.state === 'waiting_approval') {
      const approved = await ensurePersistentApproval(task.approval)
      if (!approved) {
        persistentTaskRuntime.cancel(requestId)
        return { success: false, requestId, cancelled: true, error: '已取消：未授权付费云端任务' }
      }
      task = persistentTaskRuntime.approve(task.approval.id, task.approval.token)
    }
    task = await persistentTaskRuntime.run(requestId)
    if (task.state !== 'completed') return { success: false, requestId, cancelled: task.state === 'cancelled', error: task.error || '创作任务未完成' }
    return { ...task.result, requestId }
  }
  ipcMain.handle('studio:generate-video', async (event, input = {}) => {
    assertTrustedSender(event)
    const requestId = normalizeRequestId(input.requestId, 'video-gen')
    try {
      return await runCreativeTask(requestId, 'creative.video-generate', input.workspaceTaskId || `workspace-${requestId}`, preparePersistentVideoGeneration(input))
    } catch (error) {
      return { success: false, requestId, error: error instanceof Error ? error.message : String(error) }
    }
  })
  // 拉片重构短片：报告 → AI 镜头脚本 → 逐镜头生视频 → ffmpeg 拼接成片（视频→报告→新成片闭环）
  ipcMain.handle('studio:recut-short', async (event, input = {}) => {
    assertTrustedSender(event)
    const requestId = normalizeRequestId(input.requestId, 'recut')
    try {
      return await runCreativeTask(requestId, 'creative.recut-short', input.workspaceTaskId || `workspace-${requestId}`, preparePersistentRecut(input))
    } catch (error) {
      return { success: false, requestId, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('studio:task-cancel', (event, requestId) => {
    assertTrustedSender(event)
    const controller = activeCreativeTasks.get(String(requestId || ''))
    controller?.abort()
    return persistentTaskRuntime.cancel(String(requestId || '')) || Boolean(controller)
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
    if (input.engine !== 'cloud') return synthesizeSystemVoice(request)
    const config = cloudConfigForExplicitFeature()
    const approved = await ensurePersistentApproval({ action: 'paid', summary: `把配音文案发送给 ${config.providerName || config.providerId} · ${config.model}；可能消耗你的云端额度或产生费用` })
    if (!approved) return { success: false, cancelled: true, error: '已取消：未授权付费云端任务' }
    return synthesizeCloudVoice(config, request)
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
        ffmpegPath: path.join(app.getPath('userData'), 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin', 'ffmpeg.exe'),
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

  ipcMain.handle('files:scan', (_e, dir) => {
    assertTrustedSender(_e)
    try {
      return scanDir(dir ? assertAllowedPath(dir) : defaultVideoDir())
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('files:defaultDir', (event) => { assertTrustedSender(event); return defaultVideoDir() })
  ipcMain.handle('files:readText', async (_e, filePath) => {
    assertTrustedSender(_e)
    try {
      const resolved = assertAllowedPath(filePath)
      const stat = fs.statSync(resolved)
      const ext = path.extname(resolved).toLowerCase()
      if (!stat.isFile() || !['text', 'subtitle'].includes(getType(ext))) throw new Error('只允许读取支持的文本文件')
      if (stat.size > 2 * 1024 * 1024) throw new Error('文本文件超过 2MB 预览上限')
      const content = fs.readFileSync(resolved, 'utf-8')
      return { success: true, content: content.slice(0, 100000) }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
  ipcMain.handle('files:readDataUrl', async (_e, filePath) => {
    assertTrustedSender(_e)
    try {
      const resolved = assertAllowedPath(filePath)
      const stat = fs.statSync(resolved)
      const type = getType(path.extname(resolved).toLowerCase())
      if (!stat.isFile() || !['image', 'pdf'].includes(type)) throw new Error('只允许读取图片或 PDF')
      if (stat.size > 50 * 1024 * 1024) throw new Error('文件超过 50MB 预览上限')
      const buffer = fs.readFileSync(resolved)
      const ext = path.extname(resolved).slice(1).toLowerCase()
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
  ipcMain.handle('print:file', async (event, p) => {
    assertTrustedSender(event)
    try {
      const resolved = assertPrintablePath(p)
      const ext = path.extname(resolved).toLowerCase()
      if (['.doc', '.docx', '.rtf', '.odt', '.xls', '.xlsx', '.csv', '.ods', '.ppt', '.pptx', '.odp'].includes(ext)) {
        const printed = await officeConvert.printFile(resolved)
        return { success: true, action: `已用本机 ${printed.engine} 发送打印` }
      }
      return printFile(resolved)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('print:html', async (event, html) => {
    assertTrustedSender(event)
    try {
      const content = String(html || '')
      if (!content.trim()) throw new Error('没有可打印的内容')
      if (Buffer.byteLength(content, 'utf8') > 5 * 1024 * 1024) throw new Error('打印内容超过 5MB')
      const win = new BrowserWindow({ show: false, sandbox: true, webPreferences: { contextIsolation: true, nodeIntegration: false } })
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(content))
      win.webContents.print({ printBackground: true })
      setTimeout(() => win.close(), 2000)
      return { success: true, action: '已发送打印' }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('print:text', async (event, filePath) => {
    assertTrustedSender(event)
    try {
      const resolved = assertPrintablePath(filePath)
      const content = require('fs').readFileSync(resolved, 'utf-8').slice(0, 50000)
      const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const win = new BrowserWindow({ show: false })
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<pre style="font-family:monospace;white-space:pre-wrap;padding:20px">' + escaped + '</pre>'))
      win.webContents.print({ printBackground: true })
      setTimeout(() => win.close(), 2000)
      return { success: true, action: '已发送打印' }
    } catch (e) { return { success: false, error: String(e) } }
  })
  ipcMain.handle('wifi:url', async (event) => {
    assertTrustedSender(event)
    if (!wifiTransfer) return null
    try {
      if (!wifiTransfer.server) await wifiTransfer.start()
      return wifiTransfer.getUrl()
    } catch (error) {
      log.error('用户启用 WiFi 传输失败', error)
      return null
    }
  })
  ipcMain.handle('wifi:pin', (event) => { assertTrustedSender(event); return (wifiTransfer?.server ? wifiTransfer.getPin() : null) })
  ipcMain.handle('wifi:stop', (event) => {
    assertTrustedSender(event);
    wifiTransfer?.stop(); return true })
  const serviceCredentialStatus = () => {
    const status = serviceCredentialStore.publicStatus()
    const environment = {
      tmdb: Boolean(process.env.TMDB_API_KEY),
      opensubtitles: Boolean(process.env.OPENSUBTITLES_API_KEY)
    }
    return {
      ...status,
      services: Object.fromEntries(Object.entries(status.services).map(([service, value]) => [service, {
        ...value,
        hasKey: value.hasKey || environment[service],
        source: value.hasKey ? 'system' : environment[service] ? 'environment' : 'none'
      }]))
    }
  }
  const serviceKey = (service) => serviceCredentialStore.get(service)
    || (service === 'tmdb' ? process.env.TMDB_API_KEY : process.env.OPENSUBTITLES_API_KEY)
    || ''
  ipcMain.handle('serviceCredentials:status', (event) => {
    assertTrustedSender(event)
    return serviceCredentialStatus()
  })
  ipcMain.handle('serviceCredentials:save', (event, input) => {
    assertTrustedSender(event)
    serviceCredentialStore.save(input)
    return serviceCredentialStatus()
  })
  ipcMain.handle('tmdb:search', (_e, name) => { assertTrustedSender(_e); return searchMovie(name, serviceKey('tmdb')) })
  ipcMain.handle('subtitle:search', (_e, name) => { assertTrustedSender(_e); return searchSubtitle(name, serviceKey('opensubtitles')) })
  ipcMain.handle('subtitle:download', async (_e, fileId) => {
    assertTrustedSender(_e)
    const result = await downloadSubtitle(fileId, serviceKey('opensubtitles'))
    if (result.success && result.path) authorizeDerivedSubtitle(result.path)
    return result
  })
  ipcMain.handle('media:analyze', (_e, dir) => {
    assertTrustedSender(_e)
    try {
      const files = analyzeDir(dir ? assertAllowedPath(dir) : defaultVideoDir())
      return { files, clusters: clusterByTag(files) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('media:dedup', async (event, input = {}) => {
    assertTrustedSender(event)
    const request = typeof input === 'string' ? { dir: input } : input
    const dir = request.dir || request.directoryPath
    const requestId = normalizeRequestId(request.requestId, 'media-dedup')
    try {
      const rootPath = dir ? assertAllowedPath(dir) : defaultVideoDir()
      persistentTaskRuntime.enqueue({
        id: requestId,
        type: 'media.dedup',
        workspaceTaskId: request.workspaceTaskId,
        spec: { root: frozenDirectoryRoot(rootPath) }
      })
      const task = await persistentTaskRuntime.run(requestId)
      if (task.state !== 'completed') return { success: false, requestId, cancelled: task.state === 'cancelled', error: task.error || '重复文件检查未完成', duplicates: [], filesScanned: 0 }
      return { ...task.result, requestId }
    } catch (error) {
      return { success: false, requestId, error: error instanceof Error ? error.message : String(error), duplicates: [], filesScanned: 0 }
    }
  })
  ipcMain.handle('media:suggest', (_e, dir) => {
    assertTrustedSender(_e)
    try {
      const files = analyzeDir(dir ? assertAllowedPath(dir) : defaultVideoDir())
      return suggestClip(files)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('dlna:serverUrl', async (event) => {
    assertTrustedSender(event)
    if (!dlnaServer) return null
    try {
      if (!dlnaServer.server) await dlnaServer.start(defaultVideoDir())
      return `http://${require('./utils').getLanIp()}:${dlnaServer.port}`
    } catch (error) {
      log.error('用户启用 DLNA 媒体库失败', error)
      return null
    }
  })
  ipcMain.handle('dlna:serverStop', (event) => {
    assertTrustedSender(event);
    dlnaServer?.stop(); return true })
  ipcMain.handle('receiver:start', async (event) => {
    assertTrustedSender(event)
    if (!dlnaReceiver) return false
    try {
      if (!dlnaReceiver.httpServer) await dlnaReceiver.start()
      return true
    } catch (error) {
      log.error('用户启用 DLNA 接收失败', error)
      return false
    }
  })
  ipcMain.handle('receiver:stop', (event) => {
    assertTrustedSender(event);
    dlnaReceiver?.stop(); return true })
  ipcMain.handle('plugin:list', (event) => { assertTrustedSender(event); return pluginService?.refresh() || [] })
  ipcMain.handle('plugin:refresh', (event) => { assertTrustedSender(event); return pluginService?.refresh() || [] })
  ipcMain.handle('plugin:install', async (event) => {
    assertTrustedSender(event)
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: '选择 AgentPlay 插件包文件夹',
      properties: ['openDirectory']
    })
    if (selection.canceled || !selection.filePaths[0]) return { cancelled: true, plugins: pluginService?.refresh() || [] }
    try {
      return { success: true, plugins: pluginService.installFromDirectory(selection.filePaths[0]) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), plugins: pluginService?.refresh() || [] }
    }
  })
  ipcMain.handle('plugin:setEnabled', (event, input = {}) => {
    assertTrustedSender(event)
    try {
      return { success: true, plugins: pluginService.setEnabled(String(input.id || ''), input.enabled === true, input.permissions) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), plugins: pluginService?.refresh() || [] }
    }
  })
  ipcMain.handle('plugin:remove', (event, input = {}) => {
    assertTrustedSender(event)
    try {
      return { success: true, plugins: pluginService.remove(String(input.id || ''), input.confirmed === true) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), plugins: pluginService?.refresh() || [] }
    }
  })
  ipcMain.handle('plugin:openFolder', async (event) => {
    assertTrustedSender(event)
    const { shell } = require('electron')
    fs.mkdirSync(pluginService.rootDir, { recursive: true })
    const error = await shell.openPath(pluginService.rootDir)
    return error ? { success: false, error } : { success: true }
  })
  ipcMain.handle('cast:scan', (event) => { assertTrustedSender(event); return castService.scan() })
  // 防火墙放行（一次性）：DLNA 是"推 URL、电视拉回内容"，电视必须能连本机 18901；
  // Windows 防火墙默认拦新应用入站 → 电视拉取永远超时。规则只加一次（一次 UAC 弹窗，用户可见可控）。
  // 智能投屏：一次扫全类型（DLNA 电视/盒子 + AgentPlay 镜像设备），统一列表，用户只点一下
  ipcMain.handle('cast:smart-scan', async (event) => {
    assertTrustedSender(event)
    const [dlna, mirrors] = await Promise.all([
      castService.scan().catch(() => []),
      (async () => {
        try {
          mirrorDiscovery?.stop()
          mirrorDiscovery = new MirrorDiscovery()
          return await mirrorDiscovery.listen(2500)
        } catch { return [] }
      })()
    ])
    const devices = [
      ...dlna.map((d) => ({ id: d.id, name: d.name, kind: 'tv', lastSuccess: !!d.lastSuccess })),
      ...mirrors.map((m) => ({ id: `mirror:${m.host}:${m.port}`, name: m.name || 'AgentPlay 设备', kind: 'agentplay', host: m.host, port: m.port }))
    ]
    devices.sort((a, b) => Number(Boolean(b.lastSuccess)) - Number(Boolean(a.lastSuccess)))
    return devices
  })
  ipcMain.handle('cast:ensure-firewall', async (event) => {
    assertTrustedSender(event)
    if (process.platform !== 'win32') return { needed: false }
    try {
      const out = execFileSync('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=AgentPlay投屏'], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
      if (out.includes('AgentPlay')) return { needed: false }
    } catch { /* 规则不存在 */ }
    return { needed: true }
  })
  ipcMain.handle('cast:allow-firewall', async (event) => {
    assertTrustedSender(event)
    if (process.platform !== 'win32') return { success: true }
    // 写临时 ps1 + Start-Process runas 提权执行（一次 UAC）；只放行 AgentPlay 自己的投屏端口
    const rulePs = path.join(os.tmpdir(), `agentplay-fw-${process.pid}.ps1`)
    fs.writeFileSync(rulePs, [
      'New-NetFirewallRule -DisplayName "AgentPlay投屏" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 18901 -ErrorAction Stop | Out-Null',
      'New-NetFirewallRule -DisplayName "AgentPlay投屏" -Direction Inbound -Action Allow -Protocol UDP -LocalPort 1900 -ErrorAction SilentlyContinue | Out-Null',
      'Write-Output OK'
    ].join('\r\n'), 'utf8')
    try {
      execFileSync('powershell', ['-NoProfile', '-Command', `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${rulePs.replace(/'/g, "''")}'`], { windowsHide: true, timeout: 60000 })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      try { fs.rmSync(rulePs, { force: true }) } catch { /* 忽略 */ }
    }
  })
  ipcMain.handle('cast:cast', (event, deviceId, filePath) => {
    assertTrustedSender(event)
    try {
      return castService.cast(deviceId, assertAllowedPath(filePath))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('cast:stop', (_e, deviceId) => { assertTrustedSender(_e); return castService.stopCast(deviceId) })
  ipcMain.handle('cast:pause', (_e, deviceId) => { assertTrustedSender(_e); return castService.pauseCast(deviceId) })
  ipcMain.handle('cast:resume', (_e, deviceId) => { assertTrustedSender(_e); return castService.resumeCast(deviceId) })
  ipcMain.handle('cast:seek', (_e, deviceId, seconds) => { assertTrustedSender(_e); return castService.seekCast(deviceId, seconds) })
  ipcMain.handle('cast:status', (_e, deviceId) => { assertTrustedSender(_e); return castService.getStatus(deviceId) })
  ipcMain.handle('dialog:openFile', (event) => { assertTrustedSender(event); return chooseFile() })
  ipcMain.handle('dialog:openFolder', async (event) => {
    assertTrustedSender(event);
    const { dialog } = require('electron'); const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] }); if (r.canceled) return null; authorizedFolders.add(r.filePaths[0]); return r.filePaths[0] })
  ipcMain.handle('system:showInFolder', async (_e, filePath) => {
    assertTrustedSender(_e)
    const { shell } = require('electron')
    shell.showItemInFolder(path.resolve(String(filePath || '')))
    return true
  })
  ipcMain.handle('system:verifyPaths', (event, filePaths) => {
    assertTrustedSender(event)
    return (Array.isArray(filePaths) ? filePaths : []).slice(0, 20).map((filePath) => {
      const original = String(filePath || '')
      try {
        const resolved = assertAllowedPath(original, { denyExecutable: true })
        const stat = fs.statSync(resolved)
        return { path: original, exists: stat.isFile(), bytes: stat.isFile() ? stat.size : 0 }
      } catch (error) {
        return { path: original, exists: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  })
  ipcMain.handle('system:openPath', async (_e, filePath) => {
    assertTrustedSender(_e)
    const { shell } = require('electron')
    try {
      const resolved = assertAllowedPath(filePath, { denyExecutable: true })
      if (!fs.existsSync(resolved)) return { success: false, error: '文件不存在' }
      const error = await shell.openPath(resolved)
      return error ? { success: false, error } : { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('docx:preview', (_e, filePath) => {
    assertTrustedSender(_e)
    try {
      return previewDocx(assertAllowedPath(filePath))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('xlsx:preview', (_e, filePath) => {
    assertTrustedSender(_e)
    try {
      return previewXlsx(assertAllowedPath(filePath))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('sync:url', async (event) => {
    assertTrustedSender(event)
    if (!syncService) return null
    try {
      if (!syncService.server) await syncService.start()
      return syncService.getUrl()
    } catch (error) {
      log.error('用户启用跨设备同步失败', error)
      return null
    }
  })
  ipcMain.handle('sync:stop', (event) => {
    assertTrustedSender(event);
    syncService?.stop(); return true })
  ipcMain.handle('sync:setPeer', (_e, url) => {
    assertTrustedSender(_e)
    return syncService?.setPeer(url) ?? false
  })
  ipcMain.handle('sync:upload', (event) => { assertTrustedSender(event); return syncService.upload() })
  ipcMain.handle('sync:download', (event) => { assertTrustedSender(event); return syncService.download() })
  ipcMain.handle('sync:getProgress', (_e, key) => { assertTrustedSender(_e); return syncService.getProgress(key) })
  ipcMain.handle('sync:setProgress', (_e, key, position, preferences) => {
    assertTrustedSender(_e)
    syncService.setProgress(key, position, preferences)
    return true
  })

  // 模型清单周更：超过一周未刷新则后台静默刷新（淘汰下架旧型号、上新型号）
  void (async () => {
    try {
      if (!modelCatalog.needsRefresh()) return
      log.info('模型清单超过一周未更新，后台刷新中')
      await new Promise((resolve) => {
        ipcMain.once = ipcMain.once || null
        resolve()
      })
      const handlers = []
      for (const handler of ipcMain._handlers?.values?.() || []) handlers.push(handler)
      const refreshHandler = handlers.find((entry) => entry && /refresh-catalog/.test(String(entry)))
      // 直接复用 IPC 内的刷新逻辑太重，这里简化为调用 catalog.refresh（仅 codex 缓存 + 当前配置厂商）
      const chatConfig = modelConfigStore.resolved('chat')
      const listModelsForProvider = async () => {
        if (!chatConfig.apiKey || chatConfig.protocol !== 'openai' || chatConfig.providerId === 'bundled-lite') return []
        try {
          const models = await listModels(chatConfig, { timeoutMs: 12000 })
          return models.length ? [{ providerId: chatConfig.providerId, models }] : []
        } catch { return [] }
      }
      const result = await modelCatalog.refresh({ listModelsForProvider, onLog: (message) => log.info(`模型清单周更: ${message}`) })
      log.info(`模型清单周更完成：${result.updated} 个厂商`)
    } catch (error) { log.warn('模型清单周更失败（下周再试）', error) }
  })()

  // 首启自动化：新装用户后台静默装好核心组件（离线转写 + 站点视频），不用用户去猜去找
  void (async () => {
    try {
      const markerPath = path.join(app.getPath('userData'), 'first-run-components.json')
      let marker = null
      try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) } catch { /* 首次启动 */ }
      if (marker?.done || (marker?.attempts || 0) >= 3) return
      log.info('首启自动化：开始后台安装核心组件（离线转写 + 站点视频）')
      if (!transcriptionService.availability().available) {
        await whisperDownload.start({}).catch((error) => log.warn('首启转写组件下载失败', error))
      }
      if (!siteVideo.availability().available) {
        await ytdlpDownload.start({}).catch((error) => log.warn('首启站点视频组件下载失败', error))
      }
      const done = transcriptionService.availability().available && siteVideo.availability().available
      fs.writeFileSync(markerPath, JSON.stringify({ done, attempts: (marker?.attempts || 0) + 1, at: new Date().toISOString() }))
      log.info(done ? '首启自动化：核心组件已就绪' : '首启自动化：组件未全部就绪，下次启动再试')
    } catch (error) {
      log.warn('首启自动化失败（下次启动再试）', error)
    }
  })()

  // 注册完所有执行器和 IPC 后再恢复；长任务在后台继续，渲染进程可通过 list/event 回接状态。
  void persistentTaskRuntime.startRecoverable().catch((error) => log.error('持久任务恢复失败', error))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  for (const controller of activeAiRequests.values()) controller.abort()
  for (const controller of activeComputerUseRequests.values()) controller.abort()
  for (const controller of activeDocumentRequests.values()) controller.abort()
  // 统一收尸：分析/下载/实时字幕/镜像/转写，退出不留孤儿进程
  for (const controller of activeAnalysisRequests.values()) controller.abort()
  for (const controller of activeMediaDownloads.values()) controller.abort()
  for (const controller of activeMediaTasks.values()) controller.abort()
  for (const controller of activeCreativeTasks.values()) controller.abort()
  try { liveSubtitleSession?.stop?.() } catch { /* 忽略 */ }
  try { mirrorReceiver?.stop() } catch { /* 忽略 */ }
  if (mirrorCaptureTimer) clearInterval(mirrorCaptureTimer)
  try { mirrorSender?.close() } catch { /* 忽略 */ }
  try { mirrorWindow && !mirrorWindow.isDestroyed() && mirrorWindow.destroy() } catch { /* 忽略 */ }
  try { transcriptionService.stopAll() } catch { /* 忽略 */ }
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
