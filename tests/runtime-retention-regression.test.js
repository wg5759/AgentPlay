const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PersistentTaskRuntime } = require('../electron/persistent-task-runtime')
const { inspectArtifact } = require('../electron/task-result-quality')

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-retention-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('more than 200 unfinished tasks survive history churn and cold start', async t => {
  const root = directory(t)
  const runtime = new PersistentTaskRuntime({ rootDir: root })
  runtime.enqueue({ id: 'waiting', type: 'test', approval: { action: 'cloud' } })
  runtime.enqueue({ id: 'running', type: 'test' })
  runtime.markRunningForTest('running', { completedStep: 1 })
  for (let i = 0; i < 205; i++) runtime.enqueue({ id: `queued-${i}`, type: 'test' })
  runtime.register('test', async () => ({ success: true }))
  for (let i = 0; i < 205; i++) {
    const task = runtime.enqueue({ id: `finished-${i}`, type: 'test' })
    await runtime.run(task.id)
  }
  const restored = new PersistentTaskRuntime({ rootDir: root })
  assert.equal(restored.get('waiting')?.state, 'waiting_approval')
  assert.deepEqual(restored.get('running')?.checkpoint, { completedStep: 1 })
  for (let i = 0; i < 205; i++) assert.equal(restored.get(`queued-${i}`)?.state, 'queued')
  assert.ok(restored.list().filter(task => task.state === 'completed').length <= 200)
})

test('a damaged primary recovers a backup without automatically repeating work', async t => {
  const root = directory(t)
  const first = new PersistentTaskRuntime({ rootDir: root })
  first.enqueue({ id: 'recover-me', type: 'test' })
  first.markRunningForTest('recover-me', { completedStep: 2 })
  fs.writeFileSync(first.statePath, '{broken')
  const restored = new PersistentTaskRuntime({ rootDir: root })
  let calls = 0
  restored.register('test', async () => { calls++; return {} }, { autoResume: true })
  await restored.startRecoverable()
  assert.equal(calls, 0)
  assert.deepEqual(restored.get('recover-me')?.checkpoint, { completedStep: 2 })
  assert.equal(restored.get('recover-me')?.failure?.code, 'STATE_RECOVERED_REVIEW_REQUIRED')
  assert.equal(fs.readFileSync(first.statePath, 'utf8'), '{broken', 'diagnosis must preserve damaged bytes until a deliberate recovery')
})

test('artifact inspection reads a bounded header rather than the whole media file', t => {
  const file = path.join(directory(t), 'large.mp4')
  const body = Buffer.alloc(1024 * 1024); body.write('ftyp', 4)
  fs.writeFileSync(file, body)
  const original = fs.readFileSync
  t.mock.method(fs, 'readFileSync', function (target, ...args) {
    if (target === file) throw new Error('whole-file read forbidden')
    return original.call(this, target, ...args)
  })
  const result = inspectArtifact(file)
  assert.equal(result.formatOk, true)
  assert.equal(result.bytes, body.length)
})

test('unreadable task files block new tasks without crashing the application or erasing records', t => {
  const root = directory(t)
  const runtime = new PersistentTaskRuntime({ rootDir: root })
  runtime.enqueue({ id: 'original', type: 'test' })
  fs.writeFileSync(runtime.statePath, 'broken-primary'); fs.writeFileSync(runtime.backupPath, 'broken-backup')
  const recovered = new PersistentTaskRuntime({ rootDir: root })
  assert.equal(recovered.list()[0].failure.code, 'TASK_STORAGE_UNREADABLE')
  assert.throws(() => recovered.enqueue({ id: 'new', type: 'test' }), /播放仍可使用/)
  assert.equal(fs.readFileSync(runtime.statePath, 'utf8'), 'broken-primary')
  assert.equal(fs.readFileSync(runtime.backupPath, 'utf8'), 'broken-backup')
})

test('cancelled or backup-restored approvals cannot revive a task with an old token', async t => {
  const root = directory(t)
  const runtime = new PersistentTaskRuntime({ rootDir: root })
  const task = runtime.enqueue({ id: 'cancelled-cloud', type: 'test', approval: { action: 'cloud' } })
  runtime.cancel(task.id)
  assert.throws(() => runtime.approve(task.approval.id, task.approval.token), /停止|核对/)
  const pending = runtime.enqueue({ id: 'pending-cloud', type: 'test', approval: { action: 'cloud' } })
  fs.writeFileSync(runtime.statePath, 'broken')
  const recovered = new PersistentTaskRuntime({ rootDir: root })
  assert.throws(() => recovered.approve(pending.approval.id, pending.approval.token), /核对/)
  let calls = 0
  recovered.register('test', async () => { calls++; return {} }, { autoResume: true })
  await recovered.run(pending.id); await recovered.startRecoverable()
  assert.equal(calls, 0)
})

test('a long task completing late stays in recent history', async t => {
  const root = directory(t)
  const initial = new PersistentTaskRuntime({ rootDir: root, now: () => 1 })
  const long = initial.enqueue({ id: 'long-task', type: 'test' })
  const history = Array.from({ length: 200 }, (_, i) => ({ ...long, id: `done-${i}`, state: 'completed', updatedAt: i + 2, completedAt: i + 2 }))
  fs.writeFileSync(initial.statePath, JSON.stringify({ version: 1, tasks: [long, ...history] }))
  const runtime = new PersistentTaskRuntime({ rootDir: root, now: () => 1000 })
  runtime.register('test', async () => ({ success: true }))
  await runtime.run('long-task')
  assert.equal(runtime.get('long-task')?.state, 'completed')
  assert.equal(new PersistentTaskRuntime({ rootDir: root }).get('long-task')?.state, 'completed')
})
