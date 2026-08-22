const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { compileOutcomeWorkflow, assertOutcomeWorkflow } = require('../electron/outcome-workflow')
const { OutcomeWorkflowRunner } = require('../electron/outcome-workflow-runner')
const { fingerprintArtifact } = require('../electron/artifact-fingerprint')
const { evaluateTaskResult } = require('../electron/task-result-quality')

test('final video deliverables compile into one frozen evidence-analysis-package workflow', () => {
  const plan = compileOutcomeWorkflow({
    sourcePath: 'D:\\Videos\\产品介绍.mp4',
    instruction: '把这个视频做成一套中文拉片报告、PPT 和 Excel 分析表'
  })
  assert.equal(plan.schemaVersion, 1)
  assert.equal(plan.kind, 'agentplay.outcome-workflow')
  assert.equal(plan.source.kind, 'video')
  assert.deepEqual(plan.deliverables.formats, ['docx', 'pptx', 'xlsx'])
  assert.equal(plan.deliverables.language, 'zh-CN')
  assert.deepEqual(plan.steps.map((step) => step.tool), ['video.evidence-analysis', 'document.consistent-bundle'])
  assert.deepEqual(plan.steps[1].dependsOn, ['evidence-analysis'])
  assert.equal(plan.quality.requireEveryStepReceipt, true)
  assert.doesNotMatch(JSON.stringify(plan), /ffmpeg|whisper|ocr|内部工具链/i, '用户成果合同不暴露内部工程步骤')
  assert.deepEqual(assertOutcomeWorkflow(plan), plan)
})

test('outcome workflow rejects single-output, consultation and unsupported sources', () => {
  assert.equal(compileOutcomeWorkflow({ sourcePath: 'D:\\Videos\\a.mp4', instruction: '做一份 Word 报告' }), null)
  assert.equal(compileOutcomeWorkflow({ sourcePath: 'D:\\Videos\\a.mp4', instruction: '能不能做一份 Word 和 PPT？' }), null)
  assert.equal(compileOutcomeWorkflow({ sourcePath: 'D:\\Docs\\a.docx', instruction: '做一份 Word 和 PPT' }), null)
  assert.throws(() => assertOutcomeWorkflow({ schemaVersion: 1, kind: 'agentplay.outcome-workflow', steps: [] }), /成果工作流/)
})

test('outcome quality requires both real step receipts and a matching final delivery receipt', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-outcome-quality-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const report = path.join(root, '报告.docx')
  const slides = path.join(root, '汇报.pptx')
  const draft = path.join(root, '底稿.md')
  fs.writeFileSync(report, Buffer.concat([Buffer.from('PK'), Buffer.alloc(2048, 1)]))
  fs.writeFileSync(slides, Buffer.concat([Buffer.from('PK'), Buffer.alloc(2048, 2)]))
  fs.writeFileSync(draft, '# 视频解剖底稿\n证据内容', 'utf8')
  const outputs = [report, slides]
  const artifacts = outputs.map((outputPath) => ({ path: outputPath, sha256: fingerprintArtifact(outputPath).sha256 }))
  const result = {
    success: true, outputs, summary: '成果包完成',
    workflowReceipt: { schemaVersion: 1, kind: 'agentplay.outcome-workflow-receipt', source: { path: 'video.mp4', sha256: 'a'.repeat(64) }, steps: [
      { id: 'evidence-analysis', state: 'completed', outputs: [draft] },
      { id: 'consistent-package', state: 'completed', outputs }
    ] },
    deliveryReceipt: { schemaVersion: 1, kind: 'agentplay.delivery-receipt', artifacts }
  }
  assert.equal(evaluateTaskResult('outcome.workflow', result, {}).passed, true)
  assert.equal(evaluateTaskResult('outcome.workflow', result, { projectId: 'project-required' }).passed, false)
  const withProject = { ...result, projectCapsule: { schemaVersion: 1, projectId: 'project-1', revision: 1, currentPath: report } }
  assert.equal(evaluateTaskResult('outcome.workflow', withProject, { projectId: 'project-1' }).passed, true)
  const incomplete = { ...result, workflowReceipt: { ...result.workflowReceipt, steps: result.workflowReceipt.steps.slice(1) } }
  assert.equal(evaluateTaskResult('outcome.workflow', incomplete, {}).passed, false)
  assert.ok(evaluateTaskResult('outcome.workflow', incomplete, {}).reasons.some((item) => item.code === 'WORKFLOW_RECEIPT_INCOMPLETE'))
})

test('outcome runner resumes the final package without repeating completed analysis', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-outcome-resume-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const draft = path.join(root, 'analysis.md')
  const final = path.join(root, 'result.docx')
  fs.writeFileSync(draft, '# evidence', 'utf8')
  const workflow = compileOutcomeWorkflow({ sourcePath: 'D:\\Videos\\a.mp4', instruction: '做成中文拉片报告和 PPT' })
  const runner = new OutcomeWorkflowRunner({ outputsStillExist: (result) => (result?.outputs || []).every((item) => fs.existsSync(item)) })
  let persisted = {}
  let analysisCalls = 0
  await assert.rejects(runner.run({
    workflow, sourceReceipt: { path: 'D:\\Videos\\a.mp4', sha256: 'a'.repeat(64) }, checkpoint: persisted,
    saveCheckpoint: (value) => { persisted = value },
    runAnalysis: async () => { analysisCalls += 1; return { outputs: [draft], historyId: 'analysis-1' } },
    runPackage: async () => { throw new Error('模拟最终打包中断') }
  }), /模拟最终打包中断/)
  assert.equal(persisted.stage, 'analysis-complete')
  assert.equal(analysisCalls, 1)

  const result = await runner.run({
    workflow, sourceReceipt: { path: 'D:\\Videos\\a.mp4', sha256: 'a'.repeat(64) }, checkpoint: persisted,
    saveCheckpoint: (value) => { persisted = value },
    runAnalysis: async () => { throw new Error('已完成的分析不得重复') },
    runPackage: async ({ analysisResult }) => {
      assert.deepEqual(analysisResult.outputs, [draft])
      fs.writeFileSync(final, Buffer.concat([Buffer.from('PK'), Buffer.alloc(2048)]))
      return { outputs: [final], historyId: 'package-1', deliveryReceipt: { schemaVersion: 1 } }
    }
  })
  assert.equal(result.outputs[0], final)
  assert.equal(result.workflowReceipt.steps.length, 2)
  assert.equal(persisted.stage, 'workflow-complete')
  assert.equal(analysisCalls, 1)
})

test('main, preload and renderer expose one recoverable outcome workflow entry', () => {
  const root = path.join(__dirname, '..')
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
  const main = read('electron/main.js')
  const preload = read('electron/preload.js')
  const hook = read('src/components/agent-panel/useDocumentAnalysisTasks.ts')
  const router = read('src/components/agent-panel/intentRouter.ts')
  assert.match(main, /register\('outcome\.workflow'/)
  assert.match(main, /ipcMain\.handle\('outcome:detect'/)
  assert.match(main, /ipcMain\.handle\('outcome:run'/)
  assert.match(preload, /outcomeWorkflow:/)
  assert.match(hook, /runOutcomeWorkflow/)
  assert.match(router, /outcomeWorkflow\.detect/)
  assert.match(router, /runOutcomeWorkflow\(\)/)
})
