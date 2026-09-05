const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const JSZip = require('jszip')
const {
  DEFAULT_ALLOWED_HOSTS,
  LocalAiDownloadService,
  validateManifest
} = require('../electron/local-ai-download-service')
const { BundledLocalRuntime, LOCKED_MODEL_SHA256, verifyBundle } = require('../electron/bundled-local-runtime')
const PROD_MANIFEST = require('../electron/local-ai-pack-manifest')

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function serve(routes) {
  const seen = { ranges: [] }
  const server = http.createServer((req, res) => {
    const route = routes[req.url]
    if (!route) {
      res.writeHead(404).end('not found')
      return
    }
    if (route.redirect) {
      res.writeHead(302, { Location: route.redirect }).end()
      return
    }
    const body = route.body
    const range = /^bytes=(\d+)-$/.exec(req.headers.range || '')
    if (route.slow) {
      res.writeHead(range ? 206 : 200, { 'Content-Length': body.length })
      let offset = range ? Number(range[1]) : 0
      const timer = setInterval(() => {
        if (offset >= body.length) {
          clearInterval(timer)
          res.end()
          return
        }
        const end = Math.min(offset + 64 * 1024, body.length)
        res.write(body.subarray(offset, end))
        offset = end
      }, 25)
      req.on('close', () => clearInterval(timer))
      return
    }
    if (range) {
      seen.ranges.push(req.headers.range)
      const from = Number(range[1])
      res.writeHead(206, { 'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}` })
      res.end(body.subarray(from))
      return
    }
    res.writeHead(200)
    res.end(body)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }))
  })
}

async function makePack() {
  const modelBuffer = Buffer.concat([Buffer.from('GGUF'), crypto.randomBytes(256 * 1024)])
  const runtimeFiles = [
    { path: 'ai-runtime/win-x64/llama-server.exe', buffer: crypto.randomBytes(32 * 1024) },
    { path: 'ai-runtime/win-x64/ggml.dll', buffer: crypto.randomBytes(16 * 1024) },
    { path: 'licenses/llama.cpp/LICENSE.txt', buffer: Buffer.from('MIT license text') }
  ]
  const zip = new JSZip()
  for (const file of runtimeFiles) zip.file(file.path, file.buffer)
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' })
  return { modelBuffer, runtimeFiles, zipBuffer }
}

function buildManifest(baseUrl, pack, overrides = {}) {
  return {
    schemaVersion: 1,
    tag: 'test-pack',
    product: '测试组件包',
    assets: [
      {
        id: 'model', kind: 'file', role: 'model', label: '模型',
        path: 'models/Qwen2.5-0.5B-Instruct-Q4_0.gguf',
        url: overrides.modelUrl || `${baseUrl}/model`,
        size: pack.modelBuffer.length,
        sha256: overrides.modelSha256 || sha256(pack.modelBuffer)
      },
      {
        id: 'runtime', kind: 'zip', label: '运行时',
        url: `${baseUrl}/runtime`,
        size: pack.zipBuffer.length,
        sha256: sha256(pack.zipBuffer),
        files: pack.runtimeFiles.map((file) => ({ path: file.path, size: file.buffer.length, sha256: sha256(file.buffer) }))
      }
    ]
  }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('engine-only component packs finish without inventing a model asset', async (t) => {
  const body = Buffer.from('fixture-tool')
  const { server, port } = await serve({ '/tool': { body } })
  const installRoot = tempDir('toolpack-e2e-')
  t.after(() => { server.close(); fs.rmSync(installRoot, { recursive: true, force: true }) })
  const manifest = { schemaVersion: 1, tag: 'tool-fixture', assets: [{ id: 'tool', kind: 'file', role: 'engine', path: 'tool.exe', url: `http://127.0.0.1:${port}/tool`, size: body.length, sha256: sha256(body) }] }
  const service = new LocalAiDownloadService({ installRoot, manifest, localOnly: true })
  await service.start()
  assert.equal(service.status().installed, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(installRoot, 'bundled-ai-manifest.json'))).model, undefined)
})

test('zip entry identity and installation path are separate and both hash-checked', async (t) => {
  const pack = await makePack()
  const manifest = buildManifest('http://127.0.0.1:1', pack)
  const engine = manifest.assets.find(asset => asset.kind === 'zip')
  const zip = new JSZip()
  pack.runtimeFiles.forEach((file, i) => { const entry = `Release/file-${i}`; zip.file(entry, file.buffer); engine.files[i].archivePath = entry })
  const body = await zip.generateAsync({ type: 'nodebuffer' })
  engine.size = body.length; engine.sha256 = sha256(body)
  const { server, port } = await serve({ '/model': { body: pack.modelBuffer }, '/runtime': { body } })
  manifest.assets.forEach(asset => { asset.url = asset.url.replace(':1/', `:${port}/`) })
  const installRoot = tempDir('zip-entry-e2e-')
  t.after(() => { server.close(); fs.rmSync(installRoot, { recursive: true, force: true }) })
  await new LocalAiDownloadService({ installRoot, manifest, localOnly: true }).start()
  for (const file of pack.runtimeFiles) assert.equal(sha256(fs.readFileSync(path.join(installRoot, file.path))), sha256(file.buffer))
  engine.files[0].archivePath = '../escape'
  assert.throws(() => validateManifest(manifest), /路径/)
})

test('local AI pack downloads, verifies, extracts and writes a runtime-compatible manifest', async (t) => {
  const pack = await makePack()
  const { server, port } = await serve({
    '/model': { body: pack.modelBuffer },
    '/runtime': { body: pack.zipBuffer }
  })
  const installRoot = tempDir('localai-e2e-')
  t.after(() => { server.close(); fs.rmSync(installRoot, { recursive: true, force: true }) })

  const service = new LocalAiDownloadService({ installRoot, manifest: buildManifest(`http://127.0.0.1:${port}`, pack), localOnly: true })
  const stages = []
  await service.start({ onProgress: (p) => stages.push(p.stage) })

  assert.ok(fs.existsSync(path.join(installRoot, 'models', 'Qwen2.5-0.5B-Instruct-Q4_0.gguf')))
  assert.ok(fs.existsSync(path.join(installRoot, 'ai-runtime', 'win-x64', 'llama-server.exe')))
  assert.ok(fs.existsSync(path.join(installRoot, 'licenses', 'llama.cpp', 'LICENSE.txt')))
  assert.ok(stages.includes('extract'))
  assert.equal(stages[stages.length - 1], 'done')
  assert.equal(service.status().installed, true)

  // 下载产物必须能通过运行时自带的 verifyBundle 校验（哈希、大小、GGUF 魔数）。
  const document = await verifyBundle(installRoot, null, { expectedModelSha256: sha256(pack.modelBuffer) })
  assert.equal(document.artifacts.length, 4)
  assert.ok(document.artifacts.some((a) => a.role === 'license'))

  const runtime = new BundledLocalRuntime({ resourceRoot: tempDir('localai-empty-res-'), userDataRoot: installRoot })
  t.after(() => fs.rmSync(runtime.resourceRoot, { recursive: true, force: true }))
  assert.equal(runtime.paths().model, path.join(installRoot, 'models', 'Qwen2.5-0.5B-Instruct-Q4_0.gguf'))
  assert.equal(runtime.paths().executable, path.join(installRoot, 'ai-runtime', 'win-x64', 'llama-server.exe'))
  const status = runtime.status()
  assert.equal(status.assetsPresent, true)
  assert.equal(status.assetsLocation, 'userData')
})

test('interrupted downloads resume with a Range request instead of starting over', async (t) => {
  const pack = await makePack()
  const { server, port, seen } = await serve({
    '/model': { body: pack.modelBuffer },
    '/runtime': { body: pack.zipBuffer }
  })
  const installRoot = tempDir('localai-resume-')
  t.after(() => { server.close(); fs.rmSync(installRoot, { recursive: true, force: true }) })

  const partDir = path.join(installRoot, 'models')
  fs.mkdirSync(partDir, { recursive: true })
  const half = Math.floor(pack.modelBuffer.length / 2)
  fs.writeFileSync(path.join(partDir, 'Qwen2.5-0.5B-Instruct-Q4_0.gguf.part'), pack.modelBuffer.subarray(0, half))

  const service = new LocalAiDownloadService({ installRoot, manifest: buildManifest(`http://127.0.0.1:${port}`, pack), localOnly: true })
  await service.start()
  assert.ok(seen.ranges.includes(`bytes=${half}-`))
  assert.equal(fs.readFileSync(path.join(partDir, 'Qwen2.5-0.5B-Instruct-Q4_0.gguf')).length, pack.modelBuffer.length)
  assert.equal(service.status().installed, true)
})

test('sha-256 mismatch deletes the corrupted file and fails the install', async (t) => {
  const pack = await makePack()
  const { server, port } = await serve({
    '/model': { body: pack.modelBuffer },
    '/runtime': { body: pack.zipBuffer }
  })
  const installRoot = tempDir('localai-sha-')
  t.after(() => { server.close(); fs.rmSync(installRoot, { recursive: true, force: true }) })

  const manifest = buildManifest(`http://127.0.0.1:${port}`, pack, { modelSha256: '0'.repeat(64) })
  const service = new LocalAiDownloadService({ installRoot, manifest, localOnly: true })
  await assert.rejects(() => service.start(), /SHA-256 校验失败/)
  assert.equal(fs.existsSync(path.join(installRoot, 'models', 'Qwen2.5-0.5B-Instruct-Q4_0.gguf.part')), false)
  assert.equal(service.status().installed, false)
})

test('cancel keeps the partial file for a later resume', async (t) => {
  const pack = await makePack()
  const bigModel = Buffer.concat([Buffer.from('GGUF'), crypto.randomBytes(4 * 1024 * 1024)])
  const slowPack = { ...pack, modelBuffer: bigModel }
  const { server, port } = await serve({
    '/model': { body: bigModel, slow: true },
    '/runtime': { body: pack.zipBuffer }
  })
  const installRoot = tempDir('localai-cancel-')
  t.after(() => { server.close(); fs.rmSync(installRoot, { recursive: true, force: true }) })

  const service = new LocalAiDownloadService({ installRoot, manifest: buildManifest(`http://127.0.0.1:${port}`, slowPack), localOnly: true })
  const part = path.join(installRoot, 'models', 'Qwen2.5-0.5B-Instruct-Q4_0.gguf.part')
  const promise = service.start()
  const deadline = Date.now() + 5000
  while ((!fs.existsSync(part) || fs.statSync(part).size === 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(fs.existsSync(part) && fs.statSync(part).size > 0, '取消前必须先观察到真实的部分下载')
  assert.equal(service.cancel(), true)
  await assert.rejects(promise, /已取消下载/)
  assert.equal(service.status().active, false)
  assert.ok(fs.existsSync(part))
  const partial = fs.statSync(part).size
  assert.ok(partial > 0 && partial < bigModel.length)
})

test('release redirects are followed while staying inside the allowlist', async (t) => {
  const pack = await makePack()
  const { server, port } = await serve({
    '/model': { body: pack.modelBuffer },
    '/runtime': { body: pack.zipBuffer },
    '/redirect-model': { redirect: '/model' }
  })
  const installRoot = tempDir('localai-redirect-')
  t.after(() => { server.close(); fs.rmSync(installRoot, { recursive: true, force: true }) })

  const manifest = buildManifest(`http://127.0.0.1:${port}`, pack, { modelUrl: `http://127.0.0.1:${port}/redirect-model` })
  const service = new LocalAiDownloadService({ installRoot, manifest, localOnly: true })
  await service.start()
  assert.equal(service.status().installed, true)

  const evilRoot = tempDir('localai-evil-')
  t.after(() => fs.rmSync(evilRoot, { recursive: true, force: true }))
  const evil = new LocalAiDownloadService({
    installRoot: evilRoot,
    manifest: buildManifest(`http://127.0.0.1:${port}`, pack, { modelUrl: 'http://169.254.169.254/latest/meta-data' }),
    localOnly: true
  })
  await assert.rejects(() => evil.start(), /拒绝|失败/)
})

test('production pack manifest is locked to the verified model and GitHub hosting', () => {
  validateManifest(PROD_MANIFEST)
  assert.equal(PROD_MANIFEST.tag, 'local-ai-pack-v1')
  const model = PROD_MANIFEST.assets.find((asset) => asset.role === 'model')
  assert.equal(model.sha256, LOCKED_MODEL_SHA256)
  for (const asset of PROD_MANIFEST.assets) {
    assert.ok(asset.url.startsWith('https://github.com/wg5759/AgentPlay/releases/download/local-ai-pack-v1/'), asset.url)
  }
  assert.ok(DEFAULT_ALLOWED_HOSTS.includes('github.com'))
})

test('runtime falls back to the bundled root when nothing was downloaded', (t) => {
  const resourceRoot = tempDir('localai-res-only-')
  const userDataRoot = tempDir('localai-empty-user-')
  t.after(() => { fs.rmSync(resourceRoot, { recursive: true, force: true }); fs.rmSync(userDataRoot, { recursive: true, force: true }) })
  const runtime = new BundledLocalRuntime({ resourceRoot, userDataRoot })
  assert.equal(runtime.installRoot(), resourceRoot)
  const status = runtime.status()
  assert.equal(status.assetsPresent, false)
  assert.equal(status.assetsLocation, null)
})

test('allowlisted download hosts skip DNS pre-resolution so GitHub accelerators work', async (t) => {
  const installRoot = tempDir('localai-dns-')
  t.after(() => fs.rmSync(installRoot, { recursive: true, force: true }))
  const service = new LocalAiDownloadService({
    installRoot,
    manifest: {
      schemaVersion: 1, tag: 't',
      assets: [{ id: 'm', kind: 'file', path: 'models/x.gguf', url: 'https://github.com/x/y', size: 1, sha256: '0'.repeat(64) }]
    }
  })
  // 白名单域名不再做 DNS 预检：加速器把 github.com 指向本机反代时也不会被误拦。
  await service.assertUrlAllowed('https://github.com/wg5759/AgentPlay/releases/download/local-ai-pack-v1/x.zip')
  await service.assertUrlAllowed('https://objects.githubusercontent.com/x')
  await assert.rejects(() => service.assertUrlAllowed('https://evil.example.com/x'), /白名单/)
  await assert.rejects(() => service.assertUrlAllowed('https://169.254.169.254/x'), /白名单/)
})
