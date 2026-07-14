// mpv sidecar 服务（桌面端播放内核）
// 启动 mpv 子进程，命名管道 JSON IPC 双向通信，属性变化事件转发
const { spawn } = require('child_process')
const net = require('net')
const path = require('path')
const fs = require('fs')

class MpvService {
  constructor() {
    this.proc = null
    this.ipc = null
    this.ipcPath = null
    this.buffer = ''
    this.observers = new Set()
  }

  getBinaryPath() {
    const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
    const exe = process.platform === 'win32' ? 'mpv.exe' : 'mpv'
    return path.join(__dirname, '..', 'resources', 'bin', platform, exe)
  }

  isAvailable() {
    return fs.existsSync(this.getBinaryPath())
  }

  on(cb) { this.observers.add(cb) }
  off(cb) { this.observers.delete(cb) }
  emit(event, data) { this.observers.forEach((cb) => cb(event, data)) }

  async start() {
    if (!this.isAvailable()) {
      console.log('[MpvService] mpv 二进制未就绪: ' + this.getBinaryPath())
      return false
    }
    this.ipcPath =
      process.platform === 'win32'
        ? '\\\\.\\pipe\\mpv-' + Date.now()
        : '/tmp/mpv-' + Date.now() + '.sock'

    this.proc = spawn(
      this.getBinaryPath(),
      [
        '--idle',
        '--no-terminal',
        '--no-config',
        '--force-window',
        '--no-border',
        '--keep-open=yes',
        `--input-ipc-server=${this.ipcPath}`,
        '--vo=gpu',
        '--hwdec=auto'
      ],
      { cwd: path.dirname(this.getBinaryPath()) }
    )

    this.proc.on('error', (err) => console.error('[MpvService] mpv 启动失败:', err))
    this.proc.on('exit', (code) => console.log(`[MpvService] mpv 退出 code=${code}`))

    await new Promise((r) => setTimeout(r, 800))
    this.connectIpc()

    // 订阅属性变化（播放位置/时长/暂停/结束/音量）
    this.send({ command: ['observe_property', 1, 'time-pos'] })
    this.send({ command: ['observe_property', 2, 'duration'] })
    this.send({ command: ['observe_property', 3, 'pause'] })
    this.send({ command: ['observe_property', 4, 'eof-reached'] })
    this.send({ command: ['observe_property', 5, 'volume'] })

    console.log('[MpvService] mpv 已启动，IPC: ' + this.ipcPath)
    return true
  }

  connectIpc() {
    if (!this.ipcPath) return
    this.ipc = net.connect(this.ipcPath)
    this.ipc.on('connect', () => console.log('[MpvService] IPC 已连接'))
    this.ipc.on('data', (data) => this.handleData(data))
    this.ipc.on('error', (err) => console.error('[MpvService] IPC 错误:', err))
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
    if (!this.ipc) return
    this.ipc.write(JSON.stringify(cmd) + '\n')
  }

  loadFile(filePath) { this.send({ command: ['loadfile', filePath] }) }
  play() { this.send({ command: ['set_property', 'pause', false] }) }
  pause() { this.send({ command: ['set_property', 'pause', true] }) }
  seek(seconds) { this.send({ command: ['seek', seconds, 'absolute'] }) }
  setVolume(level) { this.send({ command: ['set_property', 'volume', level] }) }
  loadSubtitle(filePath) { this.send({ command: ['sub-add', filePath] }) }

  stop() {
    if (this.ipc) { this.ipc.destroy(); this.ipc = null }
    if (this.proc) { this.proc.kill(); this.proc = null }
  }
}

module.exports = { MpvService }
