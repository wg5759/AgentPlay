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
const subtitleFile = path.resolve(valueArg('--srt') || 'C:/Users/Administrator/Videos/拼接验收/校对验收.srt')
if (!fs.existsSync(executable)) throw new Error(`缺少待验收 EXE：${executable}`)
if (!fs.existsSync(sourceVideo) || !fs.existsSync(subtitleFile)) throw new Error('缺少校对验收夹具（视频/字幕）')

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-cueedit-'))
const evidenceDir = path.join(root, 'artifacts', 'acceptance', 'media-cue-edit-packaged')
const replaceInstruction = `把字幕 ${subtitleFile} 第2条改成《今天天气不错》`
const vagueDelete = '删掉第3条字幕'

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

function parseSrtEntries(text) {
  return [...String(text || '').matchAll(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})\r?\n([\s\S]*?)(?=\r?\n\r?\n|\r?\n?$)/g)]
    .map((m) => ({ start: m[1], end: m[2], text: m[3].trim() }))
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
  if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('agentplay-packaged-cueedit-')) throw new Error(`拒绝清理非验收目录：${resolved}`)
  fs.rmSync(resolved, { recursive: true, force: true })
}

let session
try {
  fs.mkdirSync(evidenceDir, { recursive: true })
  const videoBefore = quickFingerprint(sourceVideo)
  const srtBefore = quickFingerprint(subtitleFile)
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
    const replacePlan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(replaceInstruction)}, sourcePath: ${JSON.stringify(sourceVideo)} })
    if (!replacePlan.matched || replacePlan.decision?.kind !== 'media.edit-subtitle-cues' || replacePlan.decision.cueEdit?.operation !== 'replace') throw new Error('安装态字幕校对计划不合格：' + JSON.stringify(replacePlan).slice(0, 300))
    const vaguePlan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(vagueDelete)}, sourcePath: ${JSON.stringify(sourceVideo)} })
    if (vaguePlan.clarification?.reason !== 'missing-subtitle-cueedit-file') throw new Error('安装态缺文件追问不合格：' + JSON.stringify(vaguePlan).slice(0, 300))
    const resolvedPlan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(subtitleFile)}, sourcePath: ${JSON.stringify(sourceVideo)}, clarificationId: vaguePlan.clarification.id })
    if (!resolvedPlan.matched || resolvedPlan.decision?.cueEdit?.operation !== 'delete') throw new Error('安装态追问收口不合格：' + JSON.stringify(resolvedPlan).slice(0, 300))
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
    // 流 1：直接改第 2 条文本
    await sendText(${JSON.stringify(replaceInstruction)})
    const task1 = await waitFor(async () => {
      const tasks = await window.aiPlayer.taskRuntime.list()
      const candidate = [...tasks].reverse().find((item) => item.type === 'media.edit-subtitle-cues')
      return candidate && ['completed', 'failed', 'cancelled'].includes(candidate.state) ? candidate : null
    }, '字幕校对任务完成')
    if (task1.state !== 'completed') throw new Error(task1.error || task1.status || '字幕校对任务未完成')
    if (task1.result?.projectCapsule?.versionCount !== 2) throw new Error('字幕校对没有生成可撤销项目胶囊')
    // 流 2：无文件删除第 3 条 → 追问文件 → 收口执行（同一份源字幕继续产生新版本）
    await sendText(${JSON.stringify(vagueDelete)})
    await waitFor(() => document.body.innerText.includes('要处理哪个字幕文件？'), '缺文件追问出现在对话里', 10000)
    await sendText(${JSON.stringify(subtitleFile)})
    const task2 = await waitFor(async () => {
      const tasks = await window.aiPlayer.taskRuntime.list()
      const candidates = tasks.filter((item) => item.type === 'media.edit-subtitle-cues' && ['completed', 'failed', 'cancelled'].includes(item.state))
      return candidates.length >= 2 ? candidates[candidates.length - 1] : null
    }, '删除条目任务完成')
    if (task2.state !== 'completed') throw new Error(task2.error || task2.status || '删除条目任务未完成')
    const stillSameVideo = await (async () => {
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return video && video.currentSrc === initial.src
    })()
    if (!stillSameVideo) throw new Error('.srt 成果被错误地送进了播放器')
    const bodyText = document.body.innerText
    return {
      task1: { state: task1.state, quality: task1.quality, result: { outputPath: task1.result?.outputPath, cueCount: task1.result?.cueCount, sourceCueCount: task1.result?.sourceCueCount, summary: task1.result?.summary } },
      task2: { state: task2.state, quality: task2.quality, result: { outputPath: task2.result?.outputPath, cueCount: task2.result?.cueCount } },
      uiReceiptVisible: bodyText.includes('字幕校对') && bodyText.includes('原字幕文件与视频均未改动')
    }
  })()`, true)
  const screenshot = await session.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const screenshotPath = path.join(evidenceDir, 'conversation-result.png')
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  const out1 = pageResult.task1?.result?.outputPath
  const out2 = pageResult.task2?.result?.outputPath
  if (!out1 || !fs.existsSync(out1) || !out2 || !fs.existsSync(out2)) throw new Error('安装态校对没有真实成果文件')
  // 流 1：第 2 条文本已改、时间轴不动、其余条目不变
  const cues1 = parseSrtEntries(fs.readFileSync(out1, 'utf8'))
  if (cues1.length !== 3) throw new Error(`改文本成果条目数不对：${cues1.length}`)
  if (cues1[1]?.text !== '今天天气不错') throw new Error(`第 2 条文本未改正：${cues1[1]?.text}`)
  if (cues1[1]?.start !== '00:00:03,000') throw new Error('第 2 条时间轴被改动')
  // 流 2：源字幕第 3 条被删，剩 2 条且重编号
  const cues2 = parseSrtEntries(fs.readFileSync(out2, 'utf8'))
  if (cues2.length !== 2) throw new Error(`删除成果条目数不对：${cues2.length}`)
  if (cues2.some((cue) => cue.text.includes('第三条'))) throw new Error('第 3 条未被删除')
  const videoAfter = quickFingerprint(sourceVideo)
  const srtAfter = quickFingerprint(subtitleFile)
  if (videoBefore.bytes !== videoAfter.bytes || videoBefore.sha256 !== videoAfter.sha256) throw new Error('安装态校对改动了源视频')
  if (srtBefore.bytes !== srtAfter.bytes || srtBefore.sha256 !== srtAfter.sha256) throw new Error('安装态校对改动了源字幕文件')
  if (pageResult.task1.quality?.passed !== true || pageResult.task2.quality?.passed !== true) throw new Error('安装态校对质量门未通过')
  if (!pageResult.uiReceiptVisible) throw new Error('对话框没有显示校对回执')
  const persisted1 = path.join(evidenceDir, 'packaged-cue-replace.srt')
  const persisted2 = path.join(evidenceDir, 'packaged-cue-delete.srt')
  fs.copyFileSync(out1, persisted1)
  fs.copyFileSync(out2, persisted2)
  const receipt = { passed: true, checkedAt: new Date().toISOString(), executable, sourceVideo, subtitleFile, cues1, cues2, persisted1, persisted2, screenshotPath, pageResult }
  const receiptPath = path.join(evidenceDir, 'receipt.json')
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ passed: true, receiptPath, screenshotPath, cues1, cues2, qualityScore: pageResult.task1.quality?.score, persisted1, persisted2 }, null, 2)}\n`)
} finally {
  if (session) await closeSession(session)
  cleanup()
}
