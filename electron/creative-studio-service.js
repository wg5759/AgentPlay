const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { safeFetch } = require('./safe-fetch')

const MAX_VISUAL_EVIDENCE = 12
const MAX_IMAGE_BYTES = 1_500_000
const CREATIVE_PLAN_SYSTEM = `你是视频导演、剪辑师和事实核查员。只能依据提供的字幕、人工拉片和画面帧制定原创改编方案。
输出严格 JSON，不要 Markdown。不得虚构画面里未出现的人物、品牌或事实。新镜头必须标记为 generated，并给出可直接用于图像生成的 prompt；保留原片则标记 source。`

function safeText(value, max = 10000) {
  return String(value || '').replace(/\u0000/g, '').slice(0, max)
}

function normalizeDataUrl(value) {
  const match = String(value || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/)
  if (!match) return null
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null
  return { dataUrl: `data:${match[1]};base64,${match[2]}`, mimeType: match[1], base64: match[2], bytes: bytes.length }
}

function collectVisualEvidence(markers = []) {
  return markers.flatMap((marker) => {
    const image = normalizeDataUrl(marker?.thumbnail)
    if (!image) return []
    return [{
      at: Number(marker.at) || 0,
      note: safeText(marker.note, 500),
      shotSize: safeText(marker.shotSize, 50),
      movement: safeText(marker.movement, 50),
      ...image
    }]
  }).slice(0, MAX_VISUAL_EVIDENCE)
}

function buildCreativePrompt(input = {}, visualCount = 0) {
  const segments = Array.isArray(input.segments) ? input.segments.slice(0, 100) : []
  const cues = Array.isArray(input.cues) ? input.cues.slice(0, 1000) : []
  return [
    '请生成一份可执行的原创视频方案。',
    `目标：${safeText(input.originalGoal, 2000)}`,
    `风格：${safeText(input.style, 1000)}`,
    `原片名：${safeText(input.mediaName, 300)}`,
    `已提供画面帧：${visualCount} 张。没有画面帧时只能做文本证据分析。`,
    `当前重排片段：${JSON.stringify(segments.map((item) => ({ id: item.id, start: Number(item.start), end: Number(item.end), title: safeText(item.title, 300) })))}`,
    `人工拉片：${JSON.stringify((input.markers || []).slice(0, 200).map(({ thumbnail, ...marker }) => marker))}`,
    `字幕：${cues.map((cue) => `[${Number(cue.start).toFixed(1)}-${Number(cue.end).toFixed(1)}] ${safeText(cue.text, 500)}`).join('\n').slice(0, 40000)}`,
    'JSON schema：{"title":"","hook":"","narration":"完整旁白","musicBrief":"","subtitleStyle":"clean|impact|documentary","deepAnalysis":{"narrative":"","visual":"","editing":"","audio":"","hook":"","weaknesses":[""]},"shots":[{"id":"shot-1","kind":"source|generated","segmentId":"来源片段id或空","duration":3,"title":"","prompt":"仅generated必填","narration":"本镜旁白","caption":"屏幕字幕"}],"riskNotes":[""]}',
    '总镜头最多 24 个；generated 镜头建议占 20%-40%，用于补充原创视觉表达，不得冒充纪实证据。'
  ].join('\n\n')
}

function extractJson(text) {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try { return JSON.parse(source) } catch {}
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1))
  throw new Error('模型没有返回可解析的创作方案 JSON')
}

function normalizeCreativePlan(raw = {}, input = {}) {
  const validSegments = new Set((input.segments || []).map((segment) => String(segment.id)))
  const shots = (Array.isArray(raw.shots) ? raw.shots : []).slice(0, 24).flatMap((shot, index) => {
    const kind = shot.kind === 'generated' ? 'generated' : 'source'
    const segmentId = safeText(shot.segmentId, 100)
    if (kind === 'source' && !validSegments.has(segmentId)) return []
    return [{
      id: safeText(shot.id, 100) || `shot-${index + 1}`,
      kind,
      segmentId: kind === 'source' ? segmentId : '',
      duration: Math.max(1, Math.min(15, Number(shot.duration) || 3)),
      title: safeText(shot.title, 300) || `镜头 ${index + 1}`,
      prompt: kind === 'generated' ? safeText(shot.prompt, 2000) : '',
      narration: safeText(shot.narration, 2000),
      caption: safeText(shot.caption, 500),
      assetPath: '',
      status: kind === 'source' ? 'ready' : 'pending'
    }]
  })
  if (!shots.length) {
    for (const [index, segment] of (input.segments || []).slice(0, 24).entries()) {
      shots.push({
        id: `shot-${index + 1}`, kind: 'source', segmentId: String(segment.id),
        duration: Math.max(1, Math.min(15, Number(segment.end) - Number(segment.start) || 3)),
        title: safeText(segment.title, 300) || `片段 ${index + 1}`, prompt: '', narration: '', caption: '', assetPath: '', status: 'ready'
      })
    }
  }
  return {
    version: 1,
    title: safeText(raw.title, 300) || `${safeText(input.mediaName, 200) || '视频'} · 原创版`,
    hook: safeText(raw.hook, 1000),
    narration: safeText(raw.narration, 20000) || shots.map((shot) => shot.narration).filter(Boolean).join('\n'),
    musicBrief: safeText(raw.musicBrief, 1000) || '轻量、不抢人声、随叙事推进',
    subtitleStyle: ['clean', 'impact', 'documentary'].includes(raw.subtitleStyle) ? raw.subtitleStyle : 'clean',
    deepAnalysis: {
      narrative: safeText(raw.deepAnalysis?.narrative, 5000),
      visual: safeText(raw.deepAnalysis?.visual, 5000),
      editing: safeText(raw.deepAnalysis?.editing, 5000),
      audio: safeText(raw.deepAnalysis?.audio, 5000),
      hook: safeText(raw.deepAnalysis?.hook, 5000),
      weaknesses: (Array.isArray(raw.deepAnalysis?.weaknesses) ? raw.deepAnalysis.weaknesses : []).slice(0, 20).map((item) => safeText(item, 500))
    },
    shots,
    riskNotes: (Array.isArray(raw.riskNotes) ? raw.riskNotes : []).slice(0, 20).map((item) => safeText(item, 500)),
    modality: 'text-evidence'
  }
}

async function requestCreativePlan(config, input = {}, options = {}) {
  const evidence = collectVisualEvidence(input.markers)
  let usedEvidence = evidence
  let visualFallbackReason = ''
  const prompt = buildCreativePrompt(input, evidence.length)
  if (config.requiresKey && !config.apiKey) throw new Error('请先在模型接入中心保存 API Key')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('AI 创作方案请求超时')), options.timeoutMs || 120000)
  const requestOptions = { signal: controller.signal, method: 'POST', headers: { 'Content-Type': 'application/json' } }
  let response
  try {
    if (config.protocol === 'anthropic') {
      requestOptions.headers['x-api-key'] = config.apiKey
      requestOptions.headers['anthropic-version'] = '2023-06-01'
      requestOptions.body = JSON.stringify({
        model: config.model, max_tokens: 5000, system: CREATIVE_PLAN_SYSTEM,
        messages: [{ role: 'user', content: [
          ...evidence.map((item) => ({ type: 'image', source: { type: 'base64', media_type: item.mimeType, data: item.base64 } })),
          { type: 'text', text: prompt }
        ] }]
      })
      response = await safeFetch(config, `${config.baseUrl}/v1/messages`, requestOptions)
    } else if (config.protocol === 'gemini') {
      requestOptions.body = JSON.stringify({
        systemInstruction: { parts: [{ text: CREATIVE_PLAN_SYSTEM }] },
        contents: [{ role: 'user', parts: [
          { text: prompt },
          ...evidence.map((item) => ({ inlineData: { mimeType: item.mimeType, data: item.base64 } }))
        ] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
      response = await safeFetch(config, `${config.baseUrl}/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`, requestOptions)
    } else {
      if (config.apiKey) requestOptions.headers.Authorization = `Bearer ${config.apiKey}`
      const content = evidence.length
        ? [{ type: 'text', text: prompt }, ...evidence.map((item) => ({ type: 'image_url', image_url: { url: item.dataUrl, detail: 'low' } }))]
        : prompt
      const body = {
        model: config.model,
        messages: [{ role: 'system', content: CREATIVE_PLAN_SYSTEM }, { role: 'user', content }],
        temperature: 0.4,
        response_format: { type: 'json_object' }
      }
      requestOptions.body = JSON.stringify(body)
      response = await safeFetch(config, `${config.baseUrl}/chat/completions`, requestOptions)
      if ([400, 415, 422].includes(response.status)) {
        delete body.response_format
        requestOptions.body = JSON.stringify(body)
        response = await safeFetch(config, `${config.baseUrl}/chat/completions`, requestOptions)
      }
      if (evidence.length && [400, 415, 422].includes(response.status)) {
        usedEvidence = []
        visualFallbackReason = `当前型号 ${config.model} 拒绝图像输入，已退回字幕与拉片证据；请在模型中心切换支持视觉的型号。`
        body.messages = [{ role: 'system', content: CREATIVE_PLAN_SYSTEM }, { role: 'user', content: prompt }]
        requestOptions.body = JSON.stringify(body)
        response = await safeFetch(config, `${config.baseUrl}/chat/completions`, requestOptions)
      }
    }
    if (!response.ok) throw new Error(`创作模型返回 ${response.status}: ${(await response.text()).slice(0, 1000)}`)
    const body = await response.json()
    const text = config.protocol === 'anthropic'
      ? (body.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      : config.protocol === 'gemini'
        ? (body.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('\n')
        : body.choices?.[0]?.message?.content
    const plan = normalizeCreativePlan(extractJson(text), input)
    plan.modality = usedEvidence.length ? 'vision+text-evidence' : 'text-evidence'
    plan.provider = config.providerName
    plan.model = config.model
    plan.visualEvidenceCount = usedEvidence.length
    plan.visualFallbackReason = visualFallbackReason
    return plan
  } finally {
    clearTimeout(timeout)
  }
}

function validateOutputDirectory(outputDir) {
  const resolved = path.resolve(outputDir)
  fs.mkdirSync(resolved, { recursive: true })
  if (!fs.statSync(resolved).isDirectory()) throw new Error('创作资产目录不可用')
  return resolved
}

async function generateImageAsset(config, input = {}) {
  if (config.protocol !== 'openai') throw new Error('当前图像生成先支持 OpenAI 兼容的 /images/generations 接口；可改用“导入素材”')
  if (config.requiresKey && !config.apiKey) throw new Error('请先保存图像生成接口的 API Key')
  const prompt = safeText(input.prompt, 4000)
  if (!prompt) throw new Error('新镜头缺少图像提示词')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('图像生成超时')), 180000)
  try {
    const headers = { 'Content-Type': 'application/json' }
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
    const response = await safeFetch(config, `${config.baseUrl}/images/generations`, {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ model: safeText(input.model, 200) || 'gpt-image-1', prompt, size: input.size || '1536x1024', response_format: 'b64_json' })
    })
    if (!response.ok) throw new Error(`图像接口返回 ${response.status}: ${(await response.text()).slice(0, 1000)}`)
    const body = await response.json()
    const base64 = body.data?.[0]?.b64_json
    if (!base64) throw new Error('图像接口没有返回 b64_json；为避免不受控外链下载，请改用支持 base64 的接口或手动导入素材')
    const bytes = Buffer.from(base64, 'base64')
    if (!bytes.length || bytes.length > 30 * 1024 * 1024) throw new Error('图像结果为空或超过 30MB')
    const outputDir = validateOutputDirectory(input.outputDir)
    const outputPath = path.join(outputDir, `${safeText(input.id, 80).replace(/[^\w-]+/g, '_') || Date.now()}.png`)
    fs.writeFileSync(outputPath, bytes, { flag: 'wx' })
    return { success: true, outputPath, bytes: bytes.length }
  } finally {
    clearTimeout(timeout)
  }
}

async function synthesizeCloudVoice(config, input = {}) {
  if (config.protocol !== 'openai') throw new Error('当前云配音先支持 OpenAI 兼容的 /audio/speech 接口；也可使用本机系统配音')
  const text = safeText(input.text, 20000)
  if (!text) throw new Error('旁白文本为空')
  const outputDir = validateOutputDirectory(input.outputDir)
  const outputPath = path.join(outputDir, `narration-${Date.now()}.mp3`)
  const headers = { 'Content-Type': 'application/json' }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('云配音超时')), 180000)
  try {
    const response = await safeFetch(config, `${config.baseUrl}/audio/speech`, {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ model: safeText(input.model, 200) || 'gpt-4o-mini-tts', voice: safeText(input.voice, 100) || 'alloy', input: text, format: 'mp3' })
    })
    if (!response.ok) throw new Error(`配音接口返回 ${response.status}: ${(await response.text()).slice(0, 1000)}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length || bytes.length > 100 * 1024 * 1024) throw new Error('配音结果为空或超过 100MB')
    fs.writeFileSync(outputPath, bytes, { flag: 'wx' })
    return { success: true, outputPath, bytes: bytes.length, engine: 'cloud' }
  } finally {
    clearTimeout(timeout)
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, ...options })
    options.onSpawn?.(child)
    let logs = ''
    child.stdout?.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-12000) })
    child.stderr?.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-12000) })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error('任务已取消'))
      else if (code === 0) resolve({ code, logs })
      else reject(new Error(`进程退出码 ${code}${logs ? `：${logs.split(/\r?\n/).filter(Boolean).slice(-10).join(' ')}` : ''}`))
    })
  })
}

async function synthesizeSystemVoice(input = {}) {
  const text = safeText(input.text, 20000)
  if (!text) throw new Error('旁白文本为空')
  const outputDir = validateOutputDirectory(input.outputDir)
  if (process.platform === 'win32') {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-voice-'))
    const textPath = path.join(tempDir, 'narration.txt')
    const outputPath = path.join(outputDir, `narration-${Date.now()}.wav`)
    const helperPath = path.resolve(String(input.helperPath || ''))
    if (!fs.existsSync(helperPath) || !fs.statSync(helperPath).isFile()) {
      fs.rmSync(tempDir, { recursive: true, force: true })
      throw new Error('本机配音组件缺失，请重新安装完整版本')
    }
    fs.writeFileSync(textPath, `\uFEFF${text}`, 'utf16le')
    try {
      await runProcess(helperPath, [textPath, outputPath, String(Math.max(-5, Math.min(5, Number(input.rate) || 0)))])
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) throw new Error('系统配音没有生成有效音频')
      return { success: true, outputPath, bytes: fs.statSync(outputPath).size, engine: 'windows-sapi' }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }
  if (process.platform === 'darwin') {
    const outputPath = path.join(outputDir, `narration-${Date.now()}.aiff`)
    await runProcess('say', ['-o', outputPath, text])
    return { success: true, outputPath, bytes: fs.statSync(outputPath).size, engine: 'macos-say' }
  }
  const outputPath = path.join(outputDir, `narration-${Date.now()}.wav`)
  await runProcess('espeak-ng', ['-w', outputPath, text])
  return { success: true, outputPath, bytes: fs.statSync(outputPath).size, engine: 'espeak-ng' }
}

function assTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0)
  const h = Math.floor(value / 3600)
  const m = Math.floor((value % 3600) / 60)
  const s = Math.floor(value % 60)
  const cs = Math.floor((value % 1) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function escapeAss(value) {
  return safeText(value, 1000).replace(/\{[^}]*\}/g, '').replace(/\\/g, '＼').replace(/\r?\n/g, '\\N')
}

function buildSubtitleAss(shots = [], style = 'clean') {
  const preset = style === 'impact'
    ? { font: 52, outline: 5, margin: 72, primary: '&H00FFFFFF', back: '&H80000000' }
    : style === 'documentary'
      ? { font: 40, outline: 2, margin: 54, primary: '&H00F4F0E8', back: '&H70000000' }
      : { font: 44, outline: 3, margin: 64, primary: '&H00FFFFFF', back: '&H70000000' }
  let cursor = 0
  const dialogues = []
  for (const shot of shots) {
    const duration = Math.max(0.2, Number(shot.duration) || 3)
    const caption = escapeAss(shot.caption || shot.narration)
    if (caption) dialogues.push(`Dialogue: 0,${assTime(cursor)},${assTime(cursor + duration)},Default,,0,0,0,,${caption}`)
    cursor += duration
  }
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,Microsoft YaHei,${preset.font},${preset.primary},&H000000FF,&H00101010,${preset.back},-1,0,0,0,100,100,0,0,1,${preset.outline},1,2,60,60,${preset.margin},1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${dialogues.join('\n')}\n`
}

function validateCreativeTimeline(input = {}) {
  const sourcePath = path.resolve(String(input.sourcePath || ''))
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) throw new Error('原视频不存在')
  const segments = new Map((input.segments || []).map((segment) => [String(segment.id), segment]))
  const shots = (input.shots || []).slice(0, 100).map((shot, index) => {
    if (shot.kind === 'generated') {
      const assetPath = path.resolve(String(shot.assetPath || ''))
      if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) throw new Error(`第 ${index + 1} 个 AI 新镜头尚未生成或导入素材`)
      return { ...shot, kind: 'generated', assetPath, duration: Math.max(1, Math.min(30, Number(shot.duration) || 3)) }
    }
    const segment = segments.get(String(shot.segmentId))
    const start = Number(segment?.start)
    const end = Number(segment?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error(`第 ${index + 1} 个来源片段无效`)
    return { ...shot, kind: 'source', sourcePath, start, end, duration: end - start }
  })
  if (!shots.length) throw new Error('创作时间线为空')
  return shots
}

async function renderCreativeVideo({ mpvPath, input, outputPath, onSpawn }) {
  if (!mpvPath || !fs.existsSync(mpvPath)) throw new Error('视频渲染内核不可用')
  const shots = validateCreativeTimeline(input)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-creative-'))
  const videoCodec = process.platform === 'win32' ? 'h264_mf' : 'mpeg4'
  let activeChild = null
  const spawnHook = (child) => { activeChild = child; onSpawn?.(child) }
  try {
    const clipPaths = []
    for (const [index, shot] of shots.entries()) {
      const clipPath = path.join(tempDir, `clip-${String(index).padStart(3, '0')}.mp4`)
      const source = shot.kind === 'source' ? shot.sourcePath : shot.assetPath
      const args = [source, '--no-config', '--no-audio', '--no-sub', '--of=mp4', `--ovc=${videoCodec}`, '--vf=lavfi=[scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p]', `--o=${clipPath}`]
      if (shot.kind === 'source') args.push(`--start=${shot.start}`, `--length=${shot.duration}`)
      else args.push(`--length=${shot.duration}`, `--image-display-duration=${shot.duration}`)
      await runProcess(mpvPath, args, { onSpawn: spawnHook })
      if (!fs.existsSync(clipPath) || fs.statSync(clipPath).size < 1000) throw new Error(`第 ${index + 1} 个镜头预渲染失败`)
      clipPaths.push(clipPath)
    }

    const edlPath = path.join(tempDir, 'timeline.edl')
    const edl = `# mpv EDL v0\n${clipPaths.map((clip) => {
      const normalized = clip.replace(/\\/g, '/')
      return `%${Buffer.byteLength(normalized, 'utf8')}%${normalized}`
    }).join('\n')}\n`
    fs.writeFileSync(edlPath, edl, 'utf8')
    const assPath = path.join(tempDir, 'captions.ass')
    fs.writeFileSync(assPath, buildSubtitleAss(shots, input.subtitleStyle), 'utf8')
    const totalDuration = shots.reduce((sum, shot) => sum + shot.duration, 0)
    const args = [edlPath, '--no-config', '--of=mp4', `--ovc=${videoCodec}`, '--oac=aac', `--sub-file=${assPath}`, '--sub-auto=no', '--sub-visibility=yes', `--length=${totalDuration}`, `--o=${outputPath}`]
    const audioFiles = []
    if (input.voicePath && fs.existsSync(input.voicePath)) audioFiles.push(path.resolve(input.voicePath))
    if (input.musicPath && fs.existsSync(input.musicPath)) audioFiles.push(path.resolve(input.musicPath))
    for (const audio of audioFiles) args.push(`--audio-file=${audio}`)
    if (audioFiles.length === 2) {
      const musicVolume = Math.max(0.02, Math.min(0.5, Number(input.musicVolume) || 0.12))
      args.push(`--lavfi-complex=[aid1]volume=1.0,asplit=2[voice][key];[aid2]volume=${musicVolume}[music];[music][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=500[ducked];[voice][ducked]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[ao]`)
    }
    await runProcess(mpvPath, args, { onSpawn: spawnHook })
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) throw new Error('创意成片没有生成有效文件')
    return { success: true, outputPath, bytes: fs.statSync(outputPath).size, shots: shots.length, duration: totalDuration }
  } catch (error) {
    if (activeChild?.killed) throw new Error('渲染已取消')
    throw error
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch {}
  }
}

module.exports = {
  buildCreativePrompt,
  buildSubtitleAss,
  collectVisualEvidence,
  extractJson,
  generateImageAsset,
  normalizeCreativePlan,
  renderCreativeVideo,
  requestCreativePlan,
  synthesizeCloudVoice,
  synthesizeSystemVoice,
  validateCreativeTimeline
}
