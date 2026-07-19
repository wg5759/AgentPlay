const fs = require('fs')
const path = require('path')
const { fileURLToPath } = require('url')
const { ALL_EXTS } = require('./file-service')

function normalizeExternalPath(value) {
  if (typeof value !== 'string') return null
  let candidate = value.trim()
  if (!candidate || candidate.startsWith('--')) return null
  if (candidate.length >= 2 && candidate.startsWith('"') && candidate.endsWith('"')) {
    candidate = candidate.slice(1, -1)
  }
  if (/^file:\/\//i.test(candidate)) {
    try { candidate = fileURLToPath(candidate) } catch { return null }
  }
  return path.resolve(candidate)
}

function extractExternalMediaPaths(argv, options = {}) {
  const existsSync = options.existsSync || fs.existsSync
  const statSync = options.statSync || fs.statSync
  const allowedExtensions = new Set(options.allowedExtensions || ALL_EXTS)
  const found = []
  const seen = new Set()
  for (const value of Array.isArray(argv) ? argv : []) {
    const candidate = normalizeExternalPath(value)
    if (!candidate || !allowedExtensions.has(path.extname(candidate).toLowerCase())) continue
    const identity = process.platform === 'win32' ? candidate.toLowerCase() : candidate
    if (seen.has(identity)) continue
    try {
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue
    } catch {
      continue
    }
    seen.add(identity)
    found.push(candidate)
  }
  return found
}

module.exports = { extractExternalMediaPaths, normalizeExternalPath }
