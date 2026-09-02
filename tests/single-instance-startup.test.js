const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

test('a forwarded second instance quits before creating services or registering startup work', () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
  const lockAt = main.indexOf('const gotTheLock =')
  assert.ok(lockAt < main.indexOf("const ExcelJS = require"), 'secondary instances must exit before loading heavy modules')
  const guard = main.slice(lockAt, main.indexOf("const path = require"))
  const initialize = vm.compileFunction(`${guard}\nsentinel.initialized = true`, ['app', 'sentinel'])
  const second = { initialized: false, quit: false }
  initialize({ requestSingleInstanceLock: () => false, quit: () => { second.quit = true } }, second)
  assert.equal(second.quit, true)
  assert.equal(second.initialized, false, 'app.quit alone does not stop CommonJS evaluation')
  const first = { initialized: false }
  initialize({ requestSingleInstanceLock: () => true, on: () => {} }, first)
  assert.equal(first.initialized, true)
})
