// mpv sidecar 服务（桌面端播放内核）
// 启动 mpv 子进程，命名管道 JSON IPC 双向通信，属性变化事件转发
const { spawn } = require('child_process')
const net = require('net')
const path = require('path')
const fs = require('fs')

function normalizeMediaSource(source) {
  if (!/^smb:\/\//i.test(source)) return source
  try {
    const url = new URL(source)
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    return `\\\\${url.hostname}\\${segments.join('\\')}`
  } catch {
    return source
  }
}

class MpvService {
  constructor() {
    this.proc = null
    this.ipc = null
    this.ipcPath = null
    this.buffer = ''
    this.observers = new Set()
    this.embedded = false
    this.stopping = false
  }

  getBinaryPath() {
    const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
    const exe = process.platform === 'win32' ? 'mpv.exe' : 'mpv'
    const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'bin', platform, exe) : null
    if (packaged && fs.existsSync(packaged)) return packaged
    return path.join(__dirname, '..', 'resources', 'bin', platform, exe)
  }

  isAvailable() {
    return fs.existsSync(this.getBinaryPath())
  }

  on(cb) { this.observers.add(cb) }
  off(cb) { this.observers.delete(cb) }
  emit(event, data) { this.observers.forEach((cb) => cb(event, data)) }

  async start(embedHwnd = null) {
    if (this.proc && !this.proc.killed && this.ipc && !this.ipc.destroyed) return true
    if (!this.isAvailable()) {
      console.log('[MpvService] mpv 二进制未就绪: ' + this.getBinaryPath())
      return false
    }
    this.ipcPath =
      process.platform === 'win32'
        ? '\\\\.\\pipe\\mpv-' + Date.now()
        : '/tmp/mpv-' + Date.now() + '.sock'

    const args = [
      '--idle',
      '--no-terminal',
      '--no-config',
      '--keep-open=yes',
      `--input-ipc-server=${this.ipcPath}`,
      '--vo=gpu',
      '--hwdec=auto',
      '--scale=ewa_lanczossharp',
      '--cscale=ewa_lanczossharp',
      '--dscale=mitchell',
      '--target-colorspace-hint=yes'
    ]
    if (embedHwnd) {
      args.push('--no-border', '--input-vo-keyboard=no', '--input-cursor-passthrough=yes')
      args.push(`--wid=${embedHwnd}`)
      this.embedded = true
      console.log('[MpvService] 嵌入模式 --wid=' + embedHwnd)
    } else {
      this.embedded = false
      args.push('--title=AI播放器 - mpv 兼容模式')
      console.log('[MpvService] 兼容模式待命（HTML5 不支持时使用独立 mpv 窗口）')
    }

    this.proc = spawn(this.getBinaryPath(), args, {
      cwd: path.dirname(this.getBinaryPath())
    })

    this.stopping = false
    this.proc.on('error', (err) => {
      console.error('[MpvService] mpv 启动失败:', err)
      this.emit('status', { ready: false, error: err.message })
    })
    this.proc.on('exit', (code) => {
      console.log(`[MpvService] mpv 退出 code=${code}`)
      if (this.ipc) this.ipc.destroy()
      this.ipc = null
      this.proc = null
      this.emit('status', { ready: false, stopped: this.stopping, code })
    })

    for (let i = 0; i < 20; i++) {
      if (!this.proc) break
      await new Promise((r) => setTimeout(r, 150))
      if (await this.connectIpc()) break
    }
    if (!this.ipc || this.ipc.destroyed) {
      console.error('[MpvService] IPC 连接失败，请检查 mpv 启动')
      return false
    }

    // 订阅属性变化（播放位置/时长/暂停/结束/音量）
    this.send({ command: ['observe_property', 1, 'time-pos'] })
    this.send({ command: ['observe_property', 2, 'duration'] })
    this.send({ command: ['observe_property', 3, 'pause'] })
    this.send({ command: ['observe_property', 4, 'eof-reached'] })
    this.send({ command: ['observe_property', 5, 'volume'] })

    console.log('[MpvService] mpv 已启动，IPC: ' + this.ipcPath)
    this.emit('status', { ready: true, embedded: this.embedded })
    return !!this.ipc && !this.ipc.destroyed
  }

  connectIpc() {
    if (!this.ipcPath) return Promise.resolve(false)
    if (this.ipc && !this.ipc.destroyed) return Promise.resolve(true)
    return new Promise((resolve) => {
      const socket = net.connect(this.ipcPath)
      let settled = false
      const finish = (ok) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (!ok) socket.destroy()
        resolve(ok)
      }
      const timer = setTimeout(() => finish(false), 250)
      socket.once('connect', () => {
        this.ipc = socket
        socket.on('data', (data) => this.handleData(data))
        socket.on('error', (err) => {
          if (!this.stopping) console.error('[MpvService] IPC 错误:', err.message)
        })
        socket.on('close', () => {
          if (this.ipc === socket) this.ipc = null
        })
        console.log('[MpvService] IPC 已连接')
        finish(true)
      })
      socket.once('error', () => finish(false))
    })
  }

  handleData(data) {
    this.buffer += data.toString()
    let idx
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.event === 'property-change') {
          this.emit('property', { name: msg.name, data: msg.data })
        }
      } catch (e) {
        /* 忽略非 JSON */
      }
    }
  }

  send(cmd) {
    if (!this.ipc || this.ipc.destroyed || !this.ipc.writable) return false
    this.ipc.write(JSON.stringify(cmd) + '\n')
    return true
  }

  loadFile(filePath) { return this.send({ command: ['loadfile', normalizeMediaSource(filePath)] }) }
  play() { return this.send({ command: ['set_property', 'pause', false] }) }
  pause() { return this.send({ command: ['set_property', 'pause', true] }) }
  seek(seconds) { return this.send({ command: ['seek', seconds, 'absolute'] }) }
  setVolume(level) { return this.send({ command: ['set_property', 'volume', level] }) }
  setSpeed(rate) { return this.send({ command: ['set_property', 'speed', rate] }) }
  setPictureMode(mode) {
    const allowed = new Set(['original', 'fit', 'fill', 'stretch'])
    const safeMode = allowed.has(mode) ? mode : 'fit'
    // Keep HTML5 and compatibility playback on the same aspect-ratio policy.
    if (safeMode === 'stretch') {
      this.send({ command: ['set_property', 'panscan', 0] })
      this.send({ command: ['set_property', 'video-unscaled', 'no'] })
      return this.send({ command: ['set_property', 'keepaspect', false] })
    }
    this.send({ command: ['set_property', 'keepaspect', true] })
    this.send({ command: ['set_property', 'video-unscaled', safeMode === 'original' ? 'downscale-big' : 'no'] })
    return this.send({ command: ['set_property', 'panscan', safeMode === 'fill' ? 1 : 0] })
  }
  loadSubtitle(filePath) { return this.send({ command: ['sub-add', filePath] }) }
  setSubtitleVisible(visible) { return this.send({ command: ['set_property', 'sub-visibility', visible] }) }
  stopPlayback() { return this.send({ command: ['stop'] }) }
  screenshot(filePath) { return this.send({ command: ['screenshot-to-file', filePath, 'video'] }) }

  stop() {
    this.stopping = true
    if (this.ipc) { this.ipc.destroy(); this.ipc = null }
    if (this.proc) { this.proc.kill(); this.proc = null }
  }
}

module.exports = { MpvService, normalizeMediaSource }
