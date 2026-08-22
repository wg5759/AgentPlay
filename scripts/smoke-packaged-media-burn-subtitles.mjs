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
const subtitleFile = path.resolve(valueArg('--srt') || 'C:/Users/Administrator/Videos/拼接验收/验收字幕.srt')
if (!fs.existsSync(executable)) throw new Error(`缺少待验收 EXE：${executable}`)
if (!fs.existsSync(sourceVideo) || !fs.existsSync(subtitleFile)) throw new Error('缺少烧录验收夹具（视频/字幕）')

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-burn-'))
const installedFfmpeg = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const stagedFfmpeg = path.join(profileDir, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const evidenceDir = path.join(root, 'artifacts', 'acceptance', 'media-burn-subtitles-packaged')
const directInstruction = `把字幕 ${subtitleFile} 烧进视频`
const vagueInstruction = '把字幕烧进视频'

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

async function runExecutable(executablePath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, { windowsHide: true, shell: false })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${path.basename(executablePath)} 退出码 ${code}：${stderr.slice(-800)}`)))
  })
}

function meanAbsDiff(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 255
  let sum = 0
  for (let index = 0; index < a.length; index += 1) sum += Math.abs(a[index] - b[index])
  return sum / a.length
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
  if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('agentplay-packaged-burn-')) throw new Error(`拒绝清理非验收目录：${resolved}`)
  try { if (fs.lstatSync(stagedFfmpeg).isSymbolicLink()) fs.unlinkSync(stagedFfmpeg) } catch {}
  fs.rmSync(resolved, { recursive: true, force: true })
}

let session
try {
  if (!fs.existsSync(path.join(installedFfmpeg, 'bin', 'ffmpeg.exe'))) throw new Error(`缺少已安装 FFmpeg：${installedFfmpeg}`)
  fs.mkdirSync(path.dirname(stagedFfmpeg), { recursive: true })
  fs.symlinkSync(installedFfmpeg, stagedFfmpeg, 'junction')
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
      return input && video && video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0 ? { duration: video.duration } : null
    }, '本地视频与对话框就绪', 60000)
    const directPlan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(directInstruction)}, sourcePath: ${JSON.stringify(sourceVideo)} })
    if (!directPlan.matched || directPlan.decision?.kind !== 'media.burn-subtitles' || !directPlan.decision.subtitle?.path) throw new Error('安装态烧录字幕计划不合格：' + JSON.stringify(directPlan).slice(0, 300))
    const vaguePlan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(vagueInstruction)}, sourcePath: ${JSON.stringify(sourceVideo)} })
    if (vaguePlan.clarification?.reason !== 'missing-subtitle') throw new Error('安装态缺字幕追问不合格：' + JSON.stringify(vaguePlan).slice(0, 300))
    const resolvedPlan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(subtitleFile)}, sourcePath: ${JSON.stringify(sourceVideo)}, clarificationId: vaguePlan.clarification.id })
    if (!resolvedPlan.matched || resolvedPlan.decision?.kind !== 'media.burn-subtitles') throw new Error('安装态追问收口不合格：' + JSON.stringify(resolvedPlan).slice(0, 300))
    const consultationPlan = await window.aiPlayer.mediaTools.planEdit({ instruction: '能不能把字幕烧进视频？', sourcePath: ${JSON.stringify(sourceVideo)} })
    if (consultationPlan.matched) throw new Error('询问句不该形成烧录决策')
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
    await waitFor(() => document.body.innerText.includes('要把哪个字幕文件烧进视频？'), '缺字幕追问出现在对话里', 10000)
    const tasksWhileClarifying = await window.aiPlayer.taskRuntime.list()
    if (tasksWhileClarifying.length !== tasksBefore.length) throw new Error('追问阶段错误创建了持久任务')
    await sendText(${JSON.stringify(subtitleFile)})
    const task = await waitFor(async () => {
      const tasks = await window.aiPlayer.taskRuntime.list()
      const candidate = [...tasks].reverse().find((item) => item.type === 'media.edit-burn-subtitles')
      return candidate && ['completed', 'failed', 'cancelled'].includes(candidate.state) ? candidate : null
    }, '烧录字幕任务完成')
    if (task.state !== 'completed') throw new Error(task.error || task.status || '烧录字幕任务未完成')
    const preview = await waitFor(() => {
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return video && Number.isFinite(video.duration) && Math.abs(video.duration - 4) <= 0.25
        ? { duration: video.duration, currentSrc: video.currentSrc }
        : null
    }, '自动预览硬字幕成片', 30000)
    if (task.result?.projectCapsule?.versionCount !== 2 || task.result?.projectCapsule?.canUndo !== true) throw new Error('烧录字幕没有生成可撤销项目胶囊')
    if (!Array.isArray(task.result?.timelineReceipt) || task.result.timelineReceipt.length !== 1) throw new Error('烧录字幕没有返回时间线回执')
    const bodyText = document.body.innerText
    return {
      version: window.aiPlayer.version,
      initialDuration: initial.duration,
      task,
      preview,
      uiReceiptVisible: bodyText.includes('原文件与字幕文件均未改动') && bodyText.includes('烧录字幕（')
    }
  })()`, true)
  const screenshot = await session.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const screenshotPath = path.join(evidenceDir, 'conversation-result.png')
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  const outputPath = pageResult.task?.result?.outputPath
  if (!outputPath || !fs.existsSync(outputPath)) throw new Error('安装态烧录字幕没有真实成果文件')
  const videoAfter = quickFingerprint(sourceVideo)
  const srtAfter = quickFingerprint(subtitleFile)
  if (videoBefore.bytes !== videoAfter.bytes || videoBefore.sha256 !== videoAfter.sha256) throw new Error('安装态烧录改动了源视频')
  if (srtBefore.bytes !== srtAfter.bytes || srtBefore.sha256 !== srtAfter.sha256) throw new Error('安装态烧录改动了字幕文件')
  if (pageResult.task.quality?.passed !== true) throw new Error(`安装态烧录字幕质量门未通过：${JSON.stringify(pageResult.task.quality?.reasons || []).slice(0, 400)}`)
  if (!pageResult.uiReceiptVisible) throw new Error('对话框没有显示烧录回执')
  const ffmpegPath = path.join(installedFfmpeg, 'bin', 'ffmpeg.exe')
  const ffprobe = path.join(installedFfmpeg, 'bin', 'ffprobe.exe')
  const durationOut = await runExecutable(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outputPath])
  const outputDuration = Number(String(durationOut).trim())
  if (!(outputDuration > 0) || Math.abs(outputDuration - 4) > 0.25) throw new Error(`安装态硬字幕成品时长不合格：${outputDuration}`)
  const audioOut = await runExecutable(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', outputPath])
  if (!String(audioOut).includes('audio')) throw new Error('安装态硬字幕成品没有音轨')
  // 抽帧验证字幕烧进画面：活跃 2s 差异显著、安静 3.9s 差异小；并留 PNG 证据供人工查看字形
  const readGray = async (file, seconds, name) => {
    const target = path.join(evidenceDir, `${name}.gray`)
    await runExecutable(ffmpegPath, ['-hide_banner', '-nostdin', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'scale=32:32,format=gray', '-f', 'rawvideo', '-y', target])
    return fs.readFileSync(target)
  }
  const activeDiff = meanAbsDiff(await readGray(sourceVideo, 2, 'src-active'), await readGray(outputPath, 2, 'out-active'))
  const quietDiff = meanAbsDiff(await readGray(sourceVideo, 3.9, 'src-quiet'), await readGray(outputPath, 3.9, 'out-quiet'))
  if (!(activeDiff > 0.8 && activeDiff > quietDiff * 2)) throw new Error(`安装态字幕烧录帧校验失败：活跃 ${activeDiff} / 安静 ${quietDiff}`)
  const frameProofPath = path.join(evidenceDir, 'burned-frame-2s.png')
  await runExecutable(ffmpegPath, ['-hide_banner', '-nostdin', '-ss', '2', '-i', outputPath, '-frames:v', '1', '-y', frameProofPath])
  for (const name of ['src-active', 'out-active', 'src-quiet', 'out-quiet']) fs.rmSync(path.join(evidenceDir, `${name}.gray`), { force: true })
  const persistedOutputPath = path.join(evidenceDir, 'packaged-burn-subtitles-4s.mp4')
  fs.copyFileSync(outputPath, persistedOutputPath)
  const receipt = { passed: true, checkedAt: new Date().toISOString(), executable, sourceVideo, subtitleFile, videoBefore, videoAfter, srtBefore, srtAfter, outputBytes: fs.statSync(outputPath).size, outputDuration, frameEvidence: { activeDiff, quietDiff }, frameProofPath, persistedOutputPath, screenshotPath, pageResult }
  const receiptPath = path.join(evidenceDir, 'receipt.json')
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ passed: true, receiptPath, screenshotPath, outputDuration, activeDiff, quietDiff, qualityScore: pageResult.task.quality?.score, persistedOutputPath, frameProofPath }, null, 2)}\n`)
} finally {
  if (session) await closeSession(session)
  cleanup()
}
