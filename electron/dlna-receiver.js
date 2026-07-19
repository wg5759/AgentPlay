const dgram = require('dgram')
const http = require('http')
const { getLanIp } = require('./utils')

class DlnaReceiver {
  constructor() {
    this.ssdpSocket = null
    this.httpServer = null
    this.port = 18903
    this.udn = 'uuid:aiplayer-' + Date.now()
    this.onPlay = null
  }

  async start() {
    if (this.httpServer) return `http://${getLanIp()}:${this.port}`
    await this.startHttp()
    this.startSsdp()
    this.notifyTimer = setInterval(() => this.notify(), 30000)
    this.notify()
    return `http://${getLanIp()}:${this.port}`
  }

  async startHttp() {
    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res))
    this.port = await require('./utils').listenWithFallback(this.httpServer, this.port)
  }

  startSsdp() {
    this.ssdpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.ssdpSocket.bind(1900, () => {
      try { this.ssdpSocket.addMembership('239.255.255.250') } catch {}
      this.ssdpSocket.setBroadcast(true)
    })
    this.ssdpSocket.on('message', (msg, rinfo) => {
      const text = msg.toString()
      if (text.includes('M-SEARCH') && /(MediaRenderer|ssdp:all)/i.test(text)) {
        this.respondToSearch(rinfo)
      }
    })
    this.ssdpSocket.on('error', () => {})
  }

  respondToSearch(rinfo) {
    const ip = getLanIp()
    const response = [
      'HTTP/1.1 200 OK',
      'CACHE-CONTROL: max-age=1800',
      'LOCATION: http://' + ip + ':' + this.port + '/device.xml',
      'SERVER: AIPlayer/1.0 UPnP/1.1',
      'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
      'USN: ' + this.udn + '::urn:schemas-upnp-org:device:MediaRenderer:1',
      '',
      ''
    ].join('\r\n')
    try { this.ssdpSocket.send(response, rinfo.port, rinfo.address) } catch {}
  }

  notify() {
    const ip = getLanIp()
    const msg = [
      'NOTIFY * HTTP/1.1',
      'HOST: 239.255.255.250:1900',
      'LOCATION: http://' + ip + ':' + this.port + '/device.xml',
      'NT: urn:schemas-upnp-org:device:MediaRenderer:1',
      'NTS: ssdp:alive',
      'USN: ' + this.udn + '::urn:schemas-upnp-org:device:MediaRenderer:1',
      '',
      ''
    ].join('\r\n')
    try { this.ssdpSocket.send(msg, 1900, '239.255.255.250') } catch {}
  }

  handleHttp(req, res) {
    if (req.url === '/device.xml') {
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' })
      res.end(this.deviceXml())
    } else if (req.url === '/AVTransport/scpd.xml' || req.url === '/RenderingControl/scpd.xml') {
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' })
      res.end(this.scpdXml())
    } else if (req.url.includes('/AVTransport/control') || req.url.includes('/RenderingControl/control')) {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const urlMatch = body.match(/<CurrentURI>([^<]+)<\/CurrentURI>/)
        if (urlMatch && this.onPlay) {
          const url = urlMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          this.onPlay(decodeURIComponent(url))
        }
        const actionMatch = String(req.headers.soapaction || '').match(/#([^"']+)/)
        const action = actionMatch ? actionMatch[1] : urlMatch ? 'SetAVTransportURI' : 'Play'
        const service = req.url.includes('/RenderingControl/') ? 'RenderingControl' : 'AVTransport'
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' })
        res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${service}:1"/></s:Body></s:Envelope>`)
      })
    } else {
      res.writeHead(404)
      res.end()
    }
  }

  deviceXml() {
    return `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>AI播放器</friendlyName>
    <manufacturer>AIPlayer</manufacturer>
    <UDN>${this.udn}</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <controlURL>/AVTransport/control</controlURL>
        <eventSubURL>/AVTransport/event</eventSubURL>
        <SCPDURL>/AVTransport/scpd.xml</SCPDURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
        <controlURL>/RenderingControl/control</controlURL>
        <eventSubURL>/RenderingControl/event</eventSubURL>
        <SCPDURL>/RenderingControl/scpd.xml</SCPDURL>
      </service>
    </serviceList>
  </device>
</root>`
  }

  scpdXml() {
    return `<?xml version="1.0"?><scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><actionList><action><name>SetAVTransportURI</name></action><action><name>Play</name></action><action><name>Pause</name></action><action><name>Stop</name></action><action><name>Seek</name></action><action><name>SetVolume</name></action></actionList><serviceStateTable></serviceStateTable></scpd>`
  }

  stop() {
    if (this.notifyTimer) clearInterval(this.notifyTimer)
    if (this.ssdpSocket) this.ssdpSocket.close()
    if (this.httpServer) this.httpServer.close()
    this.notifyTimer = null
    this.ssdpSocket = null
    this.httpServer = null
  }
}

module.exports = { DlnaReceiver }
