const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

async function exercise(t, marker, fail = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-components-'))
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'bootstrap-components-'))); fs.rmSync(root, { recursive: true, force: true }) })
  const markerPath = path.join(root, 'first-run-components.json')
  if (marker) fs.writeFileSync(markerPath, JSON.stringify(marker))
  let calls = 0
  const component = () => { let ready = false; return { status: () => ({ installed: ready }), start: async () => { calls++; if (fail) throw Error('fixture network failure'); ready = true } } }
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
  const start = source.indexOf('// 首启自动化：'), end = source.indexOf('// 注册完所有执行器', start)
  const code = source.slice(start, end).replace('void ', 'globalThis.work = ')
  const context = { fs, path, app: { getPath: () => root }, log: { info() {}, warn() {} }, whisperDownload: component(), ytdlpDownload: component(), transcriptionService: { availability: () => ({ available: true }) }, siteVideo: { availability: () => ({ available: true }) }, ensureFirstRunComponents: (...args) => require('../electron/first-run-components').ensureFirstRunComponents(...args) }
  vm.runInNewContext(code, context)
  await context.work
  return { calls, marker: JSON.parse(fs.readFileSync(markerPath, 'utf8')) }
}

test('first-run readiness checks the entire component pack, not only a runnable executable', async t => {
  const result = await exercise(t, null)
  assert.equal(result.calls, 2)
  assert.equal(result.marker.done, true)
})
test('old attempt counts do not disable first-run recovery forever', async t => {
  const result = await exercise(t, { done: false, attempts: 3, at: '2000-01-01T00:00:00.000Z' })
  assert.equal(result.calls, 2)
})
test('a stale done marker cannot hide missing components', async t => {
  const result = await exercise(t, { done: true })
  assert.equal(result.calls, 2)
})
test('failed pack installation stays incomplete despite executable availability', async t => {
  const result = await exercise(t, null, true)
  assert.equal(result.marker.done, false)
  assert.ok(result.marker.nextRetryAt > Date.now())
})
