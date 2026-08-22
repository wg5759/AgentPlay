const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { DocumentWorkspaceService } = require('../electron/document-workspace-service')
const { evaluateTaskResult } = require('../electron/task-result-quality')

const digest = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')

function responseFor(prompt) {
  if (prompt.includes('本次只生成 DOCX')) {
    return { title: '经营报告', content: '# 核心数据\n- 1月收入100，成本80', factIds: ['F1'] }
  }
  if (prompt.includes('本次只生成 XLSX')) {
    return { sheets: [{ name: '月度数据', rows: [['月份', '收入', '成本'], ['1月', 100, 80]] }], factIds: ['F1'] }
  }
  throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`)
}

test('document bundle freezes one source ledger and returns a hash-verifiable delivery receipt', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-delivery-receipt-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, '经营资料.txt')
  fs.writeFileSync(source, '1月收入100，成本80。', 'utf8')
  const prompts = []
  const service = new DocumentWorkspaceService({
    outputRoot: root,
    historyRoot: path.join(root, 'history'),
    complete: async ({ prompt }) => {
      prompts.push(prompt)
      return { text: JSON.stringify(responseFor(prompt)) }
    }
  })

  const result = await service.run([source], '做成一套 Word 报告和 Excel 分析表', 'auto')
  assert.equal(result.plan.kind, 'ai-bundle')
  assert.equal(result.outputs.length, 2)
  assert.equal(prompts.length, 2)
  assert.ok(prompts.every((prompt) => prompt.includes('F1') && prompt.includes('1月收入100，成本80')))

  const receipt = result.deliveryReceipt
  assert.equal(receipt.schemaVersion, 1)
  assert.equal(receipt.kind, 'agentplay.delivery-receipt')
  assert.equal(receipt.status, 'complete')
  assert.equal(receipt.sources.length, 1)
  assert.equal(receipt.sources[0].sha256, digest(source))
  assert.deepEqual(receipt.bundle.requestedFormats, ['docx', 'xlsx'])
  assert.equal(receipt.bundle.consistency.verdict, 'matched')
  assert.equal(receipt.artifacts.length, 2)
  for (const artifact of receipt.artifacts) {
    assert.equal(artifact.sha256, digest(artifact.path))
    assert.equal(artifact.sourceLedgerSha256, receipt.bundle.sourceLedgerSha256)
    assert.deepEqual(artifact.factIds, ['F1'])
  }

  const quality = evaluateTaskResult('document.run', result, { sources: [{ path: source }] })
  assert.equal(quality.passed, true)
  assert.equal(quality.score, 100, '质量检查权重必须严格归一化为 100')
  assert.ok(quality.checks.some((item) => item.id === 'provenance-receipt' && item.passed))
  assert.ok(quality.checks.some((item) => item.id === 'bundle-consistency' && item.passed))
})

test('document bundle quality fails closed on a partial format or changed artifact', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-delivery-partial-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, '资料.txt')
  fs.writeFileSync(source, '事实甲。', 'utf8')
  const service = new DocumentWorkspaceService({
    outputRoot: root,
    historyRoot: path.join(root, 'history'),
    complete: async ({ prompt }) => {
      if (prompt.includes('本次只生成 PDF')) throw new Error('模型响应超时')
      return { text: JSON.stringify({ title: '报告', content: '事实甲。', factIds: ['F1'] }) }
    }
  })
  const partial = await service.run([source], '做成 Word 和 PDF 一套成果', 'auto')
  const partialQuality = evaluateTaskResult('document.run', partial, { sources: [{ path: source }] })
  assert.equal(partial.deliveryReceipt.status, 'partial')
  assert.equal(partialQuality.passed, false)
  assert.ok(partialQuality.reasons.some((item) => item.code === 'BUNDLE_INCOMPLETE'))

  const successfulOutput = partial.outputs[0]
  fs.appendFileSync(successfulOutput, 'tampered')
  const changedQuality = evaluateTaskResult('document.run', { ...partial, failures: {} }, { sources: [{ path: source }] })
  assert.equal(changedQuality.passed, false)
  assert.ok(changedQuality.reasons.some((item) => item.code === 'DELIVERY_RECEIPT_MISMATCH'))
})
