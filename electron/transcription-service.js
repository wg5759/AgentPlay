const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// 离线录音转写：whisper.cpp（whisper-cli）+ ggml-tiny 模型。
// whisper-cli 原生可读 mp3/ogg/flac/wav；其它音频与视频先经 mpv 抽音为 wav。
const DIRECT_AUDIO_EXTS = ['.mp3', '.ogg', '.flac', '.wav']
const EXTRACT_AUDIO_EXTS = ['.m4a', '.aac', '.wma', '.mp4', '.mkv', '.mov', '.webm', '.ts', '.m4v', '.wmv', '.flv', '.3gp', '.mpg', '.mpeg']
const TIMEOUT_MS = 15 * 60 * 1000

class TranscriptionService {
  constructor({ whisperRoot, mpvPath, spawnImpl, timeoutMs } = {}) {
    this.whisperRoot = whisperRoot ? path.resolve(whisperRoot) : whisperRoot
    this.mpvPath = mpvPath
    this.spawnImpl = spawnImpl || spawn
    this.timeoutMs = timeoutMs || TIMEOUT_MS
  }

  availability() {
    const engineOk = fs.existsSync(path.join(this.whisperRoot, 'engine', 'whisper-cli.exe'))
    const modelOk = fs.existsSync(path.join(this.whisperRoot, 'ggml-tiny.bin'))
    return {
      available: engineOk && modelOk,
      engineOk,
      modelOk,
      reason: !engineOk ? '转写引擎未安装（whisper 组件包）' : !modelOk ? '转写模型未安装（ggml-tiny）' : ''
    }
  }

  exec(file, args, timeoutMs, options = {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(file, args, { windowsHide: true, ...options })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(value)
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* 已退出 */ }
        finish(reject, new Error('转写超时'))
      }, timeoutMs || this.timeoutMs)
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
      child.on('error', (error) => finish(reject, error))
      child.on('close', (code) => {
        if (code === 0) finish(resolve, stdout)
        else finish(reject, new Error(stderr.trim().split('\n').pop() || `转写进程退出 (${code})`))
      })
    })
  }

  async transcribe({ sourcePath, lang = 'zh', timestamps = false, onProgress }) {
    const status = this.availability()
    if (!status.available) throw new Error(`${status.reason}，请先在模型接入中心下载转写组件`)
    const ext = path.extname(sourcePath).toLowerCase()
    if (![...DIRECT_AUDIO_EXTS, ...EXTRACT_AUDIO_EXTS].includes(ext)) {
      throw new Error(`不支持转写的格式：${ext || '未知'}（支持音频 mp3/wav/m4a/flac/ogg/aac/wma 与常见视频）`)
    }
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-whisper-'))
    try {
      // whisper-cli 的 C 运行时会把 argv 里的中文路径转成乱码并直接崩溃（0xC0000409）。
      // 因此：模型用相对路径（cwd=whisperRoot），输入一律暂存到 ASCII 安全名下。
      let input = sourcePath
      if (EXTRACT_AUDIO_EXTS.includes(ext)) {
        onProgress?.('正在提取音轨')
        const wavPath = path.join(tempDir, 'audio.wav')
        await this.exec(this.mpvPath, ['--no-video', '--ao=pcm', `--ao-pcm-file=${wavPath}`, sourcePath], 5 * 60 * 1000)
        input = wavPath
      } else if (/[^\x00-\x7F]/.test(input) || !path.isAbsolute(input)) {
        const staged = path.join(tempDir, `audio${ext}`)
        fs.copyFileSync(input, staged)
        input = staged
      }
      onProgress?.('正在离线转写（CPU 需要数倍于音频时长，可取消）')
      const args = ['-m', 'ggml-tiny.bin', '-l', lang, '-f', input, '-nt', '-np']
      if (timestamps) args.push('-osrt')
      const output = await this.exec(path.join(this.whisperRoot, 'engine', 'whisper-cli.exe'), args, this.timeoutMs, { cwd: this.whisperRoot })
      let text = output.trim()
      if (timestamps) {
        const srtPath = `${input}.srt`
        if (fs.existsSync(srtPath)) text = fs.readFileSync(srtPath, 'utf8').trim()
      }
      if (!text) throw new Error('没有识别到语音内容（可能是纯音乐或音量过低）')
      return { text, timestamps }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }
}

module.exports = { TranscriptionService, DIRECT_AUDIO_EXTS, EXTRACT_AUDIO_EXTS }
