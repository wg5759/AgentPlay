import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
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
const receiptPath = path.resolve(valueOf('--receipt', path.join(root, 'artifacts', 'acceptance', 'document-bundle', 'receipt.json')))
if (!fs.existsSync(executable)) throw new Error(`缺少待验收 EXE：${executable}`)

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const digest = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  if (!port) throw new Error('无法分配验收端口')
  return port
}

const apiPort = await freePort()
const debugPort = await freePort()
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-document-bundle-'))
const sourcePath = path.join(profileDir, '经营资料.txt')
fs.writeFileSync(sourcePath, '1月收入100，成本80。', 'utf8')
fs.writeFileSync(path.join(profileDir, 'model-config.json'), JSON.stringify({
  schemaVersion: 3,
  roles: { chat: { providerId: 'custom', model: 'bundle-smoke', baseUrl: `http://127.0.0.1:${apiPort}/v1`, encryptedApiKey: '' } },
  profiles: { chat: [{ providerId: 'custom', model: 'bundle-smoke', baseUrl: `http://127.0.0.1:${apiPort}/v1`, encryptedApiKey: '' }] }
}, null, 2), 'utf8')

const modelCalls = []
const apiServer = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  const prompt = (body.messages || []).map((message) => String(message.content || '')).join('\n')
  modelCalls.push({ url: request.url, prompt })
  let content
  if (prompt.includes('本次只生成 DOCX')) {
    content = { title: '经营报告', content: '# 核心数据\n- 1月收入100，成本80。', factIds: ['F1'] }
  } else if (prompt.includes('本次只生成 XLSX')) {
    content = { sheets: [{ name: '月度数据', rows: [['月份', '收入', '成本'], ['1月', 100, 80]] }], factIds: ['F1'] }
  } else {
    content = { title: '未知任务', content: '资料不足', factIds: ['F1'] }
  }
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ id: 'bundle-smoke', choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }], usage: { prompt_tokens: 64, completion_tokens: 32 } }))
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
    if (child.exitCode !== null) throw new Error(`待验收应用提前退出：${child.exitCode}`)
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
  await delay(3000)

  const result = await evaluate(`(async () => {
    const attached = await window.aiPlayer.documents.attachPaths([${JSON.stringify(sourcePath)}])
    if (!Array.isArray(attached) || attached.length !== 1) throw new Error('来源附件授权失败')
    return window.aiPlayer.documents.run({
      tokens: [attached[0].token],
      instruction: '做成一套 Word 报告和 Excel 分析表',
      outputFormat: 'auto',
      cloudApproved: false,
      requestId: 'document-bundle-smoke',
      workspaceTaskId: 'workspace-document-bundle-smoke'
    })
  })()`)
  if (!result?.success) throw new Error(`成果包执行失败：${JSON.stringify(result)}`)
  if (result.quality?.score !== 100 || result.quality?.passed !== true) throw new Error(`成果包质量门未满分通过：${JSON.stringify(result.quality)}`)
  if (result.deliveryReceipt?.bundle?.consistency?.verdict !== 'matched') throw new Error('成果包一致性回执未通过')
  if (result.outputs?.length !== 2 || !result.outputs.every((item) => fs.existsSync(item))) throw new Error('成果包文件不完整')
  if (modelCalls.length !== 2 || !modelCalls.every((item) => item.prompt.includes('agentplay.bundle-source-ledger'))) throw new Error('格式生成没有共用冻结事实底稿')

  const ui = await evaluate(`(async () => {
    window.dispatchEvent(new CustomEvent('agentplay-open-task-center'))
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const text = document.body.innerText
      if (text.includes('质量评分 100') && text.includes('来源指纹已冻结') && text.includes('成果包一致性已验证') && text.includes('继续修改')) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const before = document.body.innerText
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('继续修改'))
    if (!button) return { before, continued: false, input: '' }
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const input = document.querySelector('input[placeholder], textarea')?.value || ''
    return { before, continued: true, input }
  })()`)
  for (const marker of ['质量评分 100', '来源指纹已冻结', '成果包一致性已验证', '继续修改']) {
    if (!ui.before.includes(marker)) throw new Error(`任务中心缺少 ${marker}`)
  }
  if (!ui.continued || !ui.input.includes('继续修改')) throw new Error(`继续修改入口不可用：${JSON.stringify(ui)}`)

  const receipt = {
    acceptedAt: new Date().toISOString(),
    executable,
    executableSha256: digest(executable),
    source: { path: sourcePath, sha256: digest(sourcePath) },
    outputs: result.outputs.map((outputPath) => ({ path: outputPath, bytes: fs.statSync(outputPath).size, sha256: digest(outputPath) })),
    quality: result.quality,
    deliveryReceipt: result.deliveryReceipt,
    modelCalls: modelCalls.map((item) => ({ url: item.url, sharedLedger: item.prompt.includes('agentplay.bundle-source-ledger') })),
    ui: { qualityVisible: true, provenanceVisible: true, consistencyVisible: true, continueModificationWorked: true }
  }
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf8')
  process.stdout.write(`${JSON.stringify({ receiptPath, quality: result.quality.score, outputs: receipt.outputs, ui: receipt.ui })}\n`)
  socket.send(JSON.stringify({ id: ++nextId, method: 'Browser.close', params: {} }))
  await delay(1000)
} finally {
  try { socket?.close() } catch {}
  if (child.exitCode === null) child.kill()
  await new Promise((resolve) => apiServer.close(resolve))
}
