import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executableArg = process.argv.slice(2).find((value) => value.startsWith('--exe='))
const mediaArg = process.argv.slice(2).find((value) => !value.startsWith('--'))
const executable = executableArg ? path.resolve(executableArg.slice('--exe='.length)) : path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe')
const mediaPath = mediaArg ? path.resolve(mediaArg) : path.resolve(root, '..', '..', '测试视频-可见画面.mp4')
const port = 19440
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-midstream-playback-'))

for (const required of [executable, mediaPath]) {
  if (!fs.existsSync(required)) throw new Error(`缺少中段播放验收文件：${required}`)
}

const child = spawn(executable, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  ...(process.argv.includes('--visible') ? ['--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion'] : []),
  mediaPath
], { cwd: path.dirname(executable), windowsHide: !process.argv.includes('--visible'), shell: false })

let websocket
let nextId = 0
const pending = new Map()
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForChildExit(timeoutMs) {
  if (child.exitCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false) }, timeoutMs)
    const onExit = () => { clearTimeout(timer); resolve(true) }
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
  throw new Error('AgentPlay 没有开放中段播放验收页面')
}

function command(method, params = {}) {
  const id = ++nextId
  websocket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression, awaitPromise = false) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || '中段播放表达式失败')
  return response.result?.value
}

async function snapshot() {
  return evaluate(`(() => {
    const video = document.querySelector('video[data-ai-player-video="true"]')
    return {
      present: Boolean(video),
      visibility: document.visibilityState,
      playButton: document.querySelector('.player-video-controls button[title]')?.title,
      currentTime: Number(video?.currentTime || 0),
      duration: Number(video?.duration || 0),
      readyState: Number(video?.readyState || 0),
      paused: Boolean(video?.paused),
      ended: Boolean(video?.ended),
      error: video?.error ? { code: video.error.code, message: video.error.message } : null,
      fallback: (document.body?.innerText || '').includes('当前编码已切换到独立 mpv 兼容窗口'),
      processingFailed: (document.body?.innerText || '').includes('处理失败')
    }
  })()`)
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
  if (process.argv.includes('--trace')) await evaluate(`(() => {
    window.__playTrace = [];
    const pause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function() { window.__playTrace.push({event:'pause-call', time:this.currentTime, stack:new Error().stack}); return pause.call(this); };
    for (const type of ['play','pause','ended','loadedmetadata','error','seeking','seeked']) document.addEventListener(type, e => { if (e.target instanceof HTMLMediaElement) window.__playTrace.push({event:type, time:e.target.currentTime, src:e.target.currentSrc}); }, true);
  })()`)
  await command('Page.bringToFront')

  let initial
  for (let attempt = 0; attempt < 240; attempt++) {
    initial = await snapshot()
    if (initial.present && initial.duration > 0 && initial.readyState >= 1) break
    await delay(250)
  }
  assert.ok(initial?.present && initial.duration > 0, `视频没有加载元数据：${JSON.stringify(initial)}`)

  const seekTarget = Math.min(Math.max(0, initial.duration - 12), 18)
  const seekResult = await evaluate(`(async () => {
    const video = document.querySelector('video[data-ai-player-video="true"]')
    if (!video) throw new Error('video missing')
    try {
      const seeked = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('seek timeout')), 5000)
        video.addEventListener('seeked', () => { clearTimeout(timer); resolve(true) }, { once: true })
      })
      video.currentTime = ${JSON.stringify(seekTarget)}
      await seeked
      await Promise.race([
        video.play(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('play timeout')), 5000))
      ])
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })()`, true)

  const deadline = Date.now() + 12000
  let result
  while (Date.now() < deadline) {
    result = await snapshot()
    if (result.fallback || result.error || result.currentTime >= seekTarget + 6) break
    await delay(200)
  }

  process.stdout.write(`${JSON.stringify({ version: await evaluate('window.aiPlayer?.version'), seekTarget, seekResult, result })}\n`)
  if (process.argv.includes('--trace')) process.stdout.write(JSON.stringify(await evaluate('window.__playTrace')) + '\n')
  if (process.argv.includes('--trace')) {
    const shot = await command('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(root, 'release/inline-playback-trace.png'), Buffer.from(shot.data, 'base64'))
  }
  assert.equal(result?.fallback, false, '播放中途错误地切换到独立 mpv 兼容窗口')
  assert.equal(result?.error, null, `HTML5 播放中途出错：${JSON.stringify(result?.error)}`)
  assert.ok(result?.currentTime >= seekTarget + 6, `中段播放没有持续前进：${JSON.stringify(result)}`)
} finally {
  try { websocket?.close() } catch {}
  if (child.exitCode === null) {
    child.kill()
    await waitForChildExit(5000)
  }
  try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
}
