const test = require('node:test')
const assert = require('node:assert/strict')
const { CrossMaterialQaService, detectCrossMaterialQuestion } = require('../electron/cross-material-qa-service')
const { videoTime, documentPage, sheetCell, imageRegion } = require('../electron/evidence-reference')
const { evaluateTaskResult } = require('../electron/task-result-quality')

const references = [
  videoTime('interview.mp4', 4, 8, '受访者说一月收入100万'),
  sheetCell('finance.xlsx', '经营数据', 'B2', '100'),
  documentPage('contract.pdf', 3, '合同约定月收入目标90万'),
  imageRegion('chart.png', { x: 0, y: 0, width: 800, height: 600 }, '图表显示一月收入100万')
]

test('cross-material answer renders confirmed, inference and unknown claims with exact locators', async () => {
  const service = new CrossMaterialQaService({ complete: async () => ({ text: JSON.stringify({ claims: [
    { text: '访谈与表格都记录一月收入100万', status: 'confirmed', evidenceIds: ['E1', 'E2'] },
    { text: '实际收入可能高于合同目标', status: 'inference', evidenceIds: ['E2', 'E3'] },
    { text: '材料没有说明二月收入', status: 'unknown', evidenceIds: [] }
  ] }) }) })
  const result = await service.answer({ question: '这些材料的收入数字是否一致？', references })
  assert.equal(result.success, true)
  assert.equal(result.evidenceReceipt.sourceCount, 4)
  assert.equal(result.evidenceReceipt.confirmedCitationsValid, true)
  assert.match(result.summary, /【已确认】.*\[E1\]\[E2\]/)
  assert.match(result.summary, /【推断】/)
  assert.match(result.summary, /【未知】/)
  assert.match(result.summary, /interview\.mp4 00:04–00:08/)
  assert.match(result.summary, /finance\.xlsx 经营数据!B2/)
})

test('invalid confirmed citation gets one bounded repair and then passes', async () => {
  let calls = 0
  const service = new CrossMaterialQaService({ complete: async () => {
    calls += 1
    return { text: JSON.stringify({ claims: calls === 1
      ? [{ text: '虚构结论', status: 'confirmed', evidenceIds: ['E999'] }]
      : [{ text: '视频和表格数字一致', status: 'confirmed', evidenceIds: ['E1', 'E2'] }] }) }
  } })
  const result = await service.answer({ question: '数字一致吗？', references, allowRepair: true })
  assert.equal(calls, 2)
  assert.equal(result.claims[0].status, 'confirmed')
})

test('two invalid model answers fail closed instead of returning uncited prose', async () => {
  const service = new CrossMaterialQaService({ complete: async () => ({ text: '{"claims":[{"text":"虚构","status":"confirmed","evidenceIds":[]}]}' }) })
  await assert.rejects(service.answer({ question: '是否一致？', references, allowRepair: true }), /两次未通过引用校验/)
})

test('cloud-style execution fails after one invalid response instead of silently paying for repair', async () => {
  let calls = 0
  const service = new CrossMaterialQaService({ complete: async () => { calls += 1; return { text: '{"claims":[{"text":"虚构","status":"confirmed","evidenceIds":[]}]}' } } })
  await assert.rejects(service.answer({ question: '是否一致？', references, allowRepair: false }), /未通过引用校验/)
  assert.equal(calls, 1)
})

test('cross-material question detection does not steal explicit document work', () => {
  assert.equal(detectCrossMaterialQuestion('对比这几份材料，哪些数字一致？'), true)
  assert.equal(detectCrossMaterialQuestion('根据这些材料生成一份Word报告'), false)
  assert.equal(detectCrossMaterialQuestion('合并这几个PDF'), false)
})

test('cross-material answer requires at least two evidence-bearing sources', async () => {
  const service = new CrossMaterialQaService({ complete: async () => ({ text: '{}' }) })
  await assert.rejects(service.answer({ question: '结论是什么？', references: [references[0]] }), /至少需要两个/)
})

test('cross-material task quality requires source coverage, claim labels and valid citations', async () => {
  const service = new CrossMaterialQaService({ complete: async () => ({ text: JSON.stringify({ claims: [
    { text: '视频和表格数字一致', status: 'confirmed', evidenceIds: ['E1', 'E2'] },
    { text: '二月数据未提供', status: 'unknown', evidenceIds: [] }
  ] }) }) })
  const result = await service.answer({ question: '数字是否一致？', references })
  assert.equal(evaluateTaskResult('project.evidence-qa', result, {}).passed, true)
  assert.equal(evaluateTaskResult('project.evidence-qa', { ...result, evidenceReceipt: { ...result.evidenceReceipt, confirmedCitationsValid: false } }, {}).passed, false)
})

test('main, preload and renderer wire cross-material QA through persistent recovery and cloud approval', () => {
  const fs = require('node:fs'); const path = require('node:path'); const root = path.join(__dirname, '..')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8')
  const router = fs.readFileSync(path.join(root, 'src', 'components', 'agent-panel', 'intentRouter.ts'), 'utf8')
  const hook = fs.readFileSync(path.join(root, 'src', 'components', 'agent-panel', 'useCrossMaterialQaTasks.ts'), 'utf8')
  assert.match(main, /persistentTaskRuntime\.register\('project\.evidence-qa'/)
  assert.match(main, /approval: modelRoute\.local \? null : \{ action: 'cloud'/)
  assert.match(main, /ipcMain\.handle\('cross-material:ask'/)
  assert.match(preload, /crossMaterial: \{/)
  assert.ok(router.indexOf('await runCrossMaterialQuestion(text)') < router.indexOf('await runDocumentTask()'))
  assert.match(hook, /pendingTaskRef\.current = 'cross-qa'/)
  assert.match(hook, /result\.requiresApproval/)
  assert.match(hook, /if \(!waitingApproval\) setTaskStatus\(''\)/)
  assert.match(hook, /item\.locatorLabel/)
  const panel = fs.readFileSync(path.join(root, 'src', 'components', 'AgentPanel.tsx'), 'utf8')
  assert.match(panel, /pendingTaskRef\.current === 'cross-qa' && executionTask\.status/)
})
