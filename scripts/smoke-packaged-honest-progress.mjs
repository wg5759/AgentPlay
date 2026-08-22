import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const valueOf = (name, fallback = '') => args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) || fallback
const executable = path.resolve(valueOf('--exe', path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe')))
if (!fs.existsSync(executable)) throw new Error(`缺少待验收 EXE：${executable}`)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  return port
}

const apiPort = await freePort()
const debugPort = await freePort()
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-honest-progress-'))
const sourcePath = path.join(profileDir, '进度验收资料.txt')
fs.writeFileSync(sourcePath, '这是一份用于验证真实阶段和耗时提示的短文。', 'utf8')
fs.writeFileSync(path.join(profileDir, 'model-config.json'), JSON.stringify({
  schemaVersion: 3,
  roles: { chat: { providerId: 'custom', model: 'progress-smoke', baseUrl: `http://127.0.0.1:${apiPort}/v1`, encryptedApiKey: '' } },
  profiles: { chat: [{ providerId: 'custom', model: 'progress-smoke', baseUrl: `http://127.0.0.1:${apiPort}/v1`, encryptedApiKey: '' }] }
}, null, 2), 'utf8')

let requestStarted = false
const pendingResponses = new Set()
const apiServer = http.createServer(async (request, response) => {
  for await (const _chunk of request) { /* drain */ }
  requestStarted = true
  pendingResponses.add(response)
  response.on('close', () => pendingResponses.delete(response))
})
await new Promise((resolve, reject) => { apiServer.once('error', reject); apiServer.listen(apiPort, '127.0.0.1', resolve) })

const child = spawn(executable, [
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDir}`,
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--window-position=-2400,-2400'
], { cwd: path.dirname(executable), windowsHide: true, shell: false })
let socket
let nextId = 0
const pending = new Map()
const command = (method, params = {}) => {
  const id = ++nextId
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
const evaluate = async (expression) => {
  const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
  return response.result?.value
}

try {
  let page
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      page = pages.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) break
    } catch {}
    await delay(250)
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('待验收应用未开放调试页')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  await command('Runtime.enable')
  await delay(2500)
  await evaluate(`(async () => {
    const attached = await window.aiPlayer.documents.attachPaths([${JSON.stringify(sourcePath)}])
    window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: ${JSON.stringify(sourcePath)} }))
    window.__progressSmoke = window.aiPlayer.documents.run({ tokens: [attached[0].token], instruction: '整理成 Word 报告', outputFormat: 'docx', cloudApproved: false, requestId: 'progress-smoke-task', workspaceTaskId: 'progress-smoke-workspace' })
    return true
  })()`)
  for (let attempt = 0; attempt < 120 && !requestStarted; attempt += 1) await delay(100)
  if (!requestStarted) throw new Error('模型请求未进入受控等待阶段')
  const ui = await evaluate(`(async () => {
    window.dispatchEvent(new CustomEvent('agentplay-open-task-center'))
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (document.body.innerText.includes('短文通常 1–3 分钟')) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const stages = [...document.querySelectorAll('.workspace-journey li')].map((item) => ({ text: item.textContent || '', active: item.classList.contains('is-active') }))
    const indeterminate = document.querySelector('.task-center-progress i.is-indeterminate')
    return {
      text: document.body.innerText,
      stages,
      activeStages: stages.filter((item) => item.active).length,
      indeterminate: Boolean(indeterminate),
      inlineWidth: indeterminate?.style.width || ''
    }
  })()`)
  if (!ui.text.includes('短文通常 1–3 分钟')) throw new Error('任务中心没有显示合理时间范围')
  if (ui.stages.length !== 3) throw new Error(`顶部没有显示三个真实处理阶段：${JSON.stringify(ui.stages)}`)
  if (ui.stages.some((item) => /继续编辑|继续创作|查看结果/.test(item.text))) throw new Error(`把后续动作冒充了处理阶段：${JSON.stringify(ui.stages)}`)
  if (ui.activeStages >= ui.stages.length) throw new Error(`未完成任务提前点亮全部阶段：${JSON.stringify(ui.stages)}`)
  if (!ui.indeterminate || ui.inlineWidth) throw new Error(`未知进度没有使用无数值的动态状态：${JSON.stringify(ui)}`)
  await evaluate(`window.aiPlayer.taskRuntime.cancel('progress-smoke-task')`)
  process.stdout.write(`${JSON.stringify({ timingVisible: true, stages: ui.stages, activeStages: ui.activeStages, indeterminate: ui.indeterminate, fakeInlineWidth: ui.inlineWidth })}\n`)
  socket.send(JSON.stringify({ id: ++nextId, method: 'Browser.close', params: {} }))
  await delay(500)
} finally {
  for (const response of pendingResponses) response.destroy()
  try { socket?.close() } catch {}
  if (child.exitCode === null) child.kill()
  await new Promise((resolve) => apiServer.close(resolve))
}
