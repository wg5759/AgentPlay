const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const crypto = require('node:crypto')
const { LocalAiDownloadService } = require('../electron/local-ai-download-service')
const sha = value => crypto.createHash('sha256').update(value).digest('hex')

async function fixture(t, handler, options = {}) {
  const data = crypto.randomBytes(128 * 1024)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'component-recovery-'))
  const requests = []
  const server = http.createServer((req, res) => { requests.push(req.headers.range || ''); handler(req, res, data, requests.length) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const manifest = { schemaVersion: 1, tag: 'recovery-fixture', assets: [{ id: 'tool', kind: 'file', role: 'engine', path: 'tool.exe', size: data.length, sha256: sha(data), url: `http://127.0.0.1:${server.address().port}/tool` }] }
  const service = new LocalAiDownloadService({ installRoot: root, manifest, localOnly: true, maxAttempts: 2, headersTimeoutMs: 2000, idleTimeoutMs: 2000, totalTimeoutMs: 8000, retryDelayMs: 5, ...options })
  t.after(() => { service.cancel(); server.closeAllConnections(); server.close(); assert.ok(root.startsWith(path.join(os.tmpdir(), 'component-recovery-'))); fs.rmSync(root, { recursive: true, force: true }) })
  return { data, root, service, requests }
}
function complete(res, data, offset = 0) {
  res.writeHead(offset ? 206 : 200, { 'Content-Length': data.length - offset, ...(offset ? { 'Content-Range': `bytes ${offset}-${data.length - 1}/${data.length}` } : {}) })
  res.end(data.subarray(offset))
}

test('an interrupted response resumes automatically without counting bytes twice', async t => {
  const f = await fixture(t, (req, res, data, n) => {
    if (n === 1) { res.writeHead(200, { 'Content-Length': data.length }); res.write(data.subarray(0, 65536)); setTimeout(() => res.destroy(), 30) }
    else complete(res, data, Number(/bytes=(\d+)-/.exec(req.headers.range)?.[1] || 0))
  })
  const progress = []
  await f.service.start({ onProgress: p => progress.push(p.receivedBytes) })
  assert.equal(f.requests.length, 2)
  assert.match(f.requests[1], /^bytes=[1-9]\d*-$/)
  assert.equal(sha(fs.readFileSync(path.join(f.root, 'tool.exe'))), sha(f.data))
  assert.ok(progress.every(n => n <= f.data.length))
})

test('headers and body stalls have bounded timeouts and release the active slot', async t => {
  for (const bodyStall of [false, true]) {
    const f = await fixture(t, (_req, res) => { if (bodyStall) { res.writeHead(200); res.write(Buffer.from('partial')) } }, { maxAttempts: 1, headersTimeoutMs: 100, idleTimeoutMs: 100, totalTimeoutMs: 800 })
    const watchdog = setTimeout(() => f.service.cancel(), 1500)
    const started = Date.now()
    await assert.rejects(f.service.start(), /超时|停滞/)
    clearTimeout(watchdog)
    assert.ok(Date.now() - started < 1300)
    assert.equal(f.service.status().active, false)
  }
})

test('explicit cancellation does not turn into a retry', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200); res.write(Buffer.from('partial')) })
  const work = f.service.start()
  while (!f.requests.length) await new Promise(resolve => setTimeout(resolve, 5))
  f.service.cancel()
  await assert.rejects(work, /已取消/)
  assert.equal(f.requests.length, 1)
})

test('a fully downloaded part is verified and installed without another network request', async t => {
  const f = await fixture(t, (_req, res) => res.writeHead(503).end())
  fs.writeFileSync(path.join(f.root, 'tool.exe.part'), f.data)
  await f.service.start()
  assert.equal(f.requests.length, 0)
  assert.equal(sha(fs.readFileSync(path.join(f.root, 'tool.exe'))), sha(f.data))
})

test('same-sized corrupt installed components are not accepted as intact', async t => {
  const f = await fixture(t, (_req, res, data) => complete(res, data))
  fs.writeFileSync(path.join(f.root, 'tool.exe'), Buffer.alloc(f.data.length))
  assert.equal(f.service.status().installed, false, 'bytes alone are not a verified completed installation')
  await f.service.start()
  assert.equal(f.requests.length, 1)
  assert.equal(sha(fs.readFileSync(path.join(f.root, 'tool.exe'))), sha(f.data))
})

test('wrong range responses are rejected before altering a valid partial download', async t => {
  const f = await fixture(t, (_req, res, data) => { res.writeHead(206, { 'Content-Range': `bytes 0-${data.length - 1}/${data.length}` }); res.end(data) })
  const part = path.join(f.root, 'tool.exe.part'), initial = f.data.subarray(0, 4096)
  fs.writeFileSync(part, initial)
  await assert.rejects(f.service.start(), /续传|范围/)
  assert.equal(f.requests.length, 1)
  assert.deepEqual(fs.readFileSync(part), initial)
})

test('permanent HTTP errors and long server retry windows are not hammered', async t => {
  for (const status of [403, 429]) {
    const f = await fixture(t, (_req, res) => res.writeHead(status, { 'Retry-After': '600' }).end())
    await assert.rejects(f.service.start())
    assert.equal(f.requests.length, 1)
  }
})

test('two managed packs sharing a folder keep separate verified receipts', async t => {
  const f = await fixture(t, (_req, res, data) => complete(res, data))
  await f.service.start()
  const manifest = { ...f.service.manifest, tag: 'second-pack', assets: [{ ...f.service.manifest.assets[0], path: 'second.bin' }] }
  const other = new LocalAiDownloadService({ installRoot: f.root, manifest, localOnly: true })
  await other.start()
  assert.equal(f.service.status().installed, true)
  assert.equal(other.status().installed, true)
})
