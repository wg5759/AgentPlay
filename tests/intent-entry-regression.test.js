const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function router(text, decision, materials = []) {
  const events = []
  const exports = {}
  const context = { exports, require: name => name.includes('playerStore') ? { usePlayerStore: { getState: () => ({ videoSrc: 'D:/fixture.mp4' }) } } : name.includes('intent-policy') ? { directIntent: () => null } : name.includes('agent-runtime-policy') ? { canDispatchAgentTask: () => true } : { buildLinkChoice: () => ({}) }, window: { aiPlayer: { ai: { interpretIntent: async () => decision }, mediaTools: {}, mediaBatch: {} }, dispatchEvent: event => events.push(event.detail) }, CustomEvent: function (_, data) { this.detail = data.detail } }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/components/agent-panel/intentRouter.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context)
  const options = { inputText: text, attachments: materials, agentMode: 'work', addMessage: (_, value) => events.push(value), setInputText() {}, setLinkChoice() {}, setAnalysisFormat() {}, isVideoGenerationIntent: () => false }
  for (const key of ['runBatchEditTask', 'runCrossMaterialQuestion', 'runAiAssetBundleTask', 'runPersonalEditSkillCommand', 'runEditHistoryTask', 'runTrimTask', 'runAudioMixAttachmentTask']) options[key] = async () => false
  for (const key of ['runBatchTask', 'runVideoGenTask', 'runCompressTask', 'runDedupTask', 'runDocumentTask', 'runOutcomeWorkflow', 'runAnalysisTask']) options[key] = async () => events.push(key)
  options.send = async (_, opts) => events.push({ chatMode: opts?.mode })
  return { run: exports.createIntentRouter(options), events }
}

test('consultation and negative inputs reach ask mode before any side-effect detector', async () => {
  for (const text of ['不要录屏，我只是想知道这个功能怎么用', '屏幕录制支持哪些格式？', '查重会不会删除我的原文件？', '先别压缩，视频太大是不是因为码率？', '不要批量压缩，我只是在问文件大小']) {
    const sample = router(text, { kind: 'ask' }, [{ name: 'a.mp4', ext: '.mp4' }])
    await sample.run()
    assert.deepEqual(sample.events, [{ chatMode: 'ask' }], text)
  }
})

test('uncertain or unavailable intent never defaults to task execution', async () => {
  for (const decision of [{ kind: 'clarify', question: '需要保留哪一段？' }, { error: '模型不可用' }]) {
    const sample = router('帮我处理一下', decision, [{ name: 'a.docx', ext: '.docx' }])
    await sample.run()
    assert.ok(!sample.events.some(value => typeof value === 'string' && value.startsWith('run')))
  }
})

test('player controls keep their target even when documents are attached', async () => {
  const sample = router('暂停', { kind: 'execute', route: 'player' }, [{ name: 'contract.docx', ext: '.docx' }])
  await sample.run()
  assert.deepEqual(sample.events, [{ chatMode: undefined }])
})
