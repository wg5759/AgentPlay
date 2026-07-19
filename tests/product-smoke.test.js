const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { AgentEngine } = require('../electron/llm-service')
const { CastService } = require('../electron/cast-service')
const { DlnaServer } = require('../electron/dlna-server')
const { analyzeDir, findDuplicates } = require('../electron/media-service')
const { SyncService } = require('../electron/sync-service')
const { WifiTransfer } = require('../electron/wifi-transfer')
const { selectLanIp } = require('../electron/utils')
const { MpvService, normalizeMediaSource } = require('../electron/mpv-service')
const { PROVIDERS, normalizeConfig } = require('../electron/model-providers')
const { ModelConfigStore } = require('../electron/model-config-store')
const { extractExternalMediaPaths } = require('../electron/external-media-open')
const { buildMpvEdl, buildOfflineAnalysis, parseSubtitleCues } = require('../electron/analysis-studio-service')

test('playing media auto-hides chrome after idle while paused or blocked UI stays visible', async () => {
  const policyPath = path.join(__dirname, '..', 'src', 'player-ui-policy.mjs')
  assert.equal(fs.existsSync(policyPath), true, 'missing player UI visibility policy')
  const { PLAYER_CHROME_HIDE_DELAY_MS, shouldAutoHideControls } = await import(`file:///${policyPath.replace(/\\/g, '/')}`)
  assert.equal(PLAYER_CHROME_HIDE_DELAY_MS, 3000)
  assert.equal(shouldAutoHideControls({ hasMedia: true, playing: true }), true)
  assert.equal(shouldAutoHideControls({ hasMedia: true, playing: false }), false)
  assert.equal(shouldAutoHideControls({ hasMedia: false, playing: true }), false)
  assert.equal(shouldAutoHideControls({ hasMedia: true, playing: true, blocked: true }), false)
  const playerView = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PlayerView.tsx'), 'utf8')
  const controls = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PlayerControls.tsx'), 'utf8')
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  assert.match(playerView, /setPlaybackChromeVisible\(controlsVisible \|\| !isMedia\)/)
  assert.match(playerView, /onClick={searchOnlineSubtitle}[\s\S]{0,500}controlsVisible \? 'opacity-100'/)
  assert.match(controls, /data-player-chrome="true"/)
  assert.match(main, /window:setPlaybackChromeVisible[\s\S]{0,220}setMenuBarVisibility/)
  assert.match(main, /window:isPlaybackChromeVisible[\s\S]{0,180}isMenuBarVisible/)
})

test('player right-click is a real context menu, not an open-file shortcut', () => {
  const playerView = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PlayerView.tsx'), 'utf8')
  assert.match(playerView, /contextMenu\?\.show/)
  assert.doesNotMatch(playerView, /onContextMenu={[\s\S]{0,240}dialog\?\.openFile/)
})

test('Explorer Open with forwards initial and second-instance media paths to the renderer', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8')
  assert.match(main, /second-instance['"],\s*\([^)]*argv[^)]*\)\s*=>[\s\S]{0,500}queueExternalMediaArgs\(argv\)/)
  assert.match(main, /queueExternalMediaArgs\(process\.argv\)/)
  assert.match(main, /did-finish-load['"][\s\S]{0,300}flushPendingExternalMedia\(\)/)
  assert.match(preload, /external-media:accepted/)
  assert.match(app, /confirmOpenFile\?\.\(filePath\)/)
  assert.match(main, /播放界面已接收外部文件/)
})

test('both Windows installers repair the per-user Open with command without taking over defaults', () => {
  const packageConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  const leanConfig = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.lean.yml'), 'utf8')
  const installer = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8')
  assert.equal(packageConfig.build.nsis.include, 'build/installer.nsh')
  assert.match(leanConfig, /include:\s*build\/installer\.nsh/)
  assert.match(installer, /Applications\\\$\{APP_EXECUTABLE_FILENAME\}\\shell\\open\\command/)
  assert.match(installer, /\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}/)
  assert.match(installer, /SupportedTypes[\s\S]*\.mp4/)
  assert.doesNotMatch(installer, /Software\\Classes\\\.mp4/)
})

test('AgentPlay branding preserves the 0.6.x internal app identity and existing user data', () => {
  const packageConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')
  assert.equal(packageConfig.name, 'ai-player')
  assert.equal(packageConfig.build.appId, 'com.aiplayer.app')
  assert.equal(packageConfig.build.productName, 'AI播放器')
  assert.match(readme, /AgentPlay/)
  assert.doesNotMatch(readme, /AgentHub/)
})

test('service worker registration is web-only and cannot fail in packaged Electron', () => {
  const vite = fs.readFileSync(path.join(__dirname, '..', 'vite.config.ts'), 'utf8')
  const entry = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.tsx'), 'utf8')
  const buildWeb = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-web.mjs'), 'utf8')
  assert.match(vite, /injectRegister:\s*null/)
  assert.match(entry, /location\.protocol === 'http:'[\s\S]*location\.protocol === 'https:'/)
  assert.match(entry, /navigator\.serviceWorker\.register/)
  assert.doesNotMatch(entry, /virtual:pwa-register/)
  assert.match(buildWeb, /'sw\.js'/)
  assert.doesNotMatch(buildWeb, /'registerSW\.js'/)
})

test('Explorer Open with accepts supported files with spaces and Chinese characters only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-open-with-'))
  const video = path.join(dir, '竖屏 成片.MP4')
  const unsupported = path.join(dir, '不要执行.exe')
  fs.writeFileSync(video, 'fixture')
  fs.writeFileSync(unsupported, 'fixture')
  try {
    assert.deepEqual(extractExternalMediaPaths([
      'AI播放器.exe', '--flag', `"${video}"`, unsupported, video
    ]), [path.resolve(video)])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('packaged UI smoke requires decoded video metadata, not merely a video element', () => {
  const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke-packaged-ui.mjs'), 'utf8')
  assert.match(smoke, /readyState\s*>=\s*1/)
  assert.match(smoke, /videoWidth\s*>\s*0/)
  assert.match(smoke, /videoHeight\s*>\s*0/)
  assert.match(smoke, /video\.error/)
  assert.match(smoke, /idleChromeHidden/)
  assert.match(smoke, /activityChromeVisible/)
  assert.match(smoke, /pausedChromeVisible/)
})

test('player flex layout cannot push the control buttons below the viewport', () => {
  const playerView = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PlayerView.tsx'), 'utf8')
  const controls = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PlayerControls.tsx'), 'utf8')
  assert.match(playerView, /className=\{`[^`]*min-h-0[^`]*overflow-hidden/)
  assert.match(controls, /className={`[^`]*z-30/)
})

test('every newly opened video starts in a complete non-cropping layout', () => {
  const playerView = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PlayerView.tsx'), 'utf8')
  const store = fs.readFileSync(path.join(__dirname, '..', 'src', 'stores', 'playerStore.ts'), 'utf8')
  assert.match(store, /setMedia:[\s\S]*?pictureMode:\s*'fit'/)
  assert.match(playerView, /:\s*'w-full h-full object-contain'/)
})

test('mpv compatibility playback uses the same complete-fit aspect policy', () => {
  const service = new MpvService()
  const sent = []
  service.send = (command) => { sent.push(command); return true }
  assert.equal(service.setPictureMode('fit'), true)
  assert.deepEqual(sent.map((entry) => entry.command), [
    ['set_property', 'keepaspect', true],
    ['set_property', 'video-unscaled', 'no'],
    ['set_property', 'panscan', 0]
  ])
})

test('native menus own the former oversized toolbar actions', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const library = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'MediaLibrary.tsx'), 'utf8')
  for (const action of ['network-source', 'record', 'dedup', 'organize', 'plugins', 'poster', 'devices', 'model-center']) {
    assert.match(main, new RegExp(`sendAction\\(['"]${action}['"]\\)`), `${action} is missing from the native menu`)
  }
  assert.doesNotMatch(library, />\s*\+ 网络源\s*</)
  assert.doesNotMatch(library, />\s*去重\s*</)
  assert.doesNotMatch(library, />\s*海报\s*</)
})

test('analysis studio provides breakdown, evidence-bound deep analysis and original recut rendering', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8')
  const studio = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'AnalysisStudio.tsx'), 'utf8')
  const packageConfig = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  assert.match(main, /sendAction\(['"]analysis-studio['"]\)/)
  assert.match(main, /studio:render/)
  assert.match(packageConfig, /mpv\.com/)
  assert.match(app, /<AnalysisStudio/)
  for (const capability of ['标记当前镜头', 'AI 深度解剖', '一键渲染 MP4', '导出项目']) {
    assert.match(studio, new RegExp(capability))
  }
})

test('analysis studio parses subtitle evidence and builds UTF-8-safe mpv recut EDL', () => {
  const cues = parseSubtitleCues('1\n00:00:01,200 --> 00:00:03,400\n第一句\n\n2\n00:00:04.000 --> 00:00:05.000\n第二句', '.srt')
  assert.deepEqual(cues, [
    { start: 1.2, end: 3.4, text: '第一句' },
    { start: 4, end: 5, text: '第二句' }
  ])
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-edl-'))
  const source = path.join(dir, '中文 素材.mp4')
  fs.writeFileSync(source, 'fixture')
  try {
    const normalized = path.resolve(source).replace(/\\/g, '/')
    const edl = buildMpvEdl(source, [{ start: 1.2, end: 3.4 }, { start: 7, end: 8 }])
    assert.match(edl, new RegExp(`%${Buffer.byteLength(normalized, 'utf8')}%`))
    assert.match(edl, /,1\.200,2\.200/)
    assert.match(edl, /,7\.000,1\.000/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  const report = buildOfflineAnalysis({ mediaName: '片子.mp4', duration: 60, markers: [], cues })
  assert.match(report, /人工拉片点：0；字幕线索：2/)
  assert.match(report, /不对未观察画面编造结论/)
})

test('model center covers mainstream, local and custom providers without hard-wiring one vendor', () => {
  const ids = new Set(PROVIDERS.map((provider) => provider.id))
  for (const id of ['openai', 'anthropic', 'google', 'xai', 'deepseek', 'mistral', 'openrouter', 'qwen', 'moonshot', 'zhipu', 'volcengine', 'baidu', 'ollama', 'lmstudio', 'custom']) {
    assert.equal(ids.has(id), true, `missing provider ${id}`)
  }
  assert.equal(normalizeConfig({ providerId: 'custom', baseUrl: 'http://localhost:9000/v1/', model: 'mine' }).baseUrl, 'http://localhost:9000/v1')
})

test('model API keys are encrypted at rest and never returned to the renderer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-model-config-'))
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().replace(/^encrypted:/, '')
  }
  try {
    const store = new ModelConfigStore(dir, safeStorage)
    const publicConfig = store.save({ providerId: 'openai', model: 'gpt-5.2', baseUrl: 'https://api.openai.com/v1', apiKey: 'top-secret-key' })
    assert.equal(publicConfig.hasApiKey, true)
    assert.equal(Object.hasOwn(publicConfig, 'apiKey'), false)
    assert.equal(fs.readFileSync(path.join(dir, 'model-config.json'), 'utf8').includes('top-secret-key'), false)
    assert.equal(store.resolved().apiKey, 'top-secret-key')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('every main-process event sent to the renderer has a preload listener', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
  const sent = [...main.matchAll(/webContents\.send\(['"]([^'"]+)['"]/g)].map((m) => m[1])
  const listened = new Set(
    [...preload.matchAll(/ipcRenderer\.on\(['"]([^'"]+)['"]/g)].map((m) => m[1])
  )
  const missing = [...new Set(sent)].filter((channel) => !listened.has(channel))
  assert.deepEqual(missing, [], `renderer events without a listener: ${missing.join(', ')}`)
})

test('sandboxed preload has no filesystem imports and reads the packaged app version', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  assert.doesNotMatch(preload, /require\(['"]\.\.?\//)
  assert.match(preload, /version:\s*ipcRenderer\.sendSync\('app:version'\)/)
  assert.match(main, /ipcMain\.on\('app:version',[\s\S]*?app\.getVersion\(\)/)
})

test('LAN URL prefers a physical Wi-Fi adapter over VPN and WSL adapters', () => {
  const adapter = (address, mac = '00:00:00:00:00:00') => ({ family: 'IPv4', internal: false, address, mac })
  assert.equal(selectLanIp({
    tun0: [adapter('172.19.0.1')],
    NordLynx: [adapter('10.5.0.2')],
    WLAN: [adapter('192.168.3.17', '00:f4:8d:fd:fe:e1')],
    'vEthernet (WSL)': [adapter('192.168.80.1', '00:15:5d:f3:ef:b3')]
  }), '192.168.3.17')
})

test('Windows SMB sources are converted to UNC paths that mpv can open', () => {
  assert.equal(normalizeMediaSource('smb://nas/movies/Test%20Movie.mkv'), '\\\\nas\\movies\\Test Movie.mkv')
  assert.equal(normalizeMediaSource('https://example.com/movie.mp4'), 'https://example.com/movie.mp4')
})

test('black-screen-prone mpv embedding is opt-in instead of the Windows default', () => {
  const { shouldEmbedMpv } = require('../electron/playback-policy')
  assert.equal(shouldEmbedMpv('win32', {}), false)
  assert.equal(shouldEmbedMpv('win32', { MPV_EMBED: '0' }), false)
  assert.equal(shouldEmbedMpv('win32', { MPV_EMBED: '1' }), true)
  assert.equal(shouldEmbedMpv('linux', { MPV_EMBED: '1' }), false)
})

test('video summary tool never crashes', async () => {
  const engine = new AgentEngine(null)
  await assert.doesNotReject(() => engine.executeTool('summarize_video', {}))
})

test('video summary uses a same-name local subtitle instead of a placeholder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-summary-'))
  const mediaPath = path.join(dir, 'episode.mp4')
  fs.writeFileSync(mediaPath, 'media')
  fs.writeFileSync(path.join(dir, 'episode.srt'), '1\n00:00:00,000 --> 00:00:03,000\n第一章开始\n')
  try {
    const engine = new AgentEngine(null)
    const result = engine.prepareSummary({ path: mediaPath })
    assert.equal(result.success, true)
    assert.match(result.transcript, /第一章开始/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('basic Agent playback commands work without a cloud key', async () => {
  const engine = new AgentEngine(null)
  const result = await engine.chat([{ role: 'user', content: '把音量调到 35' }])
  assert.equal(result.toolResults[0].result.action, 'set_volume')
  assert.equal(result.toolResults[0].result.value, 35)
  assert.equal(engine.resolveProvider('sk-test').model, 'deepseek-chat')
})

test('player controls use the deterministic local fast path without starting a model', async () => {
  const engine = new AgentEngine(null)
  const context = { currentTime: 90, duration: 600, volume: 40, lastAudibleVolume: 65, playbackRate: 1 }
  const cases = [
    ['往后快进两分钟', 'seek', 210],
    ['声音调小一点', 'set_volume', 30],
    ['调成1.5倍速', 'set_speed', 1.5],
    ['播放速度快一点', 'set_speed', 1.25],
    ['竖屏视频完整显示，不要裁剪', 'set_picture_mode', 'fit'],
    ['把人物完整地看全，不要截掉', 'set_picture_mode', 'fit'],
    ['切到二分之一窗口', 'set_window_preset', 'half'],
    ['截取当前画面', 'screenshot', undefined],
    ['静音', 'set_volume', 0],
    ['取消静音', 'set_volume', 65]
  ]
  for (const [text, action, value] of cases) {
    const result = await engine.chat([{ role: 'user', content: text }], null, context)
    assert.equal(result.toolResults.length, 1, text)
    assert.equal(result.toolResults[0].result.action, action, text)
    if (value !== undefined) assert.equal(result.toolResults[0].result.value, value, text)
  }
})

test('exact duplicate content is found even when filenames differ', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-dedup-'))
  try {
    fs.writeFileSync(path.join(dir, 'first.mp4'), 'same-media-content')
    fs.writeFileSync(path.join(dir, 'renamed.mp4'), 'same-media-content')
    const duplicates = findDuplicates(analyzeDir(dir))
    assert.equal(duplicates.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('paired sync URLs can download progress end-to-end', async () => {
  const basePort = 42000 + (process.pid % 1000) * 2
  const source = new SyncService()
  const target = new SyncService()
  source.port = basePort
  target.port = basePort + 1
  source.getLanIp = target.getLanIp = () => '127.0.0.1'

  try {
    await Promise.all([source.start(), target.start()])
    target.setProgress('movie-key', 123, { volume: 50 })
    source.setPeer(target.getUrl())
    const result = await source.download()
    assert.equal(result.success, true, result.error)
    assert.equal(source.getProgress('movie-key').position, 123)
  } finally {
    source.stop()
    target.stop()
  }
})

test('cast file server authorizes a selected file and supports byte ranges', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-cast-'))
  const filePath = path.join(dir, 'sample.mp4')
  fs.writeFileSync(filePath, '0123456789')
  const cast = new CastService()
  cast.fileServerPort = 44000 + (process.pid % 1000)
  cast.getLanIp = () => '127.0.0.1'
  try {
    await cast.startFileServer()
    const url = cast.registerFile(filePath)
    const response = await fetch(url, { headers: { Range: 'bytes=2-5' } })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/10')
    assert.equal(await response.text(), '2345')
  } finally {
    cast.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('WiFi upload page keeps the PIN on the desktop and rejects unauthorized files', async () => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-wifi-'))
  const wifi = new WifiTransfer()
  wifi.port = 45000 + (process.pid % 1000)
  wifi.uploadDir = uploadDir
  wifi.getLanIp = () => '127.0.0.1'
  try {
    await wifi.start()
    const page = await (await fetch(wifi.getUrl())).text()
    assert.equal(page.includes(wifi.getPin()), false)
    const form = new FormData()
    form.append('pin', '000000')
    form.append('file', new Blob(['blocked']), 'blocked.txt')
    const response = await fetch(wifi.getUrl(), { method: 'POST', body: form })
    assert.equal(response.status, 403)
    assert.deepEqual(fs.readdirSync(uploadDir), [])
  } finally {
    wifi.stop()
    fs.rmSync(uploadDir, { recursive: true, force: true })
  }
})

test('DLNA ContentDirectory Browse exposes playable media with byte-range URLs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-dlna-'))
  fs.writeFileSync(path.join(dir, 'movie.mp4'), 'abcdefghij')
  const dlna = new DlnaServer()
  dlna.port = 46000 + (process.pid % 1000)
  dlna.startSsdp = () => {}
  try {
    await dlna.start(dir)
    const response = await fetch(`http://127.0.0.1:${dlna.port}/cd/control`, {
      method: 'POST',
      headers: { SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"' },
      body: '<Browse />'
    })
    const xml = await response.text()
    assert.equal(response.status, 200)
    assert.match(xml, /movie\.mp4/)
    const list = await (await fetch(`http://127.0.0.1:${dlna.port}/list`)).json()
    const media = await fetch(`http://127.0.0.1:${dlna.port}/media/${list[0].id}`, {
      headers: { Range: 'bytes=1-3' }
    })
    assert.equal(media.status, 206)
    assert.equal(await media.text(), 'bcd')
  } finally {
    dlna.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
