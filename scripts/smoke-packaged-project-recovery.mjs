import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
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
const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function openSession(profileDir) {
  const startedAt = Date.now()
  const debugPort = await freePort()
  const child = spawn(executable, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--window-position=-2400,-2400'], { cwd: path.dirname(executable), windowsHide: true, shell: false })
  let socket
  let nextId = 0
  const pending = new Map()
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
    const command = (method, params = {}) => {
      const id = ++nextId
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    }
    await command('Runtime.enable')
    await delay(2000)
    const evaluate = async (expression) => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
      return result.result?.value
    }
    return {
      child,
      readyMs: Date.now() - startedAt,
      evaluate,
      close: async () => {
        const exited = child.exitCode === null ? new Promise((resolve) => child.once('exit', resolve)) : Promise.resolve()
        try { socket.send(JSON.stringify({ id: ++nextId, method: 'Browser.close', params: {} })) } catch {}
        await Promise.race([exited, delay(5000)])
        if (child.exitCode === null) child.kill()
        try { socket.close() } catch {}
      }
    }
  } catch (error) {
    try { socket?.close() } catch {}
    if (child.exitCode === null) child.kill()
    throw error
  }
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-project-recovery-'))
const projectDir = path.join(profileDir, 'mixed-materials')
const capsuleDir = path.join(profileDir, 'project-capsules')
fs.mkdirSync(projectDir, { recursive: true })
fs.mkdirSync(capsuleDir, { recursive: true })
const files = [
  ['video', '访谈.mp4', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(256)])],
  ['audio', '旁白.wav', Buffer.from('RIFF0000WAVEfmt ')],
  ['subtitle', '字幕.srt', Buffer.from('1\n00:00:00,000 --> 00:00:02,000\n混合项目\n', 'utf8')],
  ['image', '封面.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64)])],
  ['pdf', '资料.pdf', Buffer.from('%PDF-1.4\n%%EOF')],
  ['office', '报告.docx', Buffer.concat([Buffer.from('PK'), Buffer.alloc(128)])],
  ['document', '笔记.txt', Buffer.from('项目事实底稿', 'utf8')]
].map(([kind, name, data], index) => {
  const filePath = path.join(projectDir, name)
  fs.writeFileSync(filePath, data)
  return { id: `real-material-${index}`, kind, name, bytes: fs.statSync(filePath).size, sha256: sha256(filePath), locations: [filePath], version: 1, addedAt: index + 1 }
})

const makeProject = (index) => ({
  id: `pressure-${index}`,
  name: `压力项目 ${index}`,
  createdAt: index,
  updatedAt: index,
  materials: Array.from({ length: 40 }, (_, materialIndex) => ({ id: `p-${index}-m-${materialIndex}`, kind: materialIndex % 2 ? 'video' : 'office', name: `m-${materialIndex}`, bytes: 1, sha256: 'a'.repeat(64), locations: [`C:\\AgentPlay-fixture\\${index}-${materialIndex}`], version: 1, addedAt: 1 })),
  artifacts: Array.from({ length: 20 }, (_, artifactIndex) => ({ id: `p-${index}-a-${artifactIndex}`, role: 'deliverable', kind: 'document', path: `C:\\AgentPlay-output\\${index}-${artifactIndex}.txt`, name: `${artifactIndex}.txt`, bytes: 1, sha256: 'b'.repeat(64), derivedFrom: [`p-${index}-m-0`], createdAt: artifactIndex })),
  references: [],
  instructions: Array.from({ length: 10 }, (_, instructionIndex) => ({ id: `p-${index}-i-${instructionIndex}`, text: `第 ${instructionIndex + 1} 版`, taskId: `p-${index}-t-${instructionIndex}`, createdAt: instructionIndex })),
  revisions: Array.from({ length: 10 }, (_, revisionIndex) => ({ id: `p-${index}-r-${revisionIndex}`, number: revisionIndex + 1, taskId: `p-${index}-t-${revisionIndex}`, instructionId: `p-${index}-i-${revisionIndex}`, sourceIds: [`p-${index}-m-0`], artifactIds: [`p-${index}-a-${revisionIndex}`], createdAt: revisionIndex })),
  current: { revisionId: `p-${index}-r-9`, revision: 10, artifactIds: [`p-${index}-a-9`], primaryArtifactId: `p-${index}-a-9` }
})

const realProject = {
  id: 'real-mixed-project',
  name: '真实混合项目',
  createdAt: 1,
  updatedAt: 100000,
  materials: files,
  artifacts: [],
  references: [{ id: 'real-reference', kind: 'web', uri: 'https://example.com/evidence', addedAt: 1 }],
  instructions: [{ id: 'real-instruction', text: '将视频、旁白、字幕、封面和办公资料整理为同一项目', taskId: 'real-task', createdAt: 1 }],
  revisions: [{ id: 'real-revision', number: 1, taskId: 'real-task', instructionId: 'real-instruction', sourceIds: files.map((item) => item.id), artifactIds: [], createdAt: 1 }],
  current: { revisionId: 'real-revision', revision: 1, artifactIds: [], primaryArtifactId: '' }
}

const statePath = path.join(capsuleDir, 'project-capsules-v1.json')
fs.writeFileSync(statePath, `${JSON.stringify({ schemaVersion: 0, projects: [...Array.from({ length: 200 }, (_, index) => makeProject(index)), realProject] }, null, 2)}\n`, 'utf8')

let first
let second
let migrationReadyMs = 0
let recoveryReadyMs = 0
try {
  first = await openSession(profileDir)
  if (first.readyMs >= 30000) throw new Error(`安装态冷启动耗时 ${first.readyMs}ms`)
  migrationReadyMs = first.readyMs
  const migrated = await first.evaluate(`(async () => {
    const startedAt = performance.now()
    const projects = await window.aiPlayer.projects.list()
    const listMs = performance.now() - startedAt
    const mixed = await window.aiPlayer.projects.get('real-mixed-project')
    const pressure = await window.aiPlayer.projects.get('pressure-199')
    return { projects, mixed, pressure, listMs }
  })()`)
  if (migrated.projects?.length !== 100 || migrated.projects[0]?.projectId !== 'real-mixed-project') throw new Error(`大项目列表未受控：${JSON.stringify(migrated.projects?.slice(0, 2))}`)
  if (migrated.mixed?.materials?.length !== 7 || new Set(migrated.mixed.materials.map((item) => item.kind)).size !== 7 || migrated.mixed?.revisions?.length !== 1) throw new Error('真实混合项目冷启动恢复不完整')
  if (migrated.pressure?.materials?.length !== 40 || migrated.pressure?.revisions?.length !== 10) throw new Error('压力项目被截断')
  if (migrated.listMs >= 2000) throw new Error(`安装态项目列表耗时 ${migrated.listMs.toFixed(0)}ms`)
  await first.close(); first = null

  const migratedState = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const backupState = JSON.parse(fs.readFileSync(`${statePath}.bak`, 'utf8'))
  const legacySnapshots = fs.readdirSync(capsuleDir).filter((name) => name.includes('.legacy-v0-'))
  if (migratedState.schemaVersion !== 1 || backupState.schemaVersion !== 1 || legacySnapshots.length !== 1) throw new Error('安装态 v0 迁移或原始快照不完整')

  fs.writeFileSync(statePath, '{damaged-installed-state', 'utf8')
  second = await openSession(profileDir)
  if (second.readyMs >= 30000) throw new Error(`安装态损坏恢复启动耗时 ${second.readyMs}ms`)
  recoveryReadyMs = second.readyMs
  const recovered = await second.evaluate(`(async () => {
    const projects = await window.aiPlayer.projects.list()
    const mixed = await window.aiPlayer.projects.get('real-mixed-project')
    return { projects, mixed }
  })()`)
  if (recovered.projects?.length !== 100 || recovered.mixed?.materials?.length !== 7 || recovered.mixed?.current?.revision !== 1) throw new Error('安装态损坏恢复后项目不完整')
  await second.close(); second = null

  const corruptSnapshots = fs.readdirSync(capsuleDir).filter((name) => name.includes('.corrupt-'))
  if (corruptSnapshots.length !== 1 || fs.readFileSync(path.join(capsuleDir, corruptSnapshots[0]), 'utf8') !== '{damaged-installed-state') throw new Error('损坏原件未保留')
  if (JSON.parse(fs.readFileSync(statePath, 'utf8')).schemaVersion !== 1) throw new Error('恢复后主状态不可读')
  if (!files.every((item) => fs.existsSync(item.locations[0]) && sha256(item.locations[0]) === item.sha256)) throw new Error('迁移或恢复改写了用户素材')

  process.stdout.write(`${JSON.stringify({ migrated: true, recovered: true, migrationReadyMs, recoveryReadyMs, projects: 201, visibleProjects: 100, mixedMaterialKinds: files.map((item) => item.kind), revisions: 2001, legacySnapshot: legacySnapshots[0], corruptSnapshot: corruptSnapshots[0], filesPreserved: true })}\n`)
} finally {
  try { await first?.close() } catch {}
  try { await second?.close() } catch {}
  try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch {}
}
