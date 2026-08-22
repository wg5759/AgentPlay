const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { agentPanelSource } = require('./helpers/agent-panel-source')

const { DocumentWorkspaceService } = require('../electron/document-workspace-service')

function makeWorkspace(complete) {
  return new DocumentWorkspaceService({
    outputRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-out-')),
    historyRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-his-')),
    complete
  })
}

function makePlan(root, formats) {
  const docPath = path.join(root, '资料.txt')
  fs.writeFileSync(docPath, '第一段：事实甲。\n\n第二段：事实乙。', 'utf8')
  return {
    kind: 'ai-bundle',
    instruction: '做成成套成果',
    summary: '',
    outputFormat: 'bundle',
    bundleFormats: formats,
    files: [{ path: docPath, name: '资料.txt', ext: '.txt', size: 40 }]
  }
}

test('bundle sections are generated one format per model call', async () => {
  const calls = []
  const workspace = makeWorkspace(async ({ prompt, timeoutMs }) => {
    calls.push({ prompt, timeoutMs })
    if (prompt.includes('本次只生成 PPTX')) return { text: '{"title":"演示","slides":[{"title":"页1","bullets":["要点"]}],"factIds":["F1"]}' }
    return { text: '{"title":"交付","content":"正文","factIds":["F1"]}' }
  })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-src-'))
  const plan = makePlan(root, ['pptx', 'pdf'])
  const statuses = []
  const bundle = await workspace.buildBundleSections(plan, { onStatus: (s) => statuses.push(s) })
  assert.equal(calls.length, 2, '两种格式必须分两次调用')
  assert.ok(calls.every((call) => call.timeoutMs === 180000), '文档生成调用超时应为 180 秒')
  assert.ok(bundle.sections.pptx.slides.length === 1)
  assert.equal(bundle.sections.pdf.content, '正文')
  assert.deepEqual(statuses, ['正在生成 PPTX（1/2）', '正在生成 PDF（2/2）'])
})

test('one failing format does not kill the others and is reported honestly', async () => {
  const workspace = makeWorkspace(async ({ prompt }) => {
    if (prompt.includes('本次只生成 PDF')) throw new Error('模型响应超时')
    return { text: '{"title":"演示","slides":[{"title":"页1","bullets":["要点"]}],"factIds":["F1"]}' }
  })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-src-'))
  const bundle = await workspace.buildBundleSections(makePlan(root, ['pptx', 'pdf']), {})
  assert.ok(bundle.sections.pptx, 'PPT 应照常生成')
  assert.match(bundle.failures.pdf, /超时/)
  const written = await workspace.writeBundle(makePlan(root, ['pptx', 'pdf']), bundle)
  assert.equal(written.outputs.length, 1)
  assert.match(written.summary, /PDF 失败/)
  assert.match(written.summary, /可重试/)
})

test('all formats failing throws with the real reason', async () => {
  const workspace = makeWorkspace(async () => { throw new Error('模型 500') })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-src-'))
  await assert.rejects(workspace.buildBundleSections(makePlan(root, ['pptx']), {}), /模型 500/)
})

test('paragraph-boundary truncation avoids mid-sentence cuts', () => {
  const workspace = makeWorkspace(async () => ({ text: '{}' }))
  const text = '甲'.repeat(100) + '\n\n' + '乙'.repeat(100)
  const cut = workspace.truncateAtParagraph(text, 150)
  assert.equal(cut.length, 100, '应在空行处截断')
  const hard = workspace.truncateAtParagraph('丙'.repeat(300), 150)
  assert.equal(hard.length, 150, '无空行时硬切')
})

test('agent panel guards every long-running task against double submission', () => {
  const panel = agentPanelSource()
  const guards = (panel.match(/(?:docBusyRef|busyRef)\.current\) return/g) || []).length
  const locks = (panel.match(/(?:docBusyRef|busyRef)\.current = true/g) || []).length
  const releases = (panel.match(/(?:docBusyRef|busyRef)\.current = false/g) || []).length
  assert.equal(guards, locks, '每个同步防重入口都应在执行前取得锁')
  assert.ok(locks >= 9, '文档、解剖、下载、链接拉片、去重、生成、批处理、压缩和重构都应防重')
  assert.ok(releases >= locks, '每个长任务都应在 finally 或提前返回点释放防重锁')
})
