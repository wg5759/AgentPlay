const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { after, test } = require('node:test')
const { stop, transformSync } = require('esbuild')

function loadLifecycle() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'taskLifecycle.ts'), 'utf8')
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs', target: 'node20' })
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, require)
  return mod.exports
}

const { createWorkspaceTask, patchWorkspaceTask, restoreWorkspaceTasks, progressFromStatus, recordWorkspaceTaskProgress, applyWorkspaceOutputReceipts } = loadLifecycle()

after(() => stop())

test('workspace task lifecycle records durable identity and terminal results', () => {
  const task = createWorkspaceTask({ kind: 'download', label: '视频下载', instruction: '下载链接' }, 100)
  assert.match(task.id, /^task-100-/)
  assert.equal(task.phase, 'queued')
  const running = patchWorkspaceTask(task, { phase: 'running', status: '（2/5）下载中' }, 120)
  assert.equal(running.running, true)
  const completed = patchWorkspaceTask(running, { phase: 'completed', outputs: ['D:\\result.mp4'], summary: '完成', error: '旧错误' }, 150)
  assert.equal(completed.running, false)
  assert.equal(completed.progress, 100)
  assert.equal(completed.error, '')
  assert.equal(completed.completedAt, 150)
  assert.deepEqual(completed.outputs, ['D:\\result.mp4'])
})

test('cold start fail-closes unfinished tasks as interrupted instead of pretending they still run', () => {
  const restored = restoreWorkspaceTasks([
    { id: 'running', kind: 'analysis', label: '拉片', phase: 'running', updatedAt: 30 },
    { id: 'done', kind: 'download', label: '下载', phase: 'completed', updatedAt: 20, outputs: ['x.mp4'] }
  ], 200)
  assert.equal(restored[0].id, 'running')
  assert.equal(restored[0].phase, 'interrupted')
  assert.equal(restored[0].running, false)
  assert.match(restored[0].error, /上次关闭/)
  assert.equal(restored[1].phase, 'completed')
  assert.deepEqual(restored[1].outputs, ['x.mp4'])
})

test('task progress parsing is bounded and queue history is capped', () => {
  assert.equal(progressFromStatus('（3/4）正在处理'), 75)
  assert.equal(progressFromStatus('正在下载 42%'), 42)
  assert.equal(progressFromStatus('正在下载 120%'), 100)
  assert.equal(progressFromStatus('正在准备'), null)
  const raw = Array.from({ length: 90 }, (_, index) => ({ id: String(index), updatedAt: index, phase: 'completed' }))
  const restored = restoreWorkspaceTasks(raw, 500)
  assert.equal(restored.length, 80)
  assert.equal(restored[0].id, '89')
})

test('workspace task records visible steps and verified output receipts', () => {
  const task = createWorkspaceTask({ kind: 'analysis', label: '视频解剖', phase: 'running' }, 100)
  const extracting = recordWorkspaceTaskProgress(task, '（1/3）提取字幕', 110)
  const rendering = recordWorkspaceTaskProgress(extracting, '（2/3）生成报告', 120)
  assert.equal(rendering.steps.length, 2)
  assert.equal(rendering.steps[0].phase, 'completed')
  assert.equal(rendering.steps[1].phase, 'running')
  const completed = patchWorkspaceTask(rendering, { phase: 'completed', outputs: ['D:\\report.docx'] }, 130)
  assert.equal(completed.steps[1].phase, 'completed')
  const verified = applyWorkspaceOutputReceipts(completed, [{ path: 'D:\\report.docx', exists: true, bytes: 42 }], 140)
  assert.equal(verified.evidence[0].verified, true)
  assert.equal(verified.evidence[0].bytes, 42)
})
