const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { formidable } = require('formidable')

function uploadPage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI播放器 WiFi传文件</title></head><body style="font-family:system-ui;padding:20px;max-width:500px;margin:0 auto;background:#0a0a0a;color:#fff">
<h2>AI播放器 WiFi 传文件</h2>
<p style="color:#888">请输入电脑端 AI播放器 显示的 6 位配对 PIN。</p>
<form id="upload-form">
  <input id="pin" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="6 位 PIN" required style="display:block;margin:10px 0;padding:10px;width:100%;box-sizing:border-box">
  <input type="file" name="file" multiple style="margin:10px 0;color:#fff">
  <button type="submit" style="padding:10px 20px;background:#3b82f6;color:#fff;border:none;border-radius:6px">上传</button>
</form>
<p id="status" style="color:#aaa"></p>
<script>
document.getElementById('upload-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = new FormData(event.currentTarget)
  const status = document.getElementById('status')
  status.textContent = '上传中…'
  try {
    const response = await fetch('/', { method: 'POST', headers: { 'X-AI-Player-PIN': document.getElementById('pin').value }, body: form })
    status.textContent = await response.text()
  } catch { status.textContent = '上传失败' }
})
</script>
</body></html>`
}

class WifiTransfer {
  constructor() {
    this.server = null
    this.port = 18900
    this.uploadDir = path.join(os.homedir(), 'Videos', 'ai-player-uploads')
    this.pin = String(Math.floor(100000 + Math.random() * 900000))
  }

  async start() {
    if (this.server) return this.getUrl()
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true })
    }
    this.server = http.createServer((req, res) => this.handle(req, res))
    this.port = await require('./utils').listenWithFallback(this.server, this.port)
    console.log('[WifiTransfer] 用户已启用：' + this.getUrl())
    return this.getUrl()
  }

  getUrl() {
    return `http://${this.getLanIp()}:${this.port}`
  }

  getPin() {
    return this.pin
  }

  getLanIp() {
    return require('./utils').getLanIp()
  }

  handle(req, res) {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(uploadPage())
    } else if (req.method === 'POST') {
      if (String(req.headers['x-ai-player-pin'] || '') !== this.pin) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Connection': 'close' })
        res.end('PIN 错误，请查看电脑端显示的 PIN')
        return
      }
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-upload-'))
      const form = formidable({
        uploadDir: tempDir,
        keepExtensions: true,
        maxFiles: 20,
        maxFileSize: 1024 * 1024 * 1024,
        maxTotalFileSize: 2 * 1024 * 1024 * 1024
      })
      form.parse(req, (err, fields, files) => {
        if (err) {
          fs.rmSync(tempDir, { recursive: true, force: true })
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end('上传失败')
          return
        }
        const uploaded = Array.isArray(files.file) ? files.file : files.file ? [files.file] : []
        for (const file of uploaded) {
          const safeName = path.basename(file.originalFilename || file.newFilename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
          let destination = path.join(this.uploadDir, safeName)
          if (fs.existsSync(destination)) {
            const ext = path.extname(safeName)
            destination = path.join(this.uploadDir, `${path.basename(safeName, ext)}-${Date.now()}${ext}`)
          }
          fs.copyFileSync(file.filepath, destination)
        }
        fs.rmSync(tempDir, { recursive: true, force: true })
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<p style="font-family:system-ui">上传成功（${uploaded.length} 个文件），可关闭此页</p>`)
      })
    } else {
      res.writeHead(405)
      res.end()
    }
  }

  stop() {
    if (this.server) this.server.close()
    this.server = null
  }
}

module.exports = { WifiTransfer }
