const dgram = require('dgram')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

class CastService {
  constructor() {
    this.devices = []
    this.fileServer = null
    this.fileServerPort = 18901
    this.servedFiles = new Map()
  }

  getLanIp() {
    return require('./utils').getLanIp()
  }

  scan() {
    return new Promise((resolve) => {
      this.devices = []
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      const msg =
        'M-SEARCH * HTTP/1.1\r\n' +
        'HOST: 239.255.255.250:1900\r\n' +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 3\r\n' +
        'ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n'
      socket.on('error', () => {})
      socket.bind(() => {
        socket.setBroadcast(true)
        socket.send(msg, 1900, '239.255.255.250')
      })
      socket.on('message', async (data) => {
        const text = data.toString()
        const locMatch = text.match(/LOCATION: (.+)\r?\n/i)
        if (!locMatch) return
        const location = locMatch[1].trim()
        const device = await this.parseDevice(location)
        if (device && !this.devices.find((d) => d.id === location)) {
          this.devices.push(device)
        }
      })
      setTimeout(() => {
        socket.close()
        resolve(this.devices)
      }, 3000)
    })
  }

  async parseDevice(location) {
    try {
      const resp = await fetch(location, { signal: AbortSignal.timeout(5000) })
      const xml = await resp.text()
      const nameMatch = xml.match(/<friendlyName>([^<]+)<\/friendlyName>/)
      const ctrlMatch = xml.match(
        /<service>[\s\S]*?AVTransport[\s\S]*?<controlURL>([^<]+)<\/controlURL>[\s\S]*?<\/service>/
      )
      if (!ctrlMatch) return null
      const baseUrl = new URL(location)
      return {
        id: location,
        name: nameMatch ? nameMatch[1] : 'DLNA设备',
        location,
        controlUrl: new URL(ctrlMatch[1], baseUrl).toString()
      }
    } catch {
      return null
    }
  }

  async startFileServer() {
    if (this.fileServer) return
    this.fileServer = http.createServer((req, res) => {
      const requestUrl = new URL(req.url, 'http://localhost')
      const match = requestUrl.pathname.match(/^\/media\/([a-f0-9-]+)\//i)
      const entry = match ? this.servedFiles.get(match[1]) : null
      if (!entry || entry.expiresAt < Date.now()) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      const resolved = entry.path
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        res.writeHead(404)
        res.end()
        return
      }
      const stat = fs.statSync(resolved)
      const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/)
      const start = range && range[1] ? Number(range[1]) : 0
      const end = range && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1
      if (start < 0 || end < start || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
        res.end()
        return
      }
      const headers = {
        'Content-Length': end - start + 1,
        'Content-Type': this.mimeType(resolved),
        'Accept-Ranges': 'bytes'
      }
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`
      res.writeHead(range ? 206 : 200, headers)
      if (req.method === 'HEAD') res.end()
      else fs.createReadStream(resolved, { start, end }).pipe(res)
    })
    this.fileServerPort = await require('./utils').listenWithFallback(this.fileServer, this.fileServerPort)
  }

  mimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase()
    return ({
      '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
      '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.flac': 'audio/flac',
      '.wav': 'audio/wav', '.m4a': 'audio/mp4'
    })[ext] || 'application/octet-stream'
  }

  registerFile(filePath) {
    const resolved = path.resolve(filePath)
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error('投屏文件不存在')
    }
    const token = crypto.randomUUID()
    this.servedFiles.set(token, { path: resolved, expiresAt: Date.now() + 12 * 60 * 60 * 1000 })
    return `http://${this.getLanIp()}:${this.fileServerPort}/media/${token}/${encodeURIComponent(path.basename(resolved))}`
  }

  async cast(deviceId, filePath) {
    const device = this.devices.find((d) => d.id === deviceId)
    if (!device) {
      return { success: false, error: '设备未找到，请先扫描' }
    }
    await this.startFileServer()
    let mediaUrl
    try {
      mediaUrl = this.registerFile(filePath)
    } catch (e) {
      return { success: false, error: String(e) }
    }
    const xmlMediaUrl = mediaUrl.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    const body =
      '<?xml version="1.0"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      '<s:Body>' +
      '<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">' +
      '<InstanceID>0</InstanceID>' +
      `<CurrentURI>${xmlMediaUrl}</CurrentURI>` +
      '<CurrentURIMetaData></CurrentURIMetaData>' +
      '</u:SetAVTransportURI></s:Body></s:Envelope>'
    try {
      const resp = await fetch(device.controlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPAction: '"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"'
        },
        body
      })
      if (resp.ok) {
        const playBody = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play></s:Body></s:Envelope>'
        const playResp = await fetch(device.controlUrl, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: '"urn:schemas-upnp-org:service:AVTransport:1#Play"' }, body: playBody })
        if (!playResp.ok) return { success: false, error: `设备已接收文件但播放失败（HTTP ${playResp.status}）` }
      }
      return {
        success: resp.ok,
        action: resp.ok ? `已投屏到 ${device.name}` : `投屏失败 ${resp.status}`
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  stop() {
    if (this.fileServer) this.fileServer.close()
    this.fileServer = null
    this.servedFiles.clear()
  }
}

module.exports = { CastService }
