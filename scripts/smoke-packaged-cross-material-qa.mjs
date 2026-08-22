import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ExcelJS = require('exceljs')
const { ProjectCapsuleStore } = require('../electron/project-capsule-store')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const valueOf = (name, fallback = '') => args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) || fallback
const executable = path.resolve(valueOf('--exe', path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe')))
if (!fs.existsSync(executable)) throw new Error(`缺少待验收 EXE：${executable}`)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const hash = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve) })
  const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  return port
}

function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    const match = (entries || []).find((item) => item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.'))
    if (match) return match.address
  }
  return '0.0.0.0'
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-cross-material-'))
const fixtureDir = path.join(profileDir, 'fixtures'); fs.mkdirSync(fixtureDir)
const videoPath = path.join(fixtureDir, '访谈.mp4')
const subtitlePath = path.join(fixtureDir, '访谈.srt')
const workbookPath = path.join(fixtureDir, '经营数据.xlsx')
fs.writeFileSync(videoPath, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
fs.writeFileSync(subtitlePath, '1\n00:00:04,000 --> 00:00:08,000\n受访者说一月收入100万。\n', 'utf8')
const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('数据'); sheet.addRow(['月份', '收入']); sheet.addRow(['1月', 100]); await workbook.xlsx.writeFile(workbookPath)
const originalHashes = { video: hash(videoPath), subtitle: hash(subtitlePath), workbook: hash(workbookPath) }

const projectStore = new ProjectCapsuleStore({ rootDir: path.join(profileDir, 'project-capsules') })
projectStore.recordTask({ projectId: 'project-cross-material-smoke', taskId: 'seed-project', type: 'project.seed', instruction: '把访谈和经营表放在同一项目', sources: [videoPath, workbookPath], outputs: [] })

const apiPort = await freePort()
const debugPort = await freePort()
const host = lanAddress()
fs.writeFileSync(path.join(profileDir, 'model-config.json'), JSON.stringify({
  schemaVersion: 3,
  roles: { chat: { providerId: 'custom', model: 'cross-material-smoke', baseUrl: `http://${host}:${apiPort}/v1`, encryptedApiKey: '' } },
  profiles: { chat: [{ providerId: 'custom', model: 'cross-material-smoke', baseUrl: `http://${host}:${apiPort}/v1`, encryptedApiKey: '' }] }
}, null, 2), 'utf8')

const calls = []
const apiServer = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  const prompt = (body.messages || []).map((item) => String(item.content || '')).join('\n')
  calls.push(prompt)
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ claims: [
    { text: '访谈与经营表都记录一月收入100万', status: 'confirmed', evidenceIds: ['E4', 'E5'] },
    { text: '当前素材没有二月收入', status: 'unknown', evidenceIds: [] }
  ] }) } }], usage: { prompt_tokens: 200, completion_tokens: 80 } }))
})
await new Promise((resolve, reject) => { apiServer.once('error', reject); apiServer.listen(apiPort, '0.0.0.0', resolve) })

const child = spawn(executable, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--window-position=-2400,-2400'], { cwd: path.dirname(executable), windowsHide: true, shell: false })
let socket
let nextId = 0
const pending = new Map()
const command = (method, params = {}) => {
  const id = ++nextId; socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
const evaluate = async (expression) => {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result?.value
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
    const message = JSON.parse(event.data); const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result)
  })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  await command('Runtime.enable'); await delay(2500)

  const attached = await evaluate(`(async () => {
    const files = await window.aiPlayer.documents.attachPaths([${JSON.stringify(workbookPath)}])
    window.dispatchEvent(new CustomEvent('ai-player-attach-docs', { detail: files }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    const input = document.querySelector('.agent-composer input[type="text"], input[placeholder*="完成什么"], input[placeholder*="下一步"], input[placeholder*="素材"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '对比这些素材，一月收入是否一致？二月收入是多少？')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    document.querySelector('button[aria-label="发送"]').click()
    return { files, input: Boolean(input) }
  })()`)
  if (!attached.input || attached.files?.length !== 1) throw new Error('安装态附件或统一对话入口不可用')

  let waitingTask
  for (let attempt = 0; attempt < 120; attempt += 1) {
    waitingTask = await evaluate(`window.aiPlayer.taskRuntime.list().then((items) => items.find((item) => item.type === 'project.evidence-qa'))`)
    if (waitingTask?.state === 'waiting_approval') break
    await delay(100)
  }
  if (waitingTask?.approval?.action !== 'cloud' || calls.length !== 0) throw new Error(`云端审批前已调用模型：${JSON.stringify({ state: waitingTask?.state, approval: waitingTask?.approval, calls: calls.length })}`)
  const approvalUi = await evaluate(`(() => ({ text: document.body.innerText, checkbox: Boolean(document.querySelector('input[type="checkbox"]')) }))()`)
  if (!approvalUi.checkbox || !approvalUi.text.includes('不上传原文件')) throw new Error('安装态没有显示云端发送边界')

  const switched = await evaluate(`(async () => {
    const cancelled = await window.aiPlayer.crossMaterial.cancel(${JSON.stringify(waitingTask.id)})
    const saved = await window.aiPlayer.models.save({ role: 'chat', providerId: 'custom', model: 'cross-material-smoke', baseUrl: ${JSON.stringify(`http://127.0.0.1:${apiPort}/v1`)}, apiKey: '' })
    await window.aiPlayer.models.routingSettings({ preference: 'local', objective: 'quality' })
    const input = document.querySelector('.agent-composer input[type="text"], input[placeholder*="完成什么"], input[placeholder*="下一步"], input[placeholder*="素材"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '对比这些素材，一月收入是否一致？二月收入是多少？')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 150))
    document.querySelector('button[aria-label="发送"]').click()
    return { cancelled, saved }
  })()`)
  if (!switched.cancelled || switched.saved?.providerId !== 'custom') throw new Error('云端边界验收后未能切换到受控本机模型')

  let task
  for (let attempt = 0; attempt < 600; attempt += 1) {
    task = await evaluate(`window.aiPlayer.taskRuntime.list().then((items) => items.filter((item) => item.type === 'project.evidence-qa' && item.id !== ${JSON.stringify(waitingTask.id)}).at(-1))`)
    if (['completed', 'failed', 'cancelled'].includes(task?.state)) break
    await delay(100)
  }
  if (task?.state !== 'completed' || task.quality?.score !== 100 || task.quality?.passed !== true) throw new Error(`跨素材任务未通过质量门：${JSON.stringify(task)}`)
  if (calls.length !== 1 || !calls[0].includes('受访者说一月收入100万') || !calls[0].includes('"locator":"经营数据.xlsx 数据!B2"')) throw new Error('模型未收到冻结的两类证据或发生重复调用')
  const result = task.result
  if (result.claims?.[0]?.status !== 'confirmed' || result.claims?.[1]?.status !== 'unknown' || result.evidenceReceipt?.sourceCount !== 2 || result.evidenceReceipt?.confirmedCitationsValid !== true) throw new Error('安装态回答三态或引用回执不完整')
  const project = await evaluate(`window.aiPlayer.projects.get('project-cross-material-smoke')`)
  if (project?.materials?.length !== 2 || project?.revisions?.length !== 2 || project?.instructions?.at(-1)?.text !== '对比这些素材，一月收入是否一致？二月收入是多少？') throw new Error('跨素材问答没有记入原项目')
  const bodyText = await evaluate('document.body.innerText')
  for (const marker of ['【已确认】', '[E4][E5]', '经营数据.xlsx 数据!B2', '访谈.mp4 00:04–00:08', '【未知】']) if (!bodyText.includes(marker)) throw new Error(`对话结果缺少 ${marker}`)
  if (hash(videoPath) !== originalHashes.video || hash(subtitlePath) !== originalHashes.subtitle || hash(workbookPath) !== originalHashes.workbook) throw new Error('跨素材只读问答改写了原素材')

  process.stdout.write(`${JSON.stringify({ cloudBoundary: { approval: 'cloud', preApprovalCalls: 0, cancelled: true }, execution: 'controlled-loopback', calls: calls.length, quality: task.quality.score, sourceCount: result.evidenceReceipt.sourceCount, claims: result.claims.map((item) => item.status), locators: result.evidence.map((item) => item.locatorLabel), projectRevisions: project.revisions.length, filesPreserved: true, ui: true })}\n`)
  try { socket.send(JSON.stringify({ id: ++nextId, method: 'Browser.close', params: {} })) } catch {}
  await delay(500)
} finally {
  try { socket?.close() } catch {}
  if (child.exitCode === null) child.kill()
  await new Promise((resolve) => apiServer.close(resolve))
  try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch {}
}
