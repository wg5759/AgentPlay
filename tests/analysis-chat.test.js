const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  buildAnalysisReport,
  buildDeepAnalysisPrompt,
  detectAnalysisIntent,
  resolveAnalysisOutput,
  runChatAnalysis
} = require('../electron/analysis-chat-service')
const { DocumentWorkspaceService } = require('../electron/document-workspace-service')

function makeWorkspace(root) {
  return new DocumentWorkspaceService({
    outputRoot: path.join(root, '输出'),
    historyRoot: path.join(root, 'history')
  })
}

function makeVideoWithSubtitle(root) {
  const videoPath = path.join(root, '样片.mp4')
  fs.writeFileSync(videoPath, Buffer.from('fake-video-bytes'))
  fs.writeFileSync(path.join(root, '样片.srt'), [
    '1', '00:00:01,000 --> 00:00:04,000', '开场钩子：今天讲三个重点', '',
    '2', '00:00:05,000 --> 00:00:09,000', '第一点，数据增长了百分之四十', ''
  ].join('\n'), 'utf8')
  return videoPath
}

test('analysis intent matches video breakdown phrases only', () => {
  for (const text of ['拉片这个视频', '深度解剖一下', '分析这个视频并出报告', '拆解当前视频', '镜头分析', 'analyze this video']) {
    assert.equal(detectAnalysisIntent(text), true, text)
  }
  for (const text of ['暂停播放', '你好', '分析这个文档', '把附件整理成 Word', '生成双语字幕']) {
    assert.equal(detectAnalysisIntent(text), false, text)
  }
})

test('analysis output format resolves from instruction, defaulting to docx', () => {
  assert.equal(resolveAnalysisOutput('深度解剖，输出 PDF'), 'pdf')
  assert.equal(resolveAnalysisOutput('拉片并做成PPT汇报'), 'pptx')
  assert.equal(resolveAnalysisOutput('解剖后存成 markdown'), 'md')
  assert.equal(resolveAnalysisOutput('解剖后存成md'), 'md')
  assert.equal(resolveAnalysisOutput('出一份纯文本'), 'txt')
  assert.equal(resolveAnalysisOutput('深度解剖这个视频'), 'docx')
})

test('deep analysis prompt carries evidence and no-fabrication rule', () => {
  const { systemPrompt, prompt } = buildDeepAnalysisPrompt({
    mediaName: '样片.mp4', duration: 65, instruction: '重点看开场钩子',
    offlineDraft: '# 底稿', transcript: '开场钩子：今天讲三个重点'
  })
  assert.match(systemPrompt, /不得编造/)
  assert.match(prompt, /样片\.mp4/)
  assert.match(prompt, /00:01:05/)
  assert.match(prompt, /重点看开场钩子/)
  assert.match(prompt, /开场钩子：今天讲三个重点/)
  assert.match(prompt, /缺少画面证据/)
})

test('analysis report embeds AI text with offline draft appendix', () => {
  const withAi = buildAnalysisReport({
    mediaName: '样片.mp4', duration: 65, cueCount: 2,
    provider: '火山引擎', model: 'doubao-pro', aiText: '## 叙事结构\n结论', offlineDraft: '# 底稿'
  })
  assert.match(withAi, /AI 深度解剖/)
  assert.match(withAi, /火山引擎 \/ doubao-pro/)
  assert.match(withAi, /附录：离线结构底稿/)
  const offlineOnly = buildAnalysisReport({ mediaName: '样片.mp4', duration: 65, cueCount: 2, aiText: '', offlineDraft: '# 底稿' })
  assert.match(offlineOnly, /未配置模型/)
  assert.doesNotMatch(offlineOnly, /附录/)
})

test('chat analysis runs offline end-to-end and writes report next to source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  const videoPath = makeVideoWithSubtitle(root)
  const result = await runChatAnalysis({
    sourcePath: videoPath, mediaName: '样片.mp4', duration: 12,
    instruction: '深度解剖这个视频，存成md', outputFormat: 'auto',
    workspace: makeWorkspace(root), model: { configured: false }
  })
  assert.equal(result.success, true)
  assert.equal(result.usedAi, false)
  assert.equal(result.cueCount, 2)
  assert.equal(result.outputs.length, 1)
  const output = result.outputs[0]
  assert.equal(path.dirname(output), root)
  assert.match(path.basename(output), /样片-AgentPlay处理版.*\.md$/)
  const content = fs.readFileSync(output, 'utf8')
  assert.match(content, /离线结构底稿/)
  assert.match(content, /数据增长了百分之四十/)
  const history = fs.readFileSync(path.join(root, 'history', 'history.jsonl'), 'utf8')
  assert.match(history, /video-analysis/)
  assert.equal(fs.readFileSync(videoPath).toString(), 'fake-video-bytes')
})

test('chat analysis gates cloud model behind explicit approval', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  const videoPath = makeVideoWithSubtitle(root)
  let completeCalled = 0
  const result = await runChatAnalysis({
    sourcePath: videoPath, mediaName: '样片.mp4', duration: 12,
    instruction: '深度解剖这个视频', outputFormat: 'md', cloudApproved: false,
    workspace: makeWorkspace(root), model: { configured: true, local: false, provider: 'p', model: 'm' },
    complete: async () => { completeCalled += 1; return { text: '' } }
  })
  assert.equal(result.success, false)
  assert.equal(result.requiresApproval, true)
  assert.equal(completeCalled, 0)
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes('处理版')), [])
})

test('chat analysis runs AI pass after approval and embeds provider line', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  const videoPath = makeVideoWithSubtitle(root)
  const statuses = []
  const result = await runChatAnalysis({
    sourcePath: videoPath, mediaName: '样片.mp4', duration: 12,
    instruction: '深度解剖这个视频', outputFormat: 'md', cloudApproved: true,
    onStatus: (status) => statuses.push(status),
    workspace: makeWorkspace(root), model: { configured: true, local: false, provider: '火山引擎', model: 'doubao-pro' },
    complete: async ({ systemPrompt, prompt }) => {
      assert.match(systemPrompt, /不得编造/)
      assert.match(prompt, /字幕正文/)
      return { text: '## 叙事结构\n开场钩子有效。' }
    }
  })
  assert.equal(result.success, true)
  assert.equal(result.usedAi, true)
  const content = fs.readFileSync(result.outputs[0], 'utf8')
  assert.match(content, /AI 深度解剖/)
  assert.match(content, /火山引擎 \/ doubao-pro/)
  assert.match(content, /开场钩子有效。/)
  assert.ok(statuses.some((status) => status.includes('深度解剖')))
})

test('chat analysis rejects network sources and non-video files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  await assert.rejects(
    runChatAnalysis({ sourcePath: 'https://example.com/a.mp4', workspace: makeWorkspace(root), model: {} }),
    /本地视频/
  )
  const textPath = path.join(root, 'notes.txt')
  fs.writeFileSync(textPath, 'hello', 'utf8')
  await assert.rejects(
    runChatAnalysis({ sourcePath: textPath, workspace: makeWorkspace(root), model: {} }),
    /不是可解剖的视频/
  )
  await assert.rejects(
    runChatAnalysis({ sourcePath: path.join(root, 'missing.mp4'), workspace: makeWorkspace(root), model: {} }),
    /不存在/
  )
})
