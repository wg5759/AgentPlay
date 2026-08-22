const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { snapshotDocumentSources, validateDocumentSources, outputsStillExist } = require('../electron/persistent-document-task')
const { DocumentWorkspaceService } = require('../electron/document-workspace-service')

test('document task freezes source fingerprints and rejects changed input on recovery', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-persistent-doc-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, '合同.txt')
  fs.writeFileSync(source, '原始内容', 'utf8')
  const snapshot = snapshotDocumentSources([source])

  assert.deepEqual(validateDocumentSources(snapshot), [source])
  fs.writeFileSync(source, '被替换的内容', 'utf8')
  assert.throws(() => validateDocumentSources(snapshot), /源文件已发生变化/)
})

test('document recovery only trusts checkpoint outputs that still exist', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-persistent-doc-out-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const output = path.join(root, '结果.docx')
  fs.writeFileSync(output, 'result')
  assert.equal(outputsStillExist({ outputs: [output] }), true)
  fs.rmSync(output)
  assert.equal(outputsStillExist({ outputs: [output] }), false)
})

test('document workspace persists an outputs-written checkpoint before history completion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-doc-checkpoint-'))
  try {
    const source = path.join(root, '原文.txt')
    fs.writeFileSync(source, '第一段\n第二段', 'utf8')
    const checkpoints = []
    const service = new DocumentWorkspaceService({ outputRoot: root, historyRoot: path.join(root, 'history') })
    const result = await service.run([source], '\u8f6c\u6362\u4e3a TXT', 'txt', { onCheckpoint: (value) => checkpoints.push(value) })
    assert.equal(result.success, true)
    assert.equal(checkpoints[0].stage, 'outputs-written')
    assert.deepEqual(checkpoints[0].result.outputs, result.outputs)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('document bundle resumes from per-format checkpoints without repeating completed model calls', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-doc-bundle-resume-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, '资料.txt')
  fs.writeFileSync(source, '1月收入100，成本80。', 'utf8')
  const checkpoint = {}
  const controller = new AbortController()
  const firstCalls = []
  const first = new DocumentWorkspaceService({
    outputRoot: root,
    historyRoot: path.join(root, 'history-first'),
    complete: async ({ prompt }) => {
      const format = prompt.includes('DOCX') ? 'docx' : 'xlsx'
      firstCalls.push(format)
      if (format === 'xlsx') throw new Error('模拟进程在第二格式调用前中断')
      return { text: JSON.stringify({ title: '报告', content: '1月收入100，成本80。', factIds: ['F1'] }) }
    }
  })
  await assert.rejects(first.run([source], '做成 Word 和 Excel 一套成果', 'auto', {
    signal: controller.signal,
    onCheckpoint: (patch) => {
      Object.assign(checkpoint, patch)
      if (patch.stage === 'bundle-section-complete') controller.abort()
    }
  }), /模拟进程/)
  assert.deepEqual(firstCalls, ['docx', 'xlsx'])
  assert.equal(checkpoint.stage, 'bundle-section-complete')
  assert.ok(checkpoint.bundle.sections.docx)

  const resumedCalls = []
  const resumed = new DocumentWorkspaceService({
    outputRoot: root,
    historyRoot: path.join(root, 'history-resumed'),
    complete: async ({ prompt }) => {
      const format = prompt.includes('DOCX') ? 'docx' : 'xlsx'
      resumedCalls.push(format)
      if (format === 'docx') throw new Error('已完成的 DOCX 模型调用不应重复')
      return { text: JSON.stringify({ sheets: [{ name: '数据', rows: [['月份', '收入'], ['1月', 100]] }], factIds: ['F1'] }) }
    }
  })
  const result = await resumed.run([source], '做成 Word 和 Excel 一套成果', 'auto', { resumeCheckpoint: checkpoint })
  assert.deepEqual(resumedCalls, ['xlsx'])
  assert.equal(result.outputs.length, 2)
  assert.equal(result.deliveryReceipt.bundle.consistency.verdict, 'matched')
})

test('single AI document persists and reuses a completed model plan before deterministic writing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-doc-plan-resume-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, '原文.txt')
  fs.writeFileSync(source, '需要整理的正文。', 'utf8')
  const checkpoint = {}
  const first = new DocumentWorkspaceService({
    outputRoot: root,
    historyRoot: path.join(root, 'history-first'),
    complete: async () => ({ text: JSON.stringify({ title: '整理结果', summary: '完成', content: '# 正文\n需要整理的正文。' }) })
  })
  await assert.rejects(first.run([source], '整理成 Word 报告', 'docx', {
    onCheckpoint: (patch) => {
      Object.assign(checkpoint, patch)
      if (patch.stage === 'ai-plan-ready') throw new Error('模拟模型返回后进程退出')
    }
  }), /模拟模型返回后进程退出/)
  assert.equal(checkpoint.stage, 'ai-plan-ready')
  assert.equal(checkpoint.aiPlan.title, '整理结果')

  const resumed = new DocumentWorkspaceService({
    outputRoot: root,
    historyRoot: path.join(root, 'history-resumed'),
    complete: async () => { throw new Error('已完成的模型方案不应重复调用') }
  })
  const result = await resumed.run([source], '整理成 Word 报告', 'docx', { resumeCheckpoint: checkpoint })
  assert.equal(result.outputs.length, 1)
  assert.ok(fs.existsSync(result.outputs[0]))
})
