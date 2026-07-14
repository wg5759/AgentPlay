const dgram = require('dgram')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

class CastService {
  constructor() {
    this.devices = []
    this.fileServer = null
    this.fileServerPort = 18901
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

  scan() {
    return new Promise((resolve) => {
      this.devices = []
      const socket = dgram.createSocket('udp4')
      const msg =
        'M-SEARCH * HTTP/1.1\r\n' +
        'HOST: 239.255.255.250:1900\r\n' +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 3\r\n' +
        'ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n'
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
      const resp = await fetch(location)
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
        controlUrl: baseUrl.origin + ctrlMatch[1]
      }
    } catch {
      return null
    }
  }

  startFileServer() {
    if (this.fileServer) return
    this.fileServer = http.createServer((req, res) => {
      const filePath = decodeURIComponent(req.url.slice(1))
      const allowedRoots = [
        path.join(os.homedir(), 'Videos'),
        path.join(os.homedir(), 'Movies'),
        path.join(os.homedir(), '视频')
      ]
      const resolved = path.resolve(filePath)
      if (
        !filePath ||
        !allowedRoots.some((d) => resolved === d || resolved.startsWith(d + path.sep))
      ) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (fs.existsSync(resolved)) {
        const stat = fs.statSync(resolved)
        res.writeHead(200, {
          'Content-Length': stat.size,
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes'
        })
        fs.createReadStream(resolved).pipe(res)
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    this.fileServer.listen(this.fileServerPort)
  }

  async cast(deviceId, filePath) {
    const device = this.devices.find((d) => d.id === deviceId)
    if (!device) {
      return { success: false, error: '设备未找到，请先扫描' }
    }
    this.startFileServer()
    const mediaUrl = `http://${this.getLanIp()}:${this.fileServerPort}/${encodeURIComponent(filePath)}`
    const body =
      '<?xml version="1.0"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      '<s:Body>' +
      '<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">' +
      '<InstanceID>0</InstanceID>' +
      `<CurrentURI>${mediaUrl}</CurrentURI>` +
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
  }
}

module.exports = { CastService }
