const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { formidable } = require('formidable')

function uploadPage(pin) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI播放器 WiFi传文件</title></head><body style="font-family:system-ui;padding:20px;max-width:500px;margin:0 auto;background:#0a0a0a;color:#fff">
<h2>AI播放器 WiFi 传文件</h2>
<p style="color:#888">配对 PIN：<b style="color:#3b82f6;font-size:1.5em">${pin}</b>（在电脑端 AI播放器 显示）</p>
<form method="POST" enctype="multipart/form-data">
  <input type="hidden" name="pin" value="${pin}">
  <input type="file" name="file" multiple style="margin:10px 0;color:#fff">
  <button type="submit" style="padding:10px 20px;background:#3b82f6;color:#fff;border:none;border-radius:6px">上传</button>
</form>
</body></html>`
}

class WifiTransfer {
  constructor() {
    this.server = null
    this.port = 18900
    this.uploadDir = path.join(os.homedir(), 'Videos', 'ai-player-uploads')
    this.pin = String(Math.floor(100000 + Math.random() * 900000))
  }

  start() {
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true })
    }
    this.server = http.createServer((req, res) => this.handle(req, res))
    this.server.listen(this.port)
    console.log('[WifiTransfer] ' + this.getUrl() + ' PIN=' + this.pin)
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
      res.end(uploadPage(this.pin))
    } else if (req.method === 'POST') {
      const form = formidable({
        uploadDir: this.uploadDir,
        keepExtensions: true,
        maxFileSize: 1024 * 1024 * 1024
      })
      form.parse(req, (err, fields) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end('上传失败')
          return
        }
        const submittedPin = Array.isArray(fields.pin) ? fields.pin[0] : fields.pin
        if (submittedPin !== this.pin) {
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end('<p style="font-family:system-ui">PIN 错误，请查看电脑端显示的 PIN</p>')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<p style="font-family:system-ui">上传成功，可关闭此页</p>')
      })
    }
  }

  stop() {
    if (this.server) this.server.close()
  }
}

module.exports = { WifiTransfer }
