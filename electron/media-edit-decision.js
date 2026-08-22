const path = require('path')

const CHINESE_DIGITS = Object.freeze({
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9
})

const NUMBER_TOKEN = String.raw`(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)`
const TIME_TOKEN = String.raw`(?:\d{1,3}:\d{2}(?:\.\d+)?|第?\s*${NUMBER_TOKEN}\s*(?:分(?:钟)?(?:\s*${NUMBER_TOKEN}\s*秒)?|秒|s))`
const RANGE_SOURCE = `(${TIME_TOKEN})\\s*(?:到|至|—|–|-|~|～)\\s*(${TIME_TOKEN})`
const RANGE_PATTERN_GLOBAL = new RegExp(RANGE_SOURCE, 'gi')
const TIME_PATTERN_GLOBAL = new RegExp(`(${TIME_TOKEN})`, 'gi')
const MAX_EDIT_SEGMENTS = 24
const DIRECT_EDIT_PATTERN = /(?:保留|留下|截取|截出|剪出|剪辑|裁剪|取出)/
const REMOVE_EDIT_PATTERN = /(?:删除|删掉|剪掉|去掉|移除)/
const JOIN_EDIT_PATTERN = /(?:拼接|拼起来|合并|接起来|连起来|再接|放(?:在)?前面|排到前面|调整顺序|重排)/
const GENERIC_EDIT_PATTERN = /(?:处理|编辑|改一下|剪一下)/
const SEGMENT_REQUEST_PATTERN = /(?:我(?:只)?想要|我要|给我|替我)[\s\S]*(?:这|那)?(?:一)?段(?:视频|片段)/
const CONSULTATION_PATTERN = /(?:能不能|可不可以|是否|怎么|如何|支不支持|能做到|可以吗|行吗|\?|？)/
const NEGATION_PATTERN = /(?:不要|别把|别剪|无需|不用|取消|不想)/
const EXAMPLE_PATTERN = /(?:比如|例如|举例|假如|如果|假设|我说[“\"])/
const MUSIC_EDIT_PATTERN = /(?:背景音乐|配乐|配个?乐|加.?个?音乐|音乐轨|背景音)/
const MUSIC_REMOVE_PATTERN = /(?:去掉|删除|移除|静音).{0,4}(?:背景)?音乐/
const CONCAT_SOURCES_PATTERN = /(?:拼起来|拼接|合并|接起来|连在一起|合成一个)/
const VIDEO_PATH_PATTERN = /["'“”‘’]?((?:[A-Za-z]:)?[\\/][^"'“”‘’，。；]+?\.(?:mp4|mkv|mov|webm|ts|m4v|wmv|flv|avi))["'“”‘’]?/gi

function extractVideoPaths(text) {
  const paths = []
  for (const match of String(text || '').matchAll(VIDEO_PATH_PATTERN)) {
    const value = match[1].trim()
    if (value && !paths.includes(value)) paths.push(value)
  }
  return paths
}

const AUDIO_PATH_PATTERN = /["'“”‘’]?((?:[A-Za-z]:)?[\\/][^"'“”‘’，。；]+?\.(?:mp3|wav|m4a|aac|flac|ogg|wma))["'“”‘’]?/i
const VOLUME_PATTERN = /(?:音量|声音|小声点|调到|降到|减到|改为)[^\d]{0,6}(\d+(?:\.\d+)?)\s*%/
const MUSIC_SELECTION_PATTERN = new RegExp(`(?:音乐|配乐|歌曲|这首歌)[^，。；]{0,12}?${RANGE_SOURCE}`, 'i')
const LOUDNESS_TARGET_PATTERN = /(?:响度(?:归一(?:化)?|标准化)?(?:到|为)?|归一(?:化)?到)\s*(-?\d+(?:\.\d+)?)\s*LUFS/i
const MUSIC_NO_LOOP_PATTERN = /(?:只播放一次|只播一次|不要循环|不循环|无需循环|别循环)/
const MUSIC_NO_LOUDNESS_PATTERN = /(?:不要|不做|无需|关闭|取消).{0,6}(?:响度归一(?:化)?|响度标准化|归一(?:化)?响度|音量归一(?:化)?)/
const DEFAULT_MUSIC_LOUDNESS = Object.freeze({
  enabled: true,
  targetLufs: -16,
  targetTruePeakDbtp: -1.5,
  maxTruePeakDbtp: -1,
  lra: 11,
  toleranceLufs: 0.7
})

// 硬字幕烧录：用户本地 .srt/.vtt/.ass/.ssa 逐条烧进画面；只说"烧字幕"不给文件时只追问唯一一项
const SUBTITLE_BURN_PATTERN = /(?:烧进|烧录|烧到|压进|嵌入|合成到视频|硬字幕)/
const SUBTITLE_PATH_PATTERN = /["'“”‘’]?((?:[A-Za-z]:)?[\\/][^"'“”‘’，。；]+?\.(?:srt|vtt|ass|ssa))["'“”‘’]?/i

function extractSubtitlePath(text) {
  const match = SUBTITLE_PATH_PATTERN.exec(String(text || ''))
  return match ? match[1].trim() : ''
}

function compileBurnSubtitlesDecisionList({ instruction, sourcePath } = {}) {
  const text = String(instruction || '').trim()
  const source = String(sourcePath || '').trim()
  if (!SUBTITLE_BURN_PATTERN.test(text)) return null
  const subtitle = extractSubtitlePath(text)
  if (!source || !subtitle) return null
  const style = extractBurnSubtitleStyle(text)
  return {
    schemaVersion: 1,
    kind: 'media.burn-subtitles',
    instruction: text,
    source: { path: source, name: portableBasename(source) },
    subtitle: { path: subtitle, name: portableBasename(subtitle), ...(style ? { style } : {}) },
    output: {
      container: 'mp4',
      overwrite: false,
      suffix: `硬字幕版${style?.fontSize === 'large' ? '-大字' : style?.fontSize === 'small' ? '-小字' : ''}${style?.alignment === 'top' ? '-顶部' : ''}${style?.color ? `-${style.color}` : ''}`
    },
    verification: { toleranceSeconds: 0.2 }
  }
}

// 烧录样式：字号（大/小）、位置（顶部/底部）、颜色（黄白红蓝绿黑）；只在烧录语境生效。
// ASS force_style：FontSize 按 libass 默认 PlayResY=288 等比缩放到实际分辨率；颜色是 &H00BBGGRR。
const BURN_FONT_SIZE_PATTERN = /(大一号|大一点|大点|大字|大号|小一号|小一点|小点|小字|小号)/
const BURN_ALIGNMENT_PATTERN = /(顶部|上面|上方|顶上|底部|下面|下方|底下)/
const BURN_COLOR_PATTERN = /(黄色|白色|红色|蓝色|绿色|黑色)/
const BURN_COLOR_MAP = { 黄色: '&H0000FFFF', 白色: '&H00FFFFFF', 红色: '&H000000FF', 蓝色: '&H00FF0000', 绿色: '&H0000FF00', 黑色: '&H00000000' }

function extractBurnSubtitleStyle(text) {
  const value = String(text || '')
  const sizeMatch = BURN_FONT_SIZE_PATTERN.exec(value)
  const alignMatch = BURN_ALIGNMENT_PATTERN.exec(value)
  const colorMatch = BURN_COLOR_PATTERN.exec(value)
  if (!sizeMatch && !alignMatch && !colorMatch) return null
  return {
    ...(sizeMatch ? { fontSize: /^大/.test(sizeMatch[1]) ? 'large' : 'small' } : {}),
    ...(alignMatch ? { alignment: /顶|上/.test(alignMatch[1]) ? 'top' : 'bottom' } : {}),
    ...(colorMatch ? { color: colorMatch[1] } : {})
  }
}

function burnForceStyle(style) {
  if (!style) return ''
  const parts = []
  if (style.fontSize === 'large') parts.push('FontSize=32')
  else if (style.fontSize === 'small') parts.push('FontSize=16')
  // force_style 走 SSA 语义：6=顶中（不是 ASS 小键盘的 8）；2=底中
  if (style.alignment === 'top') parts.push('Alignment=6')
  else if (style.alignment === 'bottom') parts.push('Alignment=2')
  if (style.color && BURN_COLOR_MAP[style.color]) parts.push(`PrimaryColour=${BURN_COLOR_MAP[style.color]}`)
  return parts.join(',')
}

// 软字幕封装：字幕作为可开关的独立轨道封进 mp4（mov_text），音画流不重编码直接 copy。
// 与烧录互斥：烧录动词优先；只说"封装/软字幕/外挂"才走这里。
const SUBTITLE_MUX_PATTERN = /(?:封装|打包进|软字幕|外挂)/
const SUBTITLE_MUX_EXCLUDE_PATTERN = /(?:烧进|烧录|烧到|压进|硬字幕)/

function compileMuxSubtitlesDecisionList({ instruction, sourcePath } = {}) {
  const text = String(instruction || '').trim()
  const source = String(sourcePath || '').trim()
  if (!SUBTITLE_MUX_PATTERN.test(text) || SUBTITLE_MUX_EXCLUDE_PATTERN.test(text)) return null
  // 字幕语境：明说“字幕”，或直接给出字幕文件路径（路径本身即无歧义指代）
  if (!/(?:字幕|\.srt|\.vtt|\.ass|\.ssa)/i.test(text)) return null
  const subtitle = extractSubtitlePath(text)
  if (!source || !subtitle) return null
  return {
    schemaVersion: 1,
    kind: 'media.mux-subtitles',
    instruction: text,
    source: { path: source, name: portableBasename(source) },
    subtitle: { path: subtitle, name: portableBasename(subtitle) },
    output: {
      container: 'mp4',
      overwrite: false,
      suffix: '软字幕版'
    },
    verification: { toleranceSeconds: 0.2, requireSubtitleStream: true }
  }
}

// 字幕条目校对/删除：用户本地 .srt 按"第 N 条"改文本或删除条目（可区间），产出全新 srt；源字幕与视频都不动。
// 范围切割：必须给出 .srt 路径才接管；序号用"第 N 条"（与剪辑的"第 N 秒"严格区分）。
const CUE_EDIT_NUMBER = String.raw`(\d+|[零〇一二两三四五六七八九十百]+)`
// 兼容"第2条到第4条""第2到第4条""第3条"三种写法；整条匹配必须含"条"
const CUE_EDIT_RANGE_PATTERN = new RegExp(`第\\s*${CUE_EDIT_NUMBER}\\s*条?(?:\\s*(?:到|至)\\s*(?:第?\\s*${CUE_EDIT_NUMBER})\\s*条?)?`)
const CUE_EDIT_DELETE_PATTERN = /(?:删除|删掉|去掉|移除)/
const CUE_EDIT_REPLACE_PATTERN = /(改成|改为|换成)\s*[《“"'「]?(.+?)[》”"'」]?\s*$/

function compileCueEditDecisionList({ instruction, sourcePath } = {}) {
  const text = String(instruction || '').trim()
  if (!/(?:字幕|\.srt|\.vtt)/i.test(text)) return null
  const subtitle = extractTextSubtitlePath(text)
  if (!subtitle) return null
  const container = path.extname(subtitle).toLowerCase() === '.vtt' ? 'vtt' : 'srt'
  const rest = text.replace(TEXT_SUBTITLE_PATH_PATTERN, '')
  const rangeMatch = CUE_EDIT_RANGE_PATTERN.exec(rest)
  if (!rangeMatch || !rangeMatch[0].includes('条')) return null
  const startIndex = parseNumber(rangeMatch[1])
  const endIndex = rangeMatch[2] ? parseNumber(rangeMatch[2]) : startIndex
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex < 1 || endIndex < startIndex || endIndex > 50000) return null
  const replaceMatch = CUE_EDIT_REPLACE_PATTERN.exec(rest)
  if (replaceMatch && replaceMatch[2] && replaceMatch[2].trim()) {
    if (endIndex !== startIndex) return null
    return {
      schemaVersion: 1,
      kind: 'media.edit-subtitle-cues',
      instruction: text,
      source: { path: String(sourcePath || '').trim(), name: portableBasename(sourcePath) },
      subtitle: { path: subtitle, name: portableBasename(subtitle) },
      cueEdit: { operation: 'replace', index: startIndex, text: replaceMatch[2].trim() },
      output: { container, overwrite: false, suffix: `校对版-改第${startIndex}条` },
      verification: { cueEdit: true }
    }
  }
  if (!CUE_EDIT_DELETE_PATTERN.test(rest)) return null
  return {
    schemaVersion: 1,
    kind: 'media.edit-subtitle-cues',
    instruction: text,
    source: { path: String(sourcePath || '').trim(), name: portableBasename(sourcePath) },
    subtitle: { path: subtitle, name: portableBasename(subtitle) },
    cueEdit: { operation: 'delete', startIndex, endIndex },
    output: { container, overwrite: false, suffix: startIndex === endIndex ? `校对版-删第${startIndex}条` : `校对版-删第${startIndex}到${endIndex}条` },
    verification: { cueEdit: true }
  }
}

// 字幕翻译：用户本地 .srt 逐句翻译成英文/中文（或双语对照），产出全新 srt；视频与源字幕都不动。
// 引擎：云端已配置且用户同意后走云端；英译中可回退本地 OPUS-MT 离线组件。批失败故障关闭不交付半成品。
// 范围切割：必须给出 .srt 路径才接管——"翻译字幕"不带路径时可能指当前视频的双语生成（既有 subtitle.generate 流程），不在这里追问劫持。
const SUBTITLE_TRANSLATE_PATTERN = /(?:翻译|译成)/
const SUBTITLE_TRANSLATE_TARGET_PATTERN = /(英文|英语|中文|汉语|双语)/

function compileTranslateSubtitlesDecisionList({ instruction, sourcePath } = {}) {
  const text = String(instruction || '').trim()
  if (!SUBTITLE_TRANSLATE_PATTERN.test(text)) return null
  if (!/(?:字幕|\.srt)/i.test(text)) return null
  const subtitle = extractSrtPath(text)
  if (!subtitle) return null
  const targetMatch = SUBTITLE_TRANSLATE_TARGET_PATTERN.exec(text)
  if (!targetMatch) return null
  const bilingual = targetMatch[1] === '双语' || /双语对照/.test(text)
  const targetLang = bilingual
    ? (/英文|英语/.test(text) ? '英文' : /中文|汉语/.test(text) ? '中文' : 'auto')
    : (/英文|英语/.test(targetMatch[1]) ? '英文' : '中文')
  return {
    schemaVersion: 1,
    kind: 'media.translate-subtitles',
    instruction: text,
    source: { path: String(sourcePath || '').trim(), name: portableBasename(sourcePath) },
    subtitle: { path: subtitle, name: portableBasename(subtitle) },
    translate: { targetLang, mode: bilingual ? 'bilingual' : 'translated' },
    output: {
      container: 'srt',
      overwrite: false,
      suffix: bilingual ? '双语版' : targetLang === '英文' ? '英译版' : targetLang === '中文' ? '中译版' : '双语版'
    },
    verification: { targetLanguage: true }
  }
}

// 字幕时间移动：用户本地 .srt/.vtt 整体提前（出现更早）或延后（出现更晚）N 秒，产出新字幕文件，不动视频。
// 语义按字面：提前=时间轴减 N，延后=时间轴加 N；完全移出 0 点之前的条目丢弃并在回执里说明。
const SUBTITLE_SHIFT_PATTERN = /(?:字幕)[\s\S]{0,20}(?:提前|延后)|(?:提前|延后)[\s\S]{0,12}(?:秒)/i
const SRT_PATH_PATTERN = /["'“”‘’]?((?:[A-Za-z]:)?[\\/][^"'“”‘’，。；]+?\.srt)["'“”‘’]?/i
const TEXT_SUBTITLE_PATH_PATTERN = /["'“”‘’]?((?:[A-Za-z]:)?[\\/][^"'“”‘’，。；]+?\.(?:srt|vtt))["'“”‘’]?/i
const SUBTITLE_SHIFT_VERB_PATTERN = /(提前|延后)/

function extractSrtPath(text) {
  const match = SRT_PATH_PATTERN.exec(String(text || ''))
  return match ? match[1].trim() : ''
}

function extractTextSubtitlePath(text) {
  const match = TEXT_SUBTITLE_PATH_PATTERN.exec(String(text || ''))
  return match ? match[1].trim() : ''
}

function compileShiftSubtitlesDecisionList({ instruction, sourcePath } = {}) {
  const text = String(instruction || '').trim()
  // 字幕语境：明说“字幕”，或直接给出 .srt/.vtt 路径（路径本身就是无歧义的字幕指代）
  if (!/(?:字幕|\.srt|\.vtt)/i.test(text) || !SUBTITLE_SHIFT_PATTERN.test(text)) return null
  const subtitle = extractTextSubtitlePath(text)
  if (!subtitle) return null
  const times = extractTimes(text.replace(TEXT_SUBTITLE_PATH_PATTERN, ''))
  if (times.length !== 1 || !(times[0] > 0)) return null
  const direction = SUBTITLE_SHIFT_VERB_PATTERN.test(text) && text.lastIndexOf('提前') > text.lastIndexOf('延后') ? 'earlier' : 'later'
  const offsetSeconds = Number(times[0].toFixed(3))
  const container = path.extname(subtitle).toLowerCase() === '.vtt' ? 'vtt' : 'srt'
  return {
    schemaVersion: 1,
    kind: 'media.shift-subtitles',
    instruction: text,
    source: { path: String(sourcePath || '').trim(), name: portableBasename(sourcePath) },
    subtitle: { path: subtitle, name: portableBasename(subtitle) },
    shift: { direction, offsetSeconds },
    output: {
      container,
      overwrite: false,
      suffix: `调时版-${direction === 'earlier' ? '提前' : '延后'}${formatSeconds(offsetSeconds)}`
    },
    verification: { cueTiming: true }
  }
}

function extractAudioPath(text) {
  const match = AUDIO_PATH_PATTERN.exec(String(text || ''))
  return match ? match[1].trim() : ''
}

function extractMusicVolume(text) {
  const match = VOLUME_PATTERN.exec(String(text || ''))
  if (!match) return null
  const percent = Number(match[1])
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return null
  return Number((percent / 100).toFixed(3))
}

function extractMusicSelection(text) {
  const match = MUSIC_SELECTION_PATTERN.exec(String(text || ''))
  if (!match) return null
  const startSeconds = parseTimeSeconds(match[1])
  const endSeconds = parseTimeSeconds(match[2])
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds) return null
  return { startSeconds, endSeconds, durationSeconds: Number((endSeconds - startSeconds).toFixed(3)) }
}

function extractLoudnessPolicy(text) {
  if (MUSIC_NO_LOUDNESS_PATTERN.test(String(text || ''))) return { ...DEFAULT_MUSIC_LOUDNESS, enabled: false }
  const match = LOUDNESS_TARGET_PATTERN.exec(String(text || ''))
  if (!match) return { ...DEFAULT_MUSIC_LOUDNESS }
  const targetLufs = Number(match[1])
  if (!Number.isFinite(targetLufs) || targetLufs < -24 || targetLufs > -10) return { ...DEFAULT_MUSIC_LOUDNESS }
  return {
    ...DEFAULT_MUSIC_LOUDNESS,
    targetLufs,
  }
}

function compileMusicDecisionList({ instruction, sourcePath, audioPath, volume }) {
  const text = String(instruction || '').trim()
  const source = String(sourcePath || '').trim()
  if (!MUSIC_EDIT_PATTERN.test(text) || MUSIC_REMOVE_PATTERN.test(text)) return null
  const safetyText = text.replace(MUSIC_NO_LOOP_PATTERN, '').replace(MUSIC_NO_LOUDNESS_PATTERN, '')
  if (CONSULTATION_PATTERN.test(text) || EXAMPLE_PATTERN.test(text) || NEGATION_PATTERN.test(safetyText)) return null
  const audio = String(audioPath || extractAudioPath(text) || '').trim()
  if (!audio) return null
  const musicVolume = Number.isFinite(volume) ? volume : extractMusicVolume(text)
  const selection = extractMusicSelection(text)
  const loudness = extractLoudnessPolicy(text)
  return {
    schemaVersion: 1,
    kind: 'media.add-music',
    instruction: text,
    source: { path: source, name: portableBasename(source) },
    audio: {
      path: audio,
      volume: musicVolume ?? 0.15,
      fadeInSeconds: 1,
      fadeOutSeconds: 1.5,
      duck: true,
      loop: !MUSIC_NO_LOOP_PATTERN.test(text),
      ...(selection ? { selection } : {}),
      loudness
    },
    output: {
      container: 'mp4',
      overwrite: false,
      suffix: `配乐版-${Math.round((musicVolume ?? 0.15) * 100)}vol`
    },
    verification: { toleranceSeconds: 0.2 }
  }
}

const UNDO_EDIT_PATTERN = /^(?:(?:请|帮我|麻烦你?)\s*)?(?:撤销(?:刚才的剪辑|这次剪辑|上一步(?:剪辑)?|上一个(?:剪辑)?版本)|撤回(?:刚才的剪辑|上一步(?:剪辑)?)|回到剪辑前|退回上一个(?:剪辑)?版本)\s*[吧。！!]*$/
const REDO_EDIT_PATTERN = /^(?:(?:请|帮我|麻烦你?)\s*)?(?:重做(?:刚才撤销的剪辑|刚才的剪辑|下一步(?:剪辑)?)|恢复(?:刚才撤销的剪辑|下一个(?:剪辑)?版本)|回到下一个(?:剪辑)?版本)\s*[吧。！!]*$/

function portableBasename(value) {
  return path.posix.basename(String(value || '').replaceAll('\\', '/'))
}

function chineseInteger(value) {
  const text = String(value || '')
  if (!text) return Number.NaN
  if (!/[十百]/.test(text)) {
    const digits = [...text].map((char) => CHINESE_DIGITS[char])
    if (digits.some((digit) => digit == null)) return Number.NaN
    return Number(digits.join(''))
  }
  let total = 0
  let current = 0
  for (const char of text) {
    if (char === '百') {
      total += (current || 1) * 100
      current = 0
    } else if (char === '十') {
      total += (current || 1) * 10
      current = 0
    } else if (CHINESE_DIGITS[char] != null) {
      current = CHINESE_DIGITS[char]
    } else {
      return Number.NaN
    }
  }
  return total + current
}

function parseNumber(value) {
  const text = String(value || '').trim()
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text)
  return chineseInteger(text)
}

function parseTimeSeconds(value) {
  const text = String(value || '').replace(/^第\s*/, '').replace(/\s+/g, '')
  const colon = /^(\d{1,3}):(\d{2}(?:\.\d+)?)$/.exec(text)
  if (colon) return Number(colon[1]) * 60 + Number(colon[2])
  const minutes = new RegExp(`^(${NUMBER_TOKEN})分(?:钟)?(?:(${NUMBER_TOKEN})秒)?$`).exec(text)
  if (minutes) return parseNumber(minutes[1]) * 60 + (minutes[2] ? parseNumber(minutes[2]) : 0)
  const seconds = new RegExp(`^(${NUMBER_TOKEN})(?:秒|s)$`, 'i').exec(text)
  return seconds ? parseNumber(seconds[1]) : Number.NaN
}

function formatSeconds(value) {
  const totalMilliseconds = Math.round(Number(value) * 1000)
  const minutes = Math.floor(totalMilliseconds / 60000)
  const seconds = Math.floor((totalMilliseconds % 60000) / 1000)
  const milliseconds = totalMilliseconds % 1000
  return `${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s${milliseconds ? `-${String(milliseconds).padStart(3, '0')}ms` : ''}`
}

function extractRanges(text) {
  return [...String(text || '').matchAll(RANGE_PATTERN_GLOBAL)].map((match) => {
    const startSeconds = parseTimeSeconds(match[1])
    const endSeconds = parseTimeSeconds(match[2])
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds) return null
    return { startSeconds, endSeconds, durationSeconds: Number((endSeconds - startSeconds).toFixed(3)) }
  })
}

function extractTimes(text) {
  return [...String(text || '').matchAll(TIME_PATTERN_GLOBAL)]
    .map((match) => parseTimeSeconds(match[1]))
    .filter((value) => Number.isFinite(value) && value >= 0)
}

function compileEditDecisionList({ instruction, sourcePath } = {}) {
  const text = String(instruction || '').trim()
  const source = String(sourcePath || '').trim()
  if (!text || !source || /^(?:https?|blob):/i.test(source)) return null
  const removesRange = REMOVE_EDIT_PATTERN.test(text)
  const joinsRanges = JOIN_EDIT_PATTERN.test(text)
  if ((!DIRECT_EDIT_PATTERN.test(text) && !SEGMENT_REQUEST_PATTERN.test(text) && !removesRange && !joinsRanges) || CONSULTATION_PATTERN.test(text) || NEGATION_PATTERN.test(text) || EXAMPLE_PATTERN.test(text)) return null
  const ranges = extractRanges(text)
  if (!ranges.length || ranges.some((range) => !range)) return null
  if (joinsRanges) {
    if (removesRange || ranges.length < 2 || ranges.length > MAX_EDIT_SEGMENTS) return null
    let targetCursor = 0
    const segments = ranges.map((range) => {
      const segment = {
        sourceStartSeconds: range.startSeconds,
        sourceEndSeconds: range.endSeconds,
        durationSeconds: range.durationSeconds,
        targetStartSeconds: targetCursor,
        targetEndSeconds: Number((targetCursor + range.durationSeconds).toFixed(3))
      }
      targetCursor = segment.targetEndSeconds
      return segment
    })
    return {
      schemaVersion: 1,
      kind: 'media.concat-segments',
      instruction: text,
      source: { path: source, name: portableBasename(source) },
      timeline: { segments, durationSeconds: targetCursor },
      operations: segments.map((segment) => ({
        type: 'append',
        sourceStartSeconds: segment.sourceStartSeconds,
        sourceEndSeconds: segment.sourceEndSeconds,
        targetStartSeconds: segment.targetStartSeconds
      })),
      output: {
        container: 'mp4',
        overwrite: false,
        suffix: `拼接版-${segments.length}段-${formatSeconds(targetCursor)}`
      },
      verification: { expectedDurationSeconds: targetCursor, toleranceSeconds: 0.2 }
    }
  }
  if (ranges.length !== 1) return null
  const [{ startSeconds, endSeconds, durationSeconds }] = ranges
  if (removesRange) {
    return {
      schemaVersion: 1,
      kind: 'media.remove-segment',
      instruction: text,
      source: { path: source, name: portableBasename(source) },
      timeline: { startSeconds, endSeconds, removedDurationSeconds: durationSeconds },
      operations: [{ type: 'remove', sourceStartSeconds: startSeconds, sourceEndSeconds: endSeconds }],
      output: {
        container: 'mp4',
        overwrite: false,
        suffix: `删除版-${formatSeconds(startSeconds)}-${formatSeconds(endSeconds)}`
      },
      verification: { removedDurationSeconds: durationSeconds, toleranceSeconds: 0.2 }
    }
  }
  return {
    schemaVersion: 1,
    kind: 'media.trim',
    instruction: text,
    source: { path: source, name: portableBasename(source) },
    timeline: { startSeconds, endSeconds, durationSeconds },
    operations: [{ type: 'trim', sourceStartSeconds: startSeconds, sourceEndSeconds: endSeconds, targetStartSeconds: 0 }],
    output: {
      container: 'mp4',
      overwrite: false,
      suffix: `剪辑版-${formatSeconds(startSeconds)}-${formatSeconds(endSeconds)}`
    },
    verification: { expectedDurationSeconds: durationSeconds, toleranceSeconds: 0.2 }
  }
}

function compileConcatSourcesDecisionList({ instruction, sourcePath }) {
  const text = String(instruction || '').trim()
  const source = String(sourcePath || '').trim()
  if (!CONCAT_SOURCES_PATTERN.test(text)) return null
  const others = extractVideoPaths(text).filter((item) => path.basename(item) !== path.basename(source))
  if (!source || others.length < 1 || others.length > MAX_EDIT_SEGMENTS - 1) return null
  const sources = [source, ...others]
  return {
    schemaVersion: 1,
    kind: 'media.concat-sources',
    instruction: text,
    sources: sources.map((item) => ({ path: item, name: portableBasename(item) })),
    output: {
      container: 'mp4',
      overwrite: false,
      suffix: `合并版-${sources.length}段`
    },
    verification: { toleranceSeconds: 0.25 }
  }
}

function planEditInstruction({ instruction, sourcePath } = {}) {
  const text = String(instruction || '').trim()
  const source = String(sourcePath || '').trim()
  const concatSourcesDecision = compileConcatSourcesDecisionList({ instruction: text, sourcePath: source })
  if (concatSourcesDecision) return { matched: true, decision: concatSourcesDecision }
  const musicDecision = compileMusicDecisionList({ instruction: text, sourcePath: source })
  if (musicDecision) return { matched: true, decision: musicDecision }
  const burnDecision = compileBurnSubtitlesDecisionList({ instruction: text, sourcePath: source })
  if (burnDecision) return { matched: true, decision: burnDecision }
  const muxDecision = compileMuxSubtitlesDecisionList({ instruction: text, sourcePath: source })
  if (muxDecision) return { matched: true, decision: muxDecision }
  const translateDecision = compileTranslateSubtitlesDecisionList({ instruction: text, sourcePath: source })
  if (translateDecision) return { matched: true, decision: translateDecision }
  const cueEditDecision = compileCueEditDecisionList({ instruction: text, sourcePath: source })
  if (cueEditDecision) return { matched: true, decision: cueEditDecision }
  const shiftDecision = compileShiftSubtitlesDecisionList({ instruction: text, sourcePath: source })
  if (shiftDecision) return { matched: true, decision: shiftDecision }
  const decision = compileEditDecisionList({ instruction: text, sourcePath: source })
  if (decision) return { matched: true, decision }
  if (!text || !source || /^(?:https?|blob):/i.test(source)) return { matched: false }
  if (CONSULTATION_PATTERN.test(text) || NEGATION_PATTERN.test(text) || EXAMPLE_PATTERN.test(text)) return { matched: false }
  // 字幕条目校对缺序号：给了 .srt 路径且有删除/改动词但没"第 N 条"时追问唯一一项
  if (extractTextSubtitlePath(text) && /(?:字幕)/.test(text) && (CUE_EDIT_DELETE_PATTERN.test(text) || /(改成|改为|换成|改)/.test(text)) && !CUE_EDIT_RANGE_PATTERN.test(text) && !compileCueEditDecisionList({ instruction: text, sourcePath: source })) {
    return {
      matched: true,
      clarification: {
        schemaVersion: 1,
        kind: 'media.edit-clarification',
        reason: 'missing-cue-index',
        question: '要处理第几条字幕？直接说序号（比如"第 3 条"或"第 2 到第 4 条"）；改文本请说"第 3 条改成《新文本》"。',
        originalInstruction: text,
        sourcePath: source,
        known: { subtitlePath: extractTextSubtitlePath(text), editIntent: CUE_EDIT_DELETE_PATTERN.test(text) ? 'delete' : 'replace' }
      }
    }
  }
  // 字幕条目校对但没给文件：明说"第 N 条字幕"已是字幕语境，追问文件而不是落到视频段时间追问
  if (!extractTextSubtitlePath(text) && /字幕/.test(text) && new RegExp(`第\\s*${CUE_EDIT_NUMBER}\\s*条`).test(text) && (CUE_EDIT_DELETE_PATTERN.test(text) || /(改成|改为|换成|改)/.test(text))) {
    return {
      matched: true,
      clarification: {
        schemaVersion: 1,
        kind: 'media.edit-clarification',
        reason: 'missing-subtitle-cueedit-file',
        question: '要处理哪个字幕文件？请给我 .srt 完整路径（也可以把字幕文件拖进对话窗）。',
        originalInstruction: text,
        sourcePath: source,
        known: {}
      }
    }
  }
  // 字幕翻译缺目标语言：给了 .srt 路径才追问唯一一项；没给路径不接管（可能是视频级双语生成诉求）
  if (SUBTITLE_TRANSLATE_PATTERN.test(text) && extractSrtPath(text) && !SUBTITLE_TRANSLATE_TARGET_PATTERN.test(text) && !compileTranslateSubtitlesDecisionList({ instruction: text, sourcePath: source })) {
    return {
      matched: true,
      clarification: {
        schemaVersion: 1,
        kind: 'media.edit-clarification',
        reason: 'missing-translate-target',
        question: '想翻译成哪种语言？说"英文"或"中文"，也可以说"双语对照"。',
        originalInstruction: text,
        sourcePath: source,
        known: { subtitlePath: extractSrtPath(text) }
      }
    }
  }
  // 软字幕封装缺文件：只追问唯一一项
  if (SUBTITLE_MUX_PATTERN.test(text) && SUBTITLE_MUX_EXCLUDE_PATTERN.test(text) === false && /(?:字幕|\.srt|\.vtt|\.ass|\.ssa)/i.test(text) && !extractSubtitlePath(text)) {
    return {
      matched: true,
      clarification: {
        schemaVersion: 1,
        kind: 'media.edit-clarification',
        reason: 'missing-subtitle-mux',
        question: '要把哪个字幕文件封装成可开关的软字幕？请给我 .srt/.vtt/.ass 完整路径（也可以把字幕文件拖进对话窗）。',
        originalInstruction: text,
        sourcePath: source,
        known: {}
      }
    }
  }
  // 字幕调时缺文件或缺秒数：只追问当前唯一影响结果的一项（.srt/.vtt 都收）
  if (/(?:字幕|\.srt|\.vtt)/i.test(text) && SUBTITLE_SHIFT_PATTERN.test(text) && !compileShiftSubtitlesDecisionList({ instruction: text, sourcePath: source })) {
    if (!extractTextSubtitlePath(text)) {
      const direction = SUBTITLE_SHIFT_VERB_PATTERN.test(text) && text.lastIndexOf('提前') > text.lastIndexOf('延后') ? 'earlier' : 'later'
      const times = extractTimes(text)
      return {
        matched: true,
        clarification: {
          schemaVersion: 1,
          kind: 'media.edit-clarification',
          reason: 'missing-subtitle-file',
          question: '要调哪个字幕文件？请给我 .srt/.vtt 完整路径（也可以把字幕文件拖进对话窗）。',
          originalInstruction: text,
          sourcePath: source,
          known: { direction, offsetSeconds: times.length === 1 ? Number(times[0].toFixed(3)) : null }
        }
      }
    }
    return {
      matched: true,
      clarification: {
        schemaVersion: 1,
        kind: 'media.edit-clarification',
        reason: 'missing-offset',
        question: '整体移动几秒？请直接说秒数（比如 2 秒或 0.5 秒）。',
        originalInstruction: text,
        sourcePath: source,
        known: { direction: SUBTITLE_SHIFT_VERB_PATTERN.test(text) && text.lastIndexOf('提前') > text.lastIndexOf('延后') ? 'earlier' : 'later', subtitlePath: extractTextSubtitlePath(text) }
      }
    }
  }
  // 烧录字幕缺文件：只追问唯一一项（用用户自己的字幕文件，不抓网）
  if (SUBTITLE_BURN_PATTERN.test(text) && !extractSubtitlePath(text)) {
    return {
      matched: true,
      clarification: {
        schemaVersion: 1,
        kind: 'media.edit-clarification',
        reason: 'missing-subtitle',
        question: '要把哪个字幕文件烧进视频？请给我 .srt/.vtt/.ass 完整路径（也可以把字幕文件拖进对话窗）。',
        originalInstruction: text,
        sourcePath: source,
        known: {}
      }
    }
  }
  // 跨素材拼接缺第二个素材：只追问唯一一项
  if (CONCAT_SOURCES_PATTERN.test(text) && extractVideoPaths(text).length < 2 && !CONSULTATION_PATTERN.test(text)) {
    return {
      matched: true,
      clarification: {
        schemaVersion: 1,
        kind: 'media.edit-clarification',
        reason: 'missing-sources',
        question: '要把当前视频和哪个视频拼在一起？请给我完整路径（也可以把另一个视频拖进对话窗）。',
        originalInstruction: text,
        sourcePath: source,
        known: {}
      }
    }
  }
  // 配乐缺文件：只追问唯一影响结果的一项（版权红线：不替用户去网上抓音乐）
  if (MUSIC_EDIT_PATTERN.test(text) && !MUSIC_REMOVE_PATTERN.test(text) && !extractAudioPath(text)) {
    return {
      matched: true,
      clarification: {
        schemaVersion: 1,
        kind: 'media.edit-clarification',
        reason: 'missing-audio',
        question: '配乐用哪个本地音乐文件？请给我完整路径（也可以把音频文件拖进对话窗）。商业歌曲请用你自己已有的合法文件，我不会去网上抓。',
        originalInstruction: text,
        sourcePath: source,
        known: { volume: extractMusicVolume(text) }
      }
    }
  }
  const removesRange = REMOVE_EDIT_PATTERN.test(text)
  const hasExplicitKeep = DIRECT_EDIT_PATTERN.test(text) || SEGMENT_REQUEST_PATTERN.test(text)
  const hasGenericTrim = /剪一下/.test(text)
  const operation = removesRange ? 'remove' : hasExplicitKeep || hasGenericTrim ? 'trim' : ''
  const ranges = extractRanges(text)
  const times = extractTimes(text)
  if (operation && times.length === 0 && (DIRECT_EDIT_PATTERN.test(text) || GENERIC_EDIT_PATTERN.test(text) || removesRange)) {
    return {
      matched: true,
      clarification: {
        schemaVersion: 1,
        kind: 'media.edit-clarification',
        reason: 'missing-range',
        question: operation === 'remove' ? '要删除哪一段？请告诉我开始和结束时间。' : '要保留哪一段？请告诉我开始和结束时间。',
        originalInstruction: text,
        sourcePath: source,
        known: { operation }
      }
    }
  }
  if (operation === 'trim' && ranges.length >= 2 && ranges.length <= MAX_EDIT_SEGMENTS && ranges.every(Boolean) && !JOIN_EDIT_PATTERN.test(text)) {
    return {
      matched: true,
      clarification: {
        schemaVersion: 1,
        kind: 'media.edit-clarification',
        reason: 'confirm-join-order',
        question: `按你刚才说的顺序，把这${ranges.length}段拼成一个新视频吗？`,
        originalInstruction: text,
        sourcePath: source,
        known: { operation: 'concat', segments: ranges.map((range) => ({ startSeconds: range.startSeconds, endSeconds: range.endSeconds })) }
      }
    }
  }
  if (!removesRange && !hasExplicitKeep && GENERIC_EDIT_PATTERN.test(text) && ranges.length === 1 && ranges[0]) {
    const range = ranges[0]
    return {
      matched: true,
      clarification: {
        schemaVersion: 1,
        kind: 'media.edit-clarification',
        reason: 'missing-operation',
        question: `第${range.startSeconds}–${range.endSeconds}秒要保留还是删除？`,
        originalInstruction: text,
        sourcePath: source,
        known: { startSeconds: range.startSeconds, endSeconds: range.endSeconds }
      }
    }
  }
  if (operation && times.length === 1 && /(?:到|至|截止|之前|以前)/.test(text) && !/(?:之后|以后|往后)/.test(text)) {
    return {
      matched: true,
      clarification: {
        schemaVersion: 1,
        kind: 'media.edit-clarification',
        reason: 'missing-start',
        question: operation === 'remove' ? '从第几秒开始删除？' : '从第几秒开始保留？',
        originalInstruction: text,
        sourcePath: source,
        known: { operation, endSeconds: times[0] }
      }
    }
  }
  if (operation && times.length === 1 && /(?:之后|以后|往后|开始)/.test(text) && !/(?:之前|以前|截止|结尾|结束)/.test(text)) {
    return {
      matched: true,
      clarification: {
        schemaVersion: 1,
        kind: 'media.edit-clarification',
        reason: 'missing-end',
        question: operation === 'remove' ? '要删除到第几秒？' : '要保留到第几秒？',
        originalInstruction: text,
        sourcePath: source,
        known: { operation, startSeconds: times[0] }
      }
    }
  }
  return { matched: false }
}

function resolveEditClarification({ clarification, answer } = {}) {
  const pending = clarification && typeof clarification === 'object' ? clarification : null
  const text = String(answer || '').trim()
  if (!pending || pending.schemaVersion !== 1 || pending.kind !== 'media.edit-clarification' || !text) return { matched: false }
  if (/^(?:算了|取消|不弄了|先不剪了|不用了)[吧。！!]*$/.test(text)) return { matched: true, cancelled: true }
  if (CONSULTATION_PATTERN.test(text) || EXAMPLE_PATTERN.test(text)) return { matched: false }
  const replacementText = text.replace(/^(?:改成|换成|重新)/, '')
  const replacementConcat = compileConcatSourcesDecisionList({ instruction: replacementText, sourcePath: pending.sourcePath })
  if (replacementConcat) return { matched: true, decision: replacementConcat }
  const replacementMusic = compileMusicDecisionList({ instruction: replacementText, sourcePath: pending.sourcePath })
  if (replacementMusic) return { matched: true, decision: replacementMusic }
  const replacementBurn = compileBurnSubtitlesDecisionList({ instruction: replacementText, sourcePath: pending.sourcePath })
  if (replacementBurn) return { matched: true, decision: replacementBurn }
  const replacementMux = compileMuxSubtitlesDecisionList({ instruction: replacementText, sourcePath: pending.sourcePath })
  if (replacementMux) return { matched: true, decision: replacementMux }
  const replacementTranslate = compileTranslateSubtitlesDecisionList({ instruction: replacementText, sourcePath: pending.sourcePath })
  if (replacementTranslate) return { matched: true, decision: replacementTranslate }
  const replacementCueEdit = compileCueEditDecisionList({ instruction: replacementText, sourcePath: pending.sourcePath })
  if (replacementCueEdit) return { matched: true, decision: replacementCueEdit }
  const replacementShift = compileShiftSubtitlesDecisionList({ instruction: replacementText, sourcePath: pending.sourcePath })
  if (replacementShift) return { matched: true, decision: replacementShift }
  const replacementDecision = compileEditDecisionList({ instruction: replacementText, sourcePath: pending.sourcePath })
  if (replacementDecision) return { matched: true, decision: replacementDecision }
  if (pending.reason === 'missing-end') {
    const times = extractTimes(text)
    if (times.length !== 1) return { matched: false }
    const startSeconds = Number(pending.known?.startSeconds)
    const endSeconds = times[0]
    if (!Number.isFinite(startSeconds)) return { matched: false }
    if (endSeconds <= startSeconds) return { matched: true, clarification: { ...pending, question: `结束时间要晚于第${startSeconds}秒，请重新告诉我结束时间。` } }
    const verb = pending.known?.operation === 'remove' ? '删除' : '保留'
    const instruction = `${verb}第${startSeconds}秒到第${endSeconds}秒`
    const decision = compileEditDecisionList({ instruction, sourcePath: pending.sourcePath })
    return decision ? { matched: true, decision } : { matched: false }
  }
  if (pending.reason === 'missing-start') {
    const times = extractTimes(text)
    if (times.length !== 1) return { matched: false }
    const startSeconds = times[0]
    const endSeconds = Number(pending.known?.endSeconds)
    if (!Number.isFinite(endSeconds)) return { matched: false }
    if (endSeconds <= startSeconds) return { matched: true, clarification: { ...pending, question: `开始时间要早于第${endSeconds}秒，请重新告诉我开始时间。` } }
    const verb = pending.known?.operation === 'remove' ? '删除' : '保留'
    const instruction = `${verb}第${startSeconds}秒到第${endSeconds}秒`
    const decision = compileEditDecisionList({ instruction, sourcePath: pending.sourcePath })
    return decision ? { matched: true, decision } : { matched: false }
  }
  if (pending.reason === 'missing-operation') {
    const removes = REMOVE_EDIT_PATTERN.test(text)
    const keeps = DIRECT_EDIT_PATTERN.test(text) || /^(?:保留|留下|要这段|留着)[吧。！!]*$/.test(text)
    if (removes === keeps) return { matched: false }
    const startSeconds = Number(pending.known?.startSeconds)
    const endSeconds = Number(pending.known?.endSeconds)
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) return { matched: false }
    const instruction = `${removes ? '删除' : '保留'}第${startSeconds}秒到第${endSeconds}秒`
    const decision = compileEditDecisionList({ instruction, sourcePath: pending.sourcePath })
    return decision ? { matched: true, decision } : { matched: false }
  }
  if (pending.reason === 'confirm-join-order') {
    const reverses = /(?:反过来|倒过来|顺序反过来|倒序)/.test(text)
    if (!reverses && !/(?:^是[的吧。！!]*$|确认|就按|按(?:这个|刚才|上述)?顺序|拼接|拼起来)/.test(text)) return { matched: false }
    const originalSegments = Array.isArray(pending.known?.segments) ? pending.known.segments : []
    const segments = reverses ? [...originalSegments].reverse() : originalSegments
    if (segments.length < 2 || segments.length > MAX_EDIT_SEGMENTS) return { matched: false }
    const rangeText = segments.map((segment) => {
      const startSeconds = Number(segment?.startSeconds)
      const endSeconds = Number(segment?.endSeconds)
      return Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && endSeconds > startSeconds
        ? `第${startSeconds}秒到第${endSeconds}秒`
        : ''
    })
    if (rangeText.some((range) => !range)) return { matched: false }
    const instruction = `按顺序拼接${rangeText.join('和')}`
    const decision = compileEditDecisionList({ instruction, sourcePath: pending.sourcePath })
    return decision ? { matched: true, decision } : { matched: false }
  }
  if (pending.reason === 'missing-sources') {
    const others = extractVideoPaths(text).filter((item) => path.basename(item) !== path.basename(pending.sourcePath))
    if (others.length < 1) return { matched: false }
    const instruction = `把${pending.sourcePath}和${others.join('和')}拼起来`
    const decision = compileConcatSourcesDecisionList({ instruction, sourcePath: pending.sourcePath })
    return decision ? { matched: true, decision } : { matched: false }
  }
  if (pending.reason === 'missing-subtitle') {
    const subtitlePath = extractSubtitlePath(text)
    if (!subtitlePath) return { matched: false }
    const instruction = `${pending.originalInstruction} ${subtitlePath}`
    const decision = compileBurnSubtitlesDecisionList({ instruction, sourcePath: pending.sourcePath })
    return decision ? { matched: true, decision } : { matched: false }
  }
  if (pending.reason === 'missing-subtitle-mux') {
    const subtitlePath = extractSubtitlePath(text)
    if (!subtitlePath) return { matched: false }
    const instruction = `把字幕 ${subtitlePath} 封装进视频`
    const decision = compileMuxSubtitlesDecisionList({ instruction, sourcePath: pending.sourcePath })
    return decision ? { matched: true, decision } : { matched: false }
  }
  if (pending.reason === 'missing-subtitle-cueedit-file') {
    const subtitlePath = extractTextSubtitlePath(text)
    if (!subtitlePath) return { matched: false }
    const instruction = `${pending.originalInstruction} ${subtitlePath}`
    const decision = compileCueEditDecisionList({ instruction, sourcePath: pending.sourcePath })
    if (decision) return { matched: true, decision }
    // 原句可能还缺序号：继续只问序号
    const followup = planEditInstruction({ instruction, sourcePath: pending.sourcePath })
    return followup.matched ? followup : { matched: false }
  }
  if (pending.reason === 'missing-cue-index') {
    const subtitlePath = String(pending.known?.subtitlePath || '')
    if (!subtitlePath) return { matched: false }
    const hasEditVerb = CUE_EDIT_DELETE_PATTERN.test(text) || /(改成|改为|换成)/.test(text)
    const hasRange = CUE_EDIT_RANGE_PATTERN.test(text)
    // 第一轮只给了序号且原句是改文本：记住序号，继续只问文本这一项
    if (hasRange && !hasEditVerb && pending.known?.editIntent === 'replace' && !pending.known?.cueRange) {
      return {
        matched: true,
        clarification: { ...pending, question: '改成什么内容？请说"改成《新文本》"。', known: { ...pending.known, cueRange: text } }
      }
    }
    // 第二轮：文本带"改成"，序号从 remembered cueRange 补回
    const body = hasEditVerb && !hasRange && pending.known?.cueRange
      ? `${pending.known.cueRange}${text}`
      : hasEditVerb && hasRange ? text
        : pending.known?.editIntent === 'delete' && hasRange ? `删掉${text}` : ''
    if (!body) return { matched: false }
    const instruction = `把字幕 ${subtitlePath} ${body}`
    const decision = compileCueEditDecisionList({ instruction, sourcePath: pending.sourcePath })
    return decision ? { matched: true, decision } : { matched: false }
  }
  if (pending.reason === 'missing-translate-target') {
    const targetMatch = SUBTITLE_TRANSLATE_TARGET_PATTERN.exec(text)
    if (!targetMatch) return { matched: false }
    const subtitlePath = String(pending.known?.subtitlePath || '')
    if (!subtitlePath) return { matched: false }
    const instruction = `把字幕 ${subtitlePath} 翻译成${targetMatch[1]}`
    const decision = compileTranslateSubtitlesDecisionList({ instruction, sourcePath: pending.sourcePath })
    return decision ? { matched: true, decision } : { matched: false }
  }
  if (pending.reason === 'missing-subtitle-file') {
    const subtitlePath = extractTextSubtitlePath(text)
    if (!subtitlePath) return { matched: false }
    const offsetSeconds = Number(pending.known?.offsetSeconds)
    if (!Number.isFinite(offsetSeconds) || offsetSeconds <= 0) {
      const times = extractTimes(text.replace(TEXT_SUBTITLE_PATH_PATTERN, ''))
      if (times.length !== 1 || !(times[0] > 0)) {
        // 原句连秒数也没给：文件补齐后继续只追问秒数这一项
        return {
          matched: true,
          clarification: {
            ...pending,
            reason: 'missing-offset',
            question: '整体移动几秒？请直接说秒数（比如 2 秒或 0.5 秒）。',
            known: { direction: pending.known?.direction || 'later', subtitlePath }
          }
        }
      }
      const direction = pending.known?.direction === 'earlier' ? '提前' : '延后'
      const instruction = `把字幕 ${subtitlePath} ${direction} ${times[0]} 秒`
      const decision = compileShiftSubtitlesDecisionList({ instruction, sourcePath: pending.sourcePath })
      return decision ? { matched: true, decision } : { matched: false }
    }
    const direction = pending.known?.direction === 'earlier' ? '提前' : '延后'
    const instruction = `把字幕 ${subtitlePath} ${direction} ${offsetSeconds} 秒`
    const decision = compileShiftSubtitlesDecisionList({ instruction, sourcePath: pending.sourcePath })
    return decision ? { matched: true, decision } : { matched: false }
  }
  if (pending.reason === 'missing-offset') {
    const times = extractTimes(text)
    if (times.length !== 1 || !(times[0] > 0)) return { matched: false }
    const subtitlePath = String(pending.known?.subtitlePath || '')
    if (!subtitlePath) return { matched: false }
    const direction = pending.known?.direction === 'earlier' ? '提前' : '延后'
    const instruction = `把字幕 ${subtitlePath} ${direction} ${times[0]} 秒`
    const decision = compileShiftSubtitlesDecisionList({ instruction, sourcePath: pending.sourcePath })
    return decision ? { matched: true, decision } : { matched: false }
  }
  if (pending.reason === 'missing-audio') {
    const audioPath = extractAudioPath(text)
    if (!audioPath) return { matched: false }
    const volume = Number.isFinite(pending.known?.volume) ? pending.known.volume : extractMusicVolume(text)
    const instruction = `${pending.originalInstruction} ${audioPath}`
    const decision = compileMusicDecisionList({ instruction, sourcePath: pending.sourcePath, audioPath, volume })
    return decision ? { matched: true, decision } : { matched: false }
  }
  if (pending.reason === 'missing-range') {
    const ranges = extractRanges(text)
    if (ranges.length !== 1 || !ranges[0]) return { matched: false }
    const verb = pending.known?.operation === 'remove' ? '删除' : '保留'
    const instruction = `${verb}第${ranges[0].startSeconds}秒到第${ranges[0].endSeconds}秒`
    const decision = compileEditDecisionList({ instruction, sourcePath: pending.sourcePath })
    return decision ? { matched: true, decision } : { matched: false }
  }
  return { matched: false }
}

function compileEditHistoryAction(instruction) {
  const text = String(instruction || '').trim()
  if (!text || CONSULTATION_PATTERN.test(text) || NEGATION_PATTERN.test(text) || EXAMPLE_PATTERN.test(text)) return null
  if (UNDO_EDIT_PATTERN.test(text)) return { action: 'undo', instruction: text }
  if (REDO_EDIT_PATTERN.test(text)) return { action: 'redo', instruction: text }
  return null
}

module.exports = {
  compileConcatSourcesDecisionList,
  compileBurnSubtitlesDecisionList,
  compileCueEditDecisionList,
  compileMuxSubtitlesDecisionList,
  compileTranslateSubtitlesDecisionList,
  compileShiftSubtitlesDecisionList,
  burnForceStyle,
  compileMusicDecisionList, compileEditDecisionList, compileEditHistoryAction, planEditInstruction, resolveEditClarification, parseTimeSeconds, chineseInteger, portableBasename }
