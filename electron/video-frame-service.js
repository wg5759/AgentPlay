// 视频关键帧服务：镜头切换感知抽帧 + 16x16 灰度去重 + 时长帧预算。
// 参照 claude-video 的配方：scene-change 优先、产出不足退回均匀采样；去重与上一张"保留"帧比亮度均值差。
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const FRAME_WIDTH = 512
const THUMB = 16
const DEDUP_THRESHOLD = 2.0
const MAX_FRAMES = 24

// 帧预算：短视密、长视稀，硬顶 MAX_FRAMES。
// 注意图片是视觉请求的主要耗时来源：实测火山 Coding Plan 端点 30+ 张会拖到超时，20 以内稳妥。
function frameBudget(durationSec) {
  const d = Number(durationSec) || 0
  if (d <= 30) return 12
  if (d <= 60) return 18
  return MAX_FRAMES
}

// 短片需要捕捉 UI 卡片、景别硬切等细变化；长片降低敏感度，避免转场噪声淹没预算。
function sceneThreshold(durationSec) {
  const d = Number(durationSec) || 0
  if (d <= 120) return 0.18
  if (d <= 600) return 0.22
  return 0.28
}

function formatTimestamp(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

// 两个等长 Buffer 的逐字节平均绝对差（0-255），用于灰度缩略图相似度
function meanAbsDiff(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 255
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

// 去重：与上一张"保留"帧比较（能抓住渐变），小于等于阈值视为重复丢弃；始终保留第一张
function dedupeThumbs(thumbs, threshold = DEDUP_THRESHOLD) {
  const keep = []
  let lastKept = -1
  for (let i = 0; i < thumbs.length; i++) {
    if (lastKept < 0 || meanAbsDiff(thumbs[i], thumbs[lastKept]) > threshold) {
      keep.push(i)
      lastKept = i
    }
  }
  return keep
}

// 超预算均匀稀疏化：保头保尾、覆盖全片
function thinToBudget(indices, budget) {
  if (indices.length <= budget) return indices
  const out = []
  const step = (indices.length - 1) / (budget - 1)
  for (let i = 0; i < budget; i++) out.push(indices[Math.round(i * step)])
  return [...new Set(out)]
}

class VideoFrameService {
  constructor({ ffmpegPath, ffprobePath, spawnImpl, frameReadTimeoutMs = 60000 } = {}) {
    this.ffmpegPath = ffmpegPath ? path.resolve(ffmpegPath) : ''
    this.ffprobePath = ffprobePath ? path.resolve(ffprobePath) : ''
    this.spawnImpl = spawnImpl || spawn
    this.frameReadTimeoutMs = Math.max(10, Number(frameReadTimeoutMs) || 60000)
  }

  availability() {
    return { available: Boolean(this.ffmpegPath && fs.existsSync(this.ffmpegPath)) }
  }

  run(args, { timeoutMs = 120000, signal } = {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.ffmpegPath, args, { windowsHide: true, shell: false })
      let stderr = ''
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* 已退出 */ }
        finish(reject, new Error('ffmpeg 执行超时'))
      }, timeoutMs)
      const finish = (fn, value) => {
        if (finish.done) return
        finish.done = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        fn(value)
      }
      const onAbort = () => {
        try { child.kill() } catch { /* 已退出 */ }
        finish(reject, new Error('已取消'))
      }
      if (signal) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })
      child.once('error', (error) => finish(reject, error))
      child.once('exit', (code) => {
        if (code === 0) finish(resolve, { stderr })
        else finish(reject, new Error(stderr.trim().split(/\r?\n/).filter(Boolean).pop() || `ffmpeg 退出码 ${code}`))
      })
    })
  }

  async probeDuration(sourcePath, { signal } = {}) {
    if (!this.ffprobePath || !fs.existsSync(this.ffprobePath)) return 0
    try {
      const child = this.spawnImpl(this.ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', sourcePath], { windowsHide: true, shell: false })
      let out = ''
      await new Promise((resolve, reject) => {
        let settled = false
        const finish = (fn, value) => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          fn(value)
        }
        const onAbort = () => {
          try { child.kill() } catch { /* 已退出 */ }
          finish(reject, new Error('已取消'))
        }
        if (signal) {
          if (signal.aborted) {
            onAbort()
            return
          }
          signal.addEventListener('abort', onAbort, { once: true })
        }
        child.stdout?.on('data', (chunk) => { out += chunk.toString('utf8') })
        child.once('error', () => finish(resolve))
        child.once('exit', () => finish(resolve))
      })
      return Number.parseFloat(out.trim()) || 0
    } catch (error) {
      if (signal?.aborted) throw error
      return 0
    }
  }

  async probeHasAudio(sourcePath, { signal } = {}) {
    if (!this.ffprobePath || !fs.existsSync(this.ffprobePath)) throw new Error('缺少 ffprobe 组件')
    const child = this.spawnImpl(this.ffprobePath, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', sourcePath], { windowsHide: true, shell: false })
    let out = ''
    await new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        fn(value)
      }
      const onAbort = () => {
        try { child.kill() } catch { /* 已退出 */ }
        finish(reject, new Error('已取消'))
      }
      if (signal) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      child.stdout?.on('data', (chunk) => { out += chunk.toString('utf8') })
      child.once('error', (error) => finish(reject, error))
      child.once('exit', (code) => code === 0 ? finish(resolve) : finish(reject, new Error(`ffprobe 退出码 ${code}`)))
    })
    return out.trim().length > 0
  }

  async readRawFrameBuffer(args, { signal } = {}) {
    if (!this.ffmpegPath || !fs.existsSync(this.ffmpegPath)) return null
    try {
      const child = this.spawnImpl(this.ffmpegPath, args, { windowsHide: true, shell: false })
      const chunks = []
      return await new Promise((resolve, reject) => {
        let settled = false
        let timer = null
        const finish = (fn, value) => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          fn(value)
        }
        const onAbort = () => {
          try { child.kill() } catch { /* 已退出 */ }
          finish(reject, new Error('已取消'))
        }
        if (signal) {
          if (signal.aborted) {
            onAbort()
            return
          }
          signal.addEventListener('abort', onAbort, { once: true })
        }
        timer = setTimeout(() => {
          try { child.kill() } catch { /* 已退出 */ }
          finish(resolve, null)
        }, this.frameReadTimeoutMs)
        child.stdout?.on('data', (chunk) => chunks.push(chunk))
        child.stderr?.resume?.()
        child.once('error', () => finish(resolve, null))
        child.once('exit', (code) => finish(resolve, code === 0 ? Buffer.concat(chunks) : null))
      })
    } catch (error) {
      if (signal?.aborted) throw error
      return null
    }
  }

  // 读取一个有界的单声道 PCM 窗口，用于声音结果核验；s16le 是样本值，不代表 LUFS 或 true peak。
  async readPcmWindow(sourcePath, seconds, { durationSeconds = 0.3, sampleRateHz = 16000, signal } = {}) {
    const start = Math.max(0, Number(seconds) || 0)
    const duration = Math.max(0.05, Math.min(2, Number(durationSeconds) || 0.3))
    const sampleRate = Math.max(8000, Math.min(48000, Math.round(Number(sampleRateHz) || 16000)))
    const buffer = await this.readRawFrameBuffer([
      '-v', 'error', '-ss', start.toFixed(3), '-i', sourcePath,
      '-t', duration.toFixed(3), '-map', '0:a:0', '-vn',
      '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le', '-f', 's16le', '-'
    ], { signal })
    return buffer && buffer.length >= 2 ? buffer.subarray(0, buffer.length - (buffer.length % 2)) : null
  }

  // 扫描整段首音轨的解码样本峰值与均值。volumedetect 的 max_volume 是 sample peak，不冒充 true peak。
  async probeAudioLevels(sourcePath, { signal } = {}) {
    try {
      const result = await this.run([
        '-hide_banner', '-nostdin', '-i', sourcePath, '-map', '0:a:0', '-vn',
        '-af', 'volumedetect', '-f', 'null', '-'
      ], { timeoutMs: 10 * 60 * 1000, signal })
      const readDb = (name) => {
        const match = String(result.stderr || '').match(new RegExp(`${name}:\\s*(-?\\d+(?:\\.\\d+)?|-inf)\\s*dB`, 'i'))
        if (!match) return null
        return match[1].toLowerCase() === '-inf' ? -Infinity : Number(match[1])
      }
      const meanVolumeDbfs = readDb('mean_volume')
      const samplePeakDbfs = readDb('max_volume')
      return Number.isFinite(samplePeakDbfs) || samplePeakDbfs === -Infinity
        ? { meanVolumeDbfs, samplePeakDbfs }
        : null
    } catch (error) {
      if (signal?.aborted) throw error
      return null
    }
  }

  // 编码后 EBU R128 复测：integrated loudness 记 LUFS，ebur128 peak=true 的 True peak 记 dBTP。
  async probeLoudness(sourcePath, { signal } = {}) {
    try {
      const result = await this.run([
        '-hide_banner', '-nostdin', '-i', sourcePath, '-map', '0:a:0', '-vn',
        '-af', 'ebur128=peak=true', '-f', 'null', '-'
      ], { timeoutMs: 10 * 60 * 1000, signal })
      const stderr = String(result.stderr || '')
      const integrated = [...stderr.matchAll(/\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/gi)]
      const peaks = [...stderr.matchAll(/\bPeak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/gi)]
      const integratedLufs = integrated.length ? Number(integrated.at(-1)[1]) : null
      const truePeakDbtp = peaks.length ? Number(peaks.at(-1)[1]) : null
      return Number.isFinite(integratedLufs) && Number.isFinite(truePeakDbtp)
        ? { integratedLufs, truePeakDbtp }
        : null
    } catch (error) {
      if (signal?.aborted) throw error
      return null
    }
  }

  frameProofScaleFilter({ fitWidth = 0, fitHeight = 0 } = {}) {
    const width = Math.round(Number(fitWidth) || 0)
    const height = Math.round(Number(fitHeight) || 0)
    return width > 0 && height > 0
      ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,scale=32:32,format=gray`
      : 'scale=32:32,format=gray'
  }

  // 单帧灰度读取（32x32 gray 裸数据经 stdout 管道，不落临时文件）；用于帧边界级证明。失败返回 null。
  // 跨素材时可先按成片画布执行与拼接管线一致的 scale+pad，再缩成证明样本。
  async readGrayFrame(sourcePath, seconds, { signal, fitWidth = 0, fitHeight = 0 } = {}) {
    const filter = this.frameProofScaleFilter({ fitWidth, fitHeight })
    const buffer = await this.readRawFrameBuffer(['-v', 'error', '-ss', Number(seconds).toFixed(3), '-i', sourcePath, '-frames:v', '1', '-vf', filter, '-f', 'rawvideo', '-'], { signal })
    return buffer?.length === 32 * 32 ? buffer : null
  }

  // 边界末帧读取：B 帧重排时按 PTS seek 可能拿不到最后几帧，且 -t 截断会丢未 flush 的 B 帧尾。
  // 改为解码 [boundary-0.7, boundary+1.05] 窗口（留足 flush 余量），select 只收 boundary 之前的帧，取最后一块 32x32 灰度帧。
  async readLastGrayFrame(sourcePath, boundarySeconds, { signal, fitWidth = 0, fitHeight = 0 } = {}) {
    if (!this.ffmpegPath || !fs.existsSync(this.ffmpegPath)) return null
    const boundary = Number(boundarySeconds)
    if (!Number.isFinite(boundary) || boundary <= 0) return null
    const start = Math.max(0, boundary - 0.7)
    const windowSeconds = Number((boundary - start + 1.05).toFixed(3))
    const keepBefore = Number((boundary - start - 0.033).toFixed(3))
    const filter = `select='lte(t,${keepBefore})',${this.frameProofScaleFilter({ fitWidth, fitHeight })}`
    const buffer = await this.readRawFrameBuffer(['-v', 'error', '-ss', start.toFixed(3), '-i', sourcePath, '-t', windowSeconds.toFixed(3), '-vf', filter, '-vsync', '0', '-f', 'rawvideo', '-'], { signal })
    if (!buffer || buffer.length < 32 * 32) return null
    return buffer.subarray(buffer.length - 32 * 32)
  }

  // 读取首个视频流的宽高；失败返回 null（调用方自行决定拒绝还是降级）
  async probeDimensions(sourcePath, { signal } = {}) {
    if (!this.ffprobePath || !fs.existsSync(this.ffprobePath)) return null
    try {
      const child = this.spawnImpl(this.ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', sourcePath], { windowsHide: true, shell: false })
      let out = ''
      await new Promise((resolve, reject) => {
        let settled = false
        const finish = (fn, value) => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          fn(value)
        }
        const onAbort = () => {
          try { child.kill() } catch { /* 已退出 */ }
          finish(reject, new Error('已取消'))
        }
        if (signal) {
          if (signal.aborted) {
            onAbort()
            return
          }
          signal.addEventListener('abort', onAbort, { once: true })
        }
        child.stdout?.on('data', (chunk) => { out += chunk.toString('utf8') })
        child.once('error', () => finish(resolve))
        child.once('exit', () => finish(resolve))
      })
      const match = out.trim().match(/^(\d+),(\d+)/)
      return match ? { width: Number(match[1]), height: Number(match[2]) } : null
    } catch (error) {
      if (signal?.aborted) throw error
      return null
    }
  }

  async probeHasSubtitle(sourcePath, { signal } = {}) {
    if (!this.ffprobePath || !fs.existsSync(this.ffprobePath)) throw new Error('缺少 ffprobe 组件')
    const child = this.spawnImpl(this.ffprobePath, ['-v', 'error', '-select_streams', 's:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', sourcePath], { windowsHide: true, shell: false })
    let out = ''
    await new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        fn(value)
      }
      const onAbort = () => {
        try { child.kill() } catch { /* 已退出 */ }
        finish(reject, new Error('已取消'))
      }
      if (signal) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      child.stdout?.on('data', (chunk) => { out += chunk.toString('utf8') })
      child.once('error', (error) => finish(reject, error))
      child.once('exit', (code) => code === 0 ? finish(resolve) : finish(reject, new Error(`ffprobe 退出码 ${code}`)))
    })
    return out.trim().length > 0
  }

  // 抽取关键帧：scene-change 优先，产出不足或去重塌缩都退均匀采样；返回 [{ path, tSec, label }]
  async extract({ sourcePath, durationSec = 0, outDir, budget, signal } = {}) {
    if (!this.availability().available) return []
    if (!sourcePath || !fs.existsSync(sourcePath)) return []
    const duration = Number(durationSec) > 0 ? Number(durationSec) : await this.probeDuration(sourcePath)
    const cap = Math.min(Number(budget) > 0 ? Number(budget) : frameBudget(duration), MAX_FRAMES)
    const threshold = sceneThreshold(duration)

    const readFiles = () => (fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((name) => name.endsWith('.jpg')).sort() : [])
    const loadThumbs = async (vf, count) => {
      const rawPath = path.join(outDir, 'thumbs.raw')
      await this.run(['-hide_banner', '-nostdin', '-i', sourcePath, '-vf', vf, '-frames:v', String(count), '-f', 'rawvideo', rawPath], { signal })
      const raw = fs.readFileSync(rawPath)
      const size = THUMB * THUMB
      const thumbs = []
      for (let offset = 0; offset + size <= raw.length && thumbs.length < count; offset += size) {
        thumbs.push(raw.subarray(offset, offset + size))
      }
      return thumbs
    }

    // 第一遍：镜头切换帧（showinfo 在 select 之后，pts_time 与落盘文件一一对应）。
    // format=yuvj420p 必带：抖音等 HEVC 窄色域(tv range)片源会让 mjpeg 编码器初始化直接失败
    fs.rmSync(outDir, { recursive: true, force: true })
    fs.mkdirSync(outDir, { recursive: true })
    let stderr = ''
    try {
      const result = await this.run([
        '-hide_banner', '-nostdin', '-i', sourcePath,
        '-vf', `select='gt(scene,${threshold})',showinfo,scale=${FRAME_WIDTH}:-2,format=yuvj420p`,
        '-fps_mode', 'vfr', '-frames:v', String(cap * 3), '-q:v', '4',
        path.join(outDir, 'f%04d.jpg')
      ], { signal })
      stderr = result.stderr
    } catch { /* 场景抽帧硬失败也交给均匀采样兜底 */ }
    let times = [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number.parseFloat(m[1]))
    let files = readFiles()
    let thumbs = []
    if (files.length) {
      try { thumbs = await loadThumbs(`select='gt(scene,${threshold})',scale=${THUMB}:${THUMB},format=gray`, files.length) } catch { thumbs = [] }
    }
    let keep = thumbs.length === files.length && files.length > 0 ? dedupeThumbs(thumbs) : files.map((_, i) => i)

    // scene 帧太少（谈话头/渐变/硬失败），或看似很多却被去重塌成个位数（噪点/闪动误触发场景切换）
    // → 均匀采样兜底，时间戳按 fps 推导；短视频两张有效帧即可，别为小片反复重抽
    const minUseful = duration <= 60 ? 2 : Math.min(8, Math.max(3, Math.ceil(duration / 20)))
    if (keep.length < minUseful && duration > 0) {
      fs.rmSync(outDir, { recursive: true, force: true })
      fs.mkdirSync(outDir, { recursive: true })
      const fps = cap / duration
      await this.run([
        '-hide_banner', '-nostdin', '-i', sourcePath,
        '-vf', `fps=${fps.toFixed(4)},scale=${FRAME_WIDTH}:-2,format=yuvj420p`, '-frames:v', String(cap), '-q:v', '4',
        path.join(outDir, 'f%04d.jpg')
      ], { signal })
      files = readFiles()
      times = files.map((_, i) => i / fps)
      thumbs = []
      if (files.length) {
        try { thumbs = await loadThumbs(`fps=${fps.toFixed(4)},scale=${THUMB}:${THUMB},format=gray`, files.length) } catch { thumbs = [] }
      }
      keep = thumbs.length === files.length && files.length > 0 ? dedupeThumbs(thumbs) : files.map((_, i) => i)
    }
    if (!files.length) return []

    keep = thinToBudget(keep, cap)
    const keepSet = new Set(keep)
    for (let i = 0; i < files.length; i++) {
      if (!keepSet.has(i)) {
        try { fs.unlinkSync(path.join(outDir, files[i])) } catch { /* 忽略 */ }
      }
    }
    return keep.map((i) => {
      const tSec = Number.isFinite(times[i]) ? times[i] : Math.round(((duration || files.length) * i) / files.length)
      return { path: path.join(outDir, files[i]), tSec, label: `t=${formatTimestamp(tSec)}` }
    })
  }
}

module.exports = {
  VideoFrameService,
  frameBudget,
  formatTimestamp,
  sceneThreshold,
  meanAbsDiff,
  dedupeThumbs,
  thinToBudget,
  MAX_FRAMES
}
