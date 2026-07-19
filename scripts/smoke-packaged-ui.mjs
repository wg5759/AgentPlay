import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const executableArg = process.argv.slice(2).find((value) => value.startsWith('--exe='))
const mediaArg = process.argv.slice(2).find((value) => !value.startsWith('--'))
const executable = executableArg ? path.resolve(executableArg.slice('--exe='.length)) : path.join(root, 'release', 'win-unpacked', 'AI播放器.exe')
const mediaPath = mediaArg || path.resolve(root, '..', '..', '测试视频-可见画面.mp4')
const port = 19333
for (const required of [executable, mediaPath]) if (!fs.existsSync(required)) throw new Error(`缺少桌面验收文件：${required}`)

const child = spawn(executable, [`--remote-debugging-port=${port}`, mediaPath], { cwd: path.dirname(executable), windowsHide: true, shell: false })
let websocket
let nextId = 0
const pending = new Map()

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

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
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {}
    await delay(250)
  }
  throw new Error('正式 EXE 没有在 20 秒内开放验收页面')
}

function command(method, params = {}) {
  const id = ++nextId
  websocket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression, awaitPromise = false) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || '页面表达式执行失败')
  return response.result?.value
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
  await command('Page.bringToFront')
  await command('Emulation.setFocusEmulationEnabled', { enabled: true })
  for (let attempt = 0; attempt < 80; attempt++) {
    const ready = await evaluate(`(() => {
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return Boolean(video && video.readyState >= 1 && video.videoWidth > 0 && video.videoHeight > 0 && !video.error)
    })()`)
    if (ready) break
    await delay(250)
  }
  const version = await evaluate('window.aiPlayer?.version')
  const playback = await evaluate(`(() => {
    const video = document.querySelector('video[data-ai-player-video="true"]')
    return video ? {
      present: true,
      readyState: video.readyState,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      currentSrc: video.currentSrc,
      error: video.error?.message || null
    } : { present: false }
  })()`)
  await evaluate(`(async () => {
    const video = document.querySelector('video[data-ai-player-video="true"]')
    video.currentTime = 0
    const toggle = document.querySelector('button[title^="播放"], button[title^="暂停"]')
    if (toggle?.title.startsWith('播放')) {
      window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'play-toggle' }))
      await new Promise((resolve) => requestAnimationFrame(() => resolve()))
    }
    await video.play()
    return true
  })()`, true)
  await delay(3500)
  const idleChromeHidden = await evaluate(`(() => {
    const chrome = [...document.querySelectorAll('[data-player-chrome="true"]')]
    return chrome.length >= 3 && chrome.every((element) => {
      const style = getComputedStyle(element)
      return style.opacity === '0' && style.pointerEvents === 'none'
    })
  })()`)
  const idleMenuHidden = !(await evaluate('window.aiPlayer.windowControls.isPlaybackChromeVisible()', true))
  await evaluate(`(() => {
    const root = document.querySelector('video[data-ai-player-video="true"]')?.parentElement
    root?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 400, clientY: 300 }))
    return true
  })()`)
  await delay(600)
  const activityChromeState = await evaluate(`(() => {
    const chrome = [...document.querySelectorAll('[data-player-chrome="true"]')]
    const elements = chrome.map((element) => ({
      tag: element.tagName,
      text: element.textContent?.trim().slice(0, 24) || '',
      opacity: Number(getComputedStyle(element).opacity),
      pointerEvents: getComputedStyle(element).pointerEvents,
      className: element.className
    }))
    return { elements, visible: chrome.length >= 3 && chrome.every((element) => element.classList.contains('opacity-100') && !element.classList.contains('pointer-events-none')) }
  })()`)
  const activityChromeVisible = activityChromeState.visible
  const activityMenuVisible = await evaluate('window.aiPlayer.windowControls.isPlaybackChromeVisible()', true)
  await evaluate("window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'play-toggle' })); true")
  await delay(3500)
  const pausedChromeState = await evaluate(`(() => {
    const chrome = [...document.querySelectorAll('[data-player-chrome="true"]')]
    const elements = chrome.map((element) => ({
      tag: element.tagName,
      text: element.textContent?.trim().slice(0, 24) || '',
      opacity: Number(getComputedStyle(element).opacity),
      pointerEvents: getComputedStyle(element).pointerEvents,
      className: element.className
    }))
    return { elements, visible: chrome.length >= 3 && chrome.every((element) => element.classList.contains('opacity-100') && !element.classList.contains('pointer-events-none')) }
  })()`)
  const pausedChromeVisible = pausedChromeState.visible
  const pausedMenuVisible = await evaluate('window.aiPlayer.windowControls.isPlaybackChromeVisible()', true)
  await evaluate("window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'analysis-studio' })); true")
  await delay(500)
  const body = await evaluate('document.body.innerText')
  const capabilities = await evaluate('window.aiPlayer.studio.capabilities()', true)
  const result = {
    version,
    videoLoaded: Boolean(playback.present && playback.readyState >= 1 && playback.videoWidth > 0 && playback.videoHeight > 0 && !playback.error),
    playback,
    idleChromeHidden,
    idleMenuHidden,
    activityChromeVisible,
    activityChromeState,
    activityMenuVisible,
    pausedChromeVisible,
    pausedChromeState,
    pausedMenuVisible,
    studioVisible: body.includes('AI 拉片与原创工作台'),
    creativeTabVisible: body.includes('4 AI 成片'),
    advancedRender: capabilities?.advancedRender,
    systemVoice: capabilities?.systemVoice,
    renderBinary: capabilities?.renderBinary
  }
  if (version !== expectedVersion || !Object.values({ videoLoaded: result.videoLoaded, idleChromeHidden, idleMenuHidden, activityChromeVisible, activityMenuVisible, pausedChromeVisible, pausedMenuVisible, studioVisible: result.studioVisible, creativeTabVisible: result.creativeTabVisible, advancedRender: result.advancedRender, systemVoice: result.systemVoice }).every(Boolean)) {
    throw new Error(`正式 EXE 验收失败：${JSON.stringify(result)}`)
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  websocket.send(JSON.stringify({ id: ++nextId, method: 'Browser.close', params: {} }))
  await waitForChildExit(5000)
} finally {
  try { websocket?.close() } catch {}
  if (child.exitCode === null) {
    child.kill()
    await waitForChildExit(5000)
  }
}
