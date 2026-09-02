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
const sourceMedia = mediaArg ? path.resolve(mediaArg) : path.resolve(root, '..', '..', '测试视频-可见画面.mp4')
const port = 19441
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-media-error-recovery-'))
const mediaPath = path.join(tempRoot, 'growing-video.mp4')
const userDataDir = path.join(tempRoot, 'profile')

for (const required of [executable, sourceMedia]) {
  if (!fs.existsSync(required)) throw new Error(`缺少媒体错误恢复验收文件：${required}`)
}
fs.copyFileSync(sourceMedia, mediaPath)

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
  throw new Error('AgentPlay 没有开放媒体错误恢复验收页面')
}

function command(method, params = {}) {
  const id = ++nextId
  websocket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression, awaitPromise = false) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || '媒体错误恢复表达式失败')
  return response.result?.value
}

async function waitForRecovery(expected, timeoutMs = 7000) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await evaluate(`(() => {
      const card = document.querySelector('[data-playback-recovery]')
      return {
        state: card?.getAttribute('data-playback-recovery') || '',
        text: card?.textContent || '',
        oldAutomaticFallback: (document.body?.innerText || '').includes('当前编码已切换到独立 mpv 兼容窗口')
      }
    })()`)
    if (last.state === expected) return last
    await delay(100)
  }
  throw new Error(`没有进入 ${expected} 恢复状态：${JSON.stringify(last)}`)
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

  for (let attempt = 0; attempt < 240; attempt++) {
    const ready = await evaluate(`(() => {
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return Boolean(video && video.duration > 0 && video.readyState >= 1)
    })()`)
    if (ready) break
    await delay(250)
  }
  await delay(500)

  await evaluate(`document.querySelector('video[data-ai-player-video="true"]')?.dispatchEvent(new Event('error')); true`)
  const stableError = await waitForRecovery('error')
  assert.match(stableError.text, /文件可能未完成或码流损坏/)
  assert.equal(stableError.oldAutomaticFallback, false)

  await evaluate(`document.querySelector('button[aria-label="关闭播放提示"]')?.click(); true`)
  const now = new Date(Date.now() + 5000)
  fs.utimesSync(mediaPath, now, now)
  await evaluate(`document.querySelector('video[data-ai-player-video="true"]')?.dispatchEvent(new Event('error')); true`)
  const growingError = await waitForRecovery('waiting')
  assert.match(growingError.text, /视频文件仍在生成，完成后会自动重试/)
  assert.equal(growingError.oldAutomaticFallback, false)
  await evaluate(`document.querySelector('button[aria-label="停止等待文件"]')?.click(); true`)

  process.stdout.write(`${JSON.stringify({ version: await evaluate('window.aiPlayer?.version'), stableError, growingError })}\n`)
} finally {
  try { websocket?.close() } catch {}
  if (child.exitCode === null) {
    child.kill()
    await waitForChildExit(5000)
  }
  try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
}
