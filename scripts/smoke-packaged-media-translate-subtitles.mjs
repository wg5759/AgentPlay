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
const subtitleFile = path.resolve(valueArg('--srt') || 'C:/Users/Administrator/Videos/拼接验收/翻译验收.srt')
if (!fs.existsSync(executable)) throw new Error(`缺少待验收 EXE：${executable}`)
if (!fs.existsSync(sourceVideo) || !fs.existsSync(subtitleFile)) throw new Error('缺少翻译验收夹具（视频/字幕）')

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-xlate-'))
const installedTranslate = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai-player', 'translate-pack')
const stagedTranslate = path.join(profileDir, 'translate-pack')
const evidenceDir = path.join(root, 'artifacts', 'acceptance', 'media-translate-subtitles-packaged')
const directInstruction = `把字幕 ${subtitleFile} 翻译成中文`
const vagueInstruction = `把字幕 ${subtitleFile} 翻译一下`

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
  if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('agentplay-packaged-xlate-')) throw new Error(`拒绝清理非验收目录：${resolved}`)
  try { if (fs.lstatSync(stagedTranslate).isSymbolicLink()) fs.unlinkSync(stagedTranslate) } catch {}
  fs.rmSync(resolved, { recursive: true, force: true })
}

let session
try {
  if (!fs.existsSync(path.join(installedTranslate, 'models'))) throw new Error(`缺少已安装离线翻译组件：${installedTranslate}`)
  fs.symlinkSync(installedTranslate, stagedTranslate, 'junction')
  fs.mkdirSync(evidenceDir, { recursive: true })
  const videoBefore = quickFingerprint(sourceVideo)
  const srtBefore = quickFingerprint(subtitleFile)
  const sourceEntries = parseSrtEntries(fs.readFileSync(subtitleFile, 'utf8'))
  if (!sourceEntries.length) throw new Error('翻译夹具字幕没有有效条目')
  session = await openSession()
  const pageResult = await session.evaluate(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const waitFor = async (probe, label, timeoutMs = 180000) => {
      const started = Date.now()
      while (Date.now() - started < timeoutMs) {
        const value = await probe()
        if (value) return value
        await wait(150)
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
    if (!directPlan.matched || directPlan.decision?.kind !== 'media.translate-subtitles' || directPlan.decision.translate?.targetLang !== '中文') throw new Error('安装态字幕翻译计划不合格：' + JSON.stringify(directPlan).slice(0, 300))
    const vaguePlan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(vagueInstruction)}, sourcePath: ${JSON.stringify(sourceVideo)} })
    if (vaguePlan.clarification?.reason !== 'missing-translate-target') throw new Error('安装态缺目标语言追问不合格：' + JSON.stringify(vaguePlan).slice(0, 300))
    const resolvedPlan = await window.aiPlayer.mediaTools.planEdit({ instruction: '中文', sourcePath: ${JSON.stringify(sourceVideo)}, clarificationId: vaguePlan.clarification.id })
    if (!resolvedPlan.matched || resolvedPlan.decision?.kind !== 'media.translate-subtitles') throw new Error('安装态追问收口不合格：' + JSON.stringify(resolvedPlan).slice(0, 300))
    const consultationPlan = await window.aiPlayer.mediaTools.planEdit({ instruction: '能不能把字幕翻译成中文？', sourcePath: ${JSON.stringify(sourceVideo)} })
    if (consultationPlan.matched) throw new Error('询问句不该形成翻译决策')
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
    const tasksBefore = await window.aiPlayer.taskRuntime.list()
    await sendText(${JSON.stringify(vagueInstruction)})
    await waitFor(() => document.body.innerText.includes('想翻译成哪种语言？'), '缺目标语言追问出现在对话里', 10000)
    const tasksWhileClarifying = await window.aiPlayer.taskRuntime.list()
    if (tasksWhileClarifying.length !== tasksBefore.length) throw new Error('追问阶段错误创建了持久任务')
    await sendText('中文')
    const task = await waitFor(async () => {
      const tasks = await window.aiPlayer.taskRuntime.list()
      const candidate = [...tasks].reverse().find((item) => item.type === 'media.translate-subtitles')
      return candidate && ['completed', 'failed', 'cancelled'].includes(candidate.state) ? candidate : null
    }, '字幕翻译任务完成', 240000)
    if (task.state !== 'completed') throw new Error(task.error || task.status || '字幕翻译任务未完成')
    if (task.result?.projectCapsule?.versionCount !== 2 || task.result?.projectCapsule?.canUndo !== true) throw new Error('字幕翻译没有生成可撤销项目胶囊')
    await waitFor(() => document.body.innerText.includes('原字幕文件与视频均未改动'), '翻译回执出现在对话里', 10000)
    const stillSameVideo = await (async () => {
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return video && video.currentSrc === initial.src
    })()
    if (!stillSameVideo) throw new Error('.srt 成果被错误地送进了播放器')
    const bodyText = document.body.innerText
    return {
      version: window.aiPlayer.version,
      task: { type: task.type, state: task.state, quality: task.quality, result: { outputPath: task.result?.outputPath, cueCount: task.result?.cueCount, sourceCueCount: task.result?.sourceCueCount, targetLang: task.result?.targetLang, engine: task.result?.engine, summary: task.result?.summary, projectCapsule: task.result?.projectCapsule } },
      uiReceiptVisible: bodyText.includes('字幕翻译') && bodyText.includes('中译版')
    }
  })()`, true)
  const screenshot = await session.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const screenshotPath = path.join(evidenceDir, 'conversation-result.png')
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  const outputPath = pageResult.task?.result?.outputPath
  if (!outputPath || !fs.existsSync(outputPath)) throw new Error('安装态字幕翻译没有真实成果文件')
  const outputEntries = parseSrtEntries(fs.readFileSync(outputPath, 'utf8'))
  if (outputEntries.length < sourceEntries.length) throw new Error(`翻译成果条数不足：${outputEntries.length}/${sourceEntries.length}`)
  if (!outputEntries.every((entry, index) => entry.start === sourceEntries[index]?.start && entry.end === sourceEntries[index]?.end)) throw new Error('翻译成果时间轴与源字幕不一致')
  if (!outputEntries.every((entry) => /[一-鿿]/.test(entry.text))) throw new Error(`翻译成果有不含中文的条目：${JSON.stringify(outputEntries).slice(0, 300)}`)
  if (outputEntries.some((entry) => entry.text === sourceEntries[outputEntries.indexOf(entry)]?.text)) throw new Error('翻译成果存在未翻译的原文条目')
  const videoAfter = quickFingerprint(sourceVideo)
  const srtAfter = quickFingerprint(subtitleFile)
  if (videoBefore.bytes !== videoAfter.bytes || videoBefore.sha256 !== videoAfter.sha256) throw new Error('安装态翻译改动了源视频')
  if (srtBefore.bytes !== srtAfter.bytes || srtBefore.sha256 !== srtAfter.sha256) throw new Error('安装态翻译改动了源字幕文件')
  if (pageResult.task.quality?.passed !== true) throw new Error(`安装态字幕翻译质量门未通过：${JSON.stringify(pageResult.task.quality?.reasons || []).slice(0, 400)}`)
  if (!pageResult.uiReceiptVisible) throw new Error('对话框没有显示翻译回执')
  const persistedOutputPath = path.join(evidenceDir, 'packaged-translate-subtitles-zh.srt')
  fs.copyFileSync(outputPath, persistedOutputPath)
  const receipt = { passed: true, checkedAt: new Date().toISOString(), executable, sourceVideo, subtitleFile, videoBefore, videoAfter, srtBefore, srtAfter, sourceEntries, outputEntries, persistedOutputPath, screenshotPath, pageResult }
  const receiptPath = path.join(evidenceDir, 'receipt.json')
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ passed: true, receiptPath, screenshotPath, engine: pageResult.task.result.engine, sourceEntries, outputEntries, qualityScore: pageResult.task.quality?.score, persistedOutputPath }, null, 2)}\n`)
} finally {
  if (session) await closeSession(session)
  cleanup()
}
