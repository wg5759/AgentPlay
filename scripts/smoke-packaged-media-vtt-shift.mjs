import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const valueArg = (name) => process.argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || ''
const executable = path.resolve(valueArg('--exe') || path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe'))
const sourceVideo = path.resolve(valueArg('--source') || 'C:/Users/Administrator/Videos/拼接验收/a-主视频.mp4')
const subtitleFile = path.resolve(valueArg('--vtt') || 'C:/Users/Administrator/Videos/拼接验收/调时验收.vtt')
if (!fs.existsSync(executable)) throw new Error(`缺少待验收 EXE：${executable}`)
if (!fs.existsSync(sourceVideo) || !fs.existsSync(subtitleFile)) throw new Error('缺少 VTT 验收夹具（视频/字幕）')

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-vtt-'))
const evidenceDir = path.join(root, 'artifacts', 'acceptance', 'media-vtt-shift-packaged')
const directInstruction = `把字幕 ${subtitleFile} 延后 2 秒`

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  if (!port) throw new Error('无法分配调试端口')
  return port
}

function quickFingerprint(filePath) {
  const stat = fs.statSync(filePath)
  const size = Math.min(128 * 1024, stat.size)
  const fd = fs.openSync(filePath, 'r')
  const first = Buffer.alloc(size)
  const last = Buffer.alloc(size)
  try {
    fs.readSync(fd, first, 0, size, 0)
    fs.readSync(fd, last, 0, size, Math.max(0, stat.size - size))
  } finally { fs.closeSync(fd) }
  return { bytes: stat.size, sha256: crypto.createHash('sha256').update(first).update(last).update(String(stat.size)).digest('hex') }
}

function parseVttTimes(text) {
  return [...String(text || '').matchAll(/(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/g)]
    .map((m) => ({ start: m[1], end: m[2] }))
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false) }, timeoutMs)
    const onExit = () => { clearTimeout(timer); resolve(true) }
    child.once('exit', onExit)
  })
}

async function openSession() {
  const port = await freePort()
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    sourceVideo
  ], { cwd: path.dirname(executable), windowsHide: true, shell: false })
  let page
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`候选应用提前退出：${child.exitCode}`)
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      page = pages.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) break
    } catch {}
    await delay(250)
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('候选应用未开放调试页面')
  const websocket = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let nextId = 0
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
  const command = (method, params = {}) => {
    const id = ++nextId
    websocket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }
  const evaluate = async (expression, awaitPromise = false) => {
    const response = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || '页面执行失败')
    return response.result?.value
  }
  await command('Runtime.enable')
  await command('Page.enable')
  return { child, websocket, command, evaluate }
}

async function closeSession(session) {
  try { await Promise.race([session.command('Browser.close'), delay(1500)]) } catch {}
  await waitForExit(session.child, 8000)
  if (session.child.exitCode === null) { session.child.kill(); await waitForExit(session.child, 5000) }
  try { session.websocket.close() } catch {}
}

function cleanup() {
  const resolved = path.resolve(profileDir)
  const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`
  if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('agentplay-packaged-vtt-')) throw new Error(`拒绝清理非验收目录：${resolved}`)
  fs.rmSync(resolved, { recursive: true, force: true })
}

let session
try {
  fs.mkdirSync(evidenceDir, { recursive: true })
  const videoBefore = quickFingerprint(sourceVideo)
  const vttBefore = quickFingerprint(subtitleFile)
  const sourceCues = parseVttTimes(fs.readFileSync(subtitleFile, 'utf8'))
  if (!sourceCues.length) throw new Error('VTT 验收夹具没有有效条目')
  session = await openSession()
  const pageResult = await session.evaluate(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const waitFor = async (probe, label, timeoutMs = 120000) => {
      const started = Date.now()
      while (Date.now() - started < timeoutMs) {
        const value = await probe()
        if (value) return value
        await wait(100)
      }
      throw new Error('等待超时：' + label)
    }
    await waitFor(() => document.readyState === 'complete' && window.aiPlayer?.mediaTools?.trim, '桌面桥接就绪', 60000)
    const initial = await waitFor(() => {
      const input = document.querySelector('.agent-composer input[type="text"], input[placeholder*="完成什么"], input[placeholder*="下一步"], input[placeholder*="素材"]')
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return input && video && video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0 ? { duration: video.duration, src: video.currentSrc } : null
    }, '本地视频与对话框就绪', 60000)
    const directPlan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(directInstruction)}, sourcePath: ${JSON.stringify(sourceVideo)} })
    if (!directPlan.matched || directPlan.decision?.kind !== 'media.shift-subtitles' || directPlan.decision.output?.container !== 'vtt') throw new Error('安装态 VTT 调时计划不合格：' + JSON.stringify(directPlan).slice(0, 300))
    const sendText = async (text) => {
      const input = document.querySelector('.agent-composer input[type="text"], input[placeholder*="完成什么"], input[placeholder*="下一步"], input[placeholder*="素材"]')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, text)
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
      await wait(120)
      const send = document.querySelector('button[aria-label="发送"]')
      if (!send) throw new Error('没有找到发送按钮')
      send.click()
    }
    await sendText(${JSON.stringify(directInstruction)})
    const task = await waitFor(async () => {
      const tasks = await window.aiPlayer.taskRuntime.list()
      const candidate = [...tasks].reverse().find((item) => item.type === 'media.shift-subtitles')
      return candidate && ['completed', 'failed', 'cancelled'].includes(candidate.state) ? candidate : null
    }, 'VTT 调时任务完成')
    if (task.state !== 'completed') throw new Error(task.error || task.status || 'VTT 调时任务未完成')
    if (task.result?.projectCapsule?.versionCount !== 2 || task.result?.projectCapsule?.canUndo !== true) throw new Error('VTT 调时没有生成可撤销项目胶囊')
    await waitFor(() => document.body.innerText.includes('原字幕文件与视频均未改动'), '调时回执出现在对话里', 10000)
    const stillSameVideo = await (async () => {
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return video && video.currentSrc === initial.src
    })()
    if (!stillSameVideo) throw new Error('.vtt 成果被错误地送进了播放器')
    return { task: { state: task.state, quality: task.quality, result: { outputPath: task.result?.outputPath, cueCount: task.result?.cueCount, sourceCueCount: task.result?.sourceCueCount } } }
  })()`, true)
  const screenshot = await session.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const screenshotPath = path.join(evidenceDir, 'conversation-result.png')
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  const outputPath = pageResult.task?.result?.outputPath
  if (!outputPath || !fs.existsSync(outputPath)) throw new Error('安装态 VTT 调时没有真实成果文件')
  if (!outputPath.toLowerCase().endsWith('.vtt')) throw new Error(`成果扩展名应保持 .vtt：${outputPath}`)
  const outputText = fs.readFileSync(outputPath, 'utf8')
  if (!outputText.startsWith('WEBVTT')) throw new Error('成果缺少 WEBVTT 头')
  const outputCues = parseVttTimes(outputText)
  const toMs = (value) => { const m = value.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})/); return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4] }
  if (outputCues.length !== sourceCues.length) throw new Error(`VTT 成果条目数不对：${outputCues.length}/${sourceCues.length}`)
  outputCues.forEach((cue, index) => {
    if (toMs(cue.start) !== toMs(sourceCues[index].start) + 2000 || toMs(cue.end) !== toMs(sourceCues[index].end) + 2000) {
      throw new Error(`第 ${index + 1} 条位移不符：${cue.start} vs 源 ${sourceCues[index].start}`)
    }
  })
  const videoAfter = quickFingerprint(sourceVideo)
  const vttAfter = quickFingerprint(subtitleFile)
  if (videoBefore.bytes !== videoAfter.bytes || videoBefore.sha256 !== videoAfter.sha256) throw new Error('安装态调时改动了源视频')
  if (vttBefore.bytes !== vttAfter.bytes || vttBefore.sha256 !== vttAfter.sha256) throw new Error('安装态调时改动了源字幕文件')
  if (pageResult.task.quality?.passed !== true) throw new Error(`安装态 VTT 调时质量门未通过：${JSON.stringify(pageResult.task.quality?.reasons || []).slice(0, 400)}`)
  const persistedOutputPath = path.join(evidenceDir, 'packaged-vtt-shift-later-2s.vtt')
  fs.copyFileSync(outputPath, persistedOutputPath)
  const receipt = { passed: true, checkedAt: new Date().toISOString(), executable, sourceVideo, subtitleFile, sourceCues, outputCues, persistedOutputPath, screenshotPath, pageResult }
  const receiptPath = path.join(evidenceDir, 'receipt.json')
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ passed: true, receiptPath, screenshotPath, outputCues, qualityScore: pageResult.task.quality?.score, persistedOutputPath }, null, 2)}\n`)
} finally {
  if (session) await closeSession(session)
  cleanup()
}
