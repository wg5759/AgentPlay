const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { formidable } = require('formidable')

const UPLOAD_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI播放器 WiFi传文件</title></head><body style="font-family:system-ui;padding:20px;max-width:500px;margin:0 auto;background:#0a0a0a;color:#fff">
<h2>AI播放器 WiFi 传文件</h2>
<p style="color:#888">选择文件上传到电脑</p>
<form method="POST" enctype="multipart/form-data">
  <input type="file" name="file" multiple style="margin:10px 0;color:#fff">
  <button type="submit" style="padding:10px 20px;background:#3b82f6;color:#fff;border:none;border-radius:6px">上传</button>
</form>
</body></html>`

class WifiTransfer {
  constructor() {
    this.server = null
    this.port = 18900
    this.uploadDir = path.join(os.homedir(), 'Videos', 'ai-player-uploads')
  }

  start() {
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true })
    }
    this.server = http.createServer((req, res) => this.handle(req, res))
    this.server.listen(this.port)
    const url = this.getUrl()
    console.log('[WifiTransfer] ' + url)
    return url
  }

  getUrl() {
    return `http://${this.getLanIp()}:${this.port}`
  }

  getLanIp() {
    const nets = os.networkInterfaces()
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) return net.address
      }
    }
    return '127.0.0.1'
  }

  handle(req, res) {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(UPLOAD_PAGE)
    } else if (req.method === 'POST') {
      const form = formidable({
        uploadDir: this.uploadDir,
        keepExtensions: true
      })
      form.parse(req, (err) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end('上传失败')
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
