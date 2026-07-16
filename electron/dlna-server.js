const dgram = require('dgram')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { getLanIp } = require('./utils')

class DlnaServer {
  constructor() {
    this.port = 18904
    this.server = null
    this.sharedDir = null
    this.ssdpSocket = null
  }

  start(dir) {
    this.sharedDir = dir
    this.server = http.createServer((req, res) => this.handle(req, res))
    this.server.listen(this.port)
    this.startSsdp()
    return `http://${getLanIp()}:${this.port}`
  }

  startSsdp() {
    this.ssdpSocket = dgram.createSocket('udp4')
    this.ssdpSocket.bind(1900, () => {
      try { this.ssdpSocket.addMembership('239.255.255.250') } catch {}
    })
    const notify = () => {
      const msg = [
        'NOTIFY * HTTP/1.1', 'HOST: 239.255.255.250:1900',
        'LOCATION: http://' + getLanIp() + ':' + this.port + '/server.xml',
        'NT: urn:schemas-upnp-org:device:MediaServer:1', 'NTS: ssdp:alive',
        'USN: uuid:aiplayer-server::urn:schemas-upnp-org:device:MediaServer:1', '', ''
      ].join('\r\n')
      try { this.ssdpSocket.send(msg, 1900, '239.255.255.250') } catch {}
    }
    notify()
    this.notifyTimer = setInterval(notify, 30000)
  }

  handle(req, res) {
    if (req.url === '/server.xml') {
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' })
      res.end(`<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType><friendlyName>AI播放器媒体库</friendlyName><serviceList><service><serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType><serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId><SCPDURL>/cd</SCPDURL><controlURL>/cd/control</controlURL></service></serviceList></device></root>`)
    } else if (req.url === '/list') {
      const files = this.scanDir(this.sharedDir)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(files))
    } else {
      const filePath = decodeURIComponent(req.url.slice(1))
      const resolved = path.resolve(filePath)
      if (!resolved.startsWith(path.resolve(this.sharedDir))) {
        res.writeHead(403); res.end('forbidden'); return
      }
      if (fs.existsSync(resolved)) {
        const stat = fs.statSync(filePath)
        res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4' })
        fs.createReadStream(filePath).pipe(res)
      } else { res.writeHead(404); res.end() }
    }
  }

  scanDir(dir, depth = 0) {
    if (depth > 10 || !dir) return []
    const results = []
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) results.push(...this.scanDir(full, depth + 1))
      else if (e.isFile()) results.push({ name: e.name, url: `http://${getLanIp()}:${this.port}/${encodeURIComponent(full)}` })
    }
    return results
  }

  stop() {
    if (this.notifyTimer) clearInterval(this.notifyTimer)
    if (this.ssdpSocket) this.ssdpSocket.close()
    if (this.server) this.server.close()
  }
}

module.exports = { DlnaServer }
