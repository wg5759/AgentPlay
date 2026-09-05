import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'peertube-no-login.json'), 'utf8'))
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const executableArg = process.argv.slice(2).find((value) => value.startsWith('--exe='))
const executable = executableArg
  ? path.resolve(executableArg.slice('--exe='.length))
  : path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe')
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-peertube-dl-'))
const port = 19336
if (!fs.existsSync(executable)) throw new Error('missing packaged executable: ' + executable)

const child = spawn(executable, [
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + profileDir,
  '--window-position=-2400,-2400'
], { cwd: path.dirname(executable), windowsHide: true, shell: false })

let websocket
let nextId = 0
const pending = new Map()
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForChildExit(timeoutMs) {
  if (child.exitCode !== null) return
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

async function findPage() {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
      const page = pages.find((item) => item.type === 'page')
      if (page && page.webSocketDebuggerUrl) return page
    } catch { /* not ready */ }
    await delay(250)
  }
  throw new Error('packaged app did not expose a page within 60s')
}

function command(method, params = {}) {
  const id = ++nextId
  websocket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression, awaitPromise = false) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (response.exceptionDetails) {
    throw new Error((response.exceptionDetails.exception && response.exceptionDetails.exception.description) || response.exceptionDetails.text || 'page eval failed')
  }
  return response.result && response.result.value
}

async function waitFor(expression, label, attempts = 480) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await evaluate(expression)) return
    await delay(250)
  }
  throw new Error('timeout waiting for: ' + label)
}

function isIsoBmff(filePath) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(12)
    fs.readSync(fd, buf, 0, 12, 0)
    return buf.subarray(4, 8).toString('ascii') === 'ftyp'
  } finally {
    fs.closeSync(fd)
  }
}

try {
  const page = await findPage()
  websocket = new WebSocket(page.webSocketDebuggerUrl)
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
  await command('Runtime.enable')
  await waitFor('window.aiPlayer?.version === ' + JSON.stringify(expectedVersion), 'version bridge')
  await waitFor("Boolean(document.querySelector('.agent-composer input'))", 'composer')
  await waitFor('Boolean(window.aiPlayer?.siteVideo?.download)', 'siteVideo.download')

  const siteStatus = await evaluate(`(async () => {
    const status = await window.aiPlayer.siteVideo.status()
    if (status?.available) return status
    await window.aiPlayer.siteVideo.downloadComponent()
    for (let i = 0; i < 240; i++) {
      const next = await window.aiPlayer.siteVideo.status()
      if (next?.available) return next
      await new Promise((r) => setTimeout(r, 500))
    }
    return { available: false, error: 'yt-dlp component did not become available' }
  })()`, true)
  if (!siteStatus || !siteStatus.available) {
    throw new Error((siteStatus && siteStatus.error) || fixture.missingFixtureHint || 'site video component unavailable')
  }

  const download = await evaluate(`(async () => {
    const url = ${JSON.stringify(fixture.url)}
    const requestId = 'peertube-smoke-' + Date.now()
    const progress = []
    const off = window.aiPlayer.mediaDownload?.onStatus?.((event) => {
      if (event.requestId === requestId) progress.push(event.status || '')
    })
    try {
      const result = await window.aiPlayer.siteVideo.download({ url, requestId })
      return { result, progress }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), progress }
    } finally {
      try { off?.() } catch {}
    }
  })()`, true)

  if (download.error) {
    const message = String(download.error)
    if (/ENOTFOUND|ECONN|timed out|unreachable|Unable to download webpage|fixture/i.test(message)) {
      throw new Error(fixture.missingFixtureHint + ' Underlying error: ' + message)
    }
    throw new Error(message)
  }

  const result = download.result || {}
  if (!result.success || !result.outputPath) {
    const err = result.error || 'PeerTube download failed without outputPath'
    if (/ENOTFOUND|ECONN|timed out|unreachable|Unable to download webpage/i.test(String(err))) {
      throw new Error(fixture.missingFixtureHint + ' Underlying error: ' + err)
    }
    throw new Error(err)
  }

  const outputPath = String(result.outputPath)
  if (!fs.existsSync(outputPath)) throw new Error('download path missing on disk: ' + outputPath)
  const bytes = Number(result.bytes) || fs.statSync(outputPath).size
  if (!(bytes > 0)) throw new Error('downloaded file is empty: ' + outputPath)
  if (!isIsoBmff(outputPath)) throw new Error('downloaded file is not ISO BMFF/mp4: ' + outputPath)

  const sourceUrl = String(result.sourceUrl || fixture.url)
  if (sourceUrl !== fixture.url && !sourceUrl.includes(fixture.shortId) && !sourceUrl.includes(fixture.uuid)) {
    throw new Error('source URL mismatch: got ' + sourceUrl + ', expected ' + fixture.url)
  }
  if (result.info && result.info.extractor && !/peertube/i.test(String(result.info.extractor))) {
    throw new Error('expected PeerTube extractor, got ' + result.info.extractor)
  }

  try {
    if (outputPath.includes(fixture.shortId) || /PeerTube/i.test(path.basename(outputPath))) {
      fs.rmSync(outputPath, { force: true })
    }
  } catch {}

  process.stdout.write(JSON.stringify({
    version: expectedVersion,
    fixture: fixture.url,
    sourceUrl,
    outputPath,
    bytes,
    container: 'isom/mp4',
    title: (result.info && result.info.title) || null,
    extractor: (result.info && result.info.extractor) || 'PeerTube',
    progressSamples: (download.progress || []).slice(0, 5)
  }) + '\n')

  websocket.send(JSON.stringify({ id: ++nextId, method: 'Browser.close', params: {} }))
  await delay(1000)
} finally {
  try { websocket && websocket.close() } catch {}
  if (child.exitCode === null) child.kill()
  await waitForChildExit(5000)
  const resolvedProfile = path.resolve(profileDir)
  const tempRoot = path.resolve(os.tmpdir()) + path.sep
  if (!resolvedProfile.startsWith(tempRoot) || !path.basename(resolvedProfile).startsWith('agentplay-peertube-dl-')) {
    throw new Error('refusing to clean unexpected profile path: ' + resolvedProfile)
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(resolvedProfile, { recursive: true, force: true })
      break
    } catch (error) {
      if (!error || !['EPERM', 'EBUSY'].includes(error.code) || attempt === 7) throw error
      await delay(500)
    }
  }
}