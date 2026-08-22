const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const JSZip = require('jszip')

const {
  buildAnalysisReport,
  buildDeepAnalysisPrompt,
  buildVisionAnalysisPrompt,
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

function validDeepAnalysis(highlight) {
  return [
    '## 第一部分　视频讲了什么',
    '### 一句话精华',
    `${highlight} 这是一段围绕明确产品命题展开的口播内容，目标是让观众理解产品差异与使用价值。结论仅依据字幕和提供的画面证据，不补写素材中没有出现的事实。`,
    '### 内容主线',
    '作品先提出用户正在面对的问题，再用产品能力和可验证结果回答问题，最后把具体功能提升为更高层的角色定位。表达中删除同义反复，每一段只承担一个明确任务。',
    '### 全片结构时间轴',
    '- 00:00–00:04：用核心反差建立问题，让观众知道为什么需要继续看。',
    '- 00:05–00:09：给出关键数据或能力说明，完成从问题到解决方案的推进。',
    '- 00:09–00:12：收束为明确行动点，说明观众下一步做什么。',
    '### 可复制的内容结构',
    '- 先定义新角色，再连续使用人机或新旧方法对比；每个观点后立即给出可核对的画面证据，最后用三个关键词升维并短促收尾。',
    '## 第二部分　专业视听拆解与 AI 复刻',
    '### 分镜与剪辑结构',
    '- 00:00–00:04：原片观察为人物中景建立身份；复刻动作是准备中景与近景两个固定景别。',
    '- 00:05–00:09：原片观察为产品证据推进；剪辑跟随句子动词切换画面，不使用无意义转场。',
    '- 00:09–00:12：原片观察为品牌收尾；尾卡至少保留两秒识别时间。',
    '### 摄影、构图、灯光与色彩',
    '- 原片观察：眼平固定机位、人物居中、背景保留环境纵深。专业估算为 35–50mm 全画幅等效中景，强调观点时切 70–85mm 等效近景；焦段属于透视关系推断。',
    '- 灯光判断：大面积柔光作为主光，背景略亮于肤色；复刻时先保证肤色曝光，再用负补光控制轮廓。色彩用冷色真人场景和暖色产品场景建立区分。',
    '### 后期、字幕与声音',
    '- 剪辑节奏让画面动作跟随口播动词；字幕保持一到两行并避开关键界面。声音以清晰口播为主，底乐压低，转场只在重要节点加入短促音效。',
    '### AI 复刻执行方案',
    '- 先重写角色升级与对比脚本，再拍摄两个固定景别；关键 UI 使用可编辑界面重建，最后统一字幕、音效与品牌尾卡。不得复制原片人物、Logo、逐字文案或受保护素材。',
    '### 生成提示词与素材清单',
    '- 提示词：16:9 创始人口播，眼平锁定机位，柔和主光，真实肤色，环境纵深，克制手势，无镜头抖动。素材至少包含中近景、产品证据、字幕、口播、底乐与尾卡。'
  ].join('\n')
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
  assert.match(prompt, /严格两个一级部分/)
  assert.match(prompt, /第二部分　专业视听拆解与 AI 复刻/)
})

test('vision prompt carries frame evidence contract and breakdown sections', () => {
  const { systemPrompt, prompt } = buildVisionAnalysisPrompt({
    mediaName: '样片.mp4', duration: 65, instruction: '拆钩子', offlineDraft: '# 底稿', transcript: '开场白', frameCount: 12
  })
  assert.match(systemPrompt, /只能依据画面/)
  assert.match(systemPrompt, /不得编造/)
  assert.match(prompt, /12 张关键帧/)
  assert.match(prompt, /t=MM:SS/)
  assert.match(prompt, /## 第一部分　视频讲了什么/)
  assert.match(prompt, /## 第二部分　专业视听拆解与 AI 复刻/)
  assert.match(prompt, /原片观察.*专业判断.*复刻动作/)
})

function makeFrames(root, labels = ['t=00:01', 't=00:08']) {
  const dir = path.join(root, 'frames-tmp')
  fs.mkdirSync(dir, { recursive: true })
  const shots = labels.map((label, i) => {
    const file = path.join(dir, `f${i}.jpg`)
    fs.writeFileSync(file, Buffer.from([0xff, 0xd8, i]))
    return { path: file, tSec: i * 7, label }
  })
  return { extract: async () => shots }
}

test('chat analysis sends frames to vision model and reports multimodal evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  const videoPath = makeVideoWithSubtitle(root)
  const seen = {}
  const result = await runChatAnalysis({
    sourcePath: videoPath, mediaName: '样片.mp4', duration: 12,
    instruction: '深度解剖这个视频', outputFormat: 'md', cloudApproved: true,
    workspace: makeWorkspace(root),
    model: { configured: true, local: false, provider: '火山引擎', model: 'doubao-vision' },
    frames: makeFrames(root),
    completeVisionMulti: async ({ systemPrompt, prompt, images, timeoutMs }) => {
      seen.systemPrompt = systemPrompt
      seen.prompt = prompt
      seen.images = images
      seen.timeoutMs = timeoutMs
      return { text: validDeepAnalysis('首帧大字标题抓人。') }
    },
    complete: async () => { throw new Error('不应退回纯文本') }
  })
  assert.equal(result.success, true)
  assert.equal(result.frameCount, 2)
  assert.equal(seen.timeoutMs, 300000, '视觉调用必须放宽到 300 秒（实测端点需要约 187 秒）')
  assert.equal(seen.images.length, 2)
  assert.equal(seen.images[0].label, 't=00:01')
  assert.match(seen.images[0].dataUrl, /^data:image\/jpeg;base64,/)
  assert.match(seen.prompt, /## 第一部分　视频讲了什么/)
  const content = fs.readFileSync(result.outputs[0], 'utf8')
  assert.match(content, /多模态拉片（画面关键帧＋字幕）/)
  assert.match(content, /关键帧 2 张/)
  assert.match(content, /首帧大字标题抓人。/)
  assert.match(result.summary, /多模态拉片/)
})

test('analysis resumes a persisted model draft without repeating the model call', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-resume-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const videoPath = makeVideoWithSubtitle(root)
  const checkpoint = {}
  let calls = 0
  await assert.rejects(runChatAnalysis({
    sourcePath: videoPath, mediaName: '样片.mp4', duration: 12,
    instruction: '深度解剖', outputFormat: 'md', cloudApproved: true,
    workspace: makeWorkspace(root),
    model: { configured: true, local: true, provider: '本机测试', model: 'analysis-test' },
    complete: async () => { calls += 1; return { text: validDeepAnalysis('检查点初稿。') } },
    onCheckpoint: (patch) => {
      Object.assign(checkpoint, patch)
      if (patch.stage === 'analysis-model-complete') throw new Error('模拟模型完成后进程退出')
    }
  }), /模拟模型完成后进程退出/)
  assert.equal(calls, 1)
  assert.equal(checkpoint.stage, 'analysis-model-complete')

  const resumed = await runChatAnalysis({
    sourcePath: videoPath, mediaName: '样片.mp4', duration: 12,
    instruction: '深度解剖', outputFormat: 'md', cloudApproved: true,
    workspace: makeWorkspace(root), resumeCheckpoint: checkpoint,
    model: { configured: true, local: true, provider: '本机测试', model: 'analysis-test' },
    complete: async () => { throw new Error('已持久化的分析模型结果不应重复调用') }
  })
  assert.equal(resumed.success, true)
  assert.match(fs.readFileSync(resumed.outputs[0], 'utf8'), /检查点初稿/)
})

test('default DOCX analysis uses the professional renderer and embeds selected evidence frames', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  const videoPath = makeVideoWithSubtitle(root)
  const result = await runChatAnalysis({
    sourcePath: videoPath, mediaName: '样片.mp4', duration: 12,
    instruction: '专业拉片并出 Word', outputFormat: 'docx', cloudApproved: true,
    workspace: makeWorkspace(root),
    model: { configured: true, local: false, provider: 'Agnes', model: 'agnes-2.0-flash' },
    frames: makeFrames(root),
    completeVisionMulti: async () => ({ text: validDeepAnalysis('画面证据有效。') }),
    complete: async () => { throw new Error('合格初稿不应触发修复') }
  })
  const output = result.outputs[0]
  assert.equal(path.extname(output), '.docx')
  const zip = await JSZip.loadAsync(fs.readFileSync(output))
  const xml = await zip.file('word/document.xml').async('string')
  assert.match(xml, /关键画面证据/)
  assert.ok(Object.keys(zip.files).filter((name) => /^word\/media\//.test(name)).length >= 2)
})

test('chat analysis degrades honestly when model rejects images', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  const videoPath = makeVideoWithSubtitle(root)
  let textCalled = 0
  const result = await runChatAnalysis({
    sourcePath: videoPath, mediaName: '样片.mp4', duration: 12,
    instruction: '深度解剖这个视频', outputFormat: 'md', cloudApproved: true,
    workspace: makeWorkspace(root),
    model: { configured: true, local: false, provider: 'p', model: 'm' },
    frames: makeFrames(root),
    completeVisionMulti: async () => { throw new Error('视觉模型 API 400: invalid image content: unsupported') },
    complete: async () => { textCalled += 1; return { text: validDeepAnalysis('纯字幕结论。') } }
  })
  assert.equal(result.success, true)
  assert.equal(textCalled, 1)
  assert.equal(result.frameCount, 0)
  assert.match(result.visionNote, /不支持图片输入/)
  assert.match(result.summary, /不支持图片输入/)
  const content = fs.readFileSync(result.outputs[0], 'utf8')
  assert.match(content, /画面降级说明/)
  assert.match(content, /纯字幕结论。/)
})

test('chat analysis propagates non-image vision errors instead of masking them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  const videoPath = makeVideoWithSubtitle(root)
  await assert.rejects(
    runChatAnalysis({
      sourcePath: videoPath, mediaName: '样片.mp4', duration: 12,
      instruction: '深度解剖这个视频', outputFormat: 'md', cloudApproved: true,
      workspace: makeWorkspace(root),
      model: { configured: true, local: false, provider: 'p', model: 'm' },
      frames: makeFrames(root),
      completeVisionMulti: async () => { throw new Error('connect ETIMEDOUT') },
      complete: async () => ({ text: 'x' })
    }),
    /ETIMEDOUT/
  )
})

test('vision timeout propagates fast instead of paying a second text round', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  const videoPath = makeVideoWithSubtitle(root)
  let textCalled = 0
  await assert.rejects(
    runChatAnalysis({
      sourcePath: videoPath, mediaName: '样片.mp4', duration: 12,
      instruction: '深度解剖这个视频', outputFormat: 'md', cloudApproved: true,
      workspace: makeWorkspace(root),
      model: { configured: true, local: false, provider: 'p', model: 'm' },
      frames: makeFrames(root),
      completeVisionMulti: async () => { throw new Error('图片理解超时') },
      complete: async () => { textCalled += 1; return { text: 'x' } }
    }),
    /图片理解超时/
  )
  assert.equal(textCalled, 0, '超时不得再触发纯文本兜底')
})

test('local model skips frames entirely and uses text path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  const videoPath = makeVideoWithSubtitle(root)
  let extractCalled = 0
  const result = await runChatAnalysis({
    sourcePath: videoPath, mediaName: '样片.mp4', duration: 12,
    instruction: '深度解剖这个视频', outputFormat: 'md',
    workspace: makeWorkspace(root),
    model: { configured: true, local: true, provider: '内置', model: 'qwen' },
    frames: { extract: async () => { extractCalled += 1; return [] } },
    complete: async () => ({ text: '## 叙事结构\n本地结论。' })
  })
  assert.equal(result.success, true)
  assert.equal(extractCalled, 0)
})

test('analysis report keeps exactly two major parts and no appendix noise', () => {
  const withAi = buildAnalysisReport({
    mediaName: '样片.mp4', duration: 65, cueCount: 2,
    provider: '火山引擎', model: 'doubao-pro', aiText: validDeepAnalysis('结论'), offlineDraft: '# 底稿'
  })
  assert.equal((withAi.match(/^##\s/gm) || []).length, 2)
  assert.match(withAi, /火山引擎 \/ doubao-pro/)
  assert.doesNotMatch(withAi, /附录|证据范围/)
  const offlineOnly = buildAnalysisReport({ mediaName: '样片.mp4', duration: 65, cueCount: 2, aiText: '', offlineDraft: '# 底稿' })
  assert.match(offlineOnly, /未配置模型/)
  assert.equal((offlineOnly.match(/^##\s/gm) || []).length, 2)
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
  assert.match(content, /第一部分　视频讲了什么/)
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
      return { text: validDeepAnalysis('开场钩子有效。') }
    }
  })
  assert.equal(result.success, true)
  assert.equal(result.usedAi, true)
  const content = fs.readFileSync(result.outputs[0], 'utf8')
  assert.match(content, /第一部分　视频讲了什么/)
  assert.match(content, /火山引擎 \/ doubao-pro/)
  assert.match(content, /开场钩子有效。/)
  assert.ok(statuses.some((status) => status.includes('深度解剖')))
})

test('professional quality failure triggers one automatic rewrite before fallback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  const videoPath = makeVideoWithSubtitle(root)
  const statuses = []
  let calls = 0
  const result = await runChatAnalysis({
    sourcePath: videoPath, mediaName: '样片.mp4', duration: 12,
    instruction: '专业拉片', outputFormat: 'md', cloudApproved: true,
    onStatus: (status) => statuses.push(status),
    workspace: makeWorkspace(root),
    model: { configured: true, local: false, provider: 'Agnes', model: 'agnes-2.5-flash' },
    complete: async ({ prompt }) => {
      calls += 1
      if (calls === 1) return { text: '## 一句话定位\n这是一份旧式空洞报告。' }
      assert.match(prompt, /待修初稿/)
      assert.match(prompt, /正好两个部分|必须严格两个一级部分/)
      return { text: validDeepAnalysis('自动精修后通过。') }
    }
  })
  assert.equal(calls, 2)
  assert.equal(result.usedAi, true)
  assert.ok(statuses.some((status) => status.includes('自动精修')))
  assert.ok(statuses.some((status) => status.includes('质量门已通过')))
  assert.match(fs.readFileSync(result.outputs[0], 'utf8'), /自动精修后通过/)
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

test('main process vision wrappers always forward the resolved model config', () => {
  // 漏传 config 会落到引擎默认端点（无图能力 400），被误判为"模型不收图"——07-29 实踩
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  // 持久任务冻结的 modelConfig 必须一路传到视觉引擎，路由器只做能力硬门，不能换掉已审批模型。
  assert.match(main, /llmCompleteVisionMulti = async[\s\S]{0,500}?selectConfiguredModel\([\s\S]{0,200}?modelConfig[\s\S]{0,500}?apiKey: config/)
  assert.match(main, /completeVisionMulti: \(input\) => llmCompleteVisionMulti\(\{ \.\.\.input, modelConfig: config/)
  assert.match(main, /completeVision\(\{[\s\S]{0,200}?apiKey: config/)
})

test('missing duration is probed via ffprobe so reports never show 00:00:00', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-chat-'))
  const videoPath = makeVideoWithSubtitle(root)
  const result = await runChatAnalysis({
    sourcePath: videoPath, mediaName: '样片.mp4', duration: 0,
    instruction: '深度解剖这个视频', outputFormat: 'md',
    workspace: makeWorkspace(root),
    model: { configured: false },
    frames: { probeDuration: async () => 156, extract: async () => [] }
  })
  assert.equal(result.success, true)
  const content = fs.readFileSync(result.outputs[0], 'utf8')
  assert.match(content, /00:02:36/)
  assert.doesNotMatch(content, /00:00:00/)
})

test('agnes vision fallback: multimodal-unsupported model retries with agnes-2.0-flash', async () => {
  const { AgentEngine } = require('../electron/llm-service')
  const engine = new AgentEngine(null)
  const calls = []
  engine.completeVisionMultiOnce = async (options) => {
    calls.push(options.apiKey.model)
    if (calls.length === 1) throw new Error('[API 错误 504] multimodal unsupported')
    return { text: '视觉回答' }
  }
  const result = await engine.completeVisionMulti({
    prompt: '看图', imageDataUrls: ['data:image/png;base64,AAAA'], labels: ['t=00:01'],
    apiKey: { providerId: 'agnes', model: 'agnes-2.5-flash', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'k' }
  })
  assert.equal(result.text, '视觉回答')
  assert.deepEqual(calls, ['agnes-2.5-flash', 'agnes-2.0-flash'], '必须先试原型号，504 后回退 2.0-flash')

  // 非 agnes 厂商不做回退
  engine.completeVisionMultiOnce = async () => { throw new Error('[API 错误 504] multimodal unsupported') }
  await assert.rejects(() => engine.completeVisionMulti({
    prompt: '看图', imageDataUrls: ['data:image/png;base64,AAAA'],
    apiKey: { providerId: 'volcengine', model: 'doubao-x', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'k' }
  }), /504/)
})

test('safeFetch tolerates VPN fake-ip placeholder but still refuses real protected/polluted addresses', async () => {
  const { safeFetch } = require('../electron/safe-fetch')
  const config = { providerId: 'agnes', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'k' }
  let fetched = false
  const fakeFetch = async () => { fetched = true; return { ok: true, status: 200, text: async () => '{}' } }
  // 全部 fake-ip（sing-box 占位）：放行，连接按域名交给 VPN 路由
  await safeFetch(config, 'https://apihub.agnes-ai.com/v1/chat/completions', {}, {
    dnsLookup: async () => [{ address: '198.18.2.235' }],
    fetchImpl: fakeFetch
  })
  assert.ok(fetched, 'fake-ip 全占位必须放行')
  // 真实保护地址：仍拒绝
  await assert.rejects(() => safeFetch(config, 'https://apihub.agnes-ai.com/v1/chat/completions', {}, {
    dnsLookup: async () => [{ address: '10.0.0.8' }],
    fetchImpl: fakeFetch
  }), /受保护地址/)
  // 真假混合（污染迹象）：仍拒绝
  await assert.rejects(() => safeFetch(config, 'https://apihub.agnes-ai.com/v1/chat/completions', {}, {
    dnsLookup: async () => [{ address: '198.18.2.235' }, { address: '104.18.19.62' }],
    fetchImpl: fakeFetch
  }), /受保护地址/)
})
