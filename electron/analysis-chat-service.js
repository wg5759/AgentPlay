// 对话流视频深度解剖（拉片收编）：意图识别、输出格式推断、解剖提示词与报告组装。
// 执行入口 runChatAnalysis 复用 analysis-studio-service 的证据读取与离线结构稿，
// 报告落盘复用 DocumentWorkspaceService.writeGenerated/recordHistory，原文件不被改动。
const fs = require('fs')
const path = require('path')
const { getType } = require('./file-service')
const { buildOfflineAnalysis, formatTime, loadAnalysisContext } = require('./analysis-studio-service')

const ANALYSIS_INTENT = /(拉片|深度解剖|解剖(这个|这段|当前|这部|该|一下)?视频|视频解剖|镜头分析|逐镜|拆解(这个|这段|当前|这部|该)?视频|视频分析|分析(这个|这段|当前|这部|该)?视频|analy[sz]e (this )?video|video analysis|shot breakdown)/i

function detectAnalysisIntent(text) {
  return ANALYSIS_INTENT.test(String(text || ''))
}

function resolveAnalysisOutput(instruction) {
  const text = String(instruction || '')
  if (/pdf/i.test(text)) return 'pdf'
  if (/pptx?|演示稿|幻灯片/i.test(text)) return 'pptx'
  if (/markdown|\bmd\b/i.test(text)) return 'md'
  if (/txt|纯文本/i.test(text)) return 'txt'
  return 'docx'
}

const DEEP_ANALYSIS_SYSTEM = '你是 AgentPlay 的视频拉片与深度解剖助手。只能依据用户提供的字幕正文与离线结构底稿作答，没有画面证据时必须明说“缺少画面证据”，不得编造未出现的镜头、表演或数据。输出结构化中文 Markdown，结论要具体、可执行。'

function buildDeepAnalysisPrompt({ mediaName, duration, instruction, offlineDraft, transcript }) {
  const systemPrompt = DEEP_ANALYSIS_SYSTEM
  const prompt = [
    `视频：《${mediaName || '当前视频'}》（时长 ${formatTime(duration)}）`,
    instruction ? `用户的解剖要求：${String(instruction).slice(0, 500)}` : '用户的解剖要求：做一次完整的深度解剖。',
    '',
    '离线结构底稿（由字幕与统计线索生成）：',
    offlineDraft.slice(0, 12000),
    '',
    `字幕正文（共若干条，截断保留前 20000 字）：`,
    transcript ? transcript.slice(0, 20000) : '（无字幕证据）',
    '',
    '请输出以下章节的 Markdown 报告：',
    '## 叙事结构（开端钩子/推进/高潮/结尾行动点，引用字幕原句做证据）',
    '## 内容与信息密度（哪些段落信息重复或可压缩）',
    '## 镜头与节奏（仅在字幕能推断时下结论，否则明说缺少画面证据）',
    '## 传播钩子与受众（开头 15 秒是否抓人，适合什么平台与受众）',
    '## 缺陷清单与二次创作建议（逐条可执行）'
  ].join('\n')
  return { systemPrompt, prompt }
}

function buildAnalysisReport({ mediaName, duration, cueCount, provider, model, aiText, offlineDraft }) {
  const name = mediaName || '当前视频'
  const lines = [
    `# 《${name}》深度解剖报告`,
    '',
    '## 证据范围',
    `- 时长：${formatTime(duration)}；字幕证据：${cueCount} 条。`,
    aiText
      ? `- 分析方式：云端/本地模型深度解剖（${provider || '已配置模型'}${model ? ` / ${model}` : ''}）＋离线结构底稿。`
      : '- 分析方式：离线结构底稿（未配置模型；配置模型后可升级为 AI 深度解剖）。',
    '- 本报告只依据字幕与统计线索，未观察的画面不做编造。',
    ''
  ]
  if (aiText) {
    lines.push('## AI 深度解剖', '', aiText.trim(), '', '---', '', '## 附录：离线结构底稿', '', offlineDraft)
  } else {
    lines.push('## 离线结构底稿', '', offlineDraft)
  }
  return lines.join('\n')
}

function assertAnalyzableVideo(sourcePath) {
  const value = String(sourcePath || '')
  if (!value || /^(https?|blob):/i.test(value)) throw new Error('当前没有可解剖的本地视频（网络流和在线播放源不支持）')
  if (!fs.existsSync(value)) throw new Error('视频文件不存在或已被移动')
  if (getType(path.extname(value).toLowerCase()) !== 'video') throw new Error('当前文件不是可解剖的视频')
  return path.resolve(value)
}

// 对话流一键解剖：读取字幕证据 → 离线结构稿 →（可选）模型深度解剖 → 报告另存。
// model = { configured, local, provider, model }；complete = llmComplete；workspace = DocumentWorkspaceService。
async function runChatAnalysis({
  sourcePath, mediaName, duration, instruction = '', outputFormat = 'auto',
  cloudApproved = false, signal, onStatus = () => {}, workspace, complete, model = {}
}) {
  const resolved = assertAnalyzableVideo(sourcePath)
  const format = outputFormat && outputFormat !== 'auto' ? outputFormat : resolveAnalysisOutput(instruction)
  const displayName = mediaName || path.basename(resolved)
  onStatus('正在读取字幕与上下文')
  const context = loadAnalysisContext(resolved)
  const offlineDraft = buildOfflineAnalysis({ mediaName: displayName, duration, markers: [], cues: context.cues })
  let aiText = ''
  if (model.configured) {
    if (!model.local && cloudApproved !== true) {
      return { success: false, requiresApproval: true, cueCount: context.cues.length }
    }
    onStatus('AI 正在结合字幕证据做深度解剖…')
    const { systemPrompt, prompt } = buildDeepAnalysisPrompt({
      mediaName: displayName, duration, instruction, offlineDraft, transcript: context.transcript
    })
    const result = await complete({ systemPrompt, prompt, signal })
    aiText = result.text
  }
  onStatus('正在写出解剖报告')
  const summary = aiText
    ? `已完成《${displayName}》AI 深度解剖（${context.cues.length} 条字幕证据）`
    : `已生成《${displayName}》离线解剖结构稿（${context.cues.length} 条字幕证据；配置模型可升级为 AI 解剖）`
  const plan = {
    kind: 'video-analysis', instruction, summary, outputFormat: format,
    files: [{ name: displayName, path: resolved, ext: path.extname(resolved).toLowerCase() }]
  }
  const aiPlan = {
    title: `${displayName}·深度解剖`, summary, outputFormat: format,
    content: buildAnalysisReport({
      mediaName: displayName, duration, cueCount: context.cues.length,
      provider: model.provider, model: model.model, aiText, offlineDraft
    }),
    slides: [], sheets: []
  }
  const written = await workspace.writeGenerated(plan, aiPlan)
  const historyId = workspace.recordHistory(plan, written)
  return { success: true, outputs: written.outputs, summary, historyId, usedAi: Boolean(aiText), cueCount: context.cues.length }
}

module.exports = {
  DEEP_ANALYSIS_SYSTEM,
  buildAnalysisReport,
  buildDeepAnalysisPrompt,
  detectAnalysisIntent,
  resolveAnalysisOutput,
  runChatAnalysis
}
