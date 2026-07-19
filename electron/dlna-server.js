const crypto = require('crypto')
const dgram = require('dgram')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { getType } = require('./file-service')
const { getLanIp } = require('./utils')

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

class DlnaServer {
  constructor() {
    this.port = 18904
    this.server = null
    this.sharedDir = null
    this.ssdpSocket = null
    this.mediaFiles = new Map()
    this.udn = `uuid:aiplayer-server-${crypto.createHash('sha1').update(os.hostname()).digest('hex').slice(0, 12)}`
  }

  async start(dir) {
    this.sharedDir = path.resolve(dir)
    this.refreshLibrary()
    this.server = http.createServer((req, res) => this.handle(req, res))
    this.port = await require('./utils').listenWithFallback(this.server, this.port)
    this.startSsdp()
    return `http://${getLanIp()}:${this.port}`
  }

  startSsdp() {
    this.ssdpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.ssdpSocket.on('error', () => {})
    this.ssdpSocket.on('message', (message, remote) => {
      const text = message.toString()
      if (/M-SEARCH/i.test(text) && /(MediaServer|ssdp:all)/i.test(text)) this.respondToSearch(remote)
    })
    this.ssdpSocket.bind(1900, () => {
      try { this.ssdpSocket.addMembership('239.255.255.250') } catch {}
      this.ssdpSocket.setBroadcast(true)
      this.notify()
    })
    this.notifyTimer = setInterval(() => this.notify(), 30000)
  }

  respondToSearch(remote) {
    const response = [
      'HTTP/1.1 200 OK',
      'CACHE-CONTROL: max-age=1800',
      `LOCATION: http://${getLanIp()}:${this.port}/server.xml`,
      'SERVER: AIPlayer/1.0 UPnP/1.1',
      'ST: urn:schemas-upnp-org:device:MediaServer:1',
      `USN: ${this.udn}::urn:schemas-upnp-org:device:MediaServer:1`,
      '', ''
    ].join('\r\n')
    try { this.ssdpSocket.send(response, remote.port, remote.address) } catch {}
  }

  notify() {
    if (!this.ssdpSocket) return
    const message = [
      'NOTIFY * HTTP/1.1',
      'HOST: 239.255.255.250:1900',
      `LOCATION: http://${getLanIp()}:${this.port}/server.xml`,
      'NT: urn:schemas-upnp-org:device:MediaServer:1',
      'NTS: ssdp:alive',
      `USN: ${this.udn}::urn:schemas-upnp-org:device:MediaServer:1`,
      '', ''
    ].join('\r\n')
    try { this.ssdpSocket.send(message, 1900, '239.255.255.250') } catch {}
  }

  handle(req, res) {
    const requestUrl = new URL(req.url, 'http://localhost')
    if (requestUrl.pathname === '/server.xml') {
      this.sendXml(res, this.deviceXml())
    } else if (requestUrl.pathname === '/cd/scpd.xml') {
      this.sendXml(res, this.scpdXml())
    } else if (requestUrl.pathname === '/cd/control' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => { if (body.length < 1024 * 1024) body += chunk })
      req.on('end', () => this.handleControl(req, res, body))
    } else if (requestUrl.pathname === '/list') {
      this.refreshLibrary()
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify([...this.mediaFiles.values()].map(({ id, name, size }) => ({ id, name, size }))))
    } else if (requestUrl.pathname.startsWith('/media/')) {
      this.serveMedia(req, res, requestUrl.pathname.slice('/media/'.length))
    } else {
      res.writeHead(404)
      res.end()
    }
  }

  handleControl(req, res, body) {
    const action = String(req.headers.soapaction || '')
    if (/Browse/i.test(action) || /<[^>]*Browse[ >]/i.test(body)) {
      this.refreshLibrary()
      const didl = this.didlLite()
      const count = this.mediaFiles.size
      const response = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:BrowseResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><Result>${xmlEscape(didl)}</Result><NumberReturned>${count}</NumberReturned><TotalMatches>${count}</TotalMatches><UpdateID>1</UpdateID></u:BrowseResponse></s:Body></s:Envelope>`
      this.sendXml(res, response)
      return
    }
    res.writeHead(500, { 'Content-Type': 'text/xml; charset=utf-8' })
    res.end('<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>Unsupported action</faultstring></s:Fault></s:Body></s:Envelope>')
  }

  sendXml(res, xml) {
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(xml) })
    res.end(xml)
  }

  refreshLibrary() {
    this.mediaFiles.clear()
    for (const file of this.scanDir(this.sharedDir)) this.mediaFiles.set(file.id, file)
  }

  scanDir(dir, depth = 0) {
    if (depth > 10 || !dir) return []
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
    const results = []
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) results.push(...this.scanDir(fullPath, depth + 1))
      else if (entry.isFile()) {
        const type = getType(path.extname(entry.name).toLowerCase())
        if (!['video', 'audio', 'image'].includes(type)) continue
        const relative = path.relative(this.sharedDir, fullPath)
        const id = crypto.createHash('sha1').update(relative).digest('hex')
        let size = 0
        try { size = fs.statSync(fullPath).size } catch {}
        results.push({ id, name: entry.name, path: fullPath, size, type })
      }
    }
    return results
  }

  didlLite() {
    const host = `http://${getLanIp()}:${this.port}`
    const items = [...this.mediaFiles.values()].map((file) => {
      const upnpClass = file.type === 'audio' ? 'object.item.audioItem.musicTrack' : file.type === 'image' ? 'object.item.imageItem.photo' : 'object.item.videoItem'
      return `<item id="${file.id}" parentID="0" restricted="1"><dc:title>${xmlEscape(file.name)}</dc:title><upnp:class>${upnpClass}</upnp:class><res protocolInfo="http-get:*:${this.mimeType(file.path)}:*" size="${file.size}">${xmlEscape(`${host}/media/${file.id}`)}</res></item>`
    }).join('')
    return `<?xml version="1.0"?><DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${items}</DIDL-Lite>`
  }

  serveMedia(req, res, id) {
    const file = this.mediaFiles.get(id)
    if (!file || !fs.existsSync(file.path)) {
      res.writeHead(404)
      res.end()
      return
    }
    const stat = fs.statSync(file.path)
    const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/)
    const start = range && range[1] ? Number(range[1]) : 0
    const end = range && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1
    if (start < 0 || end < start || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
      res.end()
      return
    }
    const headers = {
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': this.mimeType(file.path)
    }
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`
    res.writeHead(range ? 206 : 200, headers)
    if (req.method === 'HEAD') res.end()
    else fs.createReadStream(file.path, { start, end }).pipe(res)
  }

  mimeType(filePath) {
    return ({
      '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
      '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'
    })[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
  }

  deviceXml() {
    return `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType><friendlyName>AI播放器媒体库</friendlyName><manufacturer>AIPlayer</manufacturer><modelName>AIPlayer Media Server</modelName><UDN>${this.udn}</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType><serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId><SCPDURL>/cd/scpd.xml</SCPDURL><controlURL>/cd/control</controlURL><eventSubURL>/cd/event</eventSubURL></service></serviceList></device></root>`
  }

  scpdXml() {
    return `<?xml version="1.0"?><scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><actionList><action><name>Browse</name></action><action><name>GetSearchCapabilities</name></action><action><name>GetSortCapabilities</name></action><action><name>GetSystemUpdateID</name></action></actionList><serviceStateTable></serviceStateTable></scpd>`
  }

  stop() {
    if (this.notifyTimer) clearInterval(this.notifyTimer)
    if (this.ssdpSocket) this.ssdpSocket.close()
    if (this.server) this.server.close()
    this.ssdpSocket = null
    this.server = null
  }
}

module.exports = { DlnaServer }
