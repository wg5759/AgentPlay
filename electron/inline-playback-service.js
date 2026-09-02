// Decode unsupported local media into a verified, reusable in-app playback cache.
// The original source remains the identity for history, subtitles and AI work.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const formats = require('./media-formats.json')
const MEDIA_EXTS = new Set([...formats.video, ...formats.audio])
const VERSION = 'inline-playback-v1'

function cancelled(signal) { if (signal?.aborted) throw new Error('已取消播放准备') }
function sameStat(a, b) { return a.size === b.size && a.mtimeMs === b.mtimeMs }
function digest(file, signal) {
  cancelled(signal)
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const input = fs.createReadStream(file, { signal })
    let failure
    input.on('data', data => hash.update(data))
    input.on('error', error => { failure = error })
    input.on('close', () => failure ? reject(failure) : resolve(hash.digest('hex')))
  })
}

function runProcess(exe, args, { signal, timeoutMs = 30000, onChunk, outputPath, maxBytes } = {}) {
  cancelled(signal)
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', failure = null
    const stop = error => { failure ||= error; child.kill() }
    const timer = setTimeout(() => stop(new Error('本机解码超时，请重试或检查媒体文件')), timeoutMs)
    const onAbort = () => stop(new Error('已取消播放准备'))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const monitor = outputPath ? setInterval(() => {
      try { if (fs.statSync(outputPath).size > maxBytes) stop(new Error('播放缓存超过空间上限')) } catch { /* not created yet */ }
    }, 1000) : null
    const receive = (name, chunk) => {
      const text = chunk.toString('utf8')
      if (name === 'stdout') stdout = (stdout + text).slice(-524288)
      else stderr = (stderr + text).slice(-32768)
      onChunk?.(text)
    }
    child.stdout.on('data', chunk => receive('stdout', chunk))
    child.stderr.on('data', chunk => receive('stderr', chunk))
    child.once('error', error => { failure ||= error })
    // Wait for close, not exit: Windows must release every output handle first.
    child.once('close', code => {
      clearTimeout(timer)
      if (monitor) clearInterval(monitor)
      signal?.removeEventListener('abort', onAbort)
      if (failure || code !== 0) reject(failure || new Error(`本机解码失败：${stderr.trim().slice(-700) || `退出码 ${code}`}`))
      else resolve({ stdout, stderr })
    })
  })
}

const MPV_SAFE = ['--no-config', '--load-scripts=no', '--ytdl=no', '--access-references=no', '--sub-auto=no', '--audio-file-auto=no', '--no-resume-playback', '--demuxer-lavf-o=protocol_whitelist=file']
function encodingArgs(engine, source, output, kind, maxBytes) {
  if (engine === 'mpv') return [...MPV_SAFE, '--of=mp4', '--ofopts=movflags=+faststart', '--oac=aac', '--oacopts=b=192000', '--audio-channels=stereo',
    ...(kind === 'audio' ? ['--vid=no'] : ['--ovc=h264_mf', '--ovcopts=b=6000000', '--vf=format=yuv420p']),
    '--sid=no', '--term-status-msg=AP_PROGRESS|${=time-pos}|${=duration}', `--o=${output}`, '--', source]
  return ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file,pipe', '-i', source,
    ...(kind === 'audio' ? ['-vn', '-map', '0:a:0'] : ['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-threads', '2']),
    '-sn', '-dn', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-movflags', '+faststart', '-fs', String(maxBytes + 1), '-progress', 'pipe:1', '-nostats', '-f', 'mp4', output]
}

function parseMpvProbe(stdout) {
  const match = /AP_META\|([^\r\n]*)/.exec(stdout)
  if (!match) throw new Error('无法读取媒体信息')
  const [duration, codec, w, h, channels, audioCodec = '', pixelFormat = ''] = match[1].split('|')
  const width = Number(w) || 0, height = Number(h) || 0
  return { duration: Number(duration) || 0, video: width > 0 && height > 0, audio: Number(channels) > 0, codec, width, height, audioCodec, pixelFormat }
}

// A browser can silently discard an unsupported track without firing `error`.
// Only the conservative codec/container intersection bypasses native preparation.
function canPlayDirect(info, extension) {
  if (!['.mp4', '.m4v', '.m4a', '.mov', '.webm', '.mkv', '.mp3', '.wav', '.flac', '.ogg', '.opus'].includes(extension)) return false
  if (info.video && !['h264', 'vp8', 'vp9', 'av1'].includes(info.codec)) return false
  if (info.video && info.codec === 'h264' && !['yuv420p', 'nv12'].includes(info.pixelFormat)) return false
  return !info.audio || ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le'].includes(info.audioCodec)
}

class InlinePlaybackService {
  constructor({ cacheDir, ffmpegPath = '', ffprobePath = '', mpvPath = '', authorizePath, run = runProcess, maxBytes = 4 * 1024 ** 3 } = {}) {
    this.cacheDir = path.resolve(cacheDir)
    this.ffmpegPath = ffmpegPath
    this.ffprobePath = ffprobePath
    // Launch the real process: cancelling the console shim can leave its child encoding.
    this.mpvPath = process.platform === 'win32' && /\.com$/i.test(mpvPath) && fs.existsSync(mpvPath.replace(/\.com$/i, '.exe')) ? mpvPath.replace(/\.com$/i, '.exe') : mpvPath
    this.authorizePath = authorizePath || (() => { throw new Error('未授权媒体路径') })
    this.run = run
    this.maxBytes = maxBytes
    this.busy = false
  }

  async probe(source, signal) {
    if (this.ffprobePath && fs.existsSync(this.ffprobePath)) {
      const { stdout } = await this.run(this.ffprobePath, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', source], { signal })
      const info = JSON.parse(stdout)
      const video = info.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic)
      const audio = info.streams?.find(s => s.codec_type === 'audio')
      return { duration: Number(info.format?.duration || video?.duration || audio?.duration) || 0, video: Boolean(video), audio: Boolean(audio), codec: video?.codec_name || '', audioCodec: audio?.codec_name || '', pixelFormat: video?.pix_fmt || '', width: video?.width || 0, height: video?.height || 0 }
    }
    if (!this.mpvPath || !fs.existsSync(this.mpvPath)) throw new Error('本机解码组件缺失，请修复 AgentPlay 安装')
    const { stdout } = await this.run(this.mpvPath, [...MPV_SAFE, '--vo=null', '--ao=null', '--untimed', '--length=0.1', '--term-status-msg=', '--term-playing-msg=AP_META|${=duration}|${video-format}|${=width}|${=height}|${=audio-params/channel-count}|${audio-codec-name}|${video-params/pixelformat}', '--', source], { signal })
    return parseMpvProbe(stdout)
  }

  async prepare(source, { kind = 'video', signal, allowDirect = false, onProgress = () => {} } = {}) {
    cancelled(signal)
    if (typeof source !== 'string' || !path.isAbsolute(source) || /^\w+:\/\//.test(source)) throw new Error('仅支持已授权的本地媒体文件')
    if (!MEDIA_EXTS.has(path.extname(source).toLowerCase())) throw new Error('不是可解码的音视频格式（不接受播放列表）')
    const resolved = this.authorizePath(source)
    const initial = fs.statSync(resolved)
    if (!initial.isFile()) throw new Error('目标不是媒体文件')
    if (this.busy) throw new Error('上一项播放准备正在结束，请稍后重试')
    this.busy = true
    let temporary = null, manifestTemp = null
    try {
      onProgress({ phase: 'probing' })
      const input = await this.probe(resolved, signal)
      if (!input.video && !input.audio) throw new Error('文件没有可播放的音视频轨道')
      kind = input.video ? 'video' : 'audio'
      if (allowDirect && canPlayDirect(input, path.extname(resolved).toLowerCase())) {
        cancelled(signal)
        if (!sameStat(initial, fs.statSync(resolved))) throw new Error('源文件仍在变化，请完成写入后重试')
        return { path: resolved, kind, cached: false, duration: input.duration, backend: 'html5' }
      }
      const sourceSha256 = await digest(resolved, signal)
      const key = crypto.createHash('sha256').update(`${VERSION}|${kind}|${sourceSha256}`).digest('hex')
      fs.mkdirSync(this.cacheDir, { recursive: true })
      const output = path.join(this.cacheDir, `${key}.${kind === 'video' ? 'mp4' : 'm4a'}`)
      const manifestPath = path.join(this.cacheDir, `${key}.json`)
      let manifest
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { /* cache miss */ }
      if (manifest?.sourceSha256 === sourceSha256 && manifest?.version === VERSION && fs.existsSync(output) && fs.statSync(output).isFile()) {
        if (await digest(output, signal) === manifest.outputSha256) {
          if (!sameStat(initial, fs.statSync(resolved))) throw new Error('源文件仍在变化，请完成写入后重试')
          onProgress({ phase: 'ready', percent: 100 })
          return { path: output, cached: true, kind, sourceSha256, duration: input.duration, backend: manifest.backend }
        }
      }
      const used = fs.readdirSync(this.cacheDir).filter(name => /^[a-f0-9]{64}\.(mp4|m4a)$/.test(name)).reduce((sum, name) => sum + fs.statSync(path.join(this.cacheDir, name)).size, 0)
      if (used >= this.maxBytes) throw new Error('播放缓存空间已满，请在应用缓存目录中清理后重试')
      const budget = this.maxBytes - used
      const free = fs.statfsSync(this.cacheDir)
      if (free.bavail * free.bsize < Math.min(budget, Math.max(initial.size * 2, 64 * 1024 ** 2))) throw new Error('磁盘可用空间不足，无法准备播放缓存')
      const backend = this.ffmpegPath && fs.existsSync(this.ffmpegPath) ? 'ffmpeg' : 'mpv'
      const executable = backend === 'ffmpeg' ? this.ffmpegPath : this.mpvPath
      if (!executable || !fs.existsSync(executable)) throw new Error('本机解码组件缺失，请修复 AgentPlay 安装')
      temporary = path.join(this.cacheDir, `${key}-${crypto.randomUUID()}.partial.mp4`)
      let progressBuffer = ''
      onProgress({ phase: 'converting', percent: 0 })
      await this.run(executable, encodingArgs(backend, resolved, temporary, kind, budget), {
        signal, timeoutMs: 3600000, outputPath: temporary, maxBytes: budget,
        onChunk: text => {
          progressBuffer = (progressBuffer + text).slice(-4096)
          const ff = [...progressBuffer.matchAll(/out_time_us=(\d+)/g)].at(-1)
          const mp = [...progressBuffer.matchAll(/AP_PROGRESS\|([\d.]+)\|([\d.]+)/g)].at(-1)
          const seconds = ff ? Number(ff[1]) / 1000000 : mp ? Number(mp[1]) : 0
          if (input.duration > 0) onProgress({ phase: 'converting', percent: Math.min(99, Math.max(0, Math.floor(seconds / input.duration * 100))) })
        }
      })
      cancelled(signal)
      if (!sameStat(initial, fs.statSync(resolved))) throw new Error('源文件仍在变化，请完成写入后重试')
      if (!fs.existsSync(temporary) || fs.statSync(temporary).size < 32 || fs.statSync(temporary).size > budget) throw new Error('播放缓存不完整或超过空间上限')
      onProgress({ phase: 'verifying' })
      const outputInfo = await this.probe(temporary, signal)
      if (kind === 'video' && (!outputInfo.video || outputInfo.codec !== 'h264')) throw new Error('播放缓存的视频轨道未通过校验')
      if (input.audio && !outputInfo.audio) throw new Error('播放缓存丢失音轨，已拒绝使用')
      if (input.duration > 0 && Math.abs(input.duration - outputInfo.duration) > Math.max(0.5, input.duration * 0.005)) throw new Error('播放缓存时长与原文件不符')
      const outputSha256 = await digest(temporary, signal)
      cancelled(signal)
      if (!sameStat(initial, fs.statSync(resolved))) throw new Error('源文件仍在变化，请完成写入后重试')
      fs.rmSync(output, { force: true })
      fs.renameSync(temporary, output)
      temporary = null
      manifestTemp = `${manifestPath}.${crypto.randomUUID()}.tmp`
      fs.writeFileSync(manifestTemp, JSON.stringify({ version: VERSION, sourceSha256, outputSha256, backend, duration: outputInfo.duration }))
      fs.rmSync(manifestPath, { force: true })
      fs.renameSync(manifestTemp, manifestPath)
      manifestTemp = null
      onProgress({ phase: 'ready', percent: 100 })
      return { path: output, cached: false, kind, sourceSha256, duration: input.duration, backend }
    } finally {
      if (temporary) fs.rmSync(temporary, { force: true })
      if (manifestTemp) fs.rmSync(manifestTemp, { force: true })
      this.busy = false
    }
  }
}

module.exports = { InlinePlaybackService, encodingArgs, parseMpvProbe, canPlayDirect }
