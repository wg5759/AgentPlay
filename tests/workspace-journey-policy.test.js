const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const { pathToFileURL } = require('node:url')

const policyUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'workspace-journey-policy.mjs')).href

test('download-only completion reports download completion without pretending analysis or creation ran', async () => {
  const { workspaceJourneyForTask } = await import(policyUrl)
  const journey = workspaceJourneyForTask({
    kind: 'download',
    phase: 'completed',
    running: false,
    status: '',
    outputs: ['C:/Videos/example.mp4']
  })

  assert.equal(journey.eyebrow, '下载完成')
  assert.deepEqual(journey.stages, ['校验链接', '下载视频'])
  assert.equal(journey.activeStage, 1)
  assert.equal(journey.stages.includes('继续创作'), false)
})

test('running download exposes its real current step', async () => {
  const { workspaceJourneyForTask } = await import(policyUrl)
  assert.deepEqual(
    workspaceJourneyForTask({ kind: 'download', phase: 'running', running: true, status: '正在校验链接', outputs: [] }),
    { eyebrow: '正在下载', stages: ['校验链接', '下载视频'], activeStage: 0 }
  )
  assert.equal(
    workspaceJourneyForTask({ kind: 'download', phase: 'running', running: true, status: '正在下载 42%', outputs: [] }).activeStage,
    1
  )
})

test('link analysis retains the full analysis journey and terminal states are explicit', async () => {
  const { workspaceJourneyForTask } = await import(policyUrl)
  const completed = workspaceJourneyForTask({ kind: 'link-analysis', phase: 'completed', running: false, status: '', outputs: ['report.md'] })
  assert.deepEqual(completed.stages, ['获取内容', '理解画面', '生成报告'])
  assert.equal(completed.activeStage, 2)
  assert.equal(completed.eyebrow, '分析完成')
  assert.equal(workspaceJourneyForTask({ kind: 'doc', phase: 'waiting', running: false, status: '等待允许云端处理', outputs: [] }).eyebrow, '等待确认')
  assert.equal(workspaceJourneyForTask({ kind: 'media', phase: 'failed', running: false, status: '', outputs: [] }).eyebrow, '处理失败')
})

test('unknown running work stays on the first real stage and exposes an honest time range', async () => {
  const { workspaceJourneyForTask, taskTimingForTask } = await import(policyUrl)
  const task = { kind: 'doc', phase: 'running', running: true, status: '正在准备任务', outputs: [] }
  assert.equal(workspaceJourneyForTask(task).activeStage, 0)
  assert.equal(workspaceJourneyForTask(task).stages.includes('继续编辑'), false)
  assert.match(taskTimingForTask(task), /1–3 分钟/)
  assert.equal(taskTimingForTask({ kind: 'creative', phase: 'running', running: true, status: '正在生成 4 秒视频（约 1-2 分钟）' }), '约 1-2 分钟')
})
