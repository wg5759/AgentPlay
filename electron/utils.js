const os = require('os')

function getLanIp() {
  return selectLanIp(os.networkInterfaces())
}

function selectLanIp(nets) {
  const virtualPattern = /(^|\b)(tun|tap|vpn|nord|tailscale|zerotier|vethernet|wsl|docker|hyper-v|vmware|virtualbox|loopback)/i
  const physicalPattern = /(^|\b)(wlan|wi-?fi|wireless|无线|ethernet|以太网|eth\d*|en\d*)/i
  const candidates = []
  for (const [name, addresses] of Object.entries(nets)) {
    for (const net of addresses || []) {
      if (net.family !== 'IPv4' || net.internal) continue
      let score = 0
      if (physicalPattern.test(name)) score += 100
      if (virtualPattern.test(name)) score -= 100
      if (net.mac && net.mac !== '00:00:00:00:00:00') score += 20
      if (/^192\.168\./.test(net.address)) score += 10
      else if (/^10\./.test(net.address)) score += 5
      candidates.push({ address: net.address, score })
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.address || '127.0.0.1'
}

function listenWithFallback(server, preferredPort, attempts = 10, host) {
  return new Promise((resolve, reject) => {
    let port = preferredPort
    const tryListen = () => {
      const onError = (error) => {
        server.removeListener('listening', onListening)
        if (error.code === 'EADDRINUSE' && port < preferredPort + attempts) {
          port += 1
          setImmediate(tryListen)
        } else {
          reject(error)
        }
      }
      const onListening = () => {
        server.removeListener('error', onError)
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    }
    tryListen()
  })
}

module.exports = { getLanIp, selectLanIp, listenWithFallback }
