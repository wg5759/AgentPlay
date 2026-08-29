import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executableArg = process.argv.slice(2).find((value) => value.startsWith('--exe='))
const mediaArg = process.argv.slice(2).find((value) => !value.startsWith('--'))
const executable = executableArg
  ? path.resolve(executableArg.slice('--exe='.length))
  : path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe')
const mediaPath = mediaArg ? path.resolve(mediaArg) : path.resolve(root, '..', '..', '测试视频-可见画面.mp4')
const port = 19437
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-fullscreen-exit-'))

for (const required of [executable, mediaPath]) {
  if (!fs.existsSync(required)) throw new Error(`缺少全屏退出验收文件：${required}`)
}

const child = spawn(executable, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  mediaPath
], { cwd: path.dirname(executable), windowsHide: true, shell: false })

let websocket
let nextId = 0
const pending = new Map()
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForChildExit(timeoutMs) {
  if (child.exitCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

async function findPage() {
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {}
    await delay(250)
  }
  throw new Error('AgentPlay 没有在 60 秒内开放全屏退出验收页面')
}

function command(method, params = {}) {
  const id = ++nextId
  websocket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression, awaitPromise = false) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || '页面表达式执行失败')
  return response.result?.value
}

async function snapshot() {
  return evaluate(`(async () => ({
    fullscreen: Boolean(await window.aiPlayer?.windowControls?.isFullscreen?.()),
    theater: Boolean(document.querySelector('.workspace-theater')),
    video: Boolean(document.querySelector('video[data-ai-player-video="true"]')),
    controls: document.querySelectorAll('[data-player-chrome="true"]').length
  }))()`, true)
}

async function waitForState(predicate, label, timeoutMs = 7000) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    try {
      last = await snapshot()
      if (predicate(last)) return last
    } catch (error) {
      last = { startupError: error instanceof Error ? error.message : String(error) }
    }
    await delay(100)
  }
  throw new Error(`${label}：${JSON.stringify(last)}`)
}

async function playerCenter() {
  return evaluate(`(() => {
    const video = document.querySelector('video[data-ai-player-video="true"]')
    const root = video?.parentElement
    if (!root) return null
    const rect = root.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })()`)
}

async function nativeDoubleClick(point) {
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 2 })
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 2 })
}

async function nativeEscape() {
  const params = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
  await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
  await command('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}

try {
  const page = await findPage()
  websocket = new WebSocket(page.webSocketDebuggerUrl)
  websocket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  await new Promise((resolve, reject) => {
    websocket.addEventListener('open', resolve, { once: true })
    websocket.addEventListener('error', reject, { once: true })
  })
  await command('Runtime.enable')
  await command('Page.enable')
  await command('Page.bringToFront')
  await command('Emulation.setFocusEmulationEnabled', { enabled: true })

  for (let attempt = 0; attempt < 240; attempt++) {
    const ready = await evaluate(`(() => {
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return Boolean(video && video.readyState >= 1 && video.videoWidth > 0 && video.videoHeight > 0 && !video.error)
    })()`)
    if (ready) break
    await delay(250)
  }

  const point = await playerCenter()
  if (!point) throw new Error('找不到播放器双击区域')

  const initial = await waitForState((state) => !state.fullscreen && !state.theater && state.video, '初始窗口状态不正确')
  await nativeDoubleClick(point)
  const enteredForEscape = await waitForState((state) => state.fullscreen && state.theater, '双击没有进入全屏')
  await nativeEscape()
  const exitedByEscape = await waitForState((state) => !state.fullscreen && !state.theater, 'ESC 没有退出全屏')

  const secondPoint = await playerCenter()
  await nativeDoubleClick(secondPoint)
  const enteredForDoubleClick = await waitForState((state) => state.fullscreen && state.theater, '第二次双击没有进入全屏')
  const fullscreenPoint = await playerCenter()
  await nativeDoubleClick(fullscreenPoint)
  const exitedByDoubleClick = await waitForState((state) => !state.fullscreen && !state.theater, '双击没有退出全屏')

  await evaluate('window.aiPlayer.windowControls.setFullscreen(true)', true)
  const enteredWithDivergedState = await waitForState((state) => state.fullscreen && !state.theater, '无法建立原生全屏与界面状态分歧')
  const divergedPoint = await playerCenter()
  await nativeDoubleClick(divergedPoint)
  const recoveredFromDivergedState = await waitForState((state) => !state.fullscreen && !state.theater, '双击无法从分歧状态恢复')

  process.stdout.write(`${JSON.stringify({
    version: await evaluate('window.aiPlayer?.version'),
    initial,
    enteredForEscape,
    exitedByEscape,
    enteredForDoubleClick,
    exitedByDoubleClick,
    enteredWithDivergedState,
    recoveredFromDivergedState
  })}\n`)
} finally {
  try { websocket?.close() } catch {}
  if (child.exitCode === null) {
    child.kill()
    await waitForChildExit(5000)
  }
  try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
}
