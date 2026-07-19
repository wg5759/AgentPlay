const net = require('net')

function ipv4Parts(address) {
  const parts = String(address).split('.').map(Number)
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

function isLoopbackAddress(address) {
  const normalized = String(address || '').replace(/^\[|\]$/g, '').split('%')[0].toLowerCase()
  if (normalized === '::1') return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
  const parts = ipv4Parts(mapped ? mapped[1] : normalized)
  return Boolean(parts && parts[0] === 127)
}

function isBlockedMetadataHostname(hostname) {
  const normalized = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
  return normalized === '169.254.169.254' ||
    normalized === '100.100.100.200' ||
    normalized === 'metadata.google.internal' ||
    normalized.startsWith('fe80:')
}

function isProtectedAddress(address) {
  const normalized = String(address || '').replace(/^\[|\]$/g, '').split('%')[0].toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
  const parts = ipv4Parts(mapped ? mapped[1] : normalized)
  if (parts) {
    const [a, b, c] = parts
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) || a >= 224
  }
  if (net.isIP(normalized) === 6) {
    return normalized === '::' || normalized === '::1' ||
      normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb') ||
      normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('ff')
  }
  return false
}

module.exports = {
  isLoopbackHostname,
  isLoopbackAddress,
  isBlockedMetadataHostname,
  isProtectedAddress
}
