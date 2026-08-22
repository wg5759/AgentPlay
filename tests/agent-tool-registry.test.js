const test = require('node:test')
const assert = require('node:assert/strict')
const { listAgentTools, getAgentTool, executeAgentTool } = require('../electron/agent-tool-registry')
const { AgentRunLedger } = require('../electron/agent-run-ledger')

test('agent tool registry is the single metadata source for model tools', () => {
  const tools = listAgentTools()
  assert.equal(tools.length, 26)
  assert.equal(tools[0].function.name, 'pause')
  assert.equal(getAgentTool('summarize_video').risk, 'read-only')
  assert.deepEqual(tools.find((tool) => tool.function.name === 'seek').function.parameters.required, ['seconds'])
  assert.equal(getAgentTool('batch_transcribe').category, 'media')
  assert.equal(getAgentTool('compress_video').risk, 'local-write')
  assert.equal(getAgentTool('trim_video').risk, 'local-write')
  assert.equal(getAgentTool('remove_video_segment').risk, 'local-write')
  assert.equal(getAgentTool('concat_video_segments').risk, 'local-write')
  assert.equal(getAgentTool('undo_media_edit').risk, 'control')
  assert.equal(getAgentTool('redo_media_edit').risk, 'control')
  assert.equal(getAgentTool('find_duplicates').risk, 'read-only')
  assert.equal(getAgentTool('advanced_document_ocr').category, 'document')
  assert.equal(getAgentTool('ask_across_materials').category, 'project')
})

test('cross-material QA enters the unified registry as a recoverable evidence action', async () => {
  const result = await executeAgentTool('ask_across_materials', { question: '这些素材是否一致？' })
  assert.equal(result.action, 'start_cross_material_qa')
  assert.deepEqual(result.value, { question: '这些素材是否一致？' })
  assert.equal(result.execution, 'renderer')
  assert.equal(result.verified, false)
})

test('advanced document OCR enters the unified registry as a recoverable document action', async () => {
  const result = await executeAgentTool('advanced_document_ocr')
  assert.equal(result.action, 'start_advanced_document_ocr')
  assert.equal(result.execution, 'renderer')
  assert.equal(result.verified, false)
})

test('long-running media tools dispatch through the renderer workflow instead of bypassing task recovery', async () => {
  const batch = await executeAgentTool('batch_transcribe')
  assert.equal(batch.action, 'start_batch_transcribe')
  assert.equal(batch.execution, 'renderer')
  const compress = await executeAgentTool('compress_video', { mode: 'remux' })
  assert.equal(compress.action, 'start_compress_video')
  assert.equal(compress.value.mode, 'remux')
  const trim = await executeAgentTool('trim_video', { start_seconds: 4, end_seconds: 20 })
  assert.equal(trim.action, 'start_trim_video')
  assert.deepEqual(trim.value, { startSeconds: 4, endSeconds: 20 })
  assert.equal(trim.execution, 'renderer')
  const remove = await executeAgentTool('remove_video_segment', { start_seconds: 4, end_seconds: 20 })
  assert.equal(remove.action, 'start_remove_video_segment')
  assert.deepEqual(remove.value, { startSeconds: 4, endSeconds: 20 })
  assert.equal(remove.execution, 'renderer')
  const concat = await executeAgentTool('concat_video_segments', {
    segments: [
      { start_seconds: 8, end_seconds: 12 },
      { start_seconds: 0, end_seconds: 4 }
    ]
  })
  assert.equal(concat.action, 'start_concat_video_segments')
  assert.deepEqual(concat.value, { segments: [{ startSeconds: 8, endSeconds: 12 }, { startSeconds: 0, endSeconds: 4 }] })
  assert.equal(concat.execution, 'renderer')
  const tooManySegments = await executeAgentTool('concat_video_segments', {
    segments: Array.from({ length: 25 }, (_, index) => ({ start_seconds: index, end_seconds: index + 1 }))
  })
  assert.equal(tooManySegments.success, false)
  assert.match(tooManySegments.error, /最多 24 个/)
  const undo = await executeAgentTool('undo_media_edit')
  assert.equal(undo.action, 'start_edit_history')
  assert.deepEqual(undo.value, { direction: 'undo' })
  const redo = await executeAgentTool('redo_media_edit')
  assert.equal(redo.action, 'start_edit_history')
  assert.deepEqual(redo.value, { direction: 'redo' })
  const dedup = await executeAgentTool('find_duplicates')
  assert.equal(dedup.action, 'start_duplicate_scan')
})

test('tool registry validates required arguments and marks renderer actions unverified', async () => {
  const missing = await executeAgentTool('seek', {})
  assert.equal(missing.success, false)
  assert.match(missing.error, /缺少参数 seconds/)
  const result = await executeAgentTool('set_volume', { level: 150 })
  assert.equal(result.value, 100)
  assert.equal(result.execution, 'renderer')
  assert.equal(result.verified, false)
})

test('read-only tool can emit verified main-process evidence', async () => {
  const result = await executeAgentTool('summarize_video', {}, {}, {
    summarize: async () => ({ success: true, desc: '读取了字幕', transcript: 'hello' })
  })
  assert.equal(result.verified, true)
  assert.equal(result.execution, 'main')
})

test('agent run ledger blocks calls beyond budget and preserves receipts', () => {
  let clock = 100
  const ledger = new AgentRunLedger({ requestId: 'run-1', maxToolCalls: 1, maxElapsedMs: 1000, now: () => clock })
  ledger.beginTurn()
  const first = ledger.beginTool(getAgentTool('pause'), {})
  ledger.finishTool(first.step, { success: true, desc: '已请求暂停', execution: 'renderer', verified: false })
  clock = 120
  const second = ledger.beginTool(getAgentTool('resume'), {})
  assert.equal(second.allowed, false)
  assert.match(second.error, /工具调用预算/)
  const run = ledger.finish()
  assert.equal(run.status, 'blocked')
  assert.equal(run.budget.toolCalls, 1)
  assert.equal(run.steps[0].evidence.verified, false)
})
