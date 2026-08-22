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

const analysisText = [
  '## 第一部分　视频讲了什么',
  '### 一句话精华',
  '视频围绕“如何用一份经营数据快速形成决策材料”展开，只依据字幕给出的收入与成本事实，不补写素材中没有出现的结论。',
  '### 内容主线',
  '先提出经营复盘需要统一口径的问题，再给出收入、成本和毛利三个信息层级，最后收束为报告、演示和分析表必须来自同一事实底稿。',
  '### 全片结构时间轴',
  '- 00:00–00:04：开场说明本次要整理经营数据。',
  '- 00:05–00:09：给出一月收入100、成本80的事实。',
  '- 00:09–00:12：说明要形成报告、汇报和分析表。',
  '### 可复制的内容结构',
  '- 先说明问题，再给可核对数字，最后用三种成果承接不同使用场景；所有数字只引用同一证据源。',
  '## 第二部分　专业视听拆解与 AI 复刻',
  '### 分镜与剪辑结构',
  '- 00:00–00:04：人物中景建立任务；复刻时使用稳定机位和单一动作。',
  '- 00:05–00:09：数据出现时切近景或图表，不使用无意义转场。',
  '- 00:09–00:12：三项成果并列收尾，尾卡保留两秒。',
  '### 摄影、构图、灯光与色彩',
  '- 原片观察为眼平固定机位、人物居中、背景保持环境纵深；专业估算为35–50mm等效中景。复刻时用柔和主光保证肤色，图表画面保持高对比蓝白配色。',
  '### 后期、字幕与声音',
  '- 口播为主声道，字幕每屏一到两行；数字出现时用轻量提示音，底乐压低，不遮挡对白。',
  '### AI 复刻执行方案',
  '- 先锁定字幕事实，再生成中景、数据近景和成果尾卡；按字幕语义切镜，最后统一字体、颜色和声音响度。不得复制人物、Logo或受保护素材。',
  '### 生成提示词与素材清单',
  '- 提示词：16:9经营复盘口播，眼平固定机位，柔和主光，真实肤色，蓝白数据图表，克制手势。素材包含人物中景、数据表、字幕、旁白、底乐和尾卡。'
].join('\n')

const apiPort = await freePort()
const debugPort = await freePort()
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-outcome-workflow-'))
const videoPath = path.join(profileDir, '经营复盘.mp4')
const subtitlePath = path.join(profileDir, '经营复盘.srt')
fs.writeFileSync(videoPath, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(4096)]))
fs.writeFileSync(subtitlePath, '1\n00:00:01,000 --> 00:00:05,000\n一月收入100，成本80。\n\n2\n00:00:06,000 --> 00:00:11,000\n请形成报告、PPT和Excel分析表。\n', 'utf8')
fs.writeFileSync(path.join(profileDir, 'model-config.json'), JSON.stringify({
  schemaVersion: 3,
  roles: { chat: { providerId: 'custom', model: 'outcome-smoke', baseUrl: `http://127.0.0.1:${apiPort}/v1`, encryptedApiKey: '' } },
  profiles: { chat: [{ providerId: 'custom', model: 'outcome-smoke', baseUrl: `http://127.0.0.1:${apiPort}/v1`, encryptedApiKey: '' }] }
}, null, 2), 'utf8')

const calls = []
const apiServer = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  const prompt = (body.messages || []).map((item) => String(item.content || '')).join('\n')
  let content
  let kind
  if (prompt.includes('本次只生成 DOCX')) {
    kind = 'docx'; content = { title: '经营复盘报告', content: '# 核心事实\n- 一月收入100\n- 一月成本80\n- 毛利20', factIds: ['F1'] }
  } else if (prompt.includes('本次只生成 PPTX')) {
    kind = 'pptx'; content = { title: '经营复盘汇报', slides: [{ title: '核心事实', bullets: ['收入100', '成本80', '毛利20'], notes: '均来自视频底稿' }], factIds: ['F1'] }
  } else if (prompt.includes('本次只生成 XLSX')) {
    kind = 'xlsx'; content = { sheets: [{ name: '经营数据', rows: [['月份', '收入', '成本', '毛利'], ['1月', 100, 80, 20]] }], factIds: ['F1'] }
  } else {
    kind = 'analysis'; content = analysisText
  }
  calls.push(kind)
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }))
})
await new Promise((resolve, reject) => { apiServer.once('error', reject); apiServer.listen(apiPort, '127.0.0.1', resolve) })

const taskId = `outcome-smoke-${Date.now()}`
const child = spawn(executable, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--window-position=-2400,-2400'], { cwd: path.dirname(executable), windowsHide: true, shell: false })
let socket
let nextId = 0
const pending = new Map()
const command = (method, params = {}) => {
  const id = ++nextId
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
const evaluate = async (expression) => {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result?.value
}
let workflowRoot = ''
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
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result)
  })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  await command('Runtime.enable')
  await delay(2500)
  const result = await evaluate(`(async () => {
    window.aiPlayer.menu.confirmOpenFile(${JSON.stringify(videoPath)})
    await new Promise((resolve) => setTimeout(resolve, 200))
    const detected = await window.aiPlayer.outcomeWorkflow.detect({ sourcePath: ${JSON.stringify(videoPath)}, instruction: '把这个视频做成一套中文拉片报告、PPT 和 Excel 分析表' })
    const run = await window.aiPlayer.outcomeWorkflow.run({ sourcePath: ${JSON.stringify(videoPath)}, mediaName: '经营复盘.mp4', duration: 12, instruction: '把这个视频做成一套中文拉片报告、PPT 和 Excel 分析表', cloudApproved: false, requestId: ${JSON.stringify(taskId)}, workspaceTaskId: 'workspace-${taskId}' })
    return { detected, run }
  })()`)
  if (!result.detected?.matched || result.detected.formats?.length !== 3) throw new Error(`最终成果没有进入编排：${JSON.stringify(result.detected)}`)
  if (!result.run?.success || result.run.quality?.score !== 100 || result.run.quality?.passed !== true) throw new Error(`成果工作流质量门未通过：${JSON.stringify(result.run)}`)
  if (result.run.outputs?.length !== 3 || !result.run.outputs.every((item) => fs.existsSync(item))) throw new Error('最终三格式成果不完整')
  if (result.run.workflowReceipt?.steps?.length !== 2 || !result.run.workflowReceipt.steps.every((item) => item.state === 'completed')) throw new Error('逐步成果回执不完整')
  if (result.run.deliveryReceipt?.bundle?.consistency?.verdict !== 'matched') throw new Error('最终成果没有共享事实底稿')
  if (calls[0] !== 'analysis' || calls.length !== 4 || [...calls.slice(1)].sort().join(',') !== 'docx,pptx,xlsx') throw new Error(`模型调用顺序不符合成果驱动编排：${calls.join(',')}`)
  workflowRoot = path.dirname(result.run.outputs[0])
  const docxOutput = result.run.outputs.find((item) => item.endsWith('.docx'))

  const continuity = await evaluate(`(async () => {
    const duplicate = await window.aiPlayer.outcomeWorkflow.run({ sourcePath: ${JSON.stringify(videoPath)}, mediaName: '经营复盘.mp4', duration: 12, instruction: '把这个视频做成一套中文拉片报告、PPT 和 Excel 分析表', cloudApproved: false, requestId: '${taskId}-duplicate', workspaceTaskId: 'workspace-${taskId}-duplicate' })
    const attached = await window.aiPlayer.documents.attachPaths([${JSON.stringify(docxOutput)}])
    const continued = await window.aiPlayer.documents.run({ tokens: [attached[0].token], instruction: '继续把这个结果转换为 TXT', outputFormat: 'auto', cloudApproved: false, requestId: '${taskId}-continue', workspaceTaskId: 'workspace-${taskId}-continue' })
    const projects = await window.aiPlayer.projects.list()
    const project = await window.aiPlayer.projects.get(continued.projectCapsule.projectId)
    return { duplicate, continued, projects, project }
  })()`)
  if (!continuity.duplicate?.reused || calls.length !== 4) throw new Error(`相同内容被重复处理：${JSON.stringify({ duplicate: continuity.duplicate, calls })}`)
  if (!continuity.continued?.success || continuity.continued.projectCapsule?.revision !== 2 || continuity.continued.projectCapsule?.projectId !== result.run.projectCapsule?.projectId) throw new Error(`继续修改没有进入同一项目新版本：${JSON.stringify(continuity.continued)}`)
  if (continuity.project?.materials?.length !== 2 || continuity.project?.artifacts?.length < 5 || continuity.project?.instructions?.length !== 2) throw new Error(`混合项目清单或版本关系不完整：${JSON.stringify(continuity.project)}`)
  const lifecycle = await evaluate(`(async () => {
    const projectId = ${JSON.stringify(continuity.continued.projectCapsule.projectId)}
    const archived = await window.aiPlayer.projects.archive({ projectId })
    const active = await window.aiPlayer.projects.archive({ projectId, archived: false })
    const copied = await window.aiPlayer.projects.copy(projectId)
    const copiedProject = await window.aiPlayer.projects.get(copied.projectId)
    const requestId = 'trash-${taskId}'
    const planned = await window.aiPlayer.projects.trash({ projectId: copied.projectId, requestId })
    const trashed = await window.aiPlayer.projects.trash({ projectId: copied.projectId, requestId, approvalId: planned.approval.id, approvalToken: planned.approval.token })
    const trash = await window.aiPlayer.projects.listTrash()
    const restored = await window.aiPlayer.projects.restore(copied.projectId)
    return { archived, active, copied, copiedProject, planned, trashed, trash, restored }
  })()`)
  if (lifecycle.archived.status !== 'archived' || lifecycle.active.status !== 'active') throw new Error('项目归档/取消归档失败')
  if (lifecycle.copied.projectId === continuity.continued.projectCapsule.projectId || lifecycle.copiedProject.materials[0].locations[0] !== videoPath) throw new Error('项目复制没有生成独立胶囊或错误复制素材')
  if (!lifecycle.planned.requiresApproval || lifecycle.planned.approval.action !== 'delete' || lifecycle.trashed.projectCapsule.status !== 'trashed' || !lifecycle.trash.some((item) => item.projectId === lifecycle.copied.projectId) || lifecycle.restored.status !== 'active') throw new Error(`统一删除审批/回收/恢复失败：${JSON.stringify(lifecycle)}`)
  if (!result.run.outputs.every((item) => fs.existsSync(item))) throw new Error('项目移入回收区时删除了用户成果文件')

  const ui = await evaluate(`(async () => {
    window.dispatchEvent(new CustomEvent('agentplay-open-task-center'))
    for (let i = 0; i < 120; i += 1) {
      const text = document.body.innerText
      if (text.includes('逐步成果回执已完成') && text.includes('质量评分 100')) return text
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return document.body.innerText
  })()`)
  for (const marker of ['视频内容成果包', '工作流来源已验证', '逐步成果回执已完成', '质量评分 100', '继续修改']) {
    if (!ui.includes(marker)) throw new Error(`任务中心缺少 ${marker}`)
  }
  process.stdout.write(`${JSON.stringify({ formats: result.detected.formats, calls, outputs: result.run.outputs.map((item) => ({ ext: path.extname(item), bytes: fs.statSync(item).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(item)).digest('hex') })), quality: result.run.quality.score, consistency: result.run.deliveryReceipt.bundle.consistency.verdict, reusedWithoutCalls: continuity.duplicate.reused, project: { id: continuity.continued.projectCapsule.projectId, revision: continuity.continued.projectCapsule.revision, materials: continuity.project.materials.length, artifacts: continuity.project.artifacts.length, instructions: continuity.project.instructions.length }, lifecycle: { archived: lifecycle.archived.status, copied: lifecycle.copied.projectId, deleteApproval: lifecycle.planned.approval.action, trashed: lifecycle.trashed.projectCapsule.status, restored: lifecycle.restored.status, filesPreserved: true }, ui: true })}\n`)
  socket.send(JSON.stringify({ id: ++nextId, method: 'Browser.close', params: {} }))
  await delay(500)
} finally {
  try { socket?.close() } catch {}
  if (child.exitCode === null) child.kill()
  await new Promise((resolve) => apiServer.close(resolve))
  const documentsRoot = path.resolve(path.join(os.homedir(), 'Documents', 'AgentPlay 输出')) + path.sep
  if (workflowRoot && path.resolve(workflowRoot).startsWith(documentsRoot) && path.basename(workflowRoot) === `视频成果包-${taskId}`) {
    try { fs.rmSync(workflowRoot, { recursive: true, force: true }) } catch {}
  }
}
