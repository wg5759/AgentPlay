const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { getType } = require('./file-service')

function parseClock(value) {
  const match = String(value || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[,.](\d{1,3}))?$/)
  if (!match) return null
  const hours = Number(match[1] || 0)
  const minutes = Number(match[2] || 0)
  const seconds = Number(match[3] || 0)
  const millis = Number(String(match[4] || '').padEnd(3, '0') || 0)
  return hours * 3600 + minutes * 60 + seconds + millis / 1000
}

function cleanSubtitleText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseSubtitleCues(content, extension = '') {
  const ext = String(extension).toLowerCase()
  if (ext === '.ass' || ext === '.ssa') {
    return String(content).split(/\r?\n/).flatMap((line) => {
      if (!/^Dialogue:/i.test(line)) return []
      const parts = line.replace(/^Dialogue:\s*/i, '').split(',')
      if (parts.length < 10) return []
      const start = parseClock(parts[1])
      const end = parseClock(parts[2])
      const text = cleanSubtitleText(parts.slice(9).join(','))
      return start === null || end === null || !text ? [] : [{ start, end, text }]
    }).slice(0, 5000)
  }
  const cues = []
  const blocks = String(content).replace(/^\uFEFF/, '').split(/\r?\n\s*\r?\n/)
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const timingIndex = lines.findIndex((line) => line.includes('-->'))
    if (timingIndex < 0) continue
    const [left, right] = lines[timingIndex].split('-->').map((part) => part.trim().split(/\s+/)[0])
    const start = parseClock(left)
    const end = parseClock(right)
    const text = cleanSubtitleText(lines.slice(timingIndex + 1).join(' '))
    if (start !== null && end !== null && text) cues.push({ start, end, text })
    if (cues.length >= 5000) break
  }
  return cues
}

function findAdjacentSubtitle(mediaPath) {
  const parsed = path.parse(mediaPath)
  return ['.srt', '.vtt', '.ass', '.ssa']
    .map((ext) => path.join(parsed.dir, parsed.name + ext))
    .find((candidate) => fs.existsSync(candidate)) || null
}

function loadAnalysisContext(mediaPath) {
  if (!mediaPath || /^https?:/i.test(mediaPath) || !fs.existsSync(mediaPath)) {
    return { subtitlePath: null, cues: [], transcript: '' }
  }
  const subtitlePath = findAdjacentSubtitle(mediaPath)
  if (!subtitlePath) return { subtitlePath: null, cues: [], transcript: '' }
  const cues = parseSubtitleCues(fs.readFileSync(subtitlePath, 'utf8'), path.extname(subtitlePath))
  return {
    subtitlePath,
    cues,
    transcript: cues.map((cue) => cue.text).join('\n').slice(0, 50000)
  }
}

function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0)
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const secs = Math.floor(value % 60)
  return [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':')
}

function buildOfflineAnalysis({ mediaName, duration, markers = [], cues = [] }) {
  const ordered = [...markers]
    .filter((marker) => Number.isFinite(Number(marker.at)))
    .sort((a, b) => Number(a.at) - Number(b.at))
  const intervals = ordered.slice(1).map((marker, index) => Number(marker.at) - Number(ordered[index].at)).filter((value) => value > 0)
  const averageInterval = intervals.length ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length : 0
  const groupCounts = (field) => ordered.reduce((result, marker) => {
    const key = String(marker[field] || '未标注')
    result[key] = (result[key] || 0) + 1
    return result
  }, {})
  const summarizeCounts = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join('、') || '暂无'
  const chapterSize = Math.max(1, Math.ceil(cues.length / 6))
  const chapters = []
  for (let index = 0; index < cues.length; index += chapterSize) {
    const group = cues.slice(index, index + chapterSize)
    if (!group.length) continue
    chapters.push(`- ${formatTime(group[0].start)}–${formatTime(group[group.length - 1].end)}：${group.slice(0, 4).map((cue) => cue.text).join(' / ').slice(0, 220)}`)
  }
  return [
    `# ${mediaName || '当前视频'} · 深度解剖底稿`,
    '',
    '## 证据范围',
    `- 时长：${formatTime(duration)}；人工拉片点：${ordered.length}；字幕线索：${cues.length}。`,
    `- 本稿只依据人工标注和同名字幕，不对未观察画面编造结论。`,
    '',
    '## 镜头与节奏',
    `- 平均标注间隔：${averageInterval ? averageInterval.toFixed(1) + ' 秒' : '标注不足，暂不可计算'}。`,
    `- 景别分布：${summarizeCounts(groupCounts('shotSize'))}。`,
    `- 运镜分布：${summarizeCounts(groupCounts('movement'))}。`,
    `- 叙事功能：${summarizeCounts(groupCounts('function'))}。`,
    `- 情绪曲线：${ordered.map((marker) => `${formatTime(marker.at)} ${marker.emotion || '未标注'}`).join(' → ') || '暂无标注'}。`,
    '',
    '## 字幕结构线索',
    chapters.length ? chapters.join('\n') : '- 未发现同名字幕；可继续人工拉片，或先加载/生成字幕。',
    '',
    '## 原创重构检查',
    '- 保留事实与核心信息，但重写开场钩子、结构顺序、旁白表达、视觉包装和结尾行动点。',
    '- 仅调换原片顺序不等于原创；成片前还应检查素材授权、人物肖像、音乐和字体许可。'
  ].join('\n')
}

function normalizeSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) throw new Error('至少需要一个重构片段')
  if (segments.length > 200) throw new Error('单个项目最多 200 个片段')
  let totalDuration = 0
  const normalized = segments.map((segment, index) => {
    const start = Number(segment.start)
    const end = Number(segment.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error(`第 ${index + 1} 个片段时间无效`)
    }
    const duration = end - start
    if (duration > 7200) throw new Error(`第 ${index + 1} 个片段超过 2 小时`)
    totalDuration += duration
    return { start, end, duration }
  })
  if (totalDuration > 21600) throw new Error('成片总时长不能超过 6 小时')
  return normalized
}

function buildMpvEdl(sourcePath, segments) {
  if (!sourcePath || /[\r\n]/.test(sourcePath)) throw new Error('源文件路径无效')
  const absolute = path.resolve(sourcePath)
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile() || getType(path.extname(absolute).toLowerCase()) !== 'video') {
    throw new Error('源视频不存在或格式不受支持')
  }
  const normalized = absolute.replace(/\\/g, '/')
  const byteLength = Buffer.byteLength(normalized, 'utf8')
  const lines = normalizeSegments(segments).map((segment) =>
    `%${byteLength}%${normalized},${segment.start.toFixed(3)},${segment.duration.toFixed(3)}`
  )
  return `# mpv EDL v0\n${lines.join('\n')}\n`
}

function renderRecut({ mpvPath, sourcePath, segments, outputPath, onSpawn }) {
  if (!mpvPath || !fs.existsSync(mpvPath)) return Promise.reject(new Error('视频渲染内核不可用'))
  if (!outputPath || path.extname(outputPath).toLowerCase() !== '.mp4') return Promise.reject(new Error('输出文件必须是 MP4'))
  const edl = buildMpvEdl(sourcePath, segments)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-recut-'))
  const edlPath = path.join(tempDir, 'project.edl')
  fs.writeFileSync(edlPath, edl, 'utf8')
  return new Promise((resolve, reject) => {
    const args = [
      edlPath, '--no-config', `--o=${outputPath}`,
      '--of=mp4', `--ovc=${process.platform === 'win32' ? 'h264_mf' : 'mpeg4'}`, '--oac=aac'
    ]
    const child = spawn(mpvPath, args, { windowsHide: true, shell: false })
    onSpawn?.(child)
    let errors = ''
    child.stdout?.on('data', (chunk) => { errors = (errors + chunk.toString()).slice(-8000) })
    child.stderr?.on('data', (chunk) => { errors = (errors + chunk.toString()).slice(-8000) })
    child.once('error', (error) => {
      fs.rmSync(tempDir, { recursive: true, force: true })
      reject(error)
    })
    child.once('exit', (code, signal) => {
      fs.rmSync(tempDir, { recursive: true, force: true })
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        resolve({ success: true, outputPath, bytes: fs.statSync(outputPath).size })
      } else if (signal) {
        reject(new Error('渲染已取消'))
      } else {
        reject(new Error(`渲染失败（退出码 ${code}）${errors ? `：${errors.split(/\r?\n/).filter(Boolean).slice(-2).join(' ')}` : ''}`))
      }
    })
  })
}

module.exports = {
  buildMpvEdl,
  buildOfflineAnalysis,
  findAdjacentSubtitle,
  formatTime,
  loadAnalysisContext,
  normalizeSegments,
  parseSubtitleCues,
  renderRecut
}
