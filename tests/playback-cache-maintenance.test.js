const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { InlinePlaybackService } = require('../electron/inline-playback-service')
test('cache cleanup preserves active media and foreign files and refuses a busy conversion', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-cache-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const service = new InlinePlaybackService({ cacheDir: root, authorizePath: value => value })
  const add = value => { const sourceSha256 = value.repeat(64); const key = crypto.createHash('sha256').update(`inline-playback-v1|video|${sourceSha256}`).digest('hex'); const file = path.join(root, `${key}.mp4`); fs.writeFileSync(file, Buffer.alloc(100)); fs.writeFileSync(path.join(root, `${key}.json`), JSON.stringify({ sourceSha256, outputSha256: 'a'.repeat(64), version: 'inline-playback-v1' })); return file }
  const active = add('1'); const unused = add('2'); const foreign = path.join(root, 'original.mp4'); fs.writeFileSync(foreign, 'original')
  service.activeCachePath = active
  service.busy = true; assert.throws(() => service.clearUnusedCache(), /正在准备/)
  service.busy = false
  assert.equal(service.clearUnusedCache().removedBytes, 100)
  assert.ok(fs.existsSync(active)); assert.ok(!fs.existsSync(unused)); assert.equal(fs.readFileSync(foreign, 'utf8'), 'original')
})
