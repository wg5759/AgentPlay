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
const originalSource = path.resolve(valueArg('--source') || '')
if (!fs.existsSync(executable)) throw new Error(`缺少待验收 EXE：${executable}`)
if (!originalSource || !fs.existsSync(originalSource)) throw new Error('用 --source=<绝对视频路径> 指定至少 20 秒的真实视频')

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-edit-'))
const sourceDir = path.join(profileDir, 'media')
const sourcePath = path.join(sourceDir, path.basename(originalSource))
const installedFfmpeg = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const stagedFfmpeg = path.join(profileDir, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const evidenceDir = path.join(root, 'artifacts', 'acceptance', 'media-edit-packaged')
const instruction = '我想要第四秒到第20秒的这段视频'
const ambiguousInstruction = '保留第4秒之后'
const clarificationAnswer = '到第20秒'
const removeInstruction = '删除第4秒到第8秒'
const concatInstruction = '把第8秒到第12秒放前面，再接第0秒到第4秒'

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

function meanAbsDiff(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 255
  let sum = 0
  for (let index = 0; index < a.length; index += 1) sum += Math.abs(a[index] - b[index])
  return sum / a.length
}

async function runExecutable(executablePath, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, { windowsHide: true, shell: false })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(executablePath)} 退出码 ${code}：${stderr.slice(-1000)}`)))
  })
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
    sourcePath
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
  if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('agentplay-packaged-edit-')) throw new Error(`拒绝清理非验收目录：${resolved}`)
  try { if (fs.lstatSync(stagedFfmpeg).isSymbolicLink()) fs.unlinkSync(stagedFfmpeg) } catch {}
  fs.rmSync(resolved, { recursive: true, force: true })
}

let session
try {
  if (!fs.existsSync(path.join(installedFfmpeg, 'bin', 'ffmpeg.exe'))) throw new Error(`缺少已安装 FFmpeg：${installedFfmpeg}`)
  fs.mkdirSync(sourceDir, { recursive: true })
  fs.copyFileSync(originalSource, sourcePath)
  fs.mkdirSync(path.dirname(stagedFfmpeg), { recursive: true })
  fs.symlinkSync(installedFfmpeg, stagedFfmpeg, 'junction')
  fs.mkdirSync(evidenceDir, { recursive: true })
  const sourceBefore = quickFingerprint(sourcePath)
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
      const input = document.querySelector('.agent-composer input[type="text"]')
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return input && video && video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 20 ? { duration: video.duration } : null
    }, '本地视频与对话框就绪', 60000)
    const explicitPlan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(instruction)}, sourcePath: ${JSON.stringify(sourcePath)} })
    const consultationPlan = await window.aiPlayer.mediaTools.planEdit({ instruction: '能不能截取第4秒到第20秒？', sourcePath: ${JSON.stringify(sourcePath)} })
    const ambiguousPlan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(ambiguousInstruction)}, sourcePath: ${JSON.stringify(sourcePath)} })
    if (!explicitPlan.matched || consultationPlan.matched || ambiguousPlan.clarification?.reason !== 'missing-end') throw new Error('安装态意图或追问边界不合格')
    if (explicitPlan.decision.edl?.kind !== 'agentplay.edit-decision-list' || explicitPlan.decision.edl?.decisionKind !== 'media.trim') throw new Error('安装态明确计划缺少统一 EDL')
    const resolvedPlan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(clarificationAnswer)}, sourcePath: ${JSON.stringify(sourcePath)}, clarificationId: ambiguousPlan.clarification.id })
    if (resolvedPlan.decision.edl?.kind !== 'agentplay.edit-decision-list' || resolvedPlan.decision.edl?.operations?.[0]?.sourceRangeSeconds?.start !== 4) throw new Error('安装态追问收口计划缺少统一 EDL')
    const sendText = async (text) => {
      const input = document.querySelector('.agent-composer input[type="text"]')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, text)
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
      await wait(120)
      const send = document.querySelector('button[aria-label="发送"]')
      if (!send) throw new Error('没有找到发送按钮')
      send.click()
    }
    const tasksBeforeClarification = await window.aiPlayer.taskRuntime.list()
    await sendText(${JSON.stringify(ambiguousInstruction)})
    await waitFor(() => document.body.innerText.includes('要保留到第几秒？'), '只追问缺失的结束时间', 10000)
    const tasksWhileClarifying = await window.aiPlayer.taskRuntime.list()
    if (tasksWhileClarifying.length !== tasksBeforeClarification.length) throw new Error('追问阶段错误创建了持久任务')
    await sendText(${JSON.stringify(clarificationAnswer)})
    const task = await waitFor(async () => {
      const tasks = await window.aiPlayer.taskRuntime.list()
      const candidate = [...tasks].reverse().find((item) => item.type === 'media.edit-trim')
      return candidate && ['completed', 'failed', 'cancelled'].includes(candidate.state) ? candidate : null
    }, '剪辑任务完成')
    if (task.state !== 'completed') throw new Error(task.error || task.status || '剪辑任务未完成')
    if (task.spec?.instruction !== '保留第4秒到第20秒') throw new Error('追问补齐后没有冻结成完整剪辑指令')
    if (task.spec?.decision?.edl?.kind !== 'agentplay.edit-decision-list' || task.spec.decision.edl.operations?.[0]?.targetRangeSeconds?.end !== 16) throw new Error('持久任务没有冻结统一 EDL')
    if (task.result?.frameProof?.verdict !== 'matched') throw new Error('安装态剪辑没有得到明确的首尾帧边界匹配证明')
    const frameProofCheck = task.quality?.checks?.find((item) => item.id === 'frame-proof')
    if (!frameProofCheck?.passed || task.quality?.score !== 100) throw new Error('安装态帧边界证明没有进入质量门或未获得满分')
    const preview = await waitFor(() => {
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return video && Number.isFinite(video.duration) && Math.abs(video.duration - 16) <= 0.2
        ? { duration: video.duration, currentSrc: video.currentSrc }
        : null
    }, '自动预览剪辑成片', 30000)
    if (task.result?.projectCapsule?.versionCount !== 2 || task.result?.projectCapsule?.canUndo !== true) throw new Error('安装态任务没有生成可撤销项目胶囊')
    await waitFor(() => document.body.innerText.includes('可直接说“撤销刚才的剪辑”'), '项目胶囊提示', 10000)
    const undoInstruction = '撤销刚才的剪辑'
    const undoPlan = await window.aiPlayer.mediaTools.planHistory({ instruction: undoInstruction, currentPath: task.result.outputPath })
    if (!undoPlan.matched || undoPlan.action?.action !== 'undo') throw new Error('安装态撤销计划不合格')
    await sendText(undoInstruction)
    const undoPreview = await waitFor(() => {
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return video && Number.isFinite(video.duration) && Math.abs(video.duration - initial.duration) <= 0.2 && document.body.innerText.includes('项目版本：1/2')
        ? { duration: video.duration, currentSrc: video.currentSrc }
        : null
    }, '对话撤销并打开原片', 30000)
    const redoInstruction = '重做刚才撤销的剪辑'
    const redoPlan = await window.aiPlayer.mediaTools.planHistory({ instruction: redoInstruction, currentPath: ${JSON.stringify(sourcePath)} })
    if (!redoPlan.matched || redoPlan.action?.action !== 'redo') throw new Error('安装态重做计划不合格')
    await sendText(redoInstruction)
    const redoPreview = await waitFor(() => {
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return video && Number.isFinite(video.duration) && Math.abs(video.duration - 16) <= 0.2 && document.body.innerText.includes('项目版本：2/2')
        ? { duration: video.duration, currentSrc: video.currentSrc }
        : null
    }, '对话重做并打开成片', 30000)
    const removePlan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(removeInstruction)}, sourcePath: task.result.outputPath })
    if (!removePlan.matched || removePlan.decision?.kind !== 'media.remove-segment') throw new Error('安装态删除片段计划不合格')
    await sendText(${JSON.stringify(removeInstruction)})
    const removeTask = await waitFor(async () => {
      const tasks = await window.aiPlayer.taskRuntime.list()
      const candidate = [...tasks].reverse().find((item) => item.type === 'media.edit-remove')
      return candidate && ['completed', 'failed', 'cancelled'].includes(candidate.state) ? candidate : null
    }, '删除片段任务完成')
    if (removeTask.state !== 'completed') throw new Error(removeTask.error || removeTask.status || '删除片段任务未完成')
    if (removeTask.result?.frameProof?.verdict !== 'matched' || removeTask.result.frameProof.boundaries?.length !== 2) throw new Error('安装态删除片段没有证明两个保留片段的首尾边界')
    if (!removeTask.quality?.checks?.find((item) => item.id === 'frame-proof')?.passed) throw new Error('安装态删除帧证明没有进入质量门')
    const removePreview = await waitFor(() => {
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return video && Number.isFinite(video.duration) && Math.abs(video.duration - 12) <= 0.2
        ? { duration: video.duration, currentSrc: video.currentSrc }
        : null
    }, '自动预览删除片段成片', 30000)
    if (removeTask.result?.projectCapsule?.versionCount !== 3 || removeTask.result?.projectCapsule?.canUndo !== true) throw new Error('删除片段没有进入同一编辑项目')
    if (!Array.isArray(removeTask.result?.timelineReceipt) || removeTask.result.timelineReceipt.length !== 3) throw new Error('删除片段没有返回完整时间线映射')
    await sendText(undoInstruction)
    const removeUndoPreview = await waitFor(() => {
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return video && Number.isFinite(video.duration) && Math.abs(video.duration - 16) <= 0.2 && document.body.innerText.includes('项目版本：2/3')
        ? { duration: video.duration, currentSrc: video.currentSrc }
        : null
    }, '撤销删除并回到上一成片', 30000)
    await sendText(redoInstruction)
    const removeRedoPreview = await waitFor(() => {
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return video && Number.isFinite(video.duration) && Math.abs(video.duration - 12) <= 0.2 && document.body.innerText.includes('项目版本：3/3')
        ? { duration: video.duration, currentSrc: video.currentSrc }
        : null
    }, '重做删除并回到新成片', 30000)
    const concatPlan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(concatInstruction)}, sourcePath: removeTask.result.outputPath })
    if (!concatPlan.matched || concatPlan.decision?.kind !== 'media.concat-segments' || concatPlan.decision.timeline?.segments?.length !== 2) throw new Error('安装态拼接重排计划不合格')
    await sendText(${JSON.stringify(concatInstruction)})
    const concatTask = await waitFor(async () => {
      const tasks = await window.aiPlayer.taskRuntime.list()
      const candidate = [...tasks].reverse().find((item) => item.type === 'media.edit-concat')
      return candidate && ['completed', 'failed', 'cancelled'].includes(candidate.state) ? candidate : null
    }, '拼接重排任务完成')
    if (concatTask.state !== 'completed') throw new Error(concatTask.error || concatTask.status || '拼接重排任务未完成')
    if (concatTask.result?.frameProof?.verdict !== 'matched' || concatTask.result.frameProof.boundaries?.length !== 2) throw new Error('安装态拼接没有证明两个片段的首尾边界')
    if (!concatTask.quality?.checks?.find((item) => item.id === 'frame-proof')?.passed) throw new Error('安装态拼接帧证明没有进入质量门')
    const concatPreview = await waitFor(() => {
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return video && Number.isFinite(video.duration) && Math.abs(video.duration - 8) <= 0.2
        ? { duration: video.duration, currentSrc: video.currentSrc }
        : null
    }, '自动预览拼接重排成片', 30000)
    if (concatTask.result?.projectCapsule?.versionCount !== 4 || concatTask.result?.projectCapsule?.canUndo !== true) throw new Error('拼接重排没有进入同一编辑项目')
    if (!Array.isArray(concatTask.result?.timelineReceipt) || concatTask.result.timelineReceipt.length !== 2) throw new Error('拼接重排没有返回每个片段的时间线映射')
    await sendText(undoInstruction)
    const concatUndoPreview = await waitFor(() => {
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return video && Number.isFinite(video.duration) && Math.abs(video.duration - 12) <= 0.2 && document.body.innerText.includes('项目版本：3/4')
        ? { duration: video.duration, currentSrc: video.currentSrc }
        : null
    }, '撤销拼接并回到删除版', 30000)
    await sendText(redoInstruction)
    const concatRedoPreview = await waitFor(() => {
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return video && Number.isFinite(video.duration) && Math.abs(video.duration - 8) <= 0.2 && document.body.innerText.includes('项目版本：4/4')
        ? { duration: video.duration, currentSrc: video.currentSrc }
        : null
    }, '重做拼接并回到重排版', 30000)
    const tasksBeforeCancel = await window.aiPlayer.taskRuntime.list()
    await sendText('删除视频')
    await waitFor(() => document.body.innerText.includes('要删除哪一段？请告诉我开始和结束时间。'), '删除范围追问', 10000)
    await sendText('算了')
    await waitFor(() => document.body.innerText.includes('已取消这次剪辑，没有创建任务，也没有改动文件。'), '取消追问回执', 10000)
    const tasksAfterCancel = await window.aiPlayer.taskRuntime.list()
    if (tasksAfterCancel.length !== tasksBeforeCancel.length) throw new Error('取消追问后错误创建了持久任务')
    const bodyText = document.body.innerText
    return {
      version: window.aiPlayer.version,
      originalDuration: initial.duration,
      explicitPlan,
      resolvedPlan,
      ambiguousPlan,
      clarificationNoTask: tasksWhileClarifying.length === tasksBeforeClarification.length,
      cancelledClarificationNoTask: tasksAfterCancel.length === tasksBeforeCancel.length,
      consultationMatched: consultationPlan.matched,
      task,
      preview,
      undoPlan,
      undoPreview,
      redoPlan,
      redoPreview,
      removePlan,
      removeTask,
      removePreview,
      removeUndoPreview,
      removeRedoPreview,
      concatPlan,
      concatTask,
      concatPreview,
      concatUndoPreview,
      concatRedoPreview,
      uiReceiptVisible: bodyText.includes('原文件未改动') && bodyText.includes('首尾帧边界已核对') && bodyText.includes('2个保留片段的首尾帧边界已核对') && bodyText.includes('2个拼接片段的首尾帧边界已核对') && bodyText.includes('时间线：') && bodyText.includes('拼接片段 1：源片') && bodyText.includes('拼接片段 2：源片') && bodyText.includes('项目版本：4/4')
    }
  })()`, true)
  const screenshot = await session.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const screenshotPath = path.join(evidenceDir, 'conversation-result.png')
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  const sourceAfter = quickFingerprint(sourcePath)
  const outputPath = pageResult.task?.result?.outputPath
  if (!outputPath || !fs.existsSync(outputPath)) throw new Error('安装态任务没有真实成果文件')
  if (sourceBefore.bytes !== sourceAfter.bytes || sourceBefore.sha256 !== sourceAfter.sha256) throw new Error('安装态剪辑修改了源视频')
  if (Math.abs(Number(pageResult.task.result.durationSeconds) - 16) > 0.2) throw new Error('安装态成品时长不合格')
  if (pageResult.task.quality?.passed !== true || pageResult.task.quality?.score !== 100) throw new Error('安装态任务质量门未通过或帧证明未满分')
  if (!pageResult.uiReceiptVisible) throw new Error('对话框没有显示时间线与原文件回执')
  if (Math.abs(Number(pageResult.undoPreview?.duration) - Number(pageResult.originalDuration)) > 0.2) throw new Error('安装态撤销没有回到原片')
  if (Math.abs(Number(pageResult.redoPreview?.duration) - 16) > 0.2) throw new Error('安装态重做没有回到成片')
  const removedOutputPath = pageResult.removeTask?.result?.outputPath
  if (!removedOutputPath || !fs.existsSync(removedOutputPath)) throw new Error('安装态删除片段任务没有真实成果文件')
  if (Math.abs(Number(pageResult.removeTask.result.durationSeconds) - 12) > 0.2) throw new Error('安装态删除片段成品时长不合格')
  if (pageResult.removeTask.quality?.passed !== true || pageResult.removeTask.quality?.score !== 100) throw new Error('安装态删除片段质量门未通过')
  if (Math.abs(Number(pageResult.removeUndoPreview?.duration) - 16) > 0.2) throw new Error('安装态撤销删除没有回到上一成片')
  if (Math.abs(Number(pageResult.removeRedoPreview?.duration) - 12) > 0.2) throw new Error('安装态重做删除没有回到新成片')
  const concatOutputPath = pageResult.concatTask?.result?.outputPath
  if (!concatOutputPath || !fs.existsSync(concatOutputPath)) throw new Error('安装态拼接重排任务没有真实成果文件')
  if (Math.abs(Number(pageResult.concatTask.result.durationSeconds) - 8) > 0.2) throw new Error('安装态拼接重排成品时长不合格')
  if (pageResult.concatTask.quality?.passed !== true || pageResult.concatTask.quality?.score !== 100) throw new Error('安装态拼接重排质量门未通过')
  if (Math.abs(Number(pageResult.concatUndoPreview?.duration) - 12) > 0.2) throw new Error('安装态撤销拼接没有回到删除版')
  if (Math.abs(Number(pageResult.concatRedoPreview?.duration) - 8) > 0.2) throw new Error('安装态重做拼接没有回到重排版')
  const orderDir = path.join(evidenceDir, 'order-check')
  fs.rmSync(orderDir, { recursive: true, force: true })
  fs.mkdirSync(orderDir, { recursive: true })
  const ffmpegPath = path.join(installedFfmpeg, 'bin', 'ffmpeg.exe')
  const readGrayFrame = async (filePath, seconds, name) => {
    const framePath = path.join(orderDir, `${name}.gray`)
    await runExecutable(ffmpegPath, ['-hide_banner', '-nostdin', '-ss', Number(seconds).toFixed(3), '-i', filePath, '-frames:v', '1', '-vf', 'scale=32:32,format=gray', '-f', 'rawvideo', '-y', framePath])
    return fs.readFileSync(framePath)
  }
  const [sourceFirst, sourceSecond, outputFirst, outputSecond] = await Promise.all([
    readGrayFrame(removedOutputPath, 8.5, 'source-first'),
    readGrayFrame(removedOutputPath, 0.5, 'source-second'),
    readGrayFrame(concatOutputPath, 0.5, 'output-first'),
    readGrayFrame(concatOutputPath, 4.5, 'output-second')
  ])
  const orderEvidence = {
    firstToRequested: meanAbsDiff(outputFirst, sourceFirst),
    firstToWrong: meanAbsDiff(outputFirst, sourceSecond),
    secondToRequested: meanAbsDiff(outputSecond, sourceSecond),
    secondToWrong: meanAbsDiff(outputSecond, sourceFirst)
  }
  if (!(orderEvidence.firstToRequested < orderEvidence.firstToWrong && orderEvidence.secondToRequested < orderEvidence.secondToWrong)) throw new Error(`安装态拼接顺序画面校验失败：${JSON.stringify(orderEvidence)}`)
  const persistedOutputPath = path.join(evidenceDir, 'packaged-trim-4s-20s.mp4')
  fs.copyFileSync(outputPath, persistedOutputPath)
  const persistedRemovedOutputPath = path.join(evidenceDir, 'packaged-trim-then-remove-4s-8s.mp4')
  fs.copyFileSync(removedOutputPath, persistedRemovedOutputPath)
  const persistedConcatOutputPath = path.join(evidenceDir, 'packaged-trim-remove-reordered-8s.mp4')
  fs.copyFileSync(concatOutputPath, persistedConcatOutputPath)
  const projectStatePath = path.join(profileDir, 'media-edit-projects', 'media-edit-projects-v1.json')
  if (!fs.existsSync(projectStatePath)) throw new Error('安装态没有持久化编辑项目状态')
  const persistedProjectStatePath = path.join(evidenceDir, 'media-edit-projects-v1.json')
  fs.copyFileSync(projectStatePath, persistedProjectStatePath)
  const receipt = { passed: true, checkedAt: new Date().toISOString(), executable, sourceBefore, sourceAfter, outputBytes: fs.statSync(outputPath).size, removedOutputBytes: fs.statSync(removedOutputPath).size, concatOutputBytes: fs.statSync(concatOutputPath).size, orderEvidence, persistedOutputPath, persistedRemovedOutputPath, persistedConcatOutputPath, persistedProjectStatePath, screenshotPath, pageResult }
  const receiptPath = path.join(evidenceDir, 'receipt.json')
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ passed: true, receiptPath, screenshotPath, durationSeconds: pageResult.task.result.durationSeconds, frameProof: pageResult.task.result.frameProof, qualityScore: pageResult.task.quality.score, removedDurationSeconds: pageResult.removeTask.result.durationSeconds, removeFrameProof: pageResult.removeTask.result.frameProof, removeQualityScore: pageResult.removeTask.quality.score, concatDurationSeconds: pageResult.concatTask.result.durationSeconds, concatFrameProof: pageResult.concatTask.result.frameProof, concatQualityScore: pageResult.concatTask.quality.score, orderEvidence, undoDurationSeconds: pageResult.undoPreview.duration, redoDurationSeconds: pageResult.redoPreview.duration, removeUndoDurationSeconds: pageResult.removeUndoPreview.duration, removeRedoDurationSeconds: pageResult.removeRedoPreview.duration, concatUndoDurationSeconds: pageResult.concatUndoPreview.duration, concatRedoDurationSeconds: pageResult.concatRedoPreview.duration }, null, 2)}\n`)
} finally {
  if (session) await closeSession(session)
  cleanup()
}
