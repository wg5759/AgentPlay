const http = require('http')
const os = require('os')
const fs = require('fs')
const path = require('path')

class SyncService {
  constructor(storagePath = null) {
    this.server = null
    this.port = 18902
    this.deviceId = os.hostname()
    this.peerUrl = null
    this.peerToken = null
    this.storagePath = storagePath
    this.progress = this.loadProgress()
    this.token = require('crypto').randomUUID()
  }

  getLanIp() {
    return require('./utils').getLanIp()
  }

  loadProgress() {
    if (!this.storagePath) return {}
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  saveProgress() {
    if (!this.storagePath) return
    try {
      fs.mkdirSync(path.dirname(this.storagePath), { recursive: true })
      const tempPath = `${this.storagePath}.tmp`
      fs.writeFileSync(tempPath, JSON.stringify(this.progress), 'utf8')
      fs.renameSync(tempPath, this.storagePath)
    } catch {
      // Progress sync must not break playback if persistence is unavailable.
    }
  }

  async start() {
    if (this.server) return this.getUrl()
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost')
      if (url.searchParams.get('token') !== this.token) {
        res.writeHead(401); res.end('unauthorized'); return
      }
      this.handle(req, res)
    })
    this.port = await require('./utils').listenWithFallback(this.server, this.port)
    return this.getUrl()
  }

  getUrl() {
    return `http://${this.getLanIp()}:${this.port}?token=${this.token}`
  }

  handle(req, res) {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ deviceId: this.deviceId, progress: this.progress }))
    } else if (req.method === 'POST') {
      let body = ''
      let tooLarge = false
      req.on('data', (c) => {
        if (tooLarge) return
        body += c
        if (Buffer.byteLength(body) > 1024 * 1024) {
          tooLarge = true
          res.writeHead(413)
          res.end('payload too large')
          req.destroy()
        }
      })
      req.on('end', () => {
        if (tooLarge) return
        try {
          const data = JSON.parse(body)
          for (const [hash, val] of Object.entries(data.progress || {})) {
            const v = val
            if (!this.progress[hash] || v.updatedAt > this.progress[hash].updatedAt) {
              this.progress[hash] = v
            }
          }
          this.saveProgress()
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
      const resp = await fetch(this.peerEndpoint('/progress'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: this.deviceId, progress: this.progress })
      })
      if (!resp.ok) return { error: `对端拒绝同步（HTTP ${resp.status}）` }
      return { success: true, count: Object.keys(this.progress).length }
    } catch (e) {
      return { error: String(e) }
    }
  }

  async download() {
    if (!this.peerUrl) return { error: '未配置对端设备' }
    try {
      const resp = await fetch(this.peerEndpoint('/progress'))
      if (!resp.ok) return { error: `对端拒绝同步（HTTP ${resp.status}）` }
      const data = await resp.json()
      for (const [hash, val] of Object.entries(data.progress || {})) {
        const v = val
        if (!this.progress[hash] || v.updatedAt > this.progress[hash].updatedAt) {
          this.progress[hash] = v
        }
      }
      this.saveProgress()
      return { success: true, count: Object.keys(data.progress || {}).length }
    } catch (e) {
      return { error: String(e) }
    }
  }

  setProgress(hash, position, preferences) {
    this.progress[hash] = { position, preferences, updatedAt: Date.now() }
    this.saveProgress()
  }

  getProgress(hash) {
    return this.progress[hash] || null
  }

  setPeer(url) {
    try {
      const parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('仅支持 http/https')
      this.peerUrl = parsed.origin
      this.peerToken = parsed.searchParams.get('token')
      return true
    } catch (e) {
      this.peerUrl = null
      this.peerToken = null
      return false
    }
  }

  peerEndpoint(pathname) {
    const endpoint = new URL(pathname, this.peerUrl)
    if (this.peerToken) endpoint.searchParams.set('token', this.peerToken)
    return endpoint.toString()
  }

  stop() {
    if (this.server) this.server.close()
    this.server = null
  }
}

module.exports = { SyncService }
