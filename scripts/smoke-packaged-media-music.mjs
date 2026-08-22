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
if (!fs.existsSync(executable)) throw new Error(`缺少待验收 EXE：${executable}`)

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-music-'))
const fixtureDir = path.join(profileDir, 'media')
const sourcePath = path.join(fixtureDir, 'voice-source.mp4')
const musicPath = path.join(fixtureDir, 'background-music.mp3')
const installedFfmpeg = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const stagedFfmpeg = path.join(profileDir, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const ffmpeg = path.join(installedFfmpeg, 'bin', 'ffmpeg.exe')
const ffprobe = path.join(installedFfmpeg, 'bin', 'ffprobe.exe')
const evidenceDir = path.join(root, 'artifacts', 'acceptance', 'media-music-packaged')
const instruction = `给视频加背景音乐 ${musicPath}，用音乐第1秒到第3秒，循环铺满，响度归一到-16 LUFS`

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
    child.once('exit', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${path.basename(executablePath)} 退出码 ${code}：${stderr.slice(-1000)}`)))
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
  if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('agentplay-packaged-music-')) throw new Error(`拒绝清理非验收目录：${resolved}`)
  try { if (fs.lstatSync(stagedFfmpeg).isSymbolicLink()) fs.unlinkSync(stagedFfmpeg) } catch {}
  fs.rmSync(resolved, { recursive: true, force: true })
}

let session
try {
  if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) throw new Error(`缺少已安装 FFmpeg：${installedFfmpeg}`)
  fs.mkdirSync(fixtureDir, { recursive: true })
  await runExecutable(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=640x360:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath, '-loglevel', 'error'])
  await runExecutable(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-c:a', 'libmp3lame', musicPath, '-loglevel', 'error'])
  fs.mkdirSync(path.dirname(stagedFfmpeg), { recursive: true })
  fs.symlinkSync(installedFfmpeg, stagedFfmpeg, 'junction')
  fs.mkdirSync(evidenceDir, { recursive: true })
  const sourceBefore = quickFingerprint(sourcePath)
  const musicBefore = quickFingerprint(musicPath)
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
    await waitFor(() => document.readyState === 'complete' && window.aiPlayer?.mediaTools?.planEdit, '桌面桥接就绪', 60000)
    const initial = await waitFor(() => {
      const input = document.querySelector('.agent-composer input[type="text"], input[placeholder*="完成什么"], input[placeholder*="下一步"], input[placeholder*="素材"]')
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return input && video && video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0 ? { duration: video.duration } : null
    }, '本地视频与对话框就绪', 60000)
    window.aiPlayer.menu.confirmOpenFile?.(${JSON.stringify(musicPath)})
    await wait(150)
    const plan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(instruction)}, sourcePath: ${JSON.stringify(sourcePath)} })
    if (!plan.matched || plan.decision?.kind !== 'media.add-music') throw new Error('安装态配乐计划不合格：' + JSON.stringify(plan).slice(0, 400))
    if (plan.decision.audio?.volume !== 0.15 || plan.decision.audio?.fadeInSeconds !== 1 || plan.decision.audio?.fadeOutSeconds !== 1.5 || plan.decision.audio?.duck !== true) throw new Error('安装态配乐参数没有按默认规则冻结')
    if (plan.decision.audio?.selection?.startSeconds !== 1 || plan.decision.audio?.selection?.endSeconds !== 3 || plan.decision.audio?.loop !== true) throw new Error('安装态音乐选段或循环策略没有冻结')
    if (plan.decision.audio?.loudness?.enabled !== true || plan.decision.audio?.loudness?.targetLufs !== -16) throw new Error('安装态响度策略没有冻结')
    const input = document.querySelector('.agent-composer input[type="text"], input[placeholder*="完成什么"], input[placeholder*="下一步"], input[placeholder*="素材"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(instruction)})
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(instruction)} }))
    await wait(120)
    const send = document.querySelector('button[aria-label="发送"]')
    if (!send) throw new Error('没有找到发送按钮')
    const taskStartedAt = Date.now()
    send.click()
    const task = await waitFor(async () => {
      const tasks = await window.aiPlayer.taskRuntime.list()
      const candidate = [...tasks].reverse().find((item) => item.type === 'media.edit-music')
      return candidate && ['completed', 'failed', 'cancelled'].includes(candidate.state) ? candidate : null
    }, '配乐任务完成', 180000)
    if (task.state !== 'completed') throw new Error(task.error || task.status || '配乐任务未完成')
    if (task.result?.audioProof?.verdict !== 'matched') throw new Error('安装态配乐没有通过声音质量证明')
    if (task.result?.loudnessProof?.verdict !== 'matched') throw new Error('安装态配乐没有通过编码后 EBU R128 响度证明')
    if (!task.quality?.checks?.find((item) => item.id === 'audio-proof')?.passed || !task.quality?.checks?.find((item) => item.id === 'loudness-proof')?.passed || task.quality?.score !== 100) throw new Error('安装态声音与响度证明没有进入 100 分质量门')
    const preview = await waitFor(() => {
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return video && Number.isFinite(video.duration) && Math.abs(video.duration - initial.duration) <= 0.25
        ? { duration: video.duration, currentSrc: video.currentSrc }
        : null
    }, '自动预览配乐成片', 30000)
    const bodyText = document.body.innerText
    return {
      version: window.aiPlayer.version,
      task,
      taskElapsedMs: Date.now() - taskStartedAt,
      preview,
      uiReceiptVisible: bodyText.includes('音轨非静音') && bodyText.includes('淡入淡出窗口已核对') && bodyText.includes('编码后响度') && bodyText.includes('true peak')
    }
  })()`, true)
  const screenshot = await session.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const screenshotPath = path.join(evidenceDir, 'conversation-result.png')
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  const outputPath = pageResult.task?.result?.outputPath
  if (!outputPath || !fs.existsSync(outputPath)) throw new Error('安装态配乐没有真实成果文件')
  const sourceAfter = quickFingerprint(sourcePath)
  const musicAfter = quickFingerprint(musicPath)
  if (sourceBefore.bytes !== sourceAfter.bytes || sourceBefore.sha256 !== sourceAfter.sha256) throw new Error('安装态配乐改动了源视频')
  if (musicBefore.bytes !== musicAfter.bytes || musicBefore.sha256 !== musicAfter.sha256) throw new Error('安装态配乐改动了音乐文件')
  if (!pageResult.uiReceiptVisible) throw new Error('对话框没有显示声音质量回执')
  const durationProbe = await runExecutable(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outputPath])
  const outputDuration = Number(durationProbe.stdout.trim())
  if (!(outputDuration > 0) || Math.abs(outputDuration - 4) > 0.25) throw new Error(`安装态配乐成品时长不合格：${outputDuration}`)
  const audioProbe = await runExecutable(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', outputPath])
  if (!audioProbe.stdout.includes('audio')) throw new Error('安装态配乐成品没有音轨')
  const volumeProbe = await runExecutable(ffmpeg, ['-hide_banner', '-nostdin', '-i', outputPath, '-map', '0:a:0', '-vn', '-af', 'volumedetect', '-f', 'null', '-'])
  const peakMatch = volumeProbe.stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i)
  const samplePeakDbfs = peakMatch ? Number(peakMatch[1]) : null
  if (!Number.isFinite(samplePeakDbfs) || samplePeakDbfs > -0.1) throw new Error(`安装态配乐样本峰值没有安全余量：${samplePeakDbfs}`)
  const ebuProbe = await runExecutable(ffmpeg, ['-hide_banner', '-nostdin', '-i', outputPath, '-map', '0:a:0', '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'])
  const integratedMatches = [...ebuProbe.stderr.matchAll(/\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/gi)]
  const truePeakMatches = [...ebuProbe.stderr.matchAll(/\bPeak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/gi)]
  const integratedLufs = integratedMatches.length ? Number(integratedMatches.at(-1)[1]) : null
  const truePeakDbtp = truePeakMatches.length ? Number(truePeakMatches.at(-1)[1]) : null
  if (!Number.isFinite(integratedLufs) || Math.abs(integratedLufs - (-16)) > 0.7) throw new Error(`安装态配乐编码后响度不合格：${integratedLufs} LUFS`)
  if (!Number.isFinite(truePeakDbtp) || truePeakDbtp > -1) throw new Error(`安装态配乐编码后 true peak 不合格：${truePeakDbtp} dBTP`)
  const persistedOutputPath = path.join(evidenceDir, 'packaged-music-proof-4s.mp4')
  fs.copyFileSync(outputPath, persistedOutputPath)
  const receipt = { passed: true, checkedAt: new Date().toISOString(), executable, sourceBefore, sourceAfter, musicBefore, musicAfter, outputDuration, samplePeakDbfs, integratedLufs, truePeakDbtp, persistedOutputPath, screenshotPath, pageResult }
  const receiptPath = path.join(evidenceDir, 'receipt.json')
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ passed: true, receiptPath, screenshotPath, outputDuration, samplePeakDbfs, integratedLufs, truePeakDbtp, qualityScore: pageResult.task.quality?.score, audioProof: pageResult.task.result.audioProof, loudnessProof: pageResult.task.result.loudnessProof, taskElapsedMs: pageResult.taskElapsedMs, persistedOutputPath }, null, 2)}\n`)
} finally {
  if (session) await closeSession(session)
  cleanup()
}
