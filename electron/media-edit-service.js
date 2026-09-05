const fs = require('fs')
const path = require('path')

const { buildBilingualSrt, buildTranslationOnlySrt, chooseOppositeTarget, parseSrt, translateEntries } = require('./subtitle-bilingual-service')
const { burnForceStyle } = require('./media-edit-decision')
const { AudioMixService } = require('./audio-mix-service')
const { AudioRepairService } = require('./audio-repair-service')
const { RhythmEditService } = require('./rhythm-edit-service')
const { AudioExportQualityGate } = require('./audio-export-quality')
const { ProfessionalSubtitleService } = require('./professional-subtitle-service')
const { BrandPackageService } = require('./brand-package-service')
const { SubtitlePreviewBurnParityService } = require('./subtitle-preview-burn-parity-service')
const { parseSignalStatsLog, shakeScoreFromTransforms } = require('./visual-repair-service')

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.ts', '.m4v', '.wmv', '.flv', '.avi'])
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.wma'])
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt', '.ass', '.ssa'])
const MAX_EDIT_SEGMENTS = 24

function formatTimestamp(value) {
  const milliseconds = Math.max(0, Math.round(Number(value) * 1000))
  const hours = Math.floor(milliseconds / 3600000)
  const minutes = Math.floor((milliseconds % 3600000) / 60000)
  const seconds = Math.floor((milliseconds % 60000) / 1000)
  const fraction = milliseconds % 1000
  const prefix = hours > 0 ? `${String(hours).padStart(2, '0')}:` : ''
  return `${prefix}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(3, '0')}`
}

function validateConcatTimeline(decision) {
  const segments = Array.isArray(decision?.timeline?.segments) ? decision.timeline.segments : []
  const expectedDuration = Number(decision?.timeline?.durationSeconds)
  if (segments.length < 2 || segments.length > MAX_EDIT_SEGMENTS || !Number.isFinite(expectedDuration) || expectedDuration <= 0) throw new Error('拼接时间线无效')
  let targetCursor = 0
  for (const segment of segments) {
    const start = Number(segment?.sourceStartSeconds)
    const end = Number(segment?.sourceEndSeconds)
    const duration = Number(segment?.durationSeconds)
    const targetStart = Number(segment?.targetStartSeconds)
    const targetEnd = Number(segment?.targetEndSeconds)
    if (![start, end, duration, targetStart, targetEnd].every(Number.isFinite)
      || start < 0 || end <= start
      || Math.abs(duration - (end - start)) > 0.001
      || Math.abs(targetStart - targetCursor) > 0.001
      || Math.abs(targetEnd - (targetStart + duration)) > 0.001) throw new Error('拼接时间线无效')
    targetCursor = targetEnd
  }
  if (Math.abs(targetCursor - expectedDuration) > 0.001) throw new Error('拼接时间线总时长不一致')
  return { segments, expectedDuration }
}

function assertSegmentsWithinSource(segments, sourceDuration) {
  const outOfRange = segments.find((segment) => Number(segment.sourceEndSeconds) > sourceDuration + 0.05)
  if (outOfRange) throw new Error(`结束时间 ${formatTimestamp(outOfRange.sourceEndSeconds)} 超出源视频时长 ${formatTimestamp(sourceDuration)}`)
}

const SRT_TIME_LINE = /^\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/

function srtTimeToMs(hours, minutes, seconds, milliseconds) {
  return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(milliseconds)
}

function msToSrtTime(value) {
  const ms = Math.max(0, Math.round(value))
  const hours = Math.floor(ms / 3600000)
  const minutes = Math.floor((ms % 3600000) / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  const fraction = ms % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(fraction).padStart(3, '0')}`
}

function meanAbsDiff(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 255
  let sum = 0
  for (let index = 0; index < a.length; index += 1) sum += Math.abs(a[index] - b[index])
  return sum / a.length
}

function pcmSample(buffer, index) {
  return buffer.readInt16LE(index * 2) / 32768
}

function pcmStats(buffer) {
  const samples = buffer && Buffer.isBuffer(buffer) ? Math.floor(buffer.length / 2) : 0
  if (!samples) return { samples: 0, rms: 0, samplePeak: 0, samplePeakDbfs: -Infinity }
  let sumSquares = 0
  let samplePeak = 0
  for (let index = 0; index < samples; index += 1) {
    const value = pcmSample(buffer, index)
    sumSquares += value * value
    samplePeak = Math.max(samplePeak, Math.abs(value))
  }
  const rms = Math.sqrt(sumSquares / samples)
  return {
    samples,
    rms: Number(rms.toFixed(6)),
    samplePeak: Number(samplePeak.toFixed(6)),
    samplePeakDbfs: samplePeak > 0 ? Number((20 * Math.log10(samplePeak)).toFixed(2)) : -Infinity
  }
}

// 对齐两个解码 PCM 窗口后，用最小二乘缩放原声并计算残差。残差只用于证明“有变化”，不等同于独立音乐轨。
function comparePcmWindows(sourceBuffer, outputBuffer, { maxLagSamples = 640 } = {}) {
  const sourceSamples = sourceBuffer && Buffer.isBuffer(sourceBuffer) ? Math.floor(sourceBuffer.length / 2) : 0
  const outputSamples = outputBuffer && Buffer.isBuffer(outputBuffer) ? Math.floor(outputBuffer.length / 2) : 0
  if (sourceSamples < 160 || outputSamples < 160) return null
  const maxLag = Math.min(Math.max(0, Math.round(maxLagSamples)), Math.floor(Math.min(sourceSamples, outputSamples) / 3))
  let best = null
  for (let lag = -maxLag; lag <= maxLag; lag += 4) {
    const sourceStart = lag < 0 ? -lag : 0
    const outputStart = lag > 0 ? lag : 0
    const count = Math.min(sourceSamples - sourceStart, outputSamples - outputStart)
    if (count < 160) continue
    let dot = 0
    let sourcePower = 0
    let outputPower = 0
    for (let offset = 0; offset < count; offset += 4) {
      const sourceValue = pcmSample(sourceBuffer, sourceStart + offset)
      const outputValue = pcmSample(outputBuffer, outputStart + offset)
      dot += sourceValue * outputValue
      sourcePower += sourceValue * sourceValue
      outputPower += outputValue * outputValue
    }
    const correlation = sourcePower > 0 && outputPower > 0 ? dot / Math.sqrt(sourcePower * outputPower) : 0
    if (!best || correlation > best.correlation) best = { lagSamples: lag, correlation, sourceStart, outputStart, count }
  }
  if (!best) return null
  let dot = 0
  let sourcePower = 0
  for (let offset = 0; offset < best.count; offset += 1) {
    const sourceValue = pcmSample(sourceBuffer, best.sourceStart + offset)
    const outputValue = pcmSample(outputBuffer, best.outputStart + offset)
    dot += sourceValue * outputValue
    sourcePower += sourceValue * sourceValue
  }
  const scale = sourcePower > 1e-12 ? dot / sourcePower : 0
  let residualPower = 0
  for (let offset = 0; offset < best.count; offset += 1) {
    const sourceValue = pcmSample(sourceBuffer, best.sourceStart + offset)
    const outputValue = pcmSample(outputBuffer, best.outputStart + offset)
    const residual = outputValue - scale * sourceValue
    residualPower += residual * residual
  }
  return {
    lagSamples: best.lagSamples,
    correlation: Number(best.correlation.toFixed(6)),
    sourceScale: Number(scale.toFixed(6)),
    residualRms: Number(Math.sqrt(residualPower / best.count).toFixed(6))
  }
}

function parseLoudnormMeasurement(stderr) {
  const blocks = [...String(stderr || '').matchAll(/\{\s*"input_i"\s*:[\s\S]*?"target_offset"\s*:\s*"[^"]+"\s*\}/g)]
  if (!blocks.length) return null
  try {
    const value = JSON.parse(blocks.at(-1)[0])
    const fields = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']
    if (fields.some((field) => !Number.isFinite(Number(value[field])))) return null
    return Object.fromEntries(fields.map((field) => [field, Number(value[field])]))
  } catch {
    return null
  }
}

// srt 解码：BOM 直读；否则先严格 UTF-8，失败退 GBK（中文圈常见）；写出统一 UTF-8
function decodeSubtitleText(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString('utf8')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    try { return new TextDecoder('gbk').decode(buffer) } catch { return buffer.toString('utf8') }
  }
}

// 解析标准 srt：序号行 + 时间行 + 文本行；容忍缺序号、CRLF/LF、行间空行
function parseSrtCues(text) {
  const lines = String(text || '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const cues = []
  let block = []
  const flush = () => {
    if (!block.length) return
    const timeIndex = block.findIndex((line) => SRT_TIME_LINE.test(line))
    if (timeIndex >= 0) {
      const match = SRT_TIME_LINE.exec(block[timeIndex])
      const startMs = srtTimeToMs(match[1], match[2], match[3], match[4])
      const endMs = srtTimeToMs(match[5], match[6], match[7], match[8])
      const textLines = block.slice(timeIndex + 1)
      if (endMs > startMs && textLines.some((line) => line.trim())) cues.push({ startMs, endMs, text: textLines.join('\n') })
    }
    block = []
  }
  for (const line of lines) {
    if (line.trim() === '') flush()
    else block.push(line)
  }
  flush()
  return cues
}

function renderSrtCues(cues) {
  return cues.map((cue, index) => `${index + 1}\r\n${msToSrtTime(cue.startMs)} --> ${msToSrtTime(cue.endMs)}\r\n${cue.text.replaceAll('\n', '\r\n')}\r\n`).join('\r\n')
}

// WebVTT：头部 WEBVTT，时间用点号毫秒且可省略小时（MM:SS.mmm）；cue 前可有标识行
const VTT_TIME_LINE = /^\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})/

function parseVttCues(text) {
  const lines = String(text || '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const cues = []
  let block = []
  const flush = () => {
    if (!block.length) return
    const timeIndex = block.findIndex((line) => VTT_TIME_LINE.test(line))
    if (timeIndex >= 0) {
      const match = VTT_TIME_LINE.exec(block[timeIndex])
      const startMs = srtTimeToMs(match[1] || 0, match[2], match[3], match[4])
      const endMs = srtTimeToMs(match[5] || 0, match[6], match[7], match[8])
      const textLines = block.slice(timeIndex + 1)
      if (endMs > startMs && textLines.some((line) => line.trim())) cues.push({ startMs, endMs, text: textLines.join('\n') })
    }
    block = []
  }
  for (const line of lines.slice(lines[0]?.trim().startsWith('WEBVTT') ? 1 : 0)) {
    if (line.trim() === '') flush()
    else block.push(line)
  }
  flush()
  return cues
}

function msToVttTime(value) {
  return msToSrtTime(value).replace(',', '.')
}

function renderVttCues(cues) {
  return `WEBVTT\r\n\r\n${cues.map((cue, index) => `${index + 1}\r\n${msToVttTime(cue.startMs)} --> ${msToVttTime(cue.endMs)}\r\n${cue.text.replaceAll('\n', '\r\n')}\r\n`).join('\r\n')}`
}

// 文本字幕格式分发：srt/vtt 同一套 cue 模型（startMs/endMs/text）
function subtitleFormatOf(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase()
  if (ext === '.srt' || ext === '.vtt') return ext.slice(1)
  return ''
}

function parseSubtitleCuesAuto(text, format) {
  return format === 'vtt' ? parseVttCues(text) : parseSrtCues(text)
}

function renderSubtitleCuesAuto(cues, format) {
  return format === 'vtt' ? renderVttCues(cues) : renderSrtCues(cues)
}

function assSubtitleTime(valueMs) {
  const centiseconds = Math.max(0, Math.round(Number(valueMs) / 10)); const hours = Math.floor(centiseconds / 360000); const minutes = Math.floor((centiseconds % 360000) / 6000); const seconds = Math.floor((centiseconds % 6000) / 100)
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`
}
function parseAssSubtitleTime(value) {
  const match = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(String(value || '').trim())
  return match ? (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4]) * 10) : NaN
}
function escapeSubtitleAssText(value) { return String(value || '').replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/\r?\n/g, '\\N') }
function renderStyledSubtitleAss(cues, preset) {
  const presets = { clean: { style: 'Clean', size: 28, primary: '&H00FFFFFF', back: '&H78000000', border: 1 }, impact: { style: 'Impact', size: 34, primary: '&H004DFFFF', back: '&HC0101010', border: 3 }, documentary: { style: 'Documentary', size: 28, primary: '&H00FFFFFF', back: '&HA0181818', border: 3 } }
  const item = presets[preset] || presets.clean
  const style = `Style: ${item.style},Microsoft YaHei,${item.size},${item.primary},&H00FFFFFF,&H00000000,${item.back},-1,0,0,0,100,100,0,0,${item.border},2,0,2,48,48,40,1`
  const dialogues = cues.map((cue) => `Dialogue: 0,${assSubtitleTime(cue.startMs)},${assSubtitleTime(cue.endMs)},${item.style},,0,0,0,,${escapeSubtitleAssText(cue.text)}`).join('\n')
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n${style}\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${dialogues}\n`
}
function parseStyledSubtitleAss(content) {
  return String(content || '').split(/\r?\n/).filter((line) => line.startsWith('Dialogue:')).map((line) => {
    const fields = line.slice('Dialogue:'.length).split(','); const text = fields.slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n')
    return { startMs: parseAssSubtitleTime(fields[1]), endMs: parseAssSubtitleTime(fields[2]), text }
  }).filter((cue) => Number.isFinite(cue.startMs) && Number.isFinite(cue.endMs) && cue.endMs > cue.startMs)
}

function applyLocalSubtitleTransform(sourceCues, transform) {
  const originals = sourceCues.map((cue) => ({ ...cue })); const replacements = new Map((transform.replacements || []).map((item) => [Number(item.index), String(item.text || '').trim()])); const merges = new Map(); const mergedIndexes = new Set(); const splits = new Map((transform.splits || []).map((item) => [Number(item.index), item]))
  for (const merge of transform.merges || []) {
    const start = Number(merge.startIndex); const end = Number(merge.endIndex)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end <= start || end > originals.length) throw new Error(`合并第${start}到第${end}条超出字幕范围`)
    for (let index = start; index <= end; index += 1) { if (mergedIndexes.has(index) || splits.has(index)) throw new Error(`第${index}条存在重叠结构操作`); mergedIndexes.add(index) }
    merges.set(start, merge)
  }
  for (const [index, split] of splits) {
    if (!Number.isInteger(index) || index < 1 || index > originals.length || mergedIndexes.has(index)) throw new Error(`拆分第${index}条超出范围或与合并冲突`)
    if (!Array.isArray(split.parts) || split.parts.length !== 2 || split.parts.some((item) => !String(item || '').trim())) throw new Error(`拆分第${index}条缺少两段明确文本`)
  }
  for (const [index, text] of replacements) if (!Number.isInteger(index) || index < 1 || index > originals.length || !text) throw new Error(`改字第${index}条无效`)
  const output = []
  for (let index = 1; index <= originals.length; index += 1) {
    if (mergedIndexes.has(index) && !merges.has(index)) continue
    if (merges.has(index)) {
      const merge = merges.get(index); const last = originals[Number(merge.endIndex) - 1]
      const texts = []
      for (let item = index; item <= Number(merge.endIndex); item += 1) texts.push(replacements.get(item) || originals[item - 1].text)
      output.push({ startMs: originals[index - 1].startMs, endMs: last.endMs, text: texts.join(String(merge.separator || ' ')) }); continue
    }
    const cue = { ...originals[index - 1], text: replacements.get(index) || originals[index - 1].text }
    if (splits.has(index)) {
      const split = splits.get(index); const atMs = Math.round(Number(split.atSeconds) * 1000)
      if (!(atMs >= cue.startMs + 80 && atMs <= cue.endMs - 80)) throw new Error(`第${index}条拆分秒点必须位于${(cue.startMs / 1000).toFixed(3)}到${(cue.endMs / 1000).toFixed(3)}秒之间`)
      output.push({ startMs: cue.startMs, endMs: atMs, text: String(split.parts[0]).trim() }, { startMs: atMs, endMs: cue.endMs, text: String(split.parts[1]).trim() }); continue
    }
    output.push(cue)
  }
  const shift = transform.shift
  if (!shift) return output
  const offset = Math.round(Number(shift.offsetSeconds) * 1000) * (shift.direction === 'earlier' ? -1 : 1)
  const shifted = output.map((cue) => ({ ...cue, startMs: cue.startMs + offset, endMs: cue.endMs + offset })).filter((cue) => cue.endMs > 0).map((cue) => ({ ...cue, startMs: Math.max(0, cue.startMs) }))
  if (!shifted.length) throw new Error('批量调时会移除全部字幕，没有可交付成果')
  return shifted
}

class MediaEditService {
  constructor({ frames, fsImpl = fs, transcription = null } = {}) {
    if (!frames) throw new Error('媒体剪辑服务缺少 FFmpeg 执行器')
    this.frames = frames
    this.fs = fsImpl
    this.exportQuality = new AudioExportQualityGate({ frames, fsImpl })
    this.audioMixService = new AudioMixService({ frames, fsImpl, exportQuality: this.exportQuality })
    this.audioRepairService = new AudioRepairService({ frames, fsImpl, exportQuality: this.exportQuality })
    this.rhythmEditService = new RhythmEditService({ frames, fsImpl, exportQuality: this.exportQuality })
    this.professionalSubtitleService = transcription ? new ProfessionalSubtitleService({ frames, transcription, fsImpl }) : null
    this.brandPackageService = new BrandPackageService({ frames, fsImpl })
    this.subtitlePreviewBurnParityService = new SubtitlePreviewBurnParityService({ fsImpl })
  }

  async mixAudio(input = {}) { return this.audioMixService.mix(input) }
  async repairAudio(input = {}) { return this.audioRepairService.run(input) }
  async verifyAudioRepair(input = {}) { return this.audioRepairService.verify(input) }
  async rhythmEdit(input = {}) { return this.rhythmEditService.run(input) }
  async verifyRhythmEdit(input = {}) { return this.rhythmEditService.verify(input) }

  async trim({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.trim') throw new Error('剪辑决策无效')
    if (path.resolve(String(decision.source?.path || '')) !== source) throw new Error('剪辑决策与源文件不一致')
    if (source === output) throw new Error('禁止覆盖源视频')
    if (!VIDEO_EXTENSIONS.has(path.extname(source).toLowerCase())) throw new Error('当前文件不是受支持的视频格式')
    if (!this.fs.existsSync(source) || !this.fs.statSync(source).isFile()) throw new Error('源视频不存在')
    if (this.fs.existsSync(output)) throw new Error('成果文件已存在，为避免覆盖已停止')
    if (!this.frames.availability().available) throw new Error('缺少 ffmpeg 组件')

    const { startSeconds, endSeconds, durationSeconds } = decision.timeline || {}
    if (![startSeconds, endSeconds, durationSeconds].every(Number.isFinite) || startSeconds < 0 || endSeconds <= startSeconds) throw new Error('剪辑时间范围无效')
    const sourceDuration = await this.frames.probeDuration(source, { signal })
    if (!(sourceDuration > 0)) throw new Error('无法读取源视频时长')
    if (endSeconds > sourceDuration + 0.05) throw new Error(`结束时间 ${formatTimestamp(endSeconds)} 超出源视频时长 ${formatTimestamp(sourceDuration)}`)

    const sourceBefore = this.fs.statSync(source)
    const parsed = path.parse(output)
    const tempPath = path.join(parsed.dir, `.${parsed.name}.agentplay-edit-${process.pid}-${Date.now()}${parsed.ext || '.mp4'}`)
    try {
      await this.frames.run([
        '-hide_banner', '-nostdin', '-i', source,
        '-ss', Number(startSeconds).toFixed(3), '-t', Number(durationSeconds).toFixed(3),
        '-map', '0:v:0', '-map', '0:a?', '-map_metadata', '0', '-map_chapters', '0',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-c:a', 'aac', '-b:a', '160k',
        '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-y', tempPath
      ], { timeoutMs: 60 * 60 * 1000, signal })
      if (signal?.aborted) throw new Error('已取消')
      this.assertSourceUnchanged(sourceBefore, source)
      if (!this.fs.existsSync(tempPath) || this.fs.statSync(tempPath).size <= 1024) throw new Error('剪辑成果为空或不完整')
      const actualDuration = await this.frames.probeDuration(tempPath, { signal })
      const tolerance = Math.max(0.05, Number(decision.verification?.toleranceSeconds) || 0.2)
      if (!(actualDuration > 0) || Math.abs(actualDuration - durationSeconds) > tolerance) {
        throw new Error(`剪辑成果时长校验失败：期望 ${durationSeconds.toFixed(3)} 秒，实际 ${Number(actualDuration || 0).toFixed(3)} 秒`)
      }
      const frameProof = await this.frameProofForTrim({ source, output: tempPath, decision, sourceDuration, signal })
      this.assertFrameProofDeliverable(frameProof)
      this.assertSourceUnchanged(sourceBefore, source)
      this.fs.renameSync(tempPath, output)
      return this.resultReceipt({ source, output, decision, sourceDuration, actualDuration, frameProof })
    } catch (error) {
      if (this.fs.existsSync(tempPath)) this.fs.rmSync(tempPath, { force: true })
      throw error
    }
  }

  // 帧边界级证明：成片首帧应来自源片决策起点、尾帧应来自决策终点。
  // 首帧按帧位精确采样（剪辑是输出侧精确 seek，成片第 0 帧 = 源片第一个 PTS≥start 的帧）；
  // 尾帧因 PTS 可能越界取不到帧，用回退链采样并允许多候选匹配；内容过于均匀时如实记 inconclusive 不硬判。
  async frameProofForTrim({ source, output, decision, sourceDuration, signal }) {
    const { startSeconds, endSeconds } = decision.timeline || {}
    const proofBase = {
      schemaVersion: 1,
      method: 'gray-frame-mad-v1',
      sourceRangeSeconds: { start: startSeconds, end: endSeconds },
      sample: { width: 32, height: 32, color: 'gray' }
    }
    if (typeof this.frames.readGrayFrame !== 'function') return { ...proofBase, verdict: 'unavailable', reason: 'frame-reader-missing' }
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) return { ...proofBase, verdict: 'unavailable', reason: 'invalid-timeline' }
    const sampleAt = (file, t) => this.frames.readGrayFrame(file, Math.max(0, Number(t.toFixed(3))), { signal })
    const sampleLast = async (file, boundary) => {
      if (typeof this.frames.readLastGrayFrame === 'function') return this.frames.readLastGrayFrame(file, boundary, { signal })
      return sampleAt(file, Math.max(0.02, boundary - 0.06))
    }
    const outputDuration = await this.frames.probeDuration(output, { signal })
    const outputFirstCandidates = [await sampleAt(output, 0), await sampleAt(output, 0.067), await sampleAt(output, 0.134)].filter(Boolean)
    // 尾帧两侧采样：重编码会重置 PTS 网格，-t 严格排除边界帧；用 ±1 帧的包含/排除双候选覆盖
    const outputLast = await sampleLast(output, outputDuration + 0.067)
    const matchFirstCandidates = [await sampleAt(source, startSeconds), await sampleAt(source, startSeconds + 0.067), await sampleAt(source, Math.max(0, startSeconds - 0.067)), await sampleAt(source, startSeconds + 0.134)].filter(Boolean)
    const matchLastCandidates = [
      await sampleLast(source, endSeconds - 0.001),
      await sampleLast(source, endSeconds + 0.067),
      await sampleLast(source, endSeconds - 0.134),
      await sampleAt(source, Math.max(startSeconds, endSeconds - 0.061)),
      await sampleAt(source, Math.max(startSeconds, endSeconds - 0.094)),
      await sampleAt(source, Math.max(startSeconds, endSeconds - 0.127))
    ].filter(Boolean)
    if (!outputFirstCandidates.length || !outputLast || !matchFirstCandidates.length || !matchLastCandidates.length) return { ...proofBase, verdict: 'unavailable', reason: 'frame-sample-missing' }
    const first = this.judgeFrameBoundaryCandidates(outputFirstCandidates, matchFirstCandidates, [
      startSeconds - 0.5 >= 0 ? await sampleAt(source, startSeconds - 0.5) : null,
      startSeconds + 0.5 < sourceDuration ? await sampleAt(source, startSeconds + 0.5) : null
    ])
    const last = this.judgeFrameBoundary(outputLast, matchLastCandidates, [
      endSeconds - 0.62 >= startSeconds ? await sampleAt(source, endSeconds - 0.62) : null,
      endSeconds + 0.44 < sourceDuration ? await sampleAt(source, endSeconds + 0.44) : null
    ])
    const verdict = first.verdict === 'mismatch' || last.verdict === 'mismatch'
      ? 'mismatch'
      : first.verdict === 'matched' && last.verdict === 'matched' ? 'matched' : 'inconclusive'
    return { ...proofBase, verdict, first, last }
  }

  async frameProofForSegments({ source, output, segments, sourceDuration, signal }) {
    const proofBase = {
      schemaVersion: 1,
      method: 'gray-frame-mad-v1',
      segments: Array.isArray(segments) ? segments : []
    }
    if (typeof this.frames.readGrayFrame !== 'function') return { ...proofBase, verdict: 'unavailable', reason: 'frame-reader-missing' }
    const normalized = proofBase.segments.map((segment) => ({
      sourcePath: path.resolve(String(segment?.sourcePath || source)),
      sourceDurationSeconds: Number(segment?.sourceDurationSeconds ?? sourceDuration),
      frameFitWidth: Number(segment?.frameFitWidth || 0),
      frameFitHeight: Number(segment?.frameFitHeight || 0),
      sourceStartSeconds: Number(segment?.sourceStartSeconds),
      sourceEndSeconds: Number(segment?.sourceEndSeconds),
      targetStartSeconds: Number(segment?.targetStartSeconds),
      targetEndSeconds: Number(segment?.targetEndSeconds)
    }))
    if (!(sourceDuration > 0) || !normalized.length || normalized.some((segment) => !segment.sourcePath || ![segment.sourceDurationSeconds, segment.sourceStartSeconds, segment.sourceEndSeconds, segment.targetStartSeconds, segment.targetEndSeconds].every(Number.isFinite) || segment.sourceDurationSeconds <= 0 || segment.sourceStartSeconds < 0 || segment.sourceEndSeconds <= segment.sourceStartSeconds || segment.sourceEndSeconds > segment.sourceDurationSeconds + 0.05 || segment.targetStartSeconds < 0 || segment.targetEndSeconds <= segment.targetStartSeconds)) {
      return { ...proofBase, verdict: 'unavailable', reason: 'invalid-segment-timeline' }
    }
    const outputDuration = await this.frames.probeDuration(output, { signal })
    if (!(outputDuration > 0)) return { ...proofBase, verdict: 'unavailable', reason: 'output-duration-missing' }
    const firstCache = new Map()
    const lastCache = new Map()
    const request = (file, seconds, kind, options = {}) => {
      const at = Math.max(kind === 'last' ? 0.02 : 0, Number(seconds.toFixed(3)))
      const fitWidth = Number(options.fitWidth || 0), fitHeight = Number(options.fitHeight || 0)
      return { file, at, kind, fitWidth, fitHeight, key: `${file}\n${kind}\n${at.toFixed(3)}\n${fitWidth}x${fitHeight}` }
    }
    const sampleAt = (file, at, options) => request(file, at, 'first', options)
    const sampleLast = (file, at, options) => request(file, at, 'last', options)
    const cacheFor = item => item.kind === 'last' ? lastCache : firstCache
    const readOne = async item => {
      if (!item) return null
      const cache = cacheFor(item)
      if (!cache.has(item.key)) {
        const options = { signal, fitWidth: item.fitWidth, fitHeight: item.fitHeight }
        cache.set(item.key, item.kind === 'last' && typeof this.frames.readLastGrayFrame === 'function'
          ? this.frames.readLastGrayFrame(item.file, item.at, options)
          : this.frames.readGrayFrame(item.file, item.kind === 'last' ? Math.max(0.02, item.at - 0.06) : item.at, options))
      }
      return cache.get(item.key)
    }
    const sampleMany = async readers => {
      const requests = readers.map(read => read())
      const missing = requests.filter(item => item && !cacheFor(item).has(item.key))
      if (missing.length > 1 && typeof this.frames.readProofFrames === 'function') {
        try {
          const frames = await this.frames.readProofFrames(missing, { signal })
          for (const item of missing) if (frames?.get(item.key)?.length === 1024) cacheFor(item).set(item.key, frames.get(item.key))
        } catch (error) { if (signal?.aborted) throw error }
      }
      const results = []
      for (let index = 0; index < requests.length; index += 2) {
        const batch = await Promise.allSettled(requests.slice(index, index + 2).map(readOne))
        const failed = batch.find(item => item.status === 'rejected')
        if (failed) throw failed.reason
        results.push(...batch.map(item => item.value))
      }
      return results
    }
    const boundaries = []
    for (let index = 0; index < normalized.length; index += 1) {
      const segment = normalized[index]
      const segmentSource = segment.sourcePath
      const segmentSourceDuration = segment.sourceDurationSeconds
      const sourceFrameOptions = segment.frameFitWidth > 0 && segment.frameFitHeight > 0 ? { fitWidth: segment.frameFitWidth, fitHeight: segment.frameFitHeight } : {}
      const segmentDuration = segment.sourceEndSeconds - segment.sourceStartSeconds
      const delta = Math.min(0.5, Math.max(0.1, segmentDuration / 3))
      const outputFirstCandidates = (await sampleMany([0, 0.067, 0.134].map(offset => () => sampleAt(output, segment.targetStartSeconds + offset)))).filter(Boolean)
      const sourceFirstCandidates = (await sampleMany([segment.sourceStartSeconds, segment.sourceStartSeconds + 0.067, Math.max(0, segment.sourceStartSeconds - 0.067), segment.sourceStartSeconds + 0.134].map(at => () => sampleAt(segmentSource, at, sourceFrameOptions)))).filter(Boolean)
      const firstAlternatives = await sampleMany([
        () => segment.sourceStartSeconds - delta >= 0 ? sampleAt(segmentSource, segment.sourceStartSeconds - delta, sourceFrameOptions) : null,
        () => segment.sourceStartSeconds + delta < segmentSourceDuration ? sampleAt(segmentSource, segment.sourceStartSeconds + delta, sourceFrameOptions) : null
      ])
      const outputLastCandidates = (await sampleMany([-0.001, 0.067, -0.134].map(offset => () => sampleLast(output, segment.targetEndSeconds + offset)))).filter(Boolean)
      const sourceLastCandidates = (await sampleMany([
        ...[-0.001, 0.067, -0.134, 0.201, -0.268].map(offset => () => sampleLast(segmentSource, segment.sourceEndSeconds + offset, sourceFrameOptions)),
        ...[-0.061, -0.094, -0.127].map(offset => () => sampleAt(segmentSource, Math.max(segment.sourceStartSeconds, segment.sourceEndSeconds + offset), sourceFrameOptions))
      ])).filter(Boolean)
      const lastAlternatives = await sampleMany([
        () => segment.sourceEndSeconds - delta >= 0 ? sampleLast(segmentSource, segment.sourceEndSeconds - delta, sourceFrameOptions) : null,
        () => segment.sourceEndSeconds + delta < segmentSourceDuration ? sampleLast(segmentSource, segment.sourceEndSeconds + delta, sourceFrameOptions) : null
      ])
      if (!outputFirstCandidates.length || !sourceFirstCandidates.length || !outputLastCandidates.length || !sourceLastCandidates.length) {
        return { ...proofBase, verdict: 'unavailable', reason: 'frame-sample-missing', segmentIndex: index }
      }
      boundaries.push({
        segmentIndex: index,
        sourcePath: segmentSource,
        sourceRangeSeconds: { start: segment.sourceStartSeconds, end: segment.sourceEndSeconds },
        targetRangeSeconds: { start: segment.targetStartSeconds, end: segment.targetEndSeconds },
        first: this.judgeFrameBoundaryCandidates(outputFirstCandidates, sourceFirstCandidates, firstAlternatives),
        last: this.judgeFrameBoundaryCandidates(outputLastCandidates, sourceLastCandidates, lastAlternatives)
      })
    }
    const everyBoundary = boundaries.flatMap((item) => [item.first, item.last])
    const verdict = everyBoundary.some((item) => item.verdict === 'mismatch')
      ? 'mismatch'
      : everyBoundary.every((item) => item.verdict === 'matched') ? 'matched' : 'inconclusive'
    return { ...proofBase, segments: normalized, outputDurationSeconds: Number(outputDuration.toFixed(3)), verdict, boundaries }
  }

  async frameProofForSources({ sources, output, probes, signal }) {
    const proofBase = { schemaVersion: 1, method: 'gray-frame-mad-v1', sources: Array.isArray(sources) ? sources : [] }
    if (typeof this.frames.readGrayFrame !== 'function') return { ...proofBase, verdict: 'unavailable', reason: 'frame-reader-missing' }
    if (!Array.isArray(probes) || proofBase.sources.length !== probes.length || !proofBase.sources.length) return { ...proofBase, verdict: 'unavailable', reason: 'invalid-source-timeline' }
    let cursor = 0
    const fitWidth = Math.ceil(Number(probes[0]?.width) / 2) * 2
    const fitHeight = Math.ceil(Number(probes[0]?.height) / 2) * 2
    const segments = proofBase.sources.map((sourcePath, index) => {
      const duration = Number(probes[index]?.duration)
      const segment = { sourcePath, sourceDurationSeconds: duration, frameFitWidth: fitWidth, frameFitHeight: fitHeight, sourceStartSeconds: 0, sourceEndSeconds: duration, targetStartSeconds: cursor, targetEndSeconds: cursor + duration }
      cursor += duration
      return segment
    })
    const proof = await this.frameProofForSegments({ source: proofBase.sources[0], output, segments, sourceDuration: Number(probes[0]?.duration), signal })
    return { ...proof, sources: proofBase.sources }
  }

  judgeFrameBoundaryCandidates(outputFrames, matchFrames, altFrames) {
    const rank = { mismatch: 0, inconclusive: 1, matched: 2 }
    return outputFrames
      .filter(Boolean)
      .map((frame) => this.judgeFrameBoundary(frame, matchFrames, altFrames))
      .sort((a, b) => (rank[b.verdict] - rank[a.verdict]) || (a.matchDiff - b.matchDiff) || ((b.margin ?? -Infinity) - (a.margin ?? -Infinity)))[0]
  }

  assertFrameProofDeliverable(frameProof) {
    if (!frameProof || frameProof.verdict === 'unavailable') {
      throw new Error(`帧边界证明不可用（${frameProof?.reason || 'unknown'}），为避免交付无法核对的剪辑结果已停止`)
    }
    if (frameProof.verdict === 'mismatch') {
      const segmentMismatch = Array.isArray(frameProof.boundaries)
        ? frameProof.boundaries.flatMap((item, index) => ([['首', item.first], ['末', item.last]]).filter(([, boundary]) => boundary?.verdict === 'mismatch').map(([side, boundary]) => `片段${index + 1}${side}差异 ${boundary.matchDiff ?? '?'}、余量 ${boundary.margin ?? '?'}`))[0]
        : null
      const detail = segmentMismatch || `首帧差异 ${frameProof.first?.matchDiff ?? '?'}、余量 ${frameProof.first?.margin ?? '?'}；尾帧差异 ${frameProof.last?.matchDiff ?? '?'}、余量 ${frameProof.last?.margin ?? '?'}`
      throw new Error(`帧边界校验失败：成片与决策切割点不符（${detail}），已拒绝交付`)
    }
  }

  frameProofSummary(frameProof, segmentLabel = '片段') {
    if (frameProof?.verdict === 'matched') {
      const count = Array.isArray(frameProof.boundaries) ? frameProof.boundaries.length : 1
      return `；${count}个${segmentLabel}的首尾帧边界已核对`
    }
    if (frameProof?.verdict === 'inconclusive') return `；画面内容相似，${segmentLabel}帧边界无法唯一判定，已保留提示`
    return ''
  }

  assertSourceUnchanged(sourceBefore, source, message = '剪辑期间源视频发生变化，已拒绝交付') {
    const current = this.fs.statSync(source)
    if (sourceBefore.size !== current.size || Math.trunc(sourceBefore.mtimeMs) !== Math.trunc(current.mtimeMs)) throw new Error(message)
  }

  removeProofSegments(decision, sourceDuration) {
    const startSeconds = Number(decision?.timeline?.startSeconds)
    const endSeconds = Number(decision?.timeline?.endSeconds)
    const segments = []
    let targetCursor = 0
    if (startSeconds > 0.001) {
      segments.push({ sourceStartSeconds: 0, sourceEndSeconds: startSeconds, targetStartSeconds: 0, targetEndSeconds: startSeconds })
      targetCursor = startSeconds
    }
    if (endSeconds < sourceDuration - 0.001) {
      const duration = sourceDuration - endSeconds
      segments.push({ sourceStartSeconds: endSeconds, sourceEndSeconds: sourceDuration, targetStartSeconds: targetCursor, targetEndSeconds: targetCursor + duration })
    }
    return segments
  }

  judgeFrameBoundary(outputFrame, matchFrames, altFrames) {
    const candidates = (Array.isArray(matchFrames) ? matchFrames : [matchFrames]).filter(Boolean)
    const dMatch = Math.min(...candidates.map((frame) => meanAbsDiff(outputFrame, frame)))
    const altDiffs = (altFrames || []).filter(Boolean).map((frame) => meanAbsDiff(outputFrame, frame))
    const bestAlt = altDiffs.length ? Math.min(...altDiffs) : null
    const margin = bestAlt == null ? null : Number((bestAlt - dMatch).toFixed(3))
    if (dMatch < 0.5 && altDiffs.some((d) => d < 0.5)) return { verdict: 'inconclusive', matchDiff: Number(dMatch.toFixed(3)), margin }
    if (dMatch <= 1.5 && (margin == null || margin > 0.3)) return { verdict: 'matched', matchDiff: Number(dMatch.toFixed(3)), margin }
    return { verdict: 'mismatch', matchDiff: Number(dMatch.toFixed(3)), margin }
  }

  async audioProofForMusic({ source, audio, output, sourceDuration, hasSourceAudio, decision, signal }) {
    const proofBase = {
      schemaVersion: 1,
      method: 'decoded-pcm-s16le-v1',
      sampleRateHz: 16000,
      ducking: {
        requested: decision.audio?.duck !== false,
        configured: Boolean(hasSourceAudio && decision.audio?.duck !== false),
        claim: 'configuration-only'
      }
    }
    if (typeof this.frames.readPcmWindow !== 'function' || typeof this.frames.probeAudioLevels !== 'function') {
      return { ...proofBase, verdict: 'unavailable', reason: 'audio-reader-missing' }
    }
    const duration = Number(sourceDuration)
    if (!(duration > 0.2)) return { ...proofBase, verdict: 'unavailable', reason: 'audio-duration-too-short' }
    const levels = await this.frames.probeAudioLevels(output, { signal })
    if (!levels || !Number.isFinite(Number(levels.samplePeakDbfs))) {
      return { ...proofBase, verdict: 'unavailable', reason: 'audio-levels-missing' }
    }
    const fadeInValue = Number(decision.audio?.fadeInSeconds)
    const fadeOutValue = Number(decision.audio?.fadeOutSeconds)
    const fadeInSeconds = Math.max(0, Math.min(10, Number.isFinite(fadeInValue) ? fadeInValue : 1))
    const fadeOutSeconds = Math.max(0, Math.min(10, Number.isFinite(fadeOutValue) ? fadeOutValue : 1.5))
    const volume = Math.max(0.01, Math.min(1, Number(decision.audio?.volume) || 0.15))
    const loopMusic = decision.audio?.loop !== false
    const musicDuration = await this.frames.probeDuration(audio, { signal })
    if (!(musicDuration > 0)) return { ...proofBase, verdict: 'unavailable', reason: 'music-duration-missing' }
    const selection = this.musicSelection(decision, musicDuration)
    const musicPlaybackDuration = loopMusic ? duration : Math.min(duration, selection.durationSeconds)
    const edgeDuration = Math.min(0.2, Math.max(0.08, musicPlaybackDuration / 20))
    const innerDuration = Math.min(0.35, Math.max(0.14, musicPlaybackDuration / 16))
    const startAt = Math.min(0.02, Math.max(0, musicPlaybackDuration - edgeDuration))
    const endAt = Math.max(0, musicPlaybackDuration - edgeDuration - 0.02)
    const innerMin = Math.min(musicPlaybackDuration - innerDuration, Math.max(edgeDuration + 0.05, fadeInSeconds + 0.08))
    const innerMax = Math.max(innerMin, Math.min(musicPlaybackDuration - edgeDuration - innerDuration - 0.05, musicPlaybackDuration - fadeOutSeconds - innerDuration - 0.08))
    const innerStarts = []
    if (innerMax > innerMin + 0.03) {
      for (let index = 0; index < 5; index += 1) innerStarts.push(innerMin + ((innerMax - innerMin) * index) / 4)
    } else {
      for (const fraction of [0.2, 0.35, 0.5, 0.65, 0.8]) innerStarts.push(Math.max(edgeDuration, Math.min(musicPlaybackDuration - edgeDuration - innerDuration, musicPlaybackDuration * fraction - innerDuration / 2)))
    }
    const readMeasurement = async (atSeconds, windowSeconds, label) => {
      const outputPcm = await this.frames.readPcmWindow(output, atSeconds, { durationSeconds: windowSeconds, sampleRateHz: proofBase.sampleRateHz, signal })
      if (!outputPcm) return null
      const outputStats = pcmStats(outputPcm)
      if (!hasSourceAudio) {
        return { label, atSeconds: Number(atSeconds.toFixed(3)), durationSeconds: Number(windowSeconds.toFixed(3)), outputRms: outputStats.rms, contributionRms: outputStats.rms, correlation: null, residualRms: outputStats.rms }
      }
      const sourcePcm = await this.frames.readPcmWindow(source, atSeconds, { durationSeconds: windowSeconds, sampleRateHz: proofBase.sampleRateHz, signal })
      const sourceStats = pcmStats(sourcePcm)
      const comparison = comparePcmWindows(sourcePcm, outputPcm, { maxLagSamples: Math.round(proofBase.sampleRateHz * 0.04) })
      if (!comparison) return null
      return {
        label,
        atSeconds: Number(atSeconds.toFixed(3)),
        durationSeconds: Number(windowSeconds.toFixed(3)),
        sourceRms: sourceStats.rms,
        outputRms: outputStats.rms,
        contributionRms: comparison.residualRms,
        correlation: comparison.correlation,
        lagSamples: comparison.lagSamples,
        sourceScale: comparison.sourceScale
      }
    }
    const readMusicEnvelope = async (atSeconds, windowSeconds, label) => {
      const relativeAt = loopMusic ? ((atSeconds % selection.durationSeconds) + selection.durationSeconds) % selection.durationSeconds : atSeconds
      const musicAt = selection.startSeconds + relativeAt
      const musicPcm = relativeAt < selection.durationSeconds && musicAt < selection.endSeconds
        ? await this.frames.readPcmWindow(audio, musicAt, { durationSeconds: windowSeconds, sampleRateHz: proofBase.sampleRateHz, signal })
        : Buffer.alloc(2)
      if (!musicPcm) return null
      const raw = pcmStats(musicPcm)
      const gainAt = (seconds) => {
        const fadeInGain = fadeInSeconds > 0 ? Math.max(0, Math.min(1, seconds / fadeInSeconds)) : 1
        const remaining = musicPlaybackDuration - seconds
        const fadeOutGain = fadeOutSeconds > 0 ? Math.max(0, Math.min(1, remaining / fadeOutSeconds)) : 1
        return fadeInGain * fadeOutGain
      }
      let gainSum = 0
      const gainSamples = 32
      for (let index = 0; index < gainSamples; index += 1) gainSum += gainAt(atSeconds + (windowSeconds * (index + 0.5)) / gainSamples)
      const envelopeGain = gainSum / gainSamples
      return {
        label,
        atSeconds: Number(atSeconds.toFixed(3)),
        durationSeconds: Number(windowSeconds.toFixed(3)),
        musicSourceRms: raw.rms,
        envelopeGain: Number(envelopeGain.toFixed(4)),
        effectiveMusicRms: Number((raw.rms * volume * envelopeGain).toFixed(6))
      }
    }
    const startWindow = await readMeasurement(startAt, edgeDuration, 'fade-in-edge')
    const endWindow = await readMeasurement(endAt, edgeDuration, 'fade-out-edge')
    const innerWindows = []
    const innerMusicWindows = []
    for (const at of [...new Set(innerStarts.map((value) => Number(Math.max(0, value).toFixed(3))))]) {
      const measured = await readMeasurement(at, innerDuration, 'content')
      if (measured) innerWindows.push(measured)
      const musicMeasured = await readMusicEnvelope(at, innerDuration, 'content')
      if (musicMeasured) innerMusicWindows.push(musicMeasured)
    }
    const startMusicWindow = await readMusicEnvelope(startAt, edgeDuration, 'fade-in-edge')
    const endMusicWindow = await readMusicEnvelope(endAt, edgeDuration, 'fade-out-edge')
    if (!startWindow || !endWindow || !innerWindows.length || !startMusicWindow || !endMusicWindow || !innerMusicWindows.length) return { ...proofBase, verdict: 'unavailable', reason: 'pcm-window-missing' }
    const referenceWindow = innerWindows.reduce((best, item) => !best || item.contributionRms > best.contributionRms ? item : best, null)
    const referenceMusicWindow = innerMusicWindows.reduce((best, item) => !best || item.effectiveMusicRms > best.effectiveMusicRms ? item : best, null)
    const changedWindows = innerWindows.filter((item) => {
      const floor = Math.max(0.0008, Number(item.sourceRms || 0) * 0.012)
      return item.contributionRms > floor && (!hasSourceAudio || Number(item.correlation) < 0.9999)
    })
    const fadeVerdict = (edge, musicEdge, seconds) => {
      if (!(seconds > 0)) return { verdict: 'not-requested' }
      const referenceGain = Number(referenceMusicWindow?.envelopeGain || 0)
      const ratio = referenceGain > 0 ? musicEdge.envelopeGain / referenceGain : null
      return {
        verdict: referenceGain > 0 && referenceMusicWindow.musicSourceRms > 0.00001 && musicEdge.envelopeGain <= referenceGain * 0.82 ? 'matched' : 'mismatch',
        basis: 'decoded-music-pcm-plus-executed-filter',
        outputResidualRms: edge.contributionRms,
        musicSourceRms: musicEdge.musicSourceRms,
        effectiveMusicRms: musicEdge.effectiveMusicRms,
        envelopeGain: musicEdge.envelopeGain,
        referenceEnvelopeGain: referenceGain,
        ratio: ratio == null ? null : Number(ratio.toFixed(3))
      }
    }
    const fadeIn = fadeVerdict(startWindow, startMusicWindow, fadeInSeconds)
    const fadeOut = fadeVerdict(endWindow, endMusicWindow, fadeOutSeconds)
    const nonSilent = Number(levels.meanVolumeDbfs) > -75 && Number(levels.samplePeakDbfs) > -60
    const overloadFree = Number(levels.samplePeakDbfs) <= -0.1
    const changed = changedWindows.length > 0
    const fadesMatched = (fadeIn.verdict === 'matched' || fadeIn.verdict === 'not-requested') && (fadeOut.verdict === 'matched' || fadeOut.verdict === 'not-requested')
    return {
      ...proofBase,
      selection: { startSeconds: selection.startSeconds, endSeconds: selection.endSeconds, durationSeconds: selection.durationSeconds },
      loop: loopMusic,
      verdict: nonSilent && overloadFree && changed && fadesMatched ? 'matched' : 'mismatch',
      output: {
        hasAudio: true,
        nonSilent,
        meanVolumeDbfs: Number(levels.meanVolumeDbfs),
        samplePeakDbfs: Number(levels.samplePeakDbfs),
        overloadFree,
        peakClaim: 'decoded-sample-peak'
      },
      change: {
        verdict: changed ? 'changed' : 'unchanged',
        comparedWindows: innerWindows.length,
        changedWindows: changedWindows.length,
        windows: innerWindows
      },
      fades: { verdict: fadesMatched ? 'matched' : 'mismatch', fadeIn, fadeOut, startWindow, endWindow, referenceWindow, referenceMusicWindow }
    }
  }

  assertAudioProofDeliverable(audioProof) {
    if (!audioProof || audioProof.verdict === 'unavailable') throw new Error(`声音质量证明不可用（${audioProof?.reason || 'unknown'}），已拒绝交付`)
    if (audioProof.output?.nonSilent !== true) throw new Error('配乐成果音轨为静音或近似静音，已拒绝交付')
    if (audioProof.change?.verdict !== 'changed') throw new Error('无法证明背景音乐已混入成片，已拒绝交付')
    if (audioProof.output?.overloadFree !== true) throw new Error(`配乐成果样本峰值 ${audioProof.output?.samplePeakDbfs ?? '未知'} dBFS 达到安全上限，已拒绝交付`)
    if (audioProof.fades?.verdict !== 'matched') {
      const fadeIn = audioProof.fades?.fadeIn
      const fadeOut = audioProof.fades?.fadeOut
      throw new Error(`背景音乐淡入淡出窗口与冻结决策不符（淡入比 ${fadeIn?.ratio ?? '未知'}，淡出比 ${fadeOut?.ratio ?? '未知'}），已拒绝交付`)
    }
  }

  musicLoudnessPolicy(decision) {
    const loudness = decision?.audio?.loudness
    if (!loudness || loudness.enabled !== true) return { enabled: false }
    const targetLufs = Number(loudness.targetLufs)
    const targetTruePeakDbtp = Number(loudness.targetTruePeakDbtp)
    const maxTruePeakDbtp = Number(loudness.maxTruePeakDbtp)
    const lra = Number(loudness.lra)
    const toleranceLufs = Number(loudness.toleranceLufs)
    if (!Number.isFinite(targetLufs) || targetLufs < -24 || targetLufs > -10
      || !Number.isFinite(targetTruePeakDbtp) || targetTruePeakDbtp > -1 || targetTruePeakDbtp < -3
      || !Number.isFinite(maxTruePeakDbtp) || maxTruePeakDbtp > -0.5 || maxTruePeakDbtp < targetTruePeakDbtp
      || !Number.isFinite(lra) || lra < 1 || lra > 20
      || !Number.isFinite(toleranceLufs) || toleranceLufs < 0.2 || toleranceLufs > 2) throw new Error('配乐响度策略无效')
    return { enabled: true, targetLufs, targetTruePeakDbtp, maxTruePeakDbtp, lra, toleranceLufs }
  }

  musicSelection(decision, musicDuration) {
    const raw = decision?.audio?.selection
    if (!raw) return { startSeconds: 0, endSeconds: musicDuration, durationSeconds: musicDuration, explicit: false }
    const startSeconds = Number(raw.startSeconds)
    const endSeconds = Number(raw.endSeconds)
    const durationSeconds = Number(raw.durationSeconds)
    if (![startSeconds, endSeconds, durationSeconds].every(Number.isFinite)
      || startSeconds < 0 || endSeconds <= startSeconds
      || Math.abs(durationSeconds - (endSeconds - startSeconds)) > 0.001
      || endSeconds > musicDuration + 0.05) throw new Error(`音乐选段超出文件时长：选择 ${startSeconds}–${endSeconds} 秒，音乐共 ${musicDuration.toFixed(3)} 秒`)
    return { startSeconds, endSeconds, durationSeconds, explicit: true }
  }

  async analyzeMusicMixLoudness({ inputArgs, mixFilter, durationSeconds, policy, signal }) {
    const result = await this.frames.run([
      '-hide_banner', '-nostdin', ...inputArgs,
      '-filter_complex', `${mixFilter};[mix]loudnorm=I=${policy.targetLufs}:TP=${policy.targetTruePeakDbtp}:LRA=${policy.lra}:print_format=json[analysis]`,
      '-map', '[analysis]', '-t', Number(durationSeconds).toFixed(3), '-f', 'null', '-'
    ], { timeoutMs: 60 * 60 * 1000, signal })
    const measurement = parseLoudnormMeasurement(result.stderr)
    if (!measurement) throw new Error('无法读取第一遍 EBU R128 响度测量，已拒绝生成未核对的配乐成果')
    return measurement
  }

  secondPassLoudnormFilter(policy, measurement) {
    return `loudnorm=I=${policy.targetLufs}:TP=${policy.targetTruePeakDbtp}:LRA=${policy.lra}:measured_I=${measurement.input_i}:measured_TP=${measurement.input_tp}:measured_LRA=${measurement.input_lra}:measured_thresh=${measurement.input_thresh}:offset=${measurement.target_offset}:linear=true:print_format=summary`
  }

  async loudnessProofForMusic({ output, decision, signal }) {
    const policy = this.musicLoudnessPolicy(decision)
    const proofBase = { schemaVersion: 1, method: 'ebur128-post-encode-v1', policy }
    if (!policy.enabled) return { ...proofBase, verdict: 'not-requested' }
    if (typeof this.frames.probeLoudness !== 'function') return { ...proofBase, verdict: 'unavailable', reason: 'ebur128-reader-missing' }
    const measured = await this.frames.probeLoudness(output, { signal })
    if (!measured) return { ...proofBase, verdict: 'unavailable', reason: 'ebur128-measurement-missing' }
    const loudnessDelta = Number((measured.integratedLufs - policy.targetLufs).toFixed(2))
    const integratedMatched = Math.abs(loudnessDelta) <= policy.toleranceLufs
    const truePeakMatched = measured.truePeakDbtp <= policy.maxTruePeakDbtp
    return {
      ...proofBase,
      verdict: integratedMatched && truePeakMatched ? 'matched' : 'mismatch',
      integratedLufs: measured.integratedLufs,
      truePeakDbtp: measured.truePeakDbtp,
      loudnessDelta,
      integratedMatched,
      truePeakMatched,
      claims: { integrated: 'EBU-R128-integrated-loudness', peak: 'EBU-R128-true-peak' }
    }
  }

  assertLoudnessProofDeliverable(loudnessProof) {
    if (loudnessProof?.verdict === 'not-requested') return
    if (!loudnessProof || loudnessProof.verdict === 'unavailable') throw new Error(`配乐响度证明不可用（${loudnessProof?.reason || 'unknown'}），已拒绝交付`)
    if (loudnessProof.verdict !== 'matched') {
      throw new Error(`配乐响度未达标：目标 ${loudnessProof.policy?.targetLufs} LUFS / 最大 ${loudnessProof.policy?.maxTruePeakDbtp} dBTP，实测 ${loudnessProof.integratedLufs} LUFS / ${loudnessProof.truePeakDbtp} dBTP`)
    }
  }

  // 配乐：用户本地/合法音乐 + 音量 + 淡入淡出 + 对白闪避（sidechain）；音乐短于视频自动循环。
  // 红线：不下载任何音乐；原视频不动；成果时长必须等于源视频时长。
  async addMusic({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.add-music') throw new Error('配乐决策无效')
    if (path.resolve(String(decision.source?.path || '')) !== source) throw new Error('配乐决策与源文件不一致')
    if (source === output) throw new Error('禁止覆盖源视频')
    if (!VIDEO_EXTENSIONS.has(path.extname(source).toLowerCase())) throw new Error('当前文件不是受支持的视频格式')
    const audio = path.resolve(String(decision.audio?.path || ''))
    if (!AUDIO_EXTENSIONS.has(path.extname(audio).toLowerCase())) throw new Error('音乐文件格式不受支持（mp3/wav/m4a/aac/flac/ogg/wma）')
    if (!this.fs.existsSync(source) || !this.fs.statSync(source).isFile()) throw new Error('源视频不存在')
    if (!this.fs.existsSync(audio) || !this.fs.statSync(audio).isFile()) throw new Error(`音乐文件不存在：${audio}；请提供你已有的合法音乐文件`)
    if (this.fs.existsSync(output)) throw new Error('成果文件已存在，为避免覆盖已停止')
    if (!this.frames.availability().available) throw new Error('缺少 ffmpeg 组件')
    if (typeof this.frames.probeHasAudio !== 'function') throw new Error('无法确认源视频音轨')

    const volume = Math.max(0.01, Math.min(1, Number(decision.audio?.volume) || 0.15))
    const fadeInValue = Number(decision.audio?.fadeInSeconds)
    const fadeOutValue = Number(decision.audio?.fadeOutSeconds)
    const fadeIn = Math.max(0, Math.min(10, Number.isFinite(fadeInValue) ? fadeInValue : 1))
    const fadeOut = Math.max(0, Math.min(10, Number.isFinite(fadeOutValue) ? fadeOutValue : 1.5))
    const duck = decision.audio?.duck !== false
    const sourceDuration = await this.frames.probeDuration(source, { signal })
    if (!(sourceDuration > 0)) throw new Error('无法读取源视频时长')
    const musicSourceDuration = await this.frames.probeDuration(audio, { signal })
    if (!(musicSourceDuration > 0)) throw new Error('无法读取音乐文件时长')
    const selection = this.musicSelection(decision, musicSourceDuration)
    const loop = decision.audio?.loop !== false
    const musicPlaybackDuration = loop ? sourceDuration : Math.min(sourceDuration, selection.durationSeconds)
    const dur = sourceDuration.toFixed(3)
    const fadeOutStart = Math.max(0, musicPlaybackDuration - fadeOut).toFixed(3)
    const hasAudio = await this.frames.probeHasAudio(source, { signal })
    const loudnessPolicy = this.musicLoudnessPolicy(decision)

    const sourceBefore = this.fs.statSync(source)
    const musicBefore = this.fs.statSync(audio)
    const parsed = path.parse(output)
    const tempPath = path.join(parsed.dir, `.${parsed.name}.agentplay-edit-${process.pid}-${Date.now()}${parsed.ext || '.mp4'}`)
    const selectedAudioPath = selection.explicit ? path.join(parsed.dir, `.${parsed.name}.agentplay-music-${process.pid}-${Date.now()}.wav`) : ''
    try {
      let playbackAudio = audio
      if (selection.explicit) {
        await this.frames.run([
          '-hide_banner', '-nostdin', '-i', audio,
          '-ss', selection.startSeconds.toFixed(3), '-t', selection.durationSeconds.toFixed(3),
          '-vn', '-ar', '48000', '-c:a', 'pcm_s16le', '-y', selectedAudioPath
        ], { timeoutMs: 30 * 60 * 1000, signal })
        const selectedDuration = await this.frames.probeDuration(selectedAudioPath, { signal })
        if (!(selectedDuration > 0) || Math.abs(selectedDuration - selection.durationSeconds) > 0.05) throw new Error('音乐选段写出时长与冻结决策不一致')
        playbackAudio = selectedAudioPath
      }
      // 有原声：原声为 key 做 sidechain 闪避；无原声：纯视频+音乐；不循环且提前结束时补有限静音到成片全长。
      const musicChain = `[1:a]volume=${volume.toFixed(3)},afade=t=in:st=0:d=${fadeIn.toFixed(3)},afade=t=out:st=${fadeOutStart}:d=${fadeOut.toFixed(3)}`
      const mixFilter = hasAudio
        ? (duck
          ? `[0:a]volume=1.0,asplit=2[voice][key];${musicChain}[mu];[mu][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=500[ducked];[voice][ducked]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[mix]`
          : `[0:a]volume=1.0[voice];${musicChain}[mu];[voice][mu]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[mix]`)
        : loop
          ? `${musicChain}[mix]`
          : `${musicChain},apad=pad_dur=${dur},atrim=duration=${dur}[mix]`
      const inputArgs = ['-i', source, ...(loop ? ['-stream_loop', '-1'] : []), '-i', playbackAudio]
      const loudnessMeasurement = loudnessPolicy.enabled
        ? await this.analyzeMusicMixLoudness({ inputArgs, mixFilter, durationSeconds: sourceDuration, policy: loudnessPolicy, signal })
        : null
      const finishingFilter = loudnessMeasurement
        ? `${this.secondPassLoudnormFilter(loudnessPolicy, loudnessMeasurement)},alimiter=limit=0.850:level=0`
        : 'alimiter=limit=0.850:level=0'
      const filter = `${mixFilter};[mix]${finishingFilter}[aout]`
      await this.frames.run([
        '-hide_banner', '-nostdin',
        ...inputArgs,
        '-filter_complex', filter,
        '-map', '0:v:0', '-map', '[aout]', '-t', dur,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-c:a', 'aac', '-b:a', '160k',
        '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-y', tempPath
      ], { timeoutMs: 60 * 60 * 1000, signal })
      if (signal?.aborted) throw new Error('已取消')
      const sourceAfter = this.fs.statSync(source)
      if (sourceBefore.size !== sourceAfter.size || Math.trunc(sourceBefore.mtimeMs) !== Math.trunc(sourceAfter.mtimeMs)) throw new Error('配乐期间源视频发生变化，已拒绝交付')
      this.assertSourceUnchanged(musicBefore, audio, '配乐期间音乐文件发生变化，已拒绝交付')
      if (!this.fs.existsSync(tempPath) || this.fs.statSync(tempPath).size <= 1024) throw new Error('配乐成果为空或不完整')
      const actualDuration = await this.frames.probeDuration(tempPath, { signal })
      const tolerance = Math.max(0.05, Number(decision.verification?.toleranceSeconds) || 0.2)
      if (!(actualDuration > 0) || Math.abs(actualDuration - sourceDuration) > tolerance) {
        throw new Error(`配乐成果时长校验失败：期望 ${sourceDuration.toFixed(3)} 秒，实际 ${Number(actualDuration || 0).toFixed(3)} 秒`)
      }
      if (typeof this.frames.probeHasAudio === 'function' && !(await this.frames.probeHasAudio(tempPath, { signal }))) {
        throw new Error('配乐成果没有音轨，已拒绝交付')
      }
      const loudnessProof = await this.loudnessProofForMusic({ output: tempPath, decision, signal })
      this.assertLoudnessProofDeliverable(loudnessProof)
      const audioProof = await this.audioProofForMusic({ source, audio, output: tempPath, sourceDuration, hasSourceAudio: hasAudio, decision, signal })
      this.assertAudioProofDeliverable(audioProof)
      const audioExportQc = await this.exportQuality.audit({ sourcePath: source, outputPath: tempPath, decision, externalAudioPaths: [{ path: audio, role: 'music' }], signal })
      this.assertSourceUnchanged(sourceBefore, source)
      this.assertSourceUnchanged(musicBefore, audio, '声音证明期间音乐文件发生变化，已拒绝交付')
      this.fs.renameSync(tempPath, output)
      return this.musicReceipt({ output, decision, sourceDuration, actualDuration, audioProof, loudnessProof, audioExportQc, music: { path: audio, volume, duck, loop, selection, fadeInSeconds: fadeIn, fadeOutSeconds: fadeOut } })
    } catch (error) {
      if (this.fs.existsSync(tempPath)) this.fs.rmSync(tempPath, { force: true })
      throw error
    } finally {
      if (selectedAudioPath && this.fs.existsSync(selectedAudioPath)) this.fs.rmSync(selectedAudioPath, { force: true })
    }
  }

  async removeSegment({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.remove-segment') throw new Error('删除片段决策无效')
    if (path.resolve(String(decision.source?.path || '')) !== source) throw new Error('删除片段决策与源文件不一致')
    if (source === output) throw new Error('禁止覆盖源视频')
    if (!VIDEO_EXTENSIONS.has(path.extname(source).toLowerCase())) throw new Error('当前文件不是受支持的视频格式')
    if (!this.fs.existsSync(source) || !this.fs.statSync(source).isFile()) throw new Error('源视频不存在')
    if (this.fs.existsSync(output)) throw new Error('成果文件已存在，为避免覆盖已停止')
    if (!this.frames.availability().available) throw new Error('缺少 ffmpeg 组件')
    if (typeof this.frames.probeHasAudio !== 'function') throw new Error('无法确认源视频音轨')

    const { startSeconds, endSeconds, removedDurationSeconds } = decision.timeline || {}
    if (![startSeconds, endSeconds, removedDurationSeconds].every(Number.isFinite) || startSeconds < 0 || endSeconds <= startSeconds) throw new Error('删除时间范围无效')
    const sourceDuration = await this.frames.probeDuration(source, { signal })
    if (!(sourceDuration > 0)) throw new Error('无法读取源视频时长')
    if (endSeconds > sourceDuration + 0.05) throw new Error(`结束时间 ${formatTimestamp(endSeconds)} 超出源视频时长 ${formatTimestamp(sourceDuration)}`)
    const expectedDuration = Number((sourceDuration - removedDurationSeconds).toFixed(3))
    if (!(expectedDuration > 0.05)) throw new Error('不能删除整段视频；请至少保留一段内容')
    const hasAudio = await this.frames.probeHasAudio(source, { signal })
    const retained = []
    if (startSeconds > 0.001) retained.push({ start: 0, end: startSeconds })
    if (endSeconds < sourceDuration - 0.001) retained.push({ start: endSeconds, end: null })
    if (!retained.length) throw new Error('不能删除整段视频；请至少保留一段内容')

    const videoParts = retained.map((segment, index) => `[0:v:0]trim=start=${segment.start.toFixed(3)}${segment.end == null ? '' : `:end=${segment.end.toFixed(3)}`},setpts=PTS-STARTPTS[v${index}]`)
    const audioParts = hasAudio
      ? retained.map((segment, index) => `[0:a:0]atrim=start=${segment.start.toFixed(3)}${segment.end == null ? '' : `:end=${segment.end.toFixed(3)}`},asetpts=PTS-STARTPTS[a${index}]`)
      : []
    const videoJoin = retained.length === 1
      ? `[v0]pad=ceil(iw/2)*2:ceil(ih/2)*2[vout]`
      : `${retained.map((_, index) => `[v${index}]`).join('')}concat=n=${retained.length}:v=1:a=0,pad=ceil(iw/2)*2:ceil(ih/2)*2[vout]`
    const audioJoin = hasAudio
      ? (retained.length === 1 ? '[a0]anull[aout]' : `${retained.map((_, index) => `[a${index}]`).join('')}concat=n=${retained.length}:v=0:a=1[aout]`)
      : ''
    const filter = [...videoParts, ...audioParts, videoJoin, audioJoin].filter(Boolean).join(';')
    const sourceBefore = this.fs.statSync(source)
    const parsed = path.parse(output)
    const tempPath = path.join(parsed.dir, `.${parsed.name}.agentplay-edit-${process.pid}-${Date.now()}${parsed.ext || '.mp4'}`)
    try {
      await this.frames.run([
        '-hide_banner', '-nostdin', '-i', source,
        '-filter_complex', filter,
        '-map', '[vout]', ...(hasAudio ? ['-map', '[aout]'] : ['-an']),
        '-map_metadata', '0', '-map_chapters', '-1',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : []),
        '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-y', tempPath
      ], { timeoutMs: 60 * 60 * 1000, signal })
      if (signal?.aborted) throw new Error('已取消')
      this.assertSourceUnchanged(sourceBefore, source)
      if (!this.fs.existsSync(tempPath) || this.fs.statSync(tempPath).size <= 1024) throw new Error('删除片段后的成果为空或不完整')
      const actualDuration = await this.frames.probeDuration(tempPath, { signal })
      const tolerance = Math.max(0.05, Number(decision.verification?.toleranceSeconds) || 0.2)
      if (!(actualDuration > 0) || Math.abs(actualDuration - expectedDuration) > tolerance) {
        throw new Error(`删除片段后的时长校验失败：期望 ${expectedDuration.toFixed(3)} 秒，实际 ${Number(actualDuration || 0).toFixed(3)} 秒`)
      }
      const proofSegments = this.removeProofSegments(decision, sourceDuration)
      const frameProof = await this.frameProofForSegments({ source, output: tempPath, segments: proofSegments, sourceDuration, signal })
      this.assertFrameProofDeliverable(frameProof)
      this.assertSourceUnchanged(sourceBefore, source)
      this.fs.renameSync(tempPath, output)
      return this.removeReceipt({ source, output, decision, sourceDuration, expectedDuration, actualDuration, frameProof })
    } catch (error) {
      if (this.fs.existsSync(tempPath)) this.fs.rmSync(tempPath, { force: true })
      throw error
    }
  }

  async concatSegments({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.concat-segments') throw new Error('拼接片段决策无效')
    if (path.resolve(String(decision.source?.path || '')) !== source) throw new Error('拼接片段决策与源文件不一致')
    if (source === output) throw new Error('禁止覆盖源视频')
    if (!VIDEO_EXTENSIONS.has(path.extname(source).toLowerCase())) throw new Error('当前文件不是受支持的视频格式')
    if (!this.fs.existsSync(source) || !this.fs.statSync(source).isFile()) throw new Error('源视频不存在')
    if (this.fs.existsSync(output)) throw new Error('成果文件已存在，为避免覆盖已停止')
    if (!this.frames.availability().available) throw new Error('缺少 ffmpeg 组件')
    if (typeof this.frames.probeHasAudio !== 'function') throw new Error('无法确认源视频音轨')

    const { segments, expectedDuration } = validateConcatTimeline(decision)
    const sourceDuration = await this.frames.probeDuration(source, { signal })
    if (!(sourceDuration > 0)) throw new Error('无法读取源视频时长')
    assertSegmentsWithinSource(segments, sourceDuration)
    const hasAudio = await this.frames.probeHasAudio(source, { signal })
    const videoParts = segments.map((segment, index) => `[0:v:0]trim=start=${Number(segment.sourceStartSeconds).toFixed(3)}:end=${Number(segment.sourceEndSeconds).toFixed(3)},setpts=PTS-STARTPTS[v${index}]`)
    const audioParts = hasAudio
      ? segments.map((segment, index) => `[0:a:0]atrim=start=${Number(segment.sourceStartSeconds).toFixed(3)}:end=${Number(segment.sourceEndSeconds).toFixed(3)},asetpts=PTS-STARTPTS[a${index}]`)
      : []
    const videoJoin = `${segments.map((_, index) => `[v${index}]`).join('')}concat=n=${segments.length}:v=1:a=0,pad=ceil(iw/2)*2:ceil(ih/2)*2[vout]`
    const audioJoin = hasAudio ? `${segments.map((_, index) => `[a${index}]`).join('')}concat=n=${segments.length}:v=0:a=1[aout]` : ''
    const filter = [...videoParts, ...audioParts, videoJoin, audioJoin].filter(Boolean).join(';')
    const sourceBefore = this.fs.statSync(source)
    const parsed = path.parse(output)
    const tempPath = path.join(parsed.dir, `.${parsed.name}.agentplay-edit-${process.pid}-${Date.now()}${parsed.ext || '.mp4'}`)
    try {
      await this.frames.run([
        '-hide_banner', '-nostdin', '-i', source,
        '-filter_complex', filter,
        '-map', '[vout]', ...(hasAudio ? ['-map', '[aout]'] : ['-an']),
        '-map_metadata', '0', '-map_chapters', '-1',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : []),
        '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-y', tempPath
      ], { timeoutMs: 60 * 60 * 1000, signal })
      if (signal?.aborted) throw new Error('已取消')
      this.assertSourceUnchanged(sourceBefore, source)
      if (!this.fs.existsSync(tempPath) || this.fs.statSync(tempPath).size <= 1024) throw new Error('拼接片段后的成果为空或不完整')
      const actualDuration = await this.frames.probeDuration(tempPath, { signal })
      const tolerance = Math.max(0.05, Number(decision.verification?.toleranceSeconds) || 0.2)
      if (!(actualDuration > 0) || Math.abs(actualDuration - expectedDuration) > tolerance) {
        throw new Error(`拼接片段后的时长校验失败：期望 ${expectedDuration.toFixed(3)} 秒，实际 ${Number(actualDuration || 0).toFixed(3)} 秒`)
      }
      const frameProof = await this.frameProofForSegments({ source, output: tempPath, segments, sourceDuration, signal })
      this.assertFrameProofDeliverable(frameProof)
      this.assertSourceUnchanged(sourceBefore, source)
      this.fs.renameSync(tempPath, output)
      return this.concatReceipt({ output, decision, sourceDuration, expectedDuration, actualDuration, frameProof })
    } catch (error) {
      if (this.fs.existsSync(tempPath)) this.fs.rmSync(tempPath, { force: true })
      throw error
    }
  }

  // 跨素材拼接：当前视频 + 用户指定的其它本地视频，按给定顺序拼成一个新视频。
  // 红线：所有原文件都不动；统一等比缩放+黑边居中到第一个素材的分辨率；无音轨的素材补等长静音。
  async concatSources({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.concat-sources') throw new Error('跨素材拼接决策无效')
    const sources = (Array.isArray(decision.sources) ? decision.sources : []).map((item) => path.resolve(String(item?.path || '')))
    if (sources.length < 2 || sources.length > 20) throw new Error('跨素材拼接需要 2 到 20 个素材')
    if (sources[0] !== source) throw new Error('跨素材拼接决策与源视频不一致')
    if (new Set(sources.map((item) => item.toLowerCase())).size !== sources.length) throw new Error('拼接素材列表里有重复文件')
    if (sources.some((item) => item === output)) throw new Error('禁止覆盖源视频')
    for (const item of sources) {
      if (!VIDEO_EXTENSIONS.has(path.extname(item).toLowerCase())) throw new Error(`不是受支持的视频格式：${path.basename(item)}`)
      if (!this.fs.existsSync(item) || !this.fs.statSync(item).isFile()) throw new Error(`拼接素材不存在：${path.basename(item)}`)
    }
    if (this.fs.existsSync(output)) throw new Error('成果文件已存在，为避免覆盖已停止')
    if (!this.frames.availability().available) throw new Error('缺少 ffmpeg 组件')
    if (typeof this.frames.probeHasAudio !== 'function') throw new Error('无法确认素材音轨')
    if (typeof this.frames.probeDimensions !== 'function') throw new Error('无法确认素材分辨率')

    const probes = []
    for (const item of sources) {
      const duration = await this.frames.probeDuration(item, { signal })
      if (!(duration > 0)) throw new Error(`无法读取素材时长：${path.basename(item)}`)
      const hasAudio = await this.frames.probeHasAudio(item, { signal })
      const dimensions = await this.frames.probeDimensions(item, { signal })
      if (!(Number(dimensions?.width) > 0) || !(Number(dimensions?.height) > 0)) throw new Error(`无法读取素材分辨率：${path.basename(item)}`)
      probes.push({ duration, hasAudio, width: Number(dimensions.width), height: Number(dimensions.height) })
    }
    const expectedDuration = Number(probes.reduce((sum, item) => sum + item.duration, 0).toFixed(3))
    const targetWidth = Math.ceil(probes[0].width / 2) * 2
    const targetHeight = Math.ceil(probes[0].height / 2) * 2

    const videoParts = sources.map((_, index) => `[${index}:v:0]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}]`)
    const audioParts = sources.map((_, index) => probes[index].hasAudio
      ? `[${index}:a:0]aformat=sample_rates=48000:channel_layouts=stereo[a${index}]`
      : `anullsrc=r=48000:cl=stereo:d=${probes[index].duration.toFixed(3)}[a${index}]`)
    const join = `${sources.map((_, index) => `[v${index}][a${index}]`).join('')}concat=n=${sources.length}:v=1:a=1[vout][aout]`
    const filter = [...videoParts, ...audioParts, join].join(';')
    const sourcesBefore = sources.map((item) => this.fs.statSync(item))
    const parsed = path.parse(output)
    const tempPath = path.join(parsed.dir, `.${parsed.name}.agentplay-edit-${process.pid}-${Date.now()}${parsed.ext || '.mp4'}`)
    try {
      await this.frames.run([
        '-hide_banner', '-nostdin',
        ...sources.flatMap((item) => ['-i', item]),
        '-filter_complex', filter,
        '-map', '[vout]', '-map', '[aout]',
        '-map_chapters', '-1',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'aac', '-b:a', '160k',
        '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-y', tempPath
      ], { timeoutMs: 60 * 60 * 1000, signal })
      if (signal?.aborted) throw new Error('已取消')
      sources.forEach((item, index) => {
        const after = this.fs.statSync(item)
        if (sourcesBefore[index].size !== after.size || Math.trunc(sourcesBefore[index].mtimeMs) !== Math.trunc(after.mtimeMs)) throw new Error(`拼接期间素材发生变化，已拒绝交付：${path.basename(item)}`)
      })
      if (!this.fs.existsSync(tempPath) || this.fs.statSync(tempPath).size <= 1024) throw new Error('跨素材拼接成果为空或不完整')
      const actualDuration = await this.frames.probeDuration(tempPath, { signal })
      const tolerance = Math.max(0.05, Number(decision.verification?.toleranceSeconds) || 0.25)
      if (!(actualDuration > 0) || Math.abs(actualDuration - expectedDuration) > tolerance) {
        throw new Error(`跨素材拼接时长校验失败：期望 ${expectedDuration.toFixed(3)} 秒，实际 ${Number(actualDuration || 0).toFixed(3)} 秒`)
      }
      const frameProof = await this.frameProofForSources({ sources, output: tempPath, probes, signal })
      this.assertFrameProofDeliverable(frameProof)
      sources.forEach((item, index) => {
        const after = this.fs.statSync(item)
        if (sourcesBefore[index].size !== after.size || Math.trunc(sourcesBefore[index].mtimeMs) !== Math.trunc(after.mtimeMs)) throw new Error(`拼接期间素材发生变化，已拒绝交付：${path.basename(item)}`)
      })
      this.fs.renameSync(tempPath, output)
      return this.concatSourcesReceipt({ output, decision, probes, expectedDuration, actualDuration, frameProof })
    } catch (error) {
      if (this.fs.existsSync(tempPath)) this.fs.rmSync(tempPath, { force: true })
      throw error
    }
  }

  // 硬字幕烧录：用户本地 .srt/.vtt/.ass/.ssa 逐条烧进画面。
  // 红线：源视频与字幕文件都不动；成果时长必须等于源视频时长；字幕文件超 20MB 拒绝（对齐派生字幕安全上限）。
  async burnSubtitles({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.burn-subtitles') throw new Error('烧录字幕决策无效')
    if (path.resolve(String(decision.source?.path || '')) !== source) throw new Error('烧录字幕决策与源文件不一致')
    if (source === output) throw new Error('禁止覆盖源视频')
    if (!VIDEO_EXTENSIONS.has(path.extname(source).toLowerCase())) throw new Error('当前文件不是受支持的视频格式')
    const subtitle = path.resolve(String(decision.subtitle?.path || ''))
    if (!SUBTITLE_EXTENSIONS.has(path.extname(subtitle).toLowerCase())) throw new Error('字幕文件格式不受支持（srt/vtt/ass/ssa）')
    if (!this.fs.existsSync(source) || !this.fs.statSync(source).isFile()) throw new Error('源视频不存在')
    if (!this.fs.existsSync(subtitle) || !this.fs.statSync(subtitle).isFile()) throw new Error(`字幕文件不存在：${subtitle}；请提供你已有的字幕文件`)
    if (this.fs.statSync(subtitle).size <= 0) throw new Error('字幕文件为空')
    if (this.fs.statSync(subtitle).size > 20 * 1024 * 1024) throw new Error('字幕文件超过 20MB 安全上限')
    if (this.fs.existsSync(output)) throw new Error('成果文件已存在，为避免覆盖已停止')
    if (!this.frames.availability().available) throw new Error('缺少 ffmpeg 组件')

    const sourceDuration = await this.frames.probeDuration(source, { signal })
    if (!(sourceDuration > 0)) throw new Error('无法读取源视频时长')
    const parsed = path.parse(output)
    const generatedAssPath = path.join(parsed.dir, `.${parsed.name}.agentplay-professional-subtitle-${process.pid}-${Date.now()}.ass`)
    let subtitleToBurn = subtitle
    let professionalSubtitle = null
    if (decision.subtitle?.professional?.enabled) {
      if (!this.professionalSubtitleService) throw new Error('专业动态字幕所需逐词转写服务不可用')
      professionalSubtitle = await this.professionalSubtitleService.prepare({ sourcePath: source, subtitlePath: subtitle, outputAssPath: generatedAssPath, decision, signal })
      subtitleToBurn = generatedAssPath
    }
    // ffmpeg filter 参数转义：统一正斜杠、盘符冒号加反斜杠、单引号加倍转义；中文路径原样可行
    const escapedSubtitle = subtitleToBurn.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''")
    const forceStyle = burnForceStyle(decision.subtitle?.style)
    const subtitleFilter = `subtitles='${escapedSubtitle}'${forceStyle && !professionalSubtitle ? `:force_style='${forceStyle}'` : ''}`
    const parityFrozen = await this.subtitlePreviewBurnParityService.freeze({ subtitlePath: subtitleToBurn, renderFilter: subtitleFilter })
    const sourceBefore = this.fs.statSync(source)
    const subtitleBefore = this.fs.statSync(subtitle)
    const tempPath = path.join(parsed.dir, `.${parsed.name}.agentplay-edit-${process.pid}-${Date.now()}${parsed.ext || '.mp4'}`)
    let renamedOutput = false
    try {
      await this.frames.run([
        '-hide_banner', '-nostdin', '-i', source,
        '-vf', `${subtitleFilter},pad=ceil(iw/2)*2:ceil(ih/2)*2`,
        '-map', '0:v:0', '-map', '0:a?', '-map_metadata', '0', '-map_chapters', '0',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k',
        '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-y', tempPath
      ], { timeoutMs: 60 * 60 * 1000, signal })
      if (signal?.aborted) throw new Error('已取消')
      const sourceAfter = this.fs.statSync(source)
      if (sourceBefore.size !== sourceAfter.size || Math.trunc(sourceBefore.mtimeMs) !== Math.trunc(sourceAfter.mtimeMs)) throw new Error('烧录期间源视频发生变化，已拒绝交付')
      const subtitleAfter = this.fs.statSync(subtitle)
      if (subtitleBefore.size !== subtitleAfter.size || Math.trunc(subtitleBefore.mtimeMs) !== Math.trunc(subtitleAfter.mtimeMs)) throw new Error('烧录期间字幕文件发生变化，已拒绝交付')
      if (!this.fs.existsSync(tempPath) || this.fs.statSync(tempPath).size <= 1024) throw new Error('烧录成果为空或不完整')
      const actualDuration = await this.frames.probeDuration(tempPath, { signal })
      const tolerance = Math.max(0.05, Number(decision.verification?.toleranceSeconds) || 0.2)
      if (!(actualDuration > 0) || Math.abs(actualDuration - sourceDuration) > tolerance) {
        throw new Error(`烧录成果时长校验失败：期望 ${sourceDuration.toFixed(3)} 秒，实际 ${Number(actualDuration || 0).toFixed(3)} 秒`)
      }
      const professionalSubtitleProof = professionalSubtitle
        ? await this.professionalSubtitleService.verifyRender({ sourcePath: source, outputPath: tempPath, plan: professionalSubtitle, signal })
        : null
      this.fs.renameSync(tempPath, output)
      renamedOutput = true
      const subtitlePreviewBurnProof = await this.subtitlePreviewBurnParityService.finalize({ subtitlePath: subtitleToBurn, outputPath: output, renderFilter: subtitleFilter, frozen: parityFrozen })
      return this.burnSubtitlesReceipt({ output, decision, sourceDuration, actualDuration, professionalSubtitle, professionalSubtitleProof, subtitlePreviewBurnProof })
    } catch (error) {
      if (this.fs.existsSync(tempPath)) this.fs.rmSync(tempPath, { force: true })
      if (renamedOutput && this.fs.existsSync(output)) this.fs.rmSync(output, { force: true })
      throw error
    } finally { if (this.fs.existsSync(generatedAssPath)) this.fs.rmSync(generatedAssPath, { force: true }) }
  }

  // 软字幕封装：字幕作为可开关的独立轨道封进 mp4（mov_text）；音画流直接 copy 不重编码，秒级完成。
  // 红线：源视频与字幕文件都不动；成果时长=源视频时长；成果必须真实带字幕流。
  async muxSubtitles({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.mux-subtitles') throw new Error('软字幕封装决策无效')
    if (path.resolve(String(decision.source?.path || '')) !== source) throw new Error('软字幕封装决策与源文件不一致')
    if (source === output) throw new Error('禁止覆盖源视频')
    if (!VIDEO_EXTENSIONS.has(path.extname(source).toLowerCase())) throw new Error('当前文件不是受支持的视频格式')
    const subtitle = path.resolve(String(decision.subtitle?.path || ''))
    if (!SUBTITLE_EXTENSIONS.has(path.extname(subtitle).toLowerCase())) throw new Error('字幕文件格式不受支持（srt/vtt/ass/ssa）')
    if (!this.fs.existsSync(source) || !this.fs.statSync(source).isFile()) throw new Error('源视频不存在')
    if (!this.fs.existsSync(subtitle) || !this.fs.statSync(subtitle).isFile()) throw new Error(`字幕文件不存在：${subtitle}；请提供你已有的字幕文件`)
    if (this.fs.statSync(subtitle).size <= 0) throw new Error('字幕文件为空')
    if (this.fs.statSync(subtitle).size > 20 * 1024 * 1024) throw new Error('字幕文件超过 20MB 安全上限')
    if (this.fs.existsSync(output)) throw new Error('成果文件已存在，为避免覆盖已停止')
    if (!this.frames.availability().available) throw new Error('缺少 ffmpeg 组件')
    if (typeof this.frames.probeHasSubtitle !== 'function') throw new Error('无法确认成果字幕轨')

    const sourceDuration = await this.frames.probeDuration(source, { signal })
    if (!(sourceDuration > 0)) throw new Error('无法读取源视频时长')
    const sourceBefore = this.fs.statSync(source)
    const subtitleBefore = this.fs.statSync(subtitle)
    const parsed = path.parse(output)
    const tempPath = path.join(parsed.dir, `.${parsed.name}.agentplay-edit-${process.pid}-${Date.now()}${parsed.ext || '.mp4'}`)
    try {
      await this.frames.run([
        '-hide_banner', '-nostdin', '-i', source, '-i', subtitle,
        '-map', '0', '-map', '1',
        '-map_metadata', '0', '-map_chapters', '0',
        '-c', 'copy', '-c:s', 'mov_text',
        '-movflags', '+faststart', '-y', tempPath
      ], { timeoutMs: 60 * 60 * 1000, signal })
      if (signal?.aborted) throw new Error('已取消')
      const sourceAfter = this.fs.statSync(source)
      if (sourceBefore.size !== sourceAfter.size || Math.trunc(sourceBefore.mtimeMs) !== Math.trunc(sourceAfter.mtimeMs)) throw new Error('封装期间源视频发生变化，已拒绝交付')
      const subtitleAfter = this.fs.statSync(subtitle)
      if (subtitleBefore.size !== subtitleAfter.size || Math.trunc(subtitleBefore.mtimeMs) !== Math.trunc(subtitleAfter.mtimeMs)) throw new Error('封装期间字幕文件发生变化，已拒绝交付')
      if (!this.fs.existsSync(tempPath) || this.fs.statSync(tempPath).size <= 1024) throw new Error('封装成果为空或不完整')
      const actualDuration = await this.frames.probeDuration(tempPath, { signal })
      const tolerance = Math.max(0.05, Number(decision.verification?.toleranceSeconds) || 0.2)
      if (!(actualDuration > 0) || Math.abs(actualDuration - sourceDuration) > tolerance) {
        throw new Error(`封装成果时长校验失败：期望 ${sourceDuration.toFixed(3)} 秒，实际 ${Number(actualDuration || 0).toFixed(3)} 秒`)
      }
      if (!(await this.frames.probeHasSubtitle(tempPath, { signal }))) throw new Error('封装成果没有字幕轨，已拒绝交付')
      this.fs.renameSync(tempPath, output)
      return this.muxSubtitlesReceipt({ output, decision, sourceDuration, actualDuration })
    } catch (error) {
      if (this.fs.existsSync(tempPath)) this.fs.rmSync(tempPath, { force: true })
      throw error
    }
  }

  // 字幕时间移动：用户本地 .srt 整体提前/延后 N 秒，产出全新 UTF-8 srt；视频与源字幕都不动。
  // 语义按字面：提前=时间轴减 N（出现更早），延后=加 N（出现更晚）；完全移到 0 点之前的条目丢弃并计入回执。
  async shiftSubtitles({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.shift-subtitles') throw new Error('字幕调时决策无效')
    if (path.resolve(String(decision.subtitle?.path || '')) !== source) throw new Error('字幕调时决策与字幕文件不一致')
    if (source === output) throw new Error('禁止覆盖源字幕文件')
    const format = subtitleFormatOf(source)
    if (!format) throw new Error('字幕调时目前只支持 .srt/.vtt 文件')
    if (!this.fs.existsSync(source) || !this.fs.statSync(source).isFile()) throw new Error('字幕文件不存在')
    const sourceStat = this.fs.statSync(source)
    if (sourceStat.size <= 0) throw new Error('字幕文件为空')
    if (sourceStat.size > 20 * 1024 * 1024) throw new Error('字幕文件超过 20MB 安全上限')
    if (this.fs.existsSync(output)) throw new Error('成果文件已存在，为避免覆盖已停止')
    const direction = decision.shift?.direction === 'earlier' ? 'earlier' : 'later'
    const offsetSeconds = Number(decision.shift?.offsetSeconds)
    if (!Number.isFinite(offsetSeconds) || offsetSeconds <= 0 || offsetSeconds > 24 * 3600) throw new Error('字幕调时秒数无效')
    if (signal?.aborted) throw new Error('已取消')

    const raw = this.fs.readFileSync(source)
    const text = decodeSubtitleText(raw)
    const cues = parseSubtitleCuesAuto(text, format)
    if (!cues.length) throw new Error(`字幕文件里没有可识别的有效条目（需要标准 ${format} 时间轴）`)
    const deltaMs = Math.round(offsetSeconds * 1000) * (direction === 'earlier' ? -1 : 1)
    const shifted = []
    let droppedCueCount = 0
    for (const cue of cues) {
      const startMs = cue.startMs + deltaMs
      const endMs = cue.endMs + deltaMs
      if (endMs <= 0) { droppedCueCount += 1; continue }
      shifted.push({ startMs: Math.max(0, startMs), endMs, text: cue.text })
    }
    if (!shifted.length) throw new Error(`全部 ${cues.length} 条字幕都会移到 0 点之前，没有可交付的内容；请减小秒数或换个方向`)
    const rendered = renderSubtitleCuesAuto(shifted, format)
    const tempPath = `${output}.agentplay-shift-${process.pid}-${Date.now()}.tmp`
    try {
      this.fs.writeFileSync(tempPath, rendered, 'utf8')
      if (signal?.aborted) throw new Error('已取消')
      const sourceAfter = this.fs.statSync(source)
      if (sourceStat.size !== sourceAfter.size || Math.trunc(sourceStat.mtimeMs) !== Math.trunc(sourceAfter.mtimeMs)) throw new Error('调时期间源字幕文件发生变化，已拒绝交付')
      // 交付前复核：重新解析成果，逐条核对时间与文本
      const reparsed = parseSubtitleCuesAuto(this.fs.readFileSync(tempPath, 'utf8'), format)
      if (reparsed.length !== shifted.length || reparsed.some((cue, index) => cue.startMs !== shifted[index].startMs || cue.endMs !== shifted[index].endMs || cue.text !== shifted[index].text)) {
        throw new Error('调时成果复核失败：写出的字幕与冻结决策不一致')
      }
      this.fs.renameSync(tempPath, output)
      return this.shiftSubtitlesReceipt({ output, decision, sourceCueCount: cues.length, droppedCueCount })
    } catch (error) {
      if (this.fs.existsSync(tempPath)) this.fs.rmSync(tempPath, { force: true })
      throw error
    }
  }

  // 字幕翻译：用户本地 .srt 逐句翻译成目标语言（或双语对照），产出全新 UTF-8 srt；视频与源字幕都不动。
  // 引擎由主进程冻结注入（云端 llmComplete 或本地 OPUS-MT jsonComplete）；任一批次失败即故障关闭，不交付半成品。
  async translateSubtitles({ sourcePath, outputPath, decision, engine, signal, onProgress } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.translate-subtitles') throw new Error('字幕翻译决策无效')
    if (path.resolve(String(decision.subtitle?.path || '')) !== source) throw new Error('字幕翻译决策与字幕文件不一致')
    if (source === output) throw new Error('禁止覆盖源字幕文件')
    if (path.extname(source).toLowerCase() !== '.srt') throw new Error('字幕翻译目前只支持 .srt 文件')
    if (!this.fs.existsSync(source) || !this.fs.statSync(source).isFile()) throw new Error('字幕文件不存在')
    const sourceStat = this.fs.statSync(source)
    if (sourceStat.size <= 0) throw new Error('字幕文件为空')
    if (sourceStat.size > 20 * 1024 * 1024) throw new Error('字幕文件超过 20MB 安全上限')
    if (this.fs.existsSync(output)) throw new Error('成果文件已存在，为避免覆盖已停止')
    if (!engine || typeof engine.complete !== 'function') throw new Error('没有可用的翻译引擎')

    const sourceCues = parseSrtCues(decodeSubtitleText(this.fs.readFileSync(source)))
    if (!sourceCues.length) throw new Error('字幕文件里没有可识别的有效条目（需要标准 srt 时间轴）')
    const entries = sourceCues.map((cue, order) => ({ index: order + 1, start: msToSrtTime(cue.startMs), end: msToSrtTime(cue.endMs), text: cue.text }))
    const mode = decision.translate?.mode === 'bilingual' ? 'bilingual' : 'translated'
    const requestedTarget = String(decision.translate?.targetLang || '')
    const targetLang = requestedTarget === 'auto' || !requestedTarget ? chooseOppositeTarget(entries) : requestedTarget
    if (!['中文', '英文'].includes(targetLang)) throw new Error('字幕翻译目标语言无效')

    const { translations, failed } = await translateEntries(entries, engine.complete, { targetLang, signal, onProgress })
    if (signal?.aborted) throw new Error('已取消')
    if (failed > 0) throw new Error(`${failed} 条字幕未能可靠翻译，已拒绝交付不完整成果；请重试`)
    if (translations.size !== entries.length) throw new Error(`翻译结果数量不一致（${translations.size}/${entries.length}），已拒绝交付`)

    const rendered = mode === 'bilingual' ? buildBilingualSrt(entries, translations) : buildTranslationOnlySrt(entries, translations, { targetLang })
    const tempPath = `${output}.agentplay-translate-${process.pid}-${Date.now()}.tmp`
    try {
      this.fs.writeFileSync(tempPath, rendered, 'utf8')
      if (signal?.aborted) throw new Error('已取消')
      const sourceAfter = this.fs.statSync(source)
      if (sourceStat.size !== sourceAfter.size || Math.trunc(sourceStat.mtimeMs) !== Math.trunc(sourceAfter.mtimeMs)) throw new Error('翻译期间源字幕文件发生变化，已拒绝交付')
      this.assertTranslatedOutput({ tempPath, entries, mode, targetLang })
      this.fs.renameSync(tempPath, output)
      return this.translateSubtitlesReceipt({ output, decision, sourceCueCount: entries.length, targetLang, mode, engineLabel: String(engine.label || '') })
    } catch (error) {
      if (this.fs.existsSync(tempPath)) this.fs.rmSync(tempPath, { force: true })
      throw error
    }
  }

  // 交付闸门：成果必须可解析、条数不低于源条数、每条时间在源范围内、目标语言真实出现
  assertTranslatedOutput({ tempPath, entries, mode, targetLang }) {
    const outputEntries = parseSrt(this.fs.readFileSync(tempPath, 'utf8'))
    if (!outputEntries.length) throw new Error('翻译成果无法解析成有效字幕，已拒绝交付')
    if (outputEntries.length < entries.length) throw new Error(`翻译成果条数不足（${outputEntries.length}/${entries.length}），已拒绝交付`)
    if (mode === 'bilingual') {
      const mismatch = entries.some((entry, index) => outputEntries[index]?.start !== entry.start || outputEntries[index]?.end !== entry.end)
      if (mismatch) throw new Error('双语成果时间轴与源字幕不一致，已拒绝交付')
    }
    const sample = outputEntries.slice(0, 30).map((entry) => entry.text).join('\n')
    const hasTarget = targetLang === '英文' ? /[A-Za-z]/.test(sample) : /[一-鿿]/.test(sample)
    if (!hasTarget) throw new Error(`翻译成果里没有检测到${targetLang}文本，已拒绝交付`)
    return outputEntries.length
  }

  async verifyTranslateSubtitles({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!this.fs.existsSync(output) || this.fs.statSync(output).size <= 0) throw new Error('翻译成果不存在或不完整')
    const sourceCues = parseSrtCues(decodeSubtitleText(this.fs.readFileSync(source)))
    const entries = sourceCues.map((cue, order) => ({ index: order + 1, start: msToSrtTime(cue.startMs), end: msToSrtTime(cue.endMs), text: cue.text }))
    const mode = decision.translate?.mode === 'bilingual' ? 'bilingual' : 'translated'
    const requestedTarget = String(decision.translate?.targetLang || '')
    const targetLang = requestedTarget === 'auto' || !requestedTarget ? chooseOppositeTarget(entries) : requestedTarget
    if (signal?.aborted) throw new Error('已取消')
    this.assertTranslatedOutput({ tempPath: output, entries, mode, targetLang })
    return this.translateSubtitlesReceipt({ output, decision, sourceCueCount: entries.length, targetLang, mode, engineLabel: '' })
  }

  translateSubtitlesReceipt({ output, decision, sourceCueCount, targetLang, mode, engineLabel }) {
    const subtitleName = String(decision.subtitle?.name || path.basename(String(decision.subtitle?.path || '字幕文件')))
    const outputEntries = parseSrt(this.fs.readFileSync(output, 'utf8'))
    return {
      success: true,
      outputPath: output,
      outputs: [output],
      outputBytes: this.fs.statSync(output).size,
      cueCount: outputEntries.length,
      sourceCueCount,
      droppedCueCount: 0,
      targetLang,
      mode,
      engine: engineLabel,
      timelineReceipt: [{
        operation: `字幕翻译（${mode === 'bilingual' ? '双语对照' : `译成${targetLang}`}）`,
        sourceRange: `${sourceCueCount} 条字幕`,
        outputRange: `${outputEntries.length} 条字幕`
      }],
      summary: `已把字幕《${subtitleName}》${sourceCueCount} 条${mode === 'bilingual' ? `翻译成双语对照（译文为${targetLang}）` : `翻译成${targetLang}`}${engineLabel ? `（${engineLabel}）` : ''}，生成全新字幕文件；原字幕文件与视频均未改动`
    }
  }

  // 字幕条目校对/删除：按"第 N 条"改文本或删除区间条目，产出全新 UTF-8 srt；源字幕与视频都不动。
  async editSubtitleCues({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.edit-subtitle-cues') throw new Error('字幕校对决策无效')
    if (path.resolve(String(decision.subtitle?.path || '')) !== source) throw new Error('字幕校对决策与字幕文件不一致')
    if (source === output) throw new Error('禁止覆盖源字幕文件')
    const format = subtitleFormatOf(source)
    if (!format) throw new Error('字幕校对目前只支持 .srt/.vtt 文件')
    if (!this.fs.existsSync(source) || !this.fs.statSync(source).isFile()) throw new Error('字幕文件不存在')
    const sourceStat = this.fs.statSync(source)
    if (sourceStat.size <= 0) throw new Error('字幕文件为空')
    if (sourceStat.size > 20 * 1024 * 1024) throw new Error('字幕文件超过 20MB 安全上限')
    if (this.fs.existsSync(output)) throw new Error('成果文件已存在，为避免覆盖已停止')
    const cueEdit = decision.cueEdit
    if (!cueEdit || !['delete', 'replace'].includes(cueEdit.operation)) throw new Error('字幕校对操作无效')
    if (signal?.aborted) throw new Error('已取消')

    const cues = parseSubtitleCuesAuto(decodeSubtitleText(this.fs.readFileSync(source)), format)
    if (!cues.length) throw new Error(`字幕文件里没有可识别的有效条目（需要标准 ${format} 时间轴）`)
    const applyEdit = (list) => {
      if (cueEdit.operation === 'replace') {
        const index = Number(cueEdit.index)
        const text = String(cueEdit.text || '').trim()
        if (!Number.isInteger(index) || index < 1 || index > list.length) throw new Error(`第 ${index} 条不存在：这份字幕一共 ${list.length} 条`)
        if (!text) throw new Error('校对的新文本不能为空')
        return list.map((cue, order) => order + 1 === index ? { ...cue, text } : cue)
      }
      const startIndex = Number(cueEdit.startIndex)
      const endIndex = Number(cueEdit.endIndex)
      if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex < 1 || endIndex < startIndex || endIndex > list.length) {
        throw new Error(`第 ${Number.isInteger(startIndex) ? startIndex : '?'} 到第 ${Number.isInteger(endIndex) ? endIndex : '?'} 条超出范围：这份字幕一共 ${list.length} 条`)
      }
      const kept = list.filter((_, order) => order + 1 < startIndex || order + 1 > endIndex)
      if (!kept.length) throw new Error('不能删除全部字幕条目；请至少保留一条')
      return kept
    }
    const edited = applyEdit(cues)
    const rendered = renderSubtitleCuesAuto(edited, format)
    const tempPath = `${output}.agentplay-cueedit-${process.pid}-${Date.now()}.tmp`
    try {
      this.fs.writeFileSync(tempPath, rendered, 'utf8')
      if (signal?.aborted) throw new Error('已取消')
      const sourceAfter = this.fs.statSync(source)
      if (sourceStat.size !== sourceAfter.size || Math.trunc(sourceStat.mtimeMs) !== Math.trunc(sourceAfter.mtimeMs)) throw new Error('校对期间源字幕文件发生变化，已拒绝交付')
      const reparsed = parseSubtitleCuesAuto(this.fs.readFileSync(tempPath, 'utf8'), format)
      if (reparsed.length !== edited.length || reparsed.some((cue, index) => cue.startMs !== edited[index].startMs || cue.endMs !== edited[index].endMs || cue.text !== edited[index].text)) {
        throw new Error('校对成果复核失败：写出的字幕与冻结决策不一致')
      }
      this.fs.renameSync(tempPath, output)
      return this.cueEditReceipt({ output, decision, sourceCueCount: cues.length, outputCueCount: edited.length })
    } catch (error) {
      if (this.fs.existsSync(tempPath)) this.fs.rmSync(tempPath, { force: true })
      throw error
    }
  }

  async verifyCueEdit({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!this.fs.existsSync(output) || this.fs.statSync(output).size <= 0) throw new Error('校对成果不存在或不完整')
    const format = subtitleFormatOf(source)
    const cues = parseSubtitleCuesAuto(decodeSubtitleText(this.fs.readFileSync(source)), format)
    const cueEdit = decision.cueEdit
    const expected = cueEdit.operation === 'replace'
      ? cues.map((cue, order) => order + 1 === Number(cueEdit.index) ? { ...cue, text: String(cueEdit.text || '').trim() } : cue)
      : cues.filter((_, order) => order + 1 < Number(cueEdit.startIndex) || order + 1 > Number(cueEdit.endIndex))
    const outputCues = parseSubtitleCuesAuto(this.fs.readFileSync(output, 'utf8'), format)
    if (outputCues.length !== expected.length || outputCues.some((cue, index) => cue.startMs !== expected[index].startMs || cue.endMs !== expected[index].endMs || cue.text !== expected[index].text)) {
      throw new Error('校对成果与冻结决策不一致，已拒绝交付')
    }
    if (signal?.aborted) throw new Error('已取消')
    return this.cueEditReceipt({ output, decision, sourceCueCount: cues.length, outputCueCount: expected.length })
  }

  cueEditReceipt({ output, decision, sourceCueCount, outputCueCount }) {
    const cueEdit = decision.cueEdit
    const subtitleName = String(decision.subtitle?.name || path.basename(String(decision.subtitle?.path || '字幕文件')))
    const operationText = cueEdit.operation === 'replace'
      ? `第 ${cueEdit.index} 条改成《${String(cueEdit.text || '').slice(0, 30)}》`
      : Number(cueEdit.startIndex) === Number(cueEdit.endIndex) ? `删除第 ${cueEdit.startIndex} 条` : `删除第 ${cueEdit.startIndex} 到第 ${cueEdit.endIndex} 条`
    return {
      success: true,
      outputPath: output,
      outputs: [output],
      outputBytes: this.fs.statSync(output).size,
      cueCount: outputCueCount,
      sourceCueCount,
      droppedCueCount: cueEdit.operation === 'delete' ? sourceCueCount - outputCueCount : 0,
      timelineReceipt: [{
        operation: `字幕校对（${operationText}）`,
        sourceRange: `${sourceCueCount} 条字幕`,
        outputRange: `${outputCueCount} 条字幕`
      }],
      summary: `已把字幕《${subtitleName}》${operationText}，其余条目不重排时间轴，共 ${outputCueCount} 条；原字幕文件与视频均未改动`
    }
  }

  async verifyShiftSubtitles({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!this.fs.existsSync(output) || this.fs.statSync(output).size <= 0) throw new Error('调时成果不存在或不完整')
    const format = subtitleFormatOf(source)
    const direction = decision.shift?.direction === 'earlier' ? 'earlier' : 'later'
    const offsetSeconds = Number(decision.shift?.offsetSeconds)
    const deltaMs = Math.round(offsetSeconds * 1000) * (direction === 'earlier' ? -1 : 1)
    const sourceCues = parseSubtitleCuesAuto(decodeSubtitleText(this.fs.readFileSync(source)), format)
    const outputCues = parseSubtitleCuesAuto(this.fs.readFileSync(output, 'utf8'), format)
    const expected = []
    let droppedCueCount = 0
    for (const cue of sourceCues) {
      const startMs = cue.startMs + deltaMs
      const endMs = cue.endMs + deltaMs
      if (endMs <= 0) { droppedCueCount += 1; continue }
      expected.push({ startMs: Math.max(0, startMs), endMs, text: cue.text })
    }
    if (outputCues.length !== expected.length || outputCues.some((cue, index) => cue.startMs !== expected[index].startMs || cue.endMs !== expected[index].endMs || cue.text !== expected[index].text)) {
      throw new Error('调时成果与冻结决策不一致，已拒绝交付')
    }
    if (signal?.aborted) throw new Error('已取消')
    return this.shiftSubtitlesReceipt({ output, decision, sourceCueCount: sourceCues.length, droppedCueCount })
  }

  shiftSubtitlesReceipt({ output, decision, sourceCueCount, droppedCueCount }) {
    const direction = decision.shift?.direction === 'earlier' ? '提前' : '延后'
    const offsetSeconds = Number(decision.shift?.offsetSeconds) || 0
    const cueCount = sourceCueCount - droppedCueCount
    const subtitleName = String(decision.subtitle?.name || path.basename(String(decision.subtitle?.path || '字幕文件')))
    return {
      success: true,
      outputPath: output,
      outputs: [output],
      outputBytes: this.fs.statSync(output).size,
      cueCount,
      sourceCueCount,
      droppedCueCount,
      timelineReceipt: [{
        operation: `字幕时间移动（${direction} ${offsetSeconds.toFixed(3)} 秒）`,
        sourceRange: `${sourceCueCount} 条字幕`,
        outputRange: `${cueCount} 条字幕${droppedCueCount > 0 ? `（${droppedCueCount} 条移出 0 点丢弃）` : ''}`
      }],
      summary: `已把字幕《${subtitleName}》共 ${cueCount} 条整体${direction} ${offsetSeconds.toFixed(3)} 秒（出现更${direction === '提前' ? '早' : '晚'}）${droppedCueCount > 0 ? `，${droppedCueCount} 条完全移出 0 点之前已丢弃` : ''}；原字幕文件与视频均未改动`
    }
  }

  verifySubtitleTransformOutput({ source, output, decision, engineLabel = '', signal } = {}) {
    if (signal?.aborted) throw new Error('已取消')
    const transform = decision?.subtitleTransform
    if (decision?.kind !== 'media.transform-subtitles' || transform?.strategy !== 'ordered-subtitle-transform-v1') throw new Error('批量字幕变换决策无效')
    const sourceCues = parseSrtCues(decodeSubtitleText(this.fs.readFileSync(source)))
    if (!sourceCues.length) throw new Error('源字幕没有有效SRT条目')
    const expectedCues = applyLocalSubtitleTransform(sourceCues, transform)
    const content = this.fs.readFileSync(output, 'utf8'); const styled = transform.style?.preset
    const outputCues = styled ? parseStyledSubtitleAss(content) : parseSrtCues(content)
    if (outputCues.length !== expectedCues.length || outputCues.some((cue, index) => cue.startMs !== expectedCues[index].startMs || cue.endMs !== expectedCues[index].endMs || !String(cue.text || '').trim())) throw new Error('批量字幕成果条数或时间结构与冻结决策不一致')
    const translation = transform.translate
    let targetLang = ''
    let translationMatched = true
    if (translation) {
      const entries = expectedCues.map((cue, index) => ({ index: index + 1, start: msToSrtTime(cue.startMs), end: msToSrtTime(cue.endMs), text: cue.text }))
      targetLang = translation.targetLang === 'auto' ? chooseOppositeTarget(entries) : translation.targetLang
      const sample = outputCues.slice(0, 30).map((cue) => cue.text).join('\n')
      translationMatched = targetLang === '英文' ? /[A-Za-z]/.test(sample) : /[一-鿿]/.test(sample)
      if (translation.mode === 'bilingual') translationMatched = translationMatched && expectedCues.every((cue, index) => outputCues[index].text.includes(cue.text))
      if (!translationMatched) throw new Error(`批量字幕成果没有形成可信${targetLang}译文`)
    } else if (outputCues.some((cue, index) => cue.text !== expectedCues[index].text)) throw new Error('未请求翻译，但批量字幕文本与冻结结构不一致')
    const styleMatched = !styled || (content.includes('[V4+ Styles]') && content.includes(`Style: ${styled === 'impact' ? 'Impact' : styled === 'documentary' ? 'Documentary' : 'Clean'}`) && (content.match(/^Dialogue:/gm) || []).length === expectedCues.length)
    if (!styleMatched) throw new Error('批量字幕样式与冻结预设不一致')
    const operationKinds = Array.isArray(transform.operationKinds) ? transform.operationKinds : []
    if (JSON.stringify(operationKinds) !== JSON.stringify(decision.verification?.expectedOperationKinds || [])) throw new Error('批量字幕操作清单与冻结验证合同不一致')
    const proof = {
      schemaVersion: 1, method: 'subtitle-transform-proof-v1', verdict: 'matched', operationKinds,
      sourceCueCount: sourceCues.length, outputCueCount: outputCues.length,
      replacementsApplied: transform.replacements?.length || 0, mergesApplied: transform.merges?.length || 0, splitsApplied: transform.splits?.length || 0,
      shift: { applied: Boolean(transform.shift), ...(transform.shift || {}) },
      translation: translation ? { targetLang, mode: translation.mode, matched: translationMatched, engine: engineLabel } : { targetLang: '', mode: '', matched: true, engine: '' },
      style: styled ? { preset: styled, matched: styleMatched } : { preset: '', matched: true }, exactStructure: true
    }
    return { sourceCues, expectedCues, outputCues, proof }
  }

  async transformSubtitles({ sourcePath, outputPath, decision, engine, signal, onProgress } = {}) {
    const source = path.resolve(String(sourcePath || '')); const output = path.resolve(String(outputPath || '')); const transform = decision?.subtitleTransform
    if (decision?.kind !== 'media.transform-subtitles' || transform?.strategy !== 'ordered-subtitle-transform-v1' || path.resolve(String(decision.subtitle?.path || '')) !== source) throw new Error('批量字幕变换决策与源字幕不一致')
    if (path.extname(source).toLowerCase() !== '.srt') throw new Error('批量字幕变换目前只支持标准SRT输入')
    if (!this.fs.existsSync(source) || !this.fs.statSync(source).isFile()) throw new Error('字幕文件不存在')
    const sourceStat = this.fs.statSync(source)
    if (sourceStat.size <= 0 || sourceStat.size > 20 * 1024 * 1024) throw new Error('字幕文件为空或超过20MB安全上限')
    if (source === output || this.fs.existsSync(output)) throw new Error(source === output ? '禁止覆盖源字幕文件' : '成果文件已存在，为避免覆盖已停止')
    const sourceCues = parseSrtCues(decodeSubtitleText(this.fs.readFileSync(source))); const localCues = applyLocalSubtitleTransform(sourceCues, transform)
    let finalCues = localCues; let engineLabel = ''
    if (transform.translate) {
      if (!engine || typeof engine.complete !== 'function') throw new Error('批量字幕翻译缺少冻结翻译引擎')
      const entries = localCues.map((cue, index) => ({ index: index + 1, start: msToSrtTime(cue.startMs), end: msToSrtTime(cue.endMs), text: cue.text }))
      const targetLang = transform.translate.targetLang === 'auto' ? chooseOppositeTarget(entries) : transform.translate.targetLang
      const { translations, failed } = await translateEntries(entries, engine.complete, { targetLang, signal, onProgress })
      if (failed > 0 || translations.size !== entries.length) throw new Error(`批量字幕有${failed || entries.length - translations.size}条未可靠翻译，已拒绝半成品`)
      finalCues = localCues.map((cue, index) => ({ ...cue, text: transform.translate.mode === 'bilingual' ? `${cue.text}\n${translations.get(index + 1)}` : String(translations.get(index + 1) || '') }))
      engineLabel = String(engine.label || '')
    }
    const rendered = transform.style ? renderStyledSubtitleAss(finalCues, transform.style.preset) : renderSrtCues(finalCues)
    const tempPath = `${output}.agentplay-transform-${process.pid}-${Date.now()}.tmp`
    try {
      this.fs.writeFileSync(tempPath, rendered, 'utf8')
      const sourceAfter = this.fs.statSync(source)
      if (sourceStat.size !== sourceAfter.size || Math.trunc(sourceStat.mtimeMs) !== Math.trunc(sourceAfter.mtimeMs)) throw new Error('批量字幕处理期间源文件发生变化')
      const verified = this.verifySubtitleTransformOutput({ source, output: tempPath, decision, engineLabel, signal })
      this.fs.renameSync(tempPath, output)
      const proof = verified.proof; const labels = { replace: '改字', merge: '合并', split: '拆分', shift: '调时', translate: '换语言', style: '换风格' }
      return { success: true, outputPath: output, outputs: [output], outputBytes: this.fs.statSync(output).size, sourceCueCount: proof.sourceCueCount, outputCueCount: proof.outputCueCount, transformProof: proof, timelineReceipt: proof.operationKinds.map((kind) => ({ operation: `字幕${labels[kind]}`, sourceRange: `${proof.sourceCueCount}条`, outputRange: `${proof.outputCueCount}条` })), summary: `已在一个任务中完成${proof.operationKinds.map((kind) => labels[kind]).join('、')}，生成${transform.style ? '带样式ASS' : 'SRT'}字幕；结构与语言逐项复核通过，原字幕和视频均未改动` }
    } catch (error) { if (this.fs.existsSync(tempPath)) this.fs.rmSync(tempPath, { force: true }); throw error }
  }

  async verifyTransformSubtitles({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || '')); const output = path.resolve(String(outputPath || ''))
    if (!this.fs.existsSync(output) || this.fs.statSync(output).size <= 0) throw new Error('批量字幕成果不存在或不完整')
    const verified = this.verifySubtitleTransformOutput({ source, output, decision, signal }); const proof = verified.proof
    return { success: true, outputPath: output, outputs: [output], outputBytes: this.fs.statSync(output).size, sourceCueCount: proof.sourceCueCount, outputCueCount: proof.outputCueCount, transformProof: proof, summary: `已从冻结合同恢复并核验${proof.operationKinds.length}类批量字幕变换，原字幕未改动` }
  }

  async visualEffects({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.visual-effects' || !Array.isArray(decision.effects) || !decision.effects.length) throw new Error('视觉效果决策无效')
    if (decision.brandPackage?.strategy === 'ass-brand-package-v1') return this.brandPackageService.render({ sourcePath, outputPath, decision, signal })
    if (path.resolve(String(decision.source?.path || '')) !== source || source === output) throw new Error('视觉效果决策与源文件不一致或试图覆盖原片')
    if (!this.fs.existsSync(source) || this.fs.existsSync(output) || !this.frames.availability().available) throw new Error(this.fs.existsSync(output) ? '成果文件已存在，为避免覆盖已停止' : '源视频或ffmpeg不可用')
    const sourceDuration = await this.frames.probeDuration(source, { signal })
    const dimensions = await this.frames.probeDimensions(source, { signal })
    if (!(sourceDuration > 0) || !(Number(dimensions?.width) > 0) || !(Number(dimensions?.height) > 0)) throw new Error('无法读取源视频时长或分辨率')
    const sourceBefore = this.fs.statSync(source)
    const even = (value) => Math.max(2, Math.floor(Number(value) / 2) * 2)
    let width = even(dimensions.width); let height = even(dimensions.height)
    const filters = []
    const crop = decision.effects.find((item) => item.type === 'crop')
    if (crop) {
      const [left, right] = String(crop.aspect).split(':').map(Number); const ratio = left / right
      if (width / height > ratio) width = even(height * ratio)
      else height = even(width / ratio)
      filters.push(`crop=${width}:${height}:(iw-${width})/2:(ih-${height})/2`)
    }
    const scale = decision.effects.find((item) => item.type === 'scale')
    if (scale) {
      const factor = Number(scale.factor)
      const scaledWidth = even(width * factor); const scaledHeight = even(height * factor)
      filters.push(`scale=${scaledWidth}:${scaledHeight}`)
      filters.push(factor >= 1 ? `crop=${width}:${height}:(iw-${width})/2:(ih-${height})/2` : `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`)
    }
    const motion = decision.effects.find((item) => item.type === 'motion')
    if (motion) {
      const amount = Math.max(0.05, Math.min(0.5, Number(motion.amount) || 0.15))
      if (motion.kind === 'pan-left-right' || motion.kind === 'pan-right-left') {
        const motionWidth = even(width * (1 + amount)); const motionHeight = even(height * (1 + amount))
        const progress = `min(max(t/${sourceDuration.toFixed(3)},0),1)`
        const x = motion.kind === 'pan-right-left' ? `(in_w-out_w)*(1-${progress})` : `(in_w-out_w)*${progress}`
        filters.push(`scale=${motionWidth}:${motionHeight}`, `crop=${width}:${height}:x='${x}':y='(in_h-out_h)/2'`)
      } else {
        const framesCount = Math.max(1, Math.round(sourceDuration * 30)); const maximum = 1 + amount
        const z = motion.kind === 'zoom-out' ? `max(1,${maximum.toFixed(3)}-on*${(amount / framesCount).toFixed(8)})` : `min(${maximum.toFixed(3)},1+on*${(amount / framesCount).toFixed(8)})`
        filters.push(`fps=30`, `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=30`)
      }
    }
    const color = decision.effects.find((item) => item.type === 'color')
    if (color) {
      filters.push(`eq=brightness=${Number(color.brightness).toFixed(3)}:contrast=${Number(color.contrast).toFixed(3)}:saturation=${Number(color.saturation).toFixed(3)}`)
      if (Number(color.temperature)) filters.push(Number(color.temperature) > 0 ? `colorbalance=rs=.15:bs=-.15` : `colorbalance=rs=-.15:bs=.15`)
    }
    const blur = decision.effects.find((item) => item.type === 'blur')
    if (blur) {
      const enable = blur.timeRange ? `:enable='between(t,${Number(blur.timeRange.startSeconds).toFixed(3)},${Number(blur.timeRange.endSeconds).toFixed(3)})'` : ''
      filters.push(`gblur=sigma=${Number(blur.strength).toFixed(2)}${enable}`)
    }
    const mask = decision.effects.find((item) => item.type === 'mask')
    if (mask) {
      const boxWidth = even(width * Number(mask.width)); const boxHeight = even(height * Number(mask.height)); const margin = Math.max(4, even(Math.min(width, height) * 0.03))
      const positions = { 'top-left': [margin, margin], 'top-right': [width - boxWidth - margin, margin], 'bottom-left': [margin, height - boxHeight - margin], 'bottom-right': [width - boxWidth - margin, height - boxHeight - margin], center: [(width - boxWidth) / 2, (height - boxHeight) / 2] }
      const [x, y] = positions[mask.position] || positions['top-right']; const enable = mask.timeRange ? `:enable='between(t,${Number(mask.timeRange.startSeconds).toFixed(3)},${Number(mask.timeRange.endSeconds).toFixed(3)})'` : ''
      filters.push(`drawbox=x=${Math.round(x)}:y=${Math.round(y)}:w=${boxWidth}:h=${boxHeight}:color=black@${Number(mask.opacity).toFixed(2)}:t=fill${enable}`)
    }
    const args = ['-hide_banner', '-nostdin', '-i', source]
    const pipEffects = decision.effects.filter((item) => item.type === 'pip')
    for (const pip of pipEffects) { if (!this.fs.existsSync(pip.path)) throw new Error(`画中画素材不存在：${path.basename(pip.path)}`); args.push('-i', path.resolve(pip.path)) }
    filters.push('setsar=1')
    const graph = [`[0:v]${filters.join(',')}[base]`]
    let current = 'base'
    pipEffects.forEach((pip, index) => {
      const pipWidth = even(width * Number(pip.scale)); const margin = Math.max(4, even(Math.min(width, height) * 0.03)); const positions = { 'top-left': [margin, margin], 'top-right': [`W-w-${margin}`, margin], 'bottom-left': [margin, `H-h-${margin}`], 'bottom-right': [`W-w-${margin}`, `H-h-${margin}`], center: ['(W-w)/2', '(H-h)/2'] }; const [x, y] = positions[pip.position] || positions['top-right']
      graph.push(`[${index + 1}:v]setpts=PTS-STARTPTS,scale=${pipWidth}:-2[pip${index}]`)
      const enable = pip.timeRange ? `:enable='between(t,${Number(pip.timeRange.startSeconds).toFixed(3)},${Number(pip.timeRange.endSeconds).toFixed(3)})'` : ''
      graph.push(`[${current}][pip${index}]overlay=x=${x}:y=${y}:eof_action=pass:shortest=0${enable}[composite${index}]`); current = `composite${index}`
    })
    const transition = decision.effects.find((item) => item.type === 'transition')
    const hasAudio = await this.frames.probeHasAudio(source, { signal })
    let expectedDuration = sourceDuration
    if (transition) {
      const at = Number(transition.atSeconds); const duration = Number(transition.durationSeconds)
      if (!(at > duration && at < sourceDuration - 0.1)) throw new Error('转场时间点超出可处理范围')
      graph.push(`[${current}]split=2[transition-a][transition-b]`, `[transition-a]trim=0:${at.toFixed(3)},setpts=PTS-STARTPTS[pre]`, `[transition-b]trim=start=${at.toFixed(3)},setpts=PTS-STARTPTS[post]`, `[pre][post]xfade=transition=fade:duration=${duration.toFixed(3)}:offset=${(at - duration).toFixed(3)}[vout]`)
      if (hasAudio) graph.push(`[0:a]asplit=2[a0][a1]`, `[a0]atrim=0:${at.toFixed(3)},asetpts=PTS-STARTPTS[apre]`, `[a1]atrim=start=${at.toFixed(3)},asetpts=PTS-STARTPTS[apost]`, `[apre][apost]acrossfade=d=${duration.toFixed(3)}[aout]`)
      expectedDuration -= duration
    } else graph.push(`[${current}]null[vout]`)
    const parsed = path.parse(output); const tempPath = path.join(parsed.dir, `.${parsed.name}.agentplay-effects-${process.pid}-${Date.now()}${parsed.ext || '.mp4'}`)
    try {
      await this.frames.run([...args, '-filter_complex', graph.join(';'), '-map', '[vout]', ...(hasAudio ? transition ? ['-map', '[aout]'] : ['-map', '0:a:0'] : ['-an']), '-map_metadata', '0', '-map_chapters', '-1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', ...(hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : []), '-movflags', '+faststart', '-y', tempPath], { timeoutMs: 60 * 60 * 1000, signal })
      this.assertSourceUnchanged(sourceBefore, source)
      const receipt = await this.verifyVisualEffects({ source, output: tempPath, decision, sourceDuration, expectedDuration, expectedDimensions: { width, height }, signal })
      this.fs.renameSync(tempPath, output)
      return { ...receipt, outputPath: output, outputs: [output], outputBytes: this.fs.statSync(output).size }
    } catch (error) { if (this.fs.existsSync(tempPath)) this.fs.rmSync(tempPath, { force: true }); throw error }
  }

  async smartReframe({ sourcePath, outputPaths, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const outputs = (Array.isArray(outputPaths) ? outputPaths : []).map((item) => path.resolve(String(item || '')))
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.smart-reframe' || decision.reframe?.tracking?.frames?.length !== 5) throw new Error('智能构图决策无效')
    if (path.resolve(String(decision.source?.path || '')) !== source || outputs.length !== 3 || new Set(outputs).size !== 3 || outputs.includes(source)) throw new Error('智能构图源文件或成果列表无效')
    if (!this.fs.existsSync(source) || !this.frames.availability().available) throw new Error('源视频或ffmpeg不可用')
    const sourceBefore = this.fs.statSync(source); const duration = await this.frames.probeDuration(source, { signal }); const dimensions = await this.frames.probeDimensions(source, { signal }); const hasAudio = await this.frames.probeHasAudio(source, { signal })
    if (!(duration > 0) || Number(dimensions?.width) !== Number(decision.reframe.sourceDimensions?.width) || Number(dimensions?.height) !== Number(decision.reframe.sourceDimensions?.height)) throw new Error('源视频尺寸或时长与冻结智能构图不一致')
    const versions = []
    try {
      for (let index = 0; index < decision.reframe.outputs.length; index += 1) {
        const spec = decision.reframe.outputs[index]; const output = outputs[index]; const parsed = path.parse(output); const temp = path.join(parsed.dir, `.${parsed.name}.agentplay-reframe-${process.pid}-${Date.now()}${parsed.ext || '.mp4'}`)
        try {
          if (this.fs.existsSync(output)) {
            const receipt = await this.verifySmartReframeOutput({ output, spec, expectedDuration: duration, tolerance: Number(decision.verification?.toleranceSeconds) || 0.35, signal })
            versions.push({ aspect: spec.aspect, outputPath: output, durationSeconds: receipt.durationSeconds, dimensions: receipt.dimensions })
            continue
          }
          const { x, y } = this.smartReframeCropExpressions(decision.reframe.tracking.frames, dimensions, spec)
          await this.frames.run(['-hide_banner', '-nostdin', '-i', source, '-vf', `crop=${spec.width}:${spec.height}:x='${x}':y='${y}',setsar=1`, '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0'] : ['-an']), '-map_metadata', '0', '-map_chapters', '-1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', ...(hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : []), '-movflags', '+faststart', '-y', temp], { timeoutMs: 60 * 60 * 1000, signal })
          const receipt = await this.verifySmartReframeOutput({ output: temp, spec, expectedDuration: duration, tolerance: Number(decision.verification?.toleranceSeconds) || 0.35, signal })
          this.assertSourceUnchanged(sourceBefore, source); this.fs.renameSync(temp, output)
          versions.push({ aspect: spec.aspect, outputPath: output, durationSeconds: receipt.durationSeconds, dimensions: receipt.dimensions })
        } catch (error) { if (this.fs.existsSync(temp)) this.fs.rmSync(temp, { force: true }); throw error }
      }
      const minimumSubjectCoverage = this.minimumSmartReframeCoverage(decision.reframe.tracking.frames, decision.reframe.outputs, dimensions)
      if (minimumSubjectCoverage + 0.0001 < Number(decision.verification?.minimumSubjectCoverage || 0.75)) throw new Error('冻结主体在目标画幅中的覆盖率不足')
      this.assertSourceUnchanged(sourceBefore, source)
      return { success: true, outputPath: outputs[0], outputs, versions, durationSeconds: duration, trackingReceipt: { strategy: decision.reframe.strategy, subject: decision.reframe.subject, frameCount: decision.reframe.tracking.frames.length, minimumConfidence: decision.reframe.tracking.minimumConfidence, minimumSubjectCoverage, model: decision.reframe.model }, summary: `已围绕“${decision.reframe.subject.description}”生成16:9、9:16和1:1三个跟踪构图版本；原文件未改动` }
    } catch (error) { this.assertSourceUnchanged(sourceBefore, source); throw error }
  }

  async visualRepair({ sourcePath, outputPaths, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || '')); const outputs = (Array.isArray(outputPaths) ? outputPaths : []).map((item) => path.resolve(String(item || '')))
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.visual-repair' || outputs.length !== 2 || path.resolve(String(decision.source?.path || '')) !== source || outputs.includes(source)) throw new Error('画面修复决策或成果位置无效')
    if (!this.fs.existsSync(source) || !this.frames.availability().available) throw new Error('源视频或ffmpeg不可用')
    const sourceBefore = this.fs.statSync(source); const duration = await this.frames.probeDuration(source, { signal }); const sourceDimensions = await this.frames.probeDimensions(source, { signal }); const hasAudio = await this.frames.probeHasAudio(source, { signal })
    if (Math.abs(duration - Number(decision.repair.durationSeconds)) > 0.1 || Number(sourceDimensions?.width) !== Number(decision.repair.sourceDimensions?.width) || Number(sourceDimensions?.height) !== Number(decision.repair.sourceDimensions?.height)) throw new Error('源视频与冻结画面修复决策不一致')
    const [repairedPath, comparisonPath] = outputs; const parsed = path.parse(repairedPath); const tempRepaired = path.join(parsed.dir, `.${parsed.name}.agentplay-repair-${process.pid}-${Date.now()}${parsed.ext || '.mp4'}`)
    const transformPath = path.join(parsed.dir, `.${parsed.name}.agentplay-vidstab-${process.pid}-${Date.now()}.trf`)
    let initialTransformText = ''
    try {
      if (!this.fs.existsSync(repairedPath)) {
        const filters = []
        if (decision.repair.stabilize) {
          initialTransformText = await this.detectShakeTransforms(source, transformPath, signal)
          filters.push(`vidstabtransform=input='${this.escapeFilterPath(transformPath)}':smoothing=12:optzoom=1:zoom=0`)
        }
        if (decision.repair.rotationDegrees === 90) filters.push('transpose=clock')
        else if (decision.repair.rotationDegrees === -90) filters.push('transpose=cclock')
        else if (Math.abs(decision.repair.rotationDegrees) === 180) filters.push('hflip', 'vflip')
        if (decision.repair.autoColor && decision.repair.correction) {
          const correction = decision.repair.correction
          filters.push(`eq=brightness=${Number(correction.brightness).toFixed(3)}:contrast=${Number(correction.contrast).toFixed(3)}:saturation=${Number(correction.saturation).toFixed(3)}`)
          if (Number(correction.redShift) || Number(correction.blueShift)) filters.push(`colorbalance=rs=${Number(correction.redShift).toFixed(3)}:bs=${Number(correction.blueShift).toFixed(3)}`)
        }
        await this.frames.run(['-hide_banner', '-nostdin', '-i', source, ...(filters.length ? ['-vf', filters.join(',')] : []), '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0'] : ['-an']), '-map_metadata', '0', '-map_chapters', '-1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', ...(hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : []), '-movflags', '+faststart', '-y', tempRepaired], { timeoutMs: 60 * 60 * 1000, signal })
        await this.verifyVisualRepairOutput({ output: tempRepaired, expectedDuration: duration, expectedDimensions: decision.repair.expectedDimensions, tolerance: Number(decision.verification?.toleranceSeconds) || 0.35, signal })
        this.assertSourceUnchanged(sourceBefore, source); this.fs.renameSync(tempRepaired, repairedPath)
      }
      const repaired = await this.verifyVisualRepairOutput({ output: repairedPath, expectedDuration: duration, expectedDimensions: decision.repair.expectedDimensions, tolerance: Number(decision.verification?.toleranceSeconds) || 0.35, signal })
      if (!this.fs.existsSync(comparisonPath)) await this.buildVisualComparison({ source, repaired: repairedPath, output: comparisonPath, duration, sourceDimensions, repairedDimensions: repaired.dimensions, hasAudio, signal })
      const comparisonDimensions = await this.frames.probeDimensions(comparisonPath, { signal }); const comparisonDuration = await this.frames.probeDuration(comparisonPath, { signal })
      if (!(comparisonDuration > 0) || Math.abs(comparisonDuration - duration) > 0.35 || !(Number(comparisonDimensions?.width) > 0) || !(Number(comparisonDimensions?.height) > 0)) throw new Error('前后对比视频校验失败')
      const stabilization = decision.repair.stabilize ? await this.stabilizationProof({ source, repaired: repairedPath, initialTransformText, tempDir: parsed.dir, signal }) : { requested: false, verdict: 'not-requested' }
      const color = decision.repair.autoColor ? await this.colorRepairProof({ source, repaired: repairedPath, duration, signal }) : { requested: false, verdict: 'not-requested' }
      if (stabilization.verdict === 'failed') throw new Error('防抖后实测运动幅度没有改善，已拒绝交付')
      if (color.verdict === 'failed') throw new Error('曝光/偏色修复后统计没有改善，已拒绝交付')
      this.assertSourceUnchanged(sourceBefore, source)
      return { success: true, outputPath: repairedPath, outputs, durationSeconds: repaired.durationSeconds, repairReceipt: { strategy: decision.repair.strategy, stabilization, rotation: { degrees: decision.repair.rotationDegrees, dimensions: repaired.dimensions, matched: true }, color, lowQualityFindings: decision.repair.lowQualityFindings, comparison: { path: comparisonPath, dimensions: { width: Number(comparisonDimensions.width), height: Number(comparisonDimensions.height) }, durationSeconds: comparisonDuration }, sourceUnchanged: true }, summary: `已生成画面修复版和处理前后对比版；${decision.repair.lowQualityFindings.length}个低质量片段仅提示未自动删除，原文件未改动` }
    } catch (error) {
      if (this.fs.existsSync(tempRepaired)) this.fs.rmSync(tempRepaired, { force: true })
      for (const output of outputs) if (this.fs.existsSync(output)) this.fs.rmSync(output, { force: true })
      this.assertSourceUnchanged(sourceBefore, source)
      throw error
    } finally { if (this.fs.existsSync(transformPath)) this.fs.rmSync(transformPath, { force: true }) }
  }

  escapeFilterPath(filePath) { return String(filePath || '').replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''") }

  async detectShakeTransforms(source, transformPath, signal) {
    if (this.fs.existsSync(transformPath)) this.fs.rmSync(transformPath, { force: true })
    await this.frames.run(['-hide_banner', '-nostdin', '-i', source, '-vf', `vidstabdetect=shakiness=8:accuracy=9:fileformat=ascii:result='${this.escapeFilterPath(transformPath)}'`, '-an', '-f', 'null', '-'], { timeoutMs: 60 * 60 * 1000, signal })
    if (!this.fs.existsSync(transformPath)) throw new Error('防抖第一遍没有生成运动变换文件')
    return this.fs.readFileSync(transformPath, 'utf8')
  }

  async stabilizationProof({ source, repaired, initialTransformText, tempDir, signal } = {}) {
    const beforePath = path.join(tempDir, `.agentplay-shake-before-${process.pid}-${Date.now()}.trf`); const afterPath = path.join(tempDir, `.agentplay-shake-after-${process.pid}-${Date.now()}.trf`)
    try {
      const beforeText = initialTransformText || await this.detectShakeTransforms(source, beforePath, signal); const afterText = await this.detectShakeTransforms(repaired, afterPath, signal)
      const before = shakeScoreFromTransforms(beforeText); const after = shakeScoreFromTransforms(afterText)
      const verdict = before.frameCount < 2 || before.averageMagnitude < 2 ? 'not-needed' : after.averageMagnitude <= before.averageMagnitude * 0.9 ? 'improved' : 'failed'
      return { requested: true, method: 'vidstab-ascii-median-motion-v1', before, after, improvementRatio: before.averageMagnitude > 0 ? Number((1 - after.averageMagnitude / before.averageMagnitude).toFixed(3)) : 0, verdict }
    } finally { for (const item of [beforePath, afterPath]) if (this.fs.existsSync(item)) this.fs.rmSync(item, { force: true }) }
  }

  async measureSignalStats(source, duration, signal) {
    const fps = Math.max(0.2, Math.min(2, 60 / Number(duration)))
    const result = await this.frames.run(['-hide_banner', '-nostats', '-i', source, '-vf', `fps=${fps.toFixed(4)},signalstats,metadata=print:key=lavfi.signalstats.YAVG,metadata=print:key=lavfi.signalstats.UAVG,metadata=print:key=lavfi.signalstats.VAVG,metadata=print:key=lavfi.signalstats.SATAVG`, '-an', '-f', 'null', '-'], { timeoutMs: Math.max(120000, Math.min(10 * 60 * 1000, Number(duration) * 800)), signal })
    return parseSignalStatsLog(result.stderr)
  }

  async colorRepairProof({ source, repaired, duration, signal } = {}) {
    const [before, after] = await Promise.all([this.measureSignalStats(source, duration, signal), this.measureSignalStats(repaired, duration, signal)])
    const distance = (stats) => Math.abs(Number(stats.yAvg) - 118) + 0.35 * (Math.abs(Number(stats.uAvg) - 128) + Math.abs(Number(stats.vAvg) - 128))
    const beforeDistance = distance(before); const afterDistance = distance(after)
    return { requested: true, method: 'signalstats-neutral-distance-v1', before, after, beforeDistance: Number(beforeDistance.toFixed(3)), afterDistance: Number(afterDistance.toFixed(3)), verdict: afterDistance <= beforeDistance * 0.95 ? 'improved' : 'failed' }
  }

  async buildVisualComparison({ source, repaired, output, duration, sourceDimensions, repairedDimensions, hasAudio, signal } = {}) {
    const canvasWidth = Math.max(Number(sourceDimensions.width), Number(repairedDimensions.width)); const canvasHeight = Math.max(Number(sourceDimensions.height), Number(repairedDimensions.height)); const parsed = path.parse(output); const temp = path.join(parsed.dir, `.${parsed.name}.agentplay-comparison-${process.pid}-${Date.now()}${parsed.ext || '.mp4'}`)
    const filter = `[0:v]scale=${canvasWidth}:${canvasHeight}:force_original_aspect_ratio=decrease,pad=${canvasWidth}:${canvasHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[before];[1:v]scale=${canvasWidth}:${canvasHeight}:force_original_aspect_ratio=decrease,pad=${canvasWidth}:${canvasHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[after];[before][after]hstack=inputs=2[vout]`
    try {
      await this.frames.run(['-hide_banner', '-nostdin', '-i', source, '-i', repaired, '-filter_complex', filter, '-map', '[vout]', ...(hasAudio ? ['-map', '1:a:0'] : ['-an']), '-t', Number(duration).toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', ...(hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : []), '-movflags', '+faststart', '-y', temp], { timeoutMs: 60 * 60 * 1000, signal })
      this.fs.renameSync(temp, output)
    } catch (error) { if (this.fs.existsSync(temp)) this.fs.rmSync(temp, { force: true }); throw error }
  }

  async verifyVisualRepairOutput({ output, expectedDuration, expectedDimensions, tolerance, signal } = {}) {
    if (!this.fs.existsSync(output) || this.fs.statSync(output).size <= 1024) throw new Error('画面修复成果不存在或不完整')
    const durationSeconds = await this.frames.probeDuration(output, { signal }); const dimensions = await this.frames.probeDimensions(output, { signal })
    if (Math.abs(durationSeconds - expectedDuration) > tolerance || Number(dimensions?.width) !== Number(expectedDimensions?.width) || Number(dimensions?.height) !== Number(expectedDimensions?.height)) throw new Error('画面修复成果时长或尺寸不一致')
    return { durationSeconds, dimensions: { width: Number(dimensions.width), height: Number(dimensions.height) } }
  }

  smartReframeCropExpressions(frames, sourceDimensions, outputSpec) {
    const centerExpression = (axis) => {
      const values = frames.map((item) => Number(item.box[axis]) + Number(item.box[axis === 'x' ? 'width' : 'height']) / 2)
      let expression = values.at(-1).toFixed(6)
      for (let index = frames.length - 2; index >= 0; index -= 1) {
        const start = Number(frames[index].seconds); const end = Number(frames[index + 1].seconds); const delta = end - start; const value = `${values[index].toFixed(6)}+(${(values[index + 1] - values[index]).toFixed(6)})*(t-${start.toFixed(3)})/${delta.toFixed(3)}`
        expression = `if(lte(t,${end.toFixed(3)}),${value},${expression})`
      }
      return expression
    }
    const maxX = Number(sourceDimensions.width) - Number(outputSpec.width); const maxY = Number(sourceDimensions.height) - Number(outputSpec.height)
    return { x: `clip((${centerExpression('x')})*iw-${Number(outputSpec.width) / 2},0,${Math.max(0, maxX)})`, y: `clip((${centerExpression('y')})*ih-${Number(outputSpec.height) / 2},0,${Math.max(0, maxY)})` }
  }

  minimumSmartReframeCoverage(frames, outputs, sourceDimensions) {
    let minimum = 1
    for (const frame of frames) for (const output of outputs) {
      const cropWidth = Number(output.width) / Number(sourceDimensions.width); const cropHeight = Number(output.height) / Number(sourceDimensions.height)
      const centerX = Number(frame.box.x) + Number(frame.box.width) / 2; const centerY = Number(frame.box.y) + Number(frame.box.height) / 2
      const cropX = Math.max(0, Math.min(1 - cropWidth, centerX - cropWidth / 2)); const cropY = Math.max(0, Math.min(1 - cropHeight, centerY - cropHeight / 2))
      const intersectionWidth = Math.max(0, Math.min(cropX + cropWidth, frame.box.x + frame.box.width) - Math.max(cropX, frame.box.x)); const intersectionHeight = Math.max(0, Math.min(cropY + cropHeight, frame.box.y + frame.box.height) - Math.max(cropY, frame.box.y))
      minimum = Math.min(minimum, intersectionWidth * intersectionHeight / (Number(frame.box.width) * Number(frame.box.height)))
    }
    return Number(minimum.toFixed(3))
  }

  async verifySmartReframeOutput({ output, spec, expectedDuration, tolerance, signal } = {}) {
    if (!this.fs.existsSync(output) || this.fs.statSync(output).size <= 1024) throw new Error(`智能构图${spec.aspect}成果不存在或不完整`)
    const durationSeconds = await this.frames.probeDuration(output, { signal }); const dimensions = await this.frames.probeDimensions(output, { signal })
    if (Math.abs(durationSeconds - expectedDuration) > tolerance) throw new Error(`智能构图${spec.aspect}成果时长不一致`)
    if (Number(dimensions?.width) !== Number(spec.width) || Number(dimensions?.height) !== Number(spec.height)) throw new Error(`智能构图${spec.aspect}成果尺寸不一致`)
    return { durationSeconds, dimensions: { width: Number(dimensions.width), height: Number(dimensions.height) } }
  }

  async verifyVisualEffects({ source, output, decision, sourceDuration = 0, expectedDuration = 0, expectedDimensions = null, signal } = {}) {
    if (!this.fs.existsSync(output) || this.fs.statSync(output).size <= 1024) throw new Error('视觉效果成果不存在或不完整')
    const inputDuration = sourceDuration || await this.frames.probeDuration(source, { signal })
    const transition = decision.effects.find((item) => item.type === 'transition')
    const wantedDuration = expectedDuration || inputDuration - Number(transition?.durationSeconds || 0)
    const actualDuration = await this.frames.probeDuration(output, { signal }); const tolerance = Math.max(0.1, Number(decision.verification?.toleranceSeconds) || 0.35)
    if (!(actualDuration > 0) || Math.abs(actualDuration - wantedDuration) > tolerance) throw new Error(`视觉效果成果时长不一致：期望${wantedDuration.toFixed(3)}，实际${actualDuration.toFixed(3)}`)
    const outputDimensions = await this.frames.probeDimensions(output, { signal })
    let dimensions = expectedDimensions
    if (!dimensions) {
      const sourceDimensions = await this.frames.probeDimensions(source, { signal })
      const even = (value) => Math.max(2, Math.floor(Number(value) / 2) * 2)
      let width = even(sourceDimensions?.width); let height = even(sourceDimensions?.height)
      const crop = decision.effects.find((item) => item.type === 'crop')
      if (crop) {
        const [left, right] = String(crop.aspect).split(':').map(Number); const ratio = left / right
        if (width / height > ratio) width = even(height * ratio)
        else height = even(width / ratio)
      }
      dimensions = { width, height }
    }
    const dimensionMatch = Number(outputDimensions?.width) === Number(dimensions?.width) && Number(outputDimensions?.height) === Number(dimensions?.height)
    if (!dimensionMatch) throw new Error('视觉效果成果分辨率与冻结决策不一致')
    const ranged = decision.effects.find((item) => item.timeRange)?.timeRange
    const sampleSource = ranged ? (Number(ranged.startSeconds) + Number(ranged.endSeconds)) / 2 : Math.min(inputDuration - 0.2, Math.max(0.2, inputDuration / 2))
    const sampleOutput = transition && sampleSource > Number(transition.atSeconds) ? sampleSource - Number(transition.durationSeconds) : Math.min(actualDuration - 0.1, sampleSource)
    const [sourceFrame, outputFrame] = await Promise.all([this.frames.readGrayFrame(source, sampleSource, { signal }), this.frames.readGrayFrame(output, sampleOutput, { signal })])
    if (!sourceFrame || !outputFrame) throw new Error('视觉效果代表帧证明不可用')
    const representativeDiff = Number(meanAbsDiff(sourceFrame, outputFrame).toFixed(3))
    const effectReceipt = { effectKinds: decision.effects.map((item) => item.type), inputDurationSeconds: Number(inputDuration.toFixed(3)), outputDurationSeconds: Number(actualDuration.toFixed(3)), outputDimensions: { width: Number(outputDimensions.width), height: Number(outputDimensions.height) }, dimensionMatch, representativeSample: { sourceSeconds: Number(sampleSource.toFixed(3)), outputSeconds: Number(sampleOutput.toFixed(3)), meanAbsDiff: representativeDiff }, changed: representativeDiff > 0.2 }
    if (!effectReceipt.changed) throw new Error('视觉效果代表帧没有产生可验证变化')
    return { success: true, durationSeconds: actualDuration, expectedDurationSeconds: wantedDuration, effectReceipt, summary: `已应用 ${effectReceipt.effectKinds.length} 类视觉效果（${effectReceipt.effectKinds.join('、')}），分辨率 ${outputDimensions.width}×${outputDimensions.height}，原文件未改动` }
  }

  async verify({ sourcePath, outputPath, decision, signal } = {}) {
    if (decision?.kind === 'media.mix-audio') return this.audioMixService.verify({ sourcePath, outputPath, decision, signal })
    if (decision?.kind === 'media.rhythm-edit') return this.rhythmEditService.verify({ sourcePath, musicPath: decision.music?.path, outputPath, decision, signal })
    if (decision?.kind === 'media.visual-effects') {
      if (decision.brandPackage?.strategy === 'ass-brand-package-v1') {
        const verified = await this.brandPackageService.verify({ sourcePath, outputPath, decision, signal })
        const representative = [verified.proof.elements.title, ...(verified.proof.elements.chapters.samples || []), verified.proof.elements.person, verified.proof.elements.corner, verified.proof.elements.outro].find((item) => Number.isFinite(Number(item?.seconds)))
        const effectReceipt = { effectKinds: ['brand-package'], inputDurationSeconds: verified.plan.timeline.durationSeconds, outputDurationSeconds: Number(verified.durationSeconds.toFixed(3)), outputDimensions: { width: Number(verified.outputDimensions.width), height: Number(verified.outputDimensions.height) }, dimensionMatch: true, representativeSample: { sourceSeconds: Number(representative?.seconds || 0), outputSeconds: Number(representative?.seconds || 0), meanAbsDiff: Number((verified.maximumDifference * 255).toFixed(3)) }, changed: true }
        const labels = { title: '标题', chapters: '章节条', person: '人物条', corner: '角标', outro: '片尾' }
        const verifiedLabels = verified.plan.requiredElements.map((item) => labels[item]).join('、')
        return { success: true, outputPath, outputs: [outputPath], outputBytes: this.fs.statSync(outputPath).size, durationSeconds: verified.durationSeconds, expectedDurationSeconds: verified.plan.timeline.durationSeconds, effectReceipt, brandPackage: verified.plan, brandPackageProof: verified.proof, summary: `已恢复并核验“${verified.plan.template.label}”品牌包装，${verifiedLabels}像素证据完整` }
      }
      const source = path.resolve(String(sourcePath || '')); const output = path.resolve(String(outputPath || ''))
      const sourceDuration = await this.frames.probeDuration(source, { signal })
      const transition = decision.effects.find((item) => item.type === 'transition')
      const receipt = await this.verifyVisualEffects({ source, output, decision, sourceDuration, expectedDuration: sourceDuration - Number(transition?.durationSeconds || 0), signal })
      return { ...receipt, outputPath: output, outputs: [output], outputBytes: this.fs.statSync(output).size }
    }
    if (decision?.kind === 'media.shift-subtitles') return this.verifyShiftSubtitles({ sourcePath, outputPath, decision, signal })
    if (decision?.kind === 'media.translate-subtitles') return this.verifyTranslateSubtitles({ sourcePath, outputPath, decision, signal })
    if (decision?.kind === 'media.edit-subtitle-cues') return this.verifyCueEdit({ sourcePath, outputPath, decision, signal })
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!this.fs.existsSync(output) || !this.fs.statSync(output).isFile() || this.fs.statSync(output).size <= 1024) throw new Error('剪辑成果不存在或不完整')
    const sourceDuration = await this.frames.probeDuration(source, { signal })
    const actualDuration = await this.frames.probeDuration(output, { signal })
    const isRemove = decision?.kind === 'media.remove-segment'
    const isConcat = decision?.kind === 'media.concat-segments'
    const isConcatSources = decision?.kind === 'media.concat-sources'
    const isMusic = decision?.kind === 'media.add-music'
    const isBurnSubtitles = decision?.kind === 'media.burn-subtitles'
    const isMuxSubtitles = decision?.kind === 'media.mux-subtitles'
    const concatTimeline = isConcat ? validateConcatTimeline(decision) : null
    if (concatTimeline) assertSegmentsWithinSource(concatTimeline.segments, sourceDuration)
    let concatSourcesProbes = null
    let concatSourcePaths = null
    if (isConcatSources) {
      if (typeof this.frames.probeDimensions !== 'function') throw new Error('无法确认拼接素材分辨率')
      concatSourcePaths = (Array.isArray(decision.sources) ? decision.sources : []).map((item) => path.resolve(String(item?.path || '')))
      concatSourcesProbes = []
      for (let index = 0; index < concatSourcePaths.length; index += 1) {
        const item = concatSourcePaths[index]
        const duration = index === 0 ? sourceDuration : await this.frames.probeDuration(item, { signal })
        if (!(duration > 0)) throw new Error(`无法读取拼接素材时长：${path.basename(item)}`)
        const dimensions = await this.frames.probeDimensions(item, { signal })
        if (!(Number(dimensions?.width) > 0) || !(Number(dimensions?.height) > 0)) throw new Error(`无法读取拼接素材分辨率：${path.basename(item)}`)
        concatSourcesProbes.push({ duration, width: Number(dimensions.width), height: Number(dimensions.height) })
      }
    }
    const expectedDuration = isRemove
      ? Number((sourceDuration - Number(decision?.timeline?.removedDurationSeconds || 0)).toFixed(3))
      : isConcat ? concatTimeline.expectedDuration
        : isConcatSources ? Number(concatSourcesProbes.reduce((sum, item) => sum + item.duration, 0).toFixed(3))
          : isMusic || isBurnSubtitles || isMuxSubtitles ? sourceDuration
            : Number(decision?.timeline?.durationSeconds || 0)
    const tolerance = Math.max(0.05, Number(decision?.verification?.toleranceSeconds) || 0.2)
    if (!(actualDuration > 0) || Math.abs(actualDuration - expectedDuration) > tolerance) throw new Error('剪辑成果时长校验失败')
    if (isMusic && !(await this.frames.probeHasAudio(output, { signal }))) throw new Error('配乐成果没有音轨，已拒绝交付')
    if (isMuxSubtitles && !(await this.frames.probeHasSubtitle(output, { signal }))) throw new Error('封装成果没有字幕轨，已拒绝交付')
    const isPlainTrim = !isRemove && !isConcat && !isConcatSources && !isBurnSubtitles && !isMuxSubtitles && decision?.kind === 'media.trim'
    let editFrameProof = null
    if (isPlainTrim) {
      editFrameProof = await this.frameProofForTrim({ source, output, decision, sourceDuration, signal })
      this.assertFrameProofDeliverable(editFrameProof)
    } else if (isRemove) {
      const proofSegments = this.removeProofSegments(decision, sourceDuration)
      editFrameProof = await this.frameProofForSegments({ source, output, segments: proofSegments, sourceDuration, signal })
      this.assertFrameProofDeliverable(editFrameProof)
    } else if (isConcat) {
      editFrameProof = await this.frameProofForSegments({ source, output, segments: concatTimeline.segments, sourceDuration, signal })
      this.assertFrameProofDeliverable(editFrameProof)
    } else if (isConcatSources) {
      editFrameProof = await this.frameProofForSources({ sources: concatSourcePaths, output, probes: concatSourcesProbes, signal })
      this.assertFrameProofDeliverable(editFrameProof)
    }
    let musicAudioProof = null
    let musicLoudnessProof = null
    let musicAudioExportQc = null
    if (isMusic) {
      const hasSourceAudio = await this.frames.probeHasAudio(source, { signal })
      const audio = path.resolve(String(decision.audio?.path || ''))
      if (!this.fs.existsSync(audio) || !this.fs.statSync(audio).isFile()) throw new Error('冻结的背景音乐文件不存在，无法恢复核验')
      musicLoudnessProof = await this.loudnessProofForMusic({ output, decision, signal })
      this.assertLoudnessProofDeliverable(musicLoudnessProof)
      musicAudioProof = await this.audioProofForMusic({ source, audio, output, sourceDuration, hasSourceAudio, decision, signal })
      this.assertAudioProofDeliverable(musicAudioProof)
      musicAudioExportQc = await this.exportQuality.audit({ sourcePath: source, outputPath: output, decision, externalAudioPaths: [{ path: audio, role: 'music' }], signal })
    }
    let professionalSubtitle = null
    let professionalSubtitleProof = null
    let subtitlePreviewBurnProof = null
    if (isBurnSubtitles && decision.subtitle?.professional?.enabled) {
      if (!this.professionalSubtitleService) throw new Error('专业动态字幕所需逐词转写服务不可用')
      const assPath = path.join(path.dirname(output), `.${path.parse(output).name}.agentplay-professional-verify-${process.pid}-${Date.now()}.ass`)
      try {
        professionalSubtitle = await this.professionalSubtitleService.prepare({ sourcePath: source, subtitlePath: decision.subtitle.path, outputAssPath: assPath, decision, signal })
        professionalSubtitleProof = await this.professionalSubtitleService.verifyRender({ sourcePath: source, outputPath: output, plan: professionalSubtitle, signal })
        const escaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''")
        const filter = `subtitles='${escaped}'`
        const frozen = await this.subtitlePreviewBurnParityService.freeze({ subtitlePath: assPath, renderFilter: filter })
        subtitlePreviewBurnProof = await this.subtitlePreviewBurnParityService.finalize({ subtitlePath: assPath, outputPath: output, renderFilter: filter, frozen })
      } finally { if (this.fs.existsSync(assPath)) this.fs.rmSync(assPath, { force: true }) }
    } else if (isBurnSubtitles) {
      const subtitle = path.resolve(String(decision.subtitle?.path || ''))
      const escaped = subtitle.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''")
      const forceStyle = burnForceStyle(decision.subtitle?.style)
      const filter = `subtitles='${escaped}'${forceStyle ? `:force_style='${forceStyle}'` : ''}`
      const frozen = await this.subtitlePreviewBurnParityService.freeze({ subtitlePath: subtitle, renderFilter: filter })
      subtitlePreviewBurnProof = await this.subtitlePreviewBurnParityService.finalize({ subtitlePath: subtitle, outputPath: output, renderFilter: filter, frozen })
    }
    return isRemove
      ? this.removeReceipt({ source, output, decision, sourceDuration, expectedDuration, actualDuration, frameProof: editFrameProof })
      : isConcat
        ? this.concatReceipt({ output, decision, sourceDuration, expectedDuration, actualDuration, frameProof: editFrameProof })
        : isConcatSources
          ? this.concatSourcesReceipt({ output, decision, probes: concatSourcesProbes, expectedDuration, actualDuration, frameProof: editFrameProof })
          : isMusic
            ? this.musicReceipt({ output, decision, sourceDuration, actualDuration, audioProof: musicAudioProof, loudnessProof: musicLoudnessProof, audioExportQc: musicAudioExportQc })
          : isBurnSubtitles
            ? this.burnSubtitlesReceipt({ output, decision, sourceDuration, actualDuration, professionalSubtitle, professionalSubtitleProof, subtitlePreviewBurnProof })
            : isMuxSubtitles
              ? this.muxSubtitlesReceipt({ output, decision, sourceDuration, actualDuration })
              : this.resultReceipt({ source, output, decision, sourceDuration, actualDuration, frameProof: editFrameProof })
  }

  resultReceipt({ source, output, decision, sourceDuration, actualDuration, frameProof = null }) {
    const { startSeconds, endSeconds, durationSeconds } = decision.timeline
    return {
      success: true,
      outputPath: output,
      outputs: [output],
      outputBytes: this.fs.statSync(output).size,
      sourceDurationSeconds: sourceDuration,
      expectedDurationSeconds: durationSeconds,
      durationSeconds: Number(actualDuration.toFixed(3)),
      ...(frameProof ? { frameProof } : {}),
      timelineReceipt: [{
        operation: '保留片段',
        sourceRange: `${formatTimestamp(startSeconds)} → ${formatTimestamp(endSeconds)}`,
        outputRange: `${formatTimestamp(0)} → ${formatTimestamp(durationSeconds)}`
      }],
      summary: `已保留 ${formatTimestamp(startSeconds)} 到 ${formatTimestamp(endSeconds)}，生成 ${durationSeconds.toFixed(3)} 秒新视频；原文件未改动${frameProof?.verdict === 'matched' ? '；首尾帧边界已核对' : frameProof?.verdict === 'inconclusive' ? '；画面内容相似，帧边界证据无法唯一判定，已保留提示' : ''}`
    }
  }

  musicReceipt({ output, decision, sourceDuration, actualDuration, audioProof, loudnessProof, audioExportQc, music = null }) {
    const volume = Math.max(0.01, Math.min(1, Number(music?.volume ?? decision.audio?.volume) || 0.15))
    const duck = (music?.duck ?? decision.audio?.duck) !== false
    const fadeInSeconds = Math.max(0, Number(music?.fadeInSeconds ?? decision.audio?.fadeInSeconds) || 0)
    const fadeOutSeconds = Math.max(0, Number(music?.fadeOutSeconds ?? decision.audio?.fadeOutSeconds) || 0)
    const audioPath = path.resolve(String(music?.path || decision.audio?.path || ''))
    const loop = (music?.loop ?? decision.audio?.loop) !== false
    const rawSelection = music?.selection?.explicit ? music.selection : decision.audio?.selection
    const selection = rawSelection
      ? { startSeconds: Number(rawSelection.startSeconds), endSeconds: Number(rawSelection.endSeconds), durationSeconds: Number(rawSelection.durationSeconds) }
      : null
    const fullRange = `${formatTimestamp(0)} → ${formatTimestamp(sourceDuration)}`
    const musicRange = selection ? `${formatTimestamp(selection.startSeconds)} → ${formatTimestamp(selection.endSeconds)}` : '音乐文件全段'
    return {
      success: true,
      outputPath: output,
      outputs: [output],
      outputBytes: this.fs.statSync(output).size,
      sourceDurationSeconds: sourceDuration,
      expectedDurationSeconds: sourceDuration,
      durationSeconds: Number(actualDuration.toFixed(3)),
      music: { path: audioPath, volume, duck, loop, ...(selection ? { selection } : {}), fadeInSeconds, fadeOutSeconds },
      audioProof,
      loudnessProof,
      audioExportQc,
      timelineReceipt: [{
        operation: `添加背景音乐（${Math.round(volume * 100)}%${duck ? '、对白闪避' : ''}${loop ? '、循环铺满' : '、播放一次'}）`,
        sourceRange: musicRange,
        outputRange: fullRange
      }],
      summary: `已生成 ${Number(actualDuration.toFixed(3)).toFixed(3)} 秒配乐版新视频（音乐${selection ? ` ${musicRange}` : '全段'}${loop ? '循环铺满' : '播放一次'}，音量 ${Math.round(volume * 100)}%${duck ? '，对白闪避' : ''}）；统一声音导出质量门已通过；原文件未改动；音轨非静音、声音变化、样本峰值与淡入淡出窗口已核对${loudnessProof?.verdict === 'matched' ? `；编码后响度 ${loudnessProof.integratedLufs} LUFS、true peak ${loudnessProof.truePeakDbtp} dBTP` : ''}`
    }
  }

  removeReceipt({ output, decision, sourceDuration, expectedDuration, actualDuration, frameProof = null }) {
    const { startSeconds, endSeconds } = decision.timeline
    const receipt = [{
      operation: '删除片段',
      sourceRange: `${formatTimestamp(startSeconds)} → ${formatTimestamp(endSeconds)}`,
      outputRange: '未进入成片'
    }]
    if (startSeconds > 0.001) receipt.push({
      operation: '保留片段',
      sourceRange: `${formatTimestamp(0)} → ${formatTimestamp(startSeconds)}`,
      outputRange: `${formatTimestamp(0)} → ${formatTimestamp(startSeconds)}`
    })
    if (endSeconds < sourceDuration - 0.001) receipt.push({
      operation: '保留片段',
      sourceRange: `${formatTimestamp(endSeconds)} → ${formatTimestamp(sourceDuration)}`,
      outputRange: `${formatTimestamp(startSeconds)} → ${formatTimestamp(expectedDuration)}`
    })
    return {
      success: true,
      outputPath: output,
      outputs: [output],
      outputBytes: this.fs.statSync(output).size,
      sourceDurationSeconds: sourceDuration,
      expectedDurationSeconds: expectedDuration,
      durationSeconds: Number(actualDuration.toFixed(3)),
      ...(frameProof ? { frameProof } : {}),
      timelineReceipt: receipt,
      summary: `已删除 ${formatTimestamp(startSeconds)} 到 ${formatTimestamp(endSeconds)}，生成 ${expectedDuration.toFixed(3)} 秒新视频；原文件未改动${this.frameProofSummary(frameProof, '保留片段')}`
    }
  }

  concatReceipt({ output, decision, sourceDuration, expectedDuration, actualDuration, frameProof = null }) {
    const segments = decision.timeline.segments
    return {
      success: true,
      outputPath: output,
      outputs: [output],
      outputBytes: this.fs.statSync(output).size,
      sourceDurationSeconds: sourceDuration,
      expectedDurationSeconds: expectedDuration,
      durationSeconds: Number(actualDuration.toFixed(3)),
      ...(frameProof ? { frameProof } : {}),
      timelineReceipt: segments.map((segment, index) => ({
        operation: `拼接片段 ${index + 1}`,
        sourceRange: `${formatTimestamp(segment.sourceStartSeconds)} → ${formatTimestamp(segment.sourceEndSeconds)}`,
        outputRange: `${formatTimestamp(segment.targetStartSeconds)} → ${formatTimestamp(segment.targetEndSeconds)}`
      })),
      summary: `已按指定顺序拼接 ${segments.length} 个片段，生成 ${expectedDuration.toFixed(3)} 秒新视频；原文件未改动${this.frameProofSummary(frameProof, '拼接片段')}`
    }
  }

  concatSourcesReceipt({ output, decision, probes, expectedDuration, actualDuration, frameProof = null }) {
    const names = (Array.isArray(decision.sources) ? decision.sources : []).map((item) => String(item?.name || path.basename(String(item?.path || ''))))
    let cursor = 0
    const timelineReceipt = probes.map((probe, index) => {
      const start = cursor
      cursor = Number((cursor + probe.duration).toFixed(3))
      return {
        operation: `拼接素材 ${index + 1}（${names[index] || `素材${index + 1}`}）`,
        sourceRange: `${formatTimestamp(0)} → ${formatTimestamp(probe.duration)}`,
        outputRange: `${formatTimestamp(start)} → ${formatTimestamp(cursor)}`
      }
    })
    return {
      success: true,
      outputPath: output,
      outputs: [output],
      outputBytes: this.fs.statSync(output).size,
      expectedDurationSeconds: expectedDuration,
      durationSeconds: Number(actualDuration.toFixed(3)),
      ...(frameProof ? { frameProof } : {}),
      timelineReceipt,
      summary: `已按顺序拼接 ${probes.length} 个素材，生成 ${expectedDuration.toFixed(3)} 秒新视频；原文件均未改动${this.frameProofSummary(frameProof, '跨素材片段')}`
    }
  }

  burnSubtitlesReceipt({ output, decision, sourceDuration, actualDuration, professionalSubtitle = null, professionalSubtitleProof = null, subtitlePreviewBurnProof = null }) {
    const subtitleName = String(decision.subtitle?.name || path.basename(String(decision.subtitle?.path || '字幕文件')))
    const fullRange = `${formatTimestamp(0)} → ${formatTimestamp(sourceDuration)}`
    const style = decision.subtitle?.style
    const styleText = style
      ? `（${[style.fontSize === 'large' ? '大号字' : style.fontSize === 'small' ? '小号字' : '', style.alignment === 'top' ? '顶部' : style.alignment === 'bottom' ? '底部' : '', style.color || ''].filter(Boolean).join('、')}）`
      : ''
    return {
      success: true,
      outputPath: output,
      outputs: [output],
      outputBytes: this.fs.statSync(output).size,
      sourceDurationSeconds: sourceDuration,
      expectedDurationSeconds: sourceDuration,
      durationSeconds: Number(actualDuration.toFixed(3)),
      ...(professionalSubtitle ? { professionalSubtitle, professionalSubtitleProof } : {}),
      ...(subtitlePreviewBurnProof ? { subtitlePreviewBurnProof, previewPath: output } : {}),
      timelineReceipt: [{
        operation: `烧录字幕（${subtitleName}）${styleText}`,
        sourceRange: fullRange,
        outputRange: fullRange
      }],
      summary: professionalSubtitle
        ? `已把字幕《${subtitleName}》生成专业动态字幕：匿名声纹聚类 ${professionalSubtitle.speakers.speakerCount} 位说话人、${professionalSubtitle.wordTiming.wordCount} 个真实逐词高亮/卡拉OK标签、${professionalSubtitle.keywords.emphasisCount} 次关键词强调，并自动避让到${professionalSubtitle.safeArea.chosenZone === 'top' ? '顶部' : '底部'}安全区；${subtitlePreviewBurnProof ? `${subtitlePreviewBurnProof.cueCount} 条字幕的预览与最终烧录使用同一冻结成果；` : ''}生成 ${sourceDuration.toFixed(3)} 秒新视频；原文件与字幕文件均未改动`
        : `已把字幕《${subtitleName}》逐条烧录进画面${styleText}；${subtitlePreviewBurnProof ? `${subtitlePreviewBurnProof.cueCount} 条字幕的预览与最终烧录使用同一冻结成果；` : ''}生成 ${sourceDuration.toFixed(3)} 秒新视频；原文件与字幕文件均未改动`
    }
  }

  muxSubtitlesReceipt({ output, decision, sourceDuration, actualDuration }) {
    const subtitleName = String(decision.subtitle?.name || path.basename(String(decision.subtitle?.path || '字幕文件')))
    const fullRange = `${formatTimestamp(0)} → ${formatTimestamp(sourceDuration)}`
    return {
      success: true,
      outputPath: output,
      outputs: [output],
      outputBytes: this.fs.statSync(output).size,
      sourceDurationSeconds: sourceDuration,
      expectedDurationSeconds: sourceDuration,
      durationSeconds: Number(actualDuration.toFixed(3)),
      timelineReceipt: [{
        operation: `封装软字幕（${subtitleName}）`,
        sourceRange: fullRange,
        outputRange: fullRange
      }],
      summary: `已把字幕《${subtitleName}》封装成可开关的软字幕轨（音画未重编码），生成 ${sourceDuration.toFixed(3)} 秒新视频；原文件与字幕文件均未改动`
    }
  }
}

module.exports = { MediaEditService, formatTimestamp, decodeSubtitleText, parseSrtCues }
