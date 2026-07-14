const http = require('http')
const os = require('os')

class SyncService {
  constructor() {
    this.server = null
    this.port = 18902
    this.deviceId = os.hostname()
    this.peerUrl = null
    this.progress = {}
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

  start() {
    this.server = http.createServer((req, res) => this.handle(req, res))
    this.server.listen(this.port)
    return this.getUrl()
  }

  getUrl() {
    return `http://${this.getLanIp()}:${this.port}`
  }

  handle(req, res) {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ deviceId: this.deviceId, progress: this.progress }))
    } else if (req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          for (const [hash, val] of Object.entries(data.progress || {})) {
            const v = val
            if (!this.progress[hash] || v.updatedAt > this.progress[hash].updatedAt) {
              this.progress[hash] = v
            }
          }
          res.writeHead(200)
          res.end('ok')
        } catch {
          res.writeHead(400)
          res.end()
        }
      })
    }
  }

  async upload() {
    if (!this.peerUrl) return { error: '未配置对端设备' }
    try {
      await fetch(this.peerUrl + '/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: this.deviceId, progress: this.progress })
      })
      return { success: true, count: Object.keys(this.progress).length }
    } catch (e) {
      return { error: String(e) }
    }
  }

  async download() {
    if (!this.peerUrl) return { error: '未配置对端设备' }
    try {
      const resp = await fetch(this.peerUrl + '/progress')
      const data = await resp.json()
      for (const [hash, val] of Object.entries(data.progress || {})) {
        const v = val
        if (!this.progress[hash] || v.updatedAt > this.progress[hash].updatedAt) {
          this.progress[hash] = v
        }
      }
      return { success: true, count: Object.keys(data.progress || {}).length }
    } catch (e) {
      return { error: String(e) }
    }
  }

  setProgress(hash, position, preferences) {
    this.progress[hash] = { position, preferences, updatedAt: Date.now() }
  }

  getProgress(hash) {
    return this.progress[hash] || null
  }

  setPeer(url) {
    this.peerUrl = url
  }

  stop() {
    if (this.server) this.server.close()
  }
}

module.exports = { SyncService }
