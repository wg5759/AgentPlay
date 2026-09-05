const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const JSZip = require('jszip')
const { LocalAiDownloadService } = require('../electron/local-ai-download-service')
const sha = b => crypto.createHash('sha256').update(b).digest('hex')

test('archive decoding and large synchronous writes do not run in the caller thread', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-worker-'))
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'archive-worker-'))); fs.rmSync(root, { recursive: true, force: true }) })
  const content = crypto.randomBytes(2 * 1024 * 1024), zip = new JSZip()
  zip.file('Release/tool.exe', content)
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const asset = { id: 'engine', kind: 'zip', size: bytes.length, sha256: sha(bytes), url: 'https://github.com/example/fixture.zip', files: [{ path: 'engine/tool.exe', archivePath: 'Release/tool.exe', size: content.length, sha256: sha(content) }] }
  fs.mkdirSync(path.join(root, '.dl')); fs.writeFileSync(path.join(root, '.dl/engine.zip'), bytes)
  const service = new LocalAiDownloadService({ installRoot: root, manifest: { schemaVersion: 1, tag: 'fixture', assets: [asset] }, fetchImpl: async () => { throw Error('network forbidden') } })
  const original = fs.writeFileSync
  fs.writeFileSync = (file, data, ...args) => {
    if (String(file).startsWith(root) && String(file).endsWith('.tmp') && data.length > 1024 * 1024) throw Error('large archive write ran on main thread')
    return original(file, data, ...args)
  }
  try { await service.start() } finally { fs.writeFileSync = original }
  assert.equal(sha(fs.readFileSync(path.join(root, 'engine/tool.exe'))), sha(content))
  assert.equal(service.status().installed, true)
})
