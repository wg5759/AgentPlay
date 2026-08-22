import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ExcelJS = require('exceljs')
const { PDFDocument } = require('pdf-lib')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = path.resolve(process.argv.find((item) => item.startsWith('--exe='))?.slice(6) || path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe'))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-unified-content-'))
const fixture = path.join(profile, 'fixtures'); fs.mkdirSync(fixture)
const xlsx = path.join(fixture, 'data.xlsx'); const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('数据').addRows([['月份', '收入'], ['1月', 100]]); await workbook.xlsx.writeFile(xlsx)
const pdf = path.join(fixture, 'report.pdf'); const pdfDoc = await PDFDocument.create(); pdfDoc.addPage(); pdfDoc.addPage(); fs.writeFileSync(pdf, await pdfDoc.save())
const png = path.join(fixture, 'image.png'); fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAQAAABWKLW/AAAADElEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
const video = path.join(fixture, 'video.mp4'); fs.writeFileSync(video, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)])); fs.writeFileSync(path.join(fixture, 'video.srt'), '1\n00:00:01,000 --> 00:00:03,000\n证据字幕\n', 'utf8')
const server = net.createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise((resolve) => server.close(resolve))
const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-position=-2400,-2400'], { cwd: path.dirname(executable), windowsHide: true, shell: false })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); let socket; let id = 0; const pending = new Map()
try {
  let page
  for (let i = 0; i < 240; i += 1) { try { const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); page = pages.find((item) => item.type === 'page'); if (page?.webSocketDebuggerUrl) break } catch {} await delay(250) }
  if (!page) throw new Error('桌面候选未就绪')
  socket = new WebSocket(page.webSocketDebuggerUrl); socket.addEventListener('message', (event) => { const msg = JSON.parse(event.data); const waiter = pending.get(msg.id); if (!waiter) return; pending.delete(msg.id); msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result) }); await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
  const command = (method, params = {}) => { const next = ++id; socket.send(JSON.stringify({ id: next, method, params })); return new Promise((resolve, reject) => pending.set(next, { resolve, reject })) }
  const evaluate = async (expression) => { const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value }
  await command('Runtime.enable'); await delay(2500)
  const result = await evaluate(`(async () => {
    await window.aiPlayer.documents.attachPaths([${JSON.stringify(xlsx)}, ${JSON.stringify(pdf)}, ${JSON.stringify(png)}])
    window.aiPlayer.menu.confirmOpenFile(${JSON.stringify(video)})
    await new Promise((resolve) => setTimeout(resolve, 100))
    const detected = await Promise.all([
      window.aiPlayer.linkContent.detect('https://github.com/wg5759/AgentPlay'),
      window.aiPlayer.linkContent.detect('https://example.com/report.pdf'),
      window.aiPlayer.linkContent.detect('https://example.com/feed.rss')
    ])
    const publicPreview = await window.aiPlayer.linkContent.handle({ url: 'https://example.com/', instruction: '读取这个公开网页' })
    const added = publicPreview.success ? await window.aiPlayer.linkContent.handle({ url: 'https://example.com/', instruction: '加入项目' }) : null
    const evidence = await Promise.all([${JSON.stringify(xlsx)}, ${JSON.stringify(pdf)}, ${JSON.stringify(png)}, ${JSON.stringify(video)}].map((file) => window.aiPlayer.evidence.inspectFile(file)))
    return { detected, publicPreview, added, evidence }
  })()`)
  assert(result.detected.map((item) => item.kind).join(',') === 'github,public-pdf,rss', '链接分类错误')
  assert(result.publicPreview.success && result.publicPreview.evidence.length > 0, '公开网页预览或段落证据失败')
  assert(result.added?.projectCapsule?.projectId, '公开网页没有加入项目')
  assert(result.evidence.map((item) => item.evidence[0]?.evidenceKind).join(',') === 'sheet-cell,document-page,image-region,video-time', '本地证据定位不完整')
  process.stdout.write(`${JSON.stringify({ linkKinds: result.detected.map((item) => item.kind), publicEvidence: result.publicPreview.evidence.length, projectId: result.added.projectCapsule.projectId, localEvidenceKinds: result.evidence.map((item) => item.evidence[0].evidenceKind) })}\n`)
  socket.send(JSON.stringify({ id: ++id, method: 'Browser.close', params: {} })); await delay(500)
} finally { try { socket?.close() } catch {}; if (child.exitCode === null) child.kill() }

function assert(value, message) { if (!value) throw new Error(message) }
