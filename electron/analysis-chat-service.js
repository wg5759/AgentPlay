// 对话流视频深度解剖（拉片收编）：意图识别、输出格式推断、解剖提示词与报告组装。
// 执行入口 runChatAnalysis 复用 analysis-studio-service 的证据读取与离线结构稿，
// 报告落盘复用 DocumentWorkspaceService.writeGenerated/recordHistory，原文件不被改动。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { getType } = require('./file-service')
const { formatTime, loadAnalysisContext } = require('./analysis-studio-service')
const {
  buildEvidenceAnalysis,
  detectSourceLanguage,
  evaluateProfessionalAnalysisQuality,
  isUnderpoweredLocalAnalysisModel
} = require('./analysis-quality-policy')

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

const PROFESSIONAL_REPORT_CONTRACT = [
  '正文必须严格两个一级部分（使用下面两个二级标题），不得增加“证据范围”“总结”“附录”等第三部分：',
  '## 第一部分　视频讲了什么',
  '其中使用三级标题：一句话精华、内容主线、全片结构时间轴、可复制的内容结构。',
  '## 第二部分　专业视听拆解与 AI 复刻',
  '其中使用三级标题：分镜与剪辑结构、摄影/机位/景别/构图/灯光/曝光/色彩、后期/字幕/声音、AI 复刻执行方案、生成提示词与最小素材清单。',
  '第二部分每个关键判断按“原片观察—专业判断—复刻动作”表达；焦段、光位等不能从单帧精确确认的参数必须标注“专业估算”或“推断”。',
  '时间轴必须覆盖开头、中段和结尾；删除营销套话、重复结论、信息密度打分和无关方法说明。'
].join('\n')

const DEEP_ANALYSIS_SYSTEM = `你是 AgentPlay 的资深导演、摄影指导、剪辑师和 AI 视频制片人。界面语言为中文，因此标题、解释、结论和建议必须全部使用中文；外语原句只能作为短证据引用，引用后立即用中文解释，禁止整段复制外语冒充分析。只能依据用户提供的字幕正文与证据底稿作答，没有画面证据时必须明说“缺少画面证据”，不得编造未出现的镜头、表演或数据。输出专业、克制、可直接执行的中文 Markdown。\n${PROFESSIONAL_REPORT_CONTRACT}`

// 多模态拉片：画面关键帧（标注 t=MM:SS）与字幕同为一手证据，镜头/构图/节奏只看画面
const DEEP_ANALYSIS_VISION_SYSTEM = `你是 AgentPlay 的资深导演、摄影指导、剪辑师和 AI 视频制片人。界面语言为中文，因此标题、解释、结论和建议必须全部使用中文；外语原句只能作为短证据引用，引用后立即用中文解释。用户会给你按时间顺序排列的视频关键帧（每张标注 t=MM:SS）与口播字幕，两者都是一手证据：镜头、构图、节奏只能依据画面，台词与观点只能依据字幕，两者冲突以画面为准，不得编造未出现的镜头、表演或数据。静态关键帧不能证明连续运镜、精确焦段、灯具型号或完整声音设计，相关结论必须标注观察边界、专业估算或复刻建议。\n${PROFESSIONAL_REPORT_CONTRACT}`

function buildDeepAnalysisPrompt({ mediaName, duration, instruction, offlineDraft, transcript }) {
  const systemPrompt = DEEP_ANALYSIS_SYSTEM
  const prompt = [
    `视频：《${mediaName || '当前视频'}》（时长 ${formatTime(duration)}）`,
    instruction ? `用户的解剖要求：${String(instruction).slice(0, 500)}` : '用户的解剖要求：做一次完整的深度解剖。',
    '',
    '离线证据底稿（只提取事实，不沿用其表达）：',
    offlineDraft.slice(0, 12000),
    '',
    `字幕正文（共若干条，截断保留前 20000 字）：`,
    transcript ? transcript.slice(0, 20000) : '（无字幕证据）',
    '',
    '请按下面契约直接输出正文，不要写总标题或前言：',
    PROFESSIONAL_REPORT_CONTRACT,
    '本次缺少画面证据：第二部分必须明确哪些摄影结论无法确认，但仍可给出基于内容结构的拍摄与 AI 复刻方案；不得把字幕时间冒充镜头切点。'
  ].join('\n')
  return { systemPrompt, prompt }
}

function buildVisionAnalysisPrompt({ mediaName, duration, instruction, offlineDraft, transcript, frameCount }) {
  const systemPrompt = DEEP_ANALYSIS_VISION_SYSTEM
  const prompt = [
    `视频：《${mediaName || '当前视频'}》（时长 ${formatTime(duration)}）`,
    `画面证据：随附 ${frameCount} 张关键帧（镜头切换感知抽取、已去重），每张标注拍摄时间点 t=MM:SS。`,
    instruction ? `用户的解剖要求：${String(instruction).slice(0, 500)}` : '用户的解剖要求：做一次完整的拉片拆解。',
    '',
    '离线证据底稿（字幕统计线索，仅供对照，不沿用其表达）：',
    offlineDraft.slice(0, 8000),
    '',
    '口播字幕正文（截断保留前 15000 字）：',
    transcript ? transcript.slice(0, 15000) : '（无字幕证据）',
    '',
    '请按下面契约直接输出正文，不要写总标题或前言：',
    PROFESSIONAL_REPORT_CONTRACT,
    '分镜表必须引用 t=MM:SS；不能从相邻静态帧确认的运动或转场不要写成事实。第二部分必须覆盖摄影、构图、灯光、色彩、剪辑、字幕、声音和 AI 复刻，并使用“原片观察—专业判断—复刻动作”。'
  ].join('\n')
  return { systemPrompt, prompt }
}

function buildQualityRepairPrompt({ mediaName, duration, draft, reasons, transcript, hasVisualEvidence }) {
  return [
    `《${mediaName || '当前视频'}》专业拉片初稿未通过质量门（时长 ${formatTime(duration)}）。`,
    `失败原因：${reasons.join('；')}`,
    '',
    '请只重写，不解释修改过程。必须保留已有事实证据，不得补写未观察画面。',
    hasVisualEvidence ? '已有关键帧证据；保留原片观察与时间码。' : '没有画面证据；摄影结论必须明确限制。',
    PROFESSIONAL_REPORT_CONTRACT,
    '',
    '字幕证据：',
    String(transcript || '').slice(0, 12000),
    '',
    '待修初稿：',
    String(draft || '').slice(0, 24000)
  ].join('\n')
}

function buildAnalysisReport({ mediaName, duration, cueCount, frameCount = 0, provider, model, aiText, offlineDraft, visionNote = '', analysisNote = '' }) {
  const name = mediaName || '当前视频'
  const method = aiText
    ? `${frameCount ? '多模态拉片（画面关键帧＋字幕）' : '字幕证据分析'} · ${provider || '已配置模型'}${model ? ` / ${model}` : ''}`
    : `证据化本地底稿 · ${analysisNote || '未配置模型或模型结果未通过质量门'}`
  const lines = [
    `# 《${name}》专业拉片与 AI 复刻报告`,
    '',
    `> 时长 ${formatTime(duration)} · 字幕 ${cueCount} 条${frameCount ? ` · 关键帧 ${frameCount} 张` : ''} · ${method}`,
    '> 观察、专业推断与复刻建议分开表达；未取得的证据不做编造。'
  ]
  if (visionNote) lines.push(`> 画面降级说明：${visionNote}`)
  let body = String(aiText || offlineDraft || '').trim()
  const bodySections = body.match(/^##\s+.+$/gm) || []
  if (bodySections.length !== 2) {
    const plain = body.replace(/^#{1,6}\s+/gm, '**').replace(/\*\*([^\n]+)$/gm, '**$1**')
    body = [
      '## 第一部分　视频讲了什么',
      '',
      '### 当前可确认的内容',
      plain || '- 缺少可核对的字幕内容。',
      '',
      '## 第二部分　专业视听拆解与 AI 复刻',
      '',
      '### 证据边界与复刻动作',
      '- 当前结果未形成合格的画面分析；不编造摄影、灯光、焦段或剪辑结论。',
      '- 复刻时先补齐关键帧和细粒度字幕，再按“原片观察—专业判断—复刻动作”重新生成。'
    ].join('\n')
  }
  lines.push('', body)
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
  cloudApproved = false, signal, onStatus = () => {}, workspace, complete, completeVisionMulti, frames,
  translateToChinese, model = {}, onCheckpoint, resumeCheckpoint, outputDir
}) {
  const resolved = assertAnalyzableVideo(sourcePath)
  const format = outputFormat && outputFormat !== 'auto' ? outputFormat : resolveAnalysisOutput(instruction)
  const displayName = mediaName || path.basename(resolved)
  // 部分站点解析不带时长：用 ffprobe 补上，否则报告显示 00:00:00
  if (!(Number(duration) > 0) && frames?.probeDuration) {
    try { duration = await frames.probeDuration(resolved) || duration } catch { /* 保留原值 */ }
  }
  onStatus('正在读取字幕与上下文')
  const context = loadAnalysisContext(resolved)
  if (model.configured && !model.local && cloudApproved !== true) {
    return { success: false, requiresApproval: true, cueCount: context.cues.length }
  }
  let translatedCues = []
  if (context.cues.length && detectSourceLanguage(context.cues) === '英文' && typeof translateToChinese === 'function') {
    onStatus('源字幕为英文，正在生成中文分析证据')
    try {
      const translated = await translateToChinese({ cues: context.cues, signal, onStatus })
      if (Array.isArray(translated) && translated.length === context.cues.length) translatedCues = translated
    } catch (error) {
      onStatus(`中文证据生成失败（${String(error?.message || error).slice(0, 60)}），报告将只做结构判断`)
    }
  }
  const offlineDraft = buildEvidenceAnalysis({
    mediaName: displayName,
    duration,
    cues: context.cues,
    translatedCues,
    frameCount: 0
  })
  const evidenceCues = translatedCues.length ? translatedCues : context.cues
  const analysisTranscript = evidenceCues.length
    ? evidenceCues.map((cue) => `${formatTime(cue.start)}–${formatTime(cue.end)} ${cue.text}`).join('\n')
    : context.transcript
  let aiText = ''
  let frameCount = 0
  let visionNote = ''
  let analysisNote = ''
  let reportFrames = []
  let semanticQuality = null
  const domainRepairHistory = []
  const resumedDraft = resumeCheckpoint?.analysisDraft && typeof resumeCheckpoint.analysisDraft === 'object'
    ? resumeCheckpoint.analysisDraft
    : null
  if (resumedDraft) {
    aiText = String(resumedDraft.aiText || '')
    frameCount = Math.max(0, Number(resumedDraft.frameCount) || 0)
    visionNote = String(resumedDraft.visionNote || '')
    analysisNote = String(resumedDraft.analysisNote || '')
    semanticQuality = resumedDraft.semanticQuality || null
    if (Array.isArray(resumedDraft.domainRepairHistory)) domainRepairHistory.push(...resumedDraft.domainRepairHistory.slice(-4))
    onStatus('已从检查点恢复模型分析结果，不重复调用模型')
  }
  const underpoweredLocal = isUnderpoweredLocalAnalysisModel(model)
  if (resumedDraft) {
    // 模型结果已经持久化；后续只做本地证据恢复和确定性写出。
  } else if (underpoweredLocal) {
    analysisNote = `内置轻量模型 ${model.model || ''} 不具备可靠深度拉片能力，已阻止其生成伪分析`
    onStatus(`${analysisNote}；改用证据化中文拆解`)
  } else if (model.configured) {
    // 多模态拉片：抽关键帧随字幕一起给视觉模型；模型不收图片则如实降级为纯文本解剖
    if (!model.local && frames && completeVisionMulti) {
      onStatus('正在抽取关键画面帧')
      let shots = []
      try {
        shots = await frames.extract({ sourcePath: resolved, durationSec: duration, outDir: path.join(os.tmpdir(), `agentplay-frames-${Date.now()}`), signal })
      } catch (error) {
        onStatus(`关键帧抽取失败（${String(error?.message || '未知原因').slice(0, 60)}），本次仅基于字幕`)
        shots = []
      }
      if (shots.length) {
        onStatus(`AI 正在观看 ${shots.length} 张关键画面并拆解（约 1-3 分钟）…`)
        try {
          const framePayloads = shots.map((shot) => ({ label: shot.label, data: fs.readFileSync(shot.path) }))
          const images = framePayloads.map((shot) => ({
            label: shot.label,
            dataUrl: `data:image/jpeg;base64,${shot.data.toString('base64')}`
          }))
          const { systemPrompt, prompt } = buildVisionAnalysisPrompt({
            mediaName: displayName, duration, instruction, offlineDraft,
            transcript: analysisTranscript, frameCount: shots.length
          })
          const result = await completeVisionMulti({ systemPrompt, prompt, images, signal, timeoutMs: 300000 })
          aiText = result.text
          frameCount = shots.length
          reportFrames = framePayloads
        } catch (error) {
          const message = String(error?.message || '')
          // 只有"模型能力上不收图"才降级纯文本；超时/网络错误直接抛出，不再白等一轮
          if (/multimodal|does not support|unsupported.*(image|vision|media| modality)|invalid.*(image|image_url|content)|image.*(unsupported|invalid|not supported)|(不支持|不接受).{0,4}(图|图片|图像|多模态)/i.test(message)) {
            visionNote = '当前模型不支持图片输入，本次仅基于字幕与结构线索（想看画面：到模型接入中心换视觉模型，如 doubao-vision 系列）'
            onStatus(`${visionNote}，退回纯文本解剖`)
          } else {
            throw error
          }
        } finally {
          try { fs.rmSync(path.dirname(shots[0].path), { recursive: true, force: true }) } catch { /* 忽略 */ }
        }
      }
    }
    if (!aiText) {
      onStatus('AI 正在结合字幕证据做深度解剖…')
      const { systemPrompt, prompt } = buildDeepAnalysisPrompt({
        mediaName: displayName, duration, instruction, offlineDraft, transcript: analysisTranscript
      })
      const result = await complete({ systemPrompt, prompt, signal, timeoutMs: 300000 })
      aiText = result.text
    }
  }
  if (aiText && !resumedDraft) {
    let quality = evaluateProfessionalAnalysisQuality(aiText, { duration, hasVisualEvidence: frameCount > 0 })
    semanticQuality = quality
    if (!quality.ok && typeof complete === 'function') {
      onStatus(`初稿未通过专业质量门，正在自动精修（${quality.reasons.slice(0, 2).join('；')}）`)
      try {
        const repaired = await complete({
          systemPrompt: DEEP_ANALYSIS_SYSTEM,
          prompt: buildQualityRepairPrompt({
            mediaName: displayName, duration, draft: aiText, reasons: quality.reasons,
            transcript: analysisTranscript, hasVisualEvidence: frameCount > 0
          }),
          signal,
          timeoutMs: 300000
        })
        const repairedText = String(repaired?.text || '').trim()
        const repairedQuality = evaluateProfessionalAnalysisQuality(repairedText, { duration, hasVisualEvidence: frameCount > 0 })
        domainRepairHistory.push({
          attempt: 1, action: '按专业拉片质量门自动精修初稿',
          fromScore: Math.max(20, 100 - quality.reasons.length * 12),
          toScore: repairedQuality.ok ? 100 : Math.max(20, 100 - repairedQuality.reasons.length * 12),
          passed: repairedQuality.ok, reasons: quality.reasons.slice(0, 6), completedAt: Date.now()
        })
        if (repairedQuality.ok) {
          aiText = repairedText
          quality = repairedQuality
          onStatus('专业质量门已通过')
        } else {
          quality = repairedQuality
        }
        semanticQuality = quality
      } catch (error) {
        if (signal?.aborted) throw error
        analysisNote = `自动精修失败：${String(error?.message || error).slice(0, 80)}`
      }
    }
    if (!quality.ok) {
      analysisNote = `模型结果未通过质量门：${quality.reasons.join('；')}`
      onStatus(`${analysisNote}；不交付该结果，改用证据化中文拆解`)
      aiText = ''
      frameCount = 0
      reportFrames = []
    }
  } else if (!resumedDraft && !analysisNote) {
    analysisNote = model.configured ? '模型没有返回可用内容' : '未配置可用的深度分析模型'
  }
  if (resumedDraft && frameCount > 0 && frames) {
    let shots = []
    try {
      onStatus('正在从本地媒体恢复报告关键帧')
      shots = await frames.extract({ sourcePath: resolved, durationSec: duration, outDir: path.join(os.tmpdir(), `agentplay-frames-resume-${Date.now()}`), signal })
      reportFrames = shots.slice(0, frameCount).map((shot) => ({ label: shot.label, data: fs.readFileSync(shot.path) }))
      frameCount = reportFrames.length
    } finally {
      try { if (shots[0]?.path) fs.rmSync(path.dirname(shots[0].path), { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
  }
  onCheckpoint?.({
    stage: 'analysis-model-complete',
    analysisDraft: { aiText, frameCount, visionNote, analysisNote, semanticQuality, domainRepairHistory }
  })
  onStatus('正在写出解剖报告')
  const summary = aiText
    ? frameCount
      ? `已完成《${displayName}》多模态拉片（${frameCount} 张关键帧 + ${context.cues.length} 条字幕证据）`
      : `已完成《${displayName}》AI 深度解剖（${context.cues.length} 条字幕证据）${visionNote ? `；${visionNote}` : ''}`
    : `已生成《${displayName}》证据化中文拆解（${context.cues.length} 条字幕证据；未交付低质量模型结果）`
  const plan = {
    kind: 'video-analysis', instruction, summary, outputFormat: format,
    files: [{ name: displayName, path: resolved, ext: path.extname(resolved).toLowerCase() }],
    ...(outputDir ? { outputDir: path.resolve(outputDir) } : {})
  }
  const aiPlan = {
    title: `${displayName}·深度解剖`, summary, outputFormat: format,
    content: buildAnalysisReport({
      mediaName: displayName, duration, cueCount: context.cues.length, frameCount,
      provider: model.provider, model: model.model, aiText, offlineDraft, visionNote, analysisNote
    }),
    slides: [], sheets: [],
    reportAssets: { type: 'video-analysis', frames: reportFrames }
  }
  const written = await workspace.writeGenerated(plan, aiPlan)
  const domainQuality = aiText
    ? { score: semanticQuality?.ok === false ? Math.max(20, 100 - semanticQuality.reasons.length * 12) : 100, passed: semanticQuality?.ok !== false, level: semanticQuality?.ok === false ? 'fail' : 'pass', reasons: semanticQuality?.reasons || [], fallbackUsed: false }
    : { score: 80, passed: true, level: 'warning', reasons: semanticQuality?.reasons || (analysisNote ? [analysisNote] : []), fallbackUsed: true }
  const result = { success: true, outputs: written.outputs, summary, usedAi: Boolean(aiText), cueCount: context.cues.length, frameCount, visionNote, analysisNote, excerpt: String(aiText || offlineDraft).slice(0, 2000), domainQuality, domainRepairHistory }
  onCheckpoint?.({ stage: 'outputs-written', result })
  const historyId = workspace.recordHistory(plan, written)
  const completed = { ...result, historyId }
  onCheckpoint?.({ stage: 'history-written', result: completed })
  return completed
}

module.exports = {
  DEEP_ANALYSIS_SYSTEM,
  DEEP_ANALYSIS_VISION_SYSTEM,
  PROFESSIONAL_REPORT_CONTRACT,
  buildAnalysisReport,
  buildDeepAnalysisPrompt,
  buildQualityRepairPrompt,
  buildVisionAnalysisPrompt,
  detectAnalysisIntent,
  resolveAnalysisOutput,
  runChatAnalysis
}
