const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { getType } = require('./file-service')

function extractTags(name, type) {
  const base = name.replace(/\.[^.]+$/, '')
  const tags = [type]
  const keywords = base.split(/[\s\-_.\[\]()【】（）]+/).filter((k) => k.length > 1)
  tags.push(...keywords.slice(0, 3))
  const dateMatch = base.match(/(20\d{2})/)
  if (dateMatch) tags.push(dateMatch[1])
  return [...new Set(tags)]
}

function analyzeDir(dir, depth = 0) {
  if (depth > 20) return []
  const results = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      results.push(...analyzeDir(full, depth + 1))
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase()
      const type = getType(ext)
      if (type === 'other') continue
      const tags = extractTags(e.name, type)
      let size = 0
      try { size = fs.statSync(full).size } catch {}
      results.push({
        name: e.name,
        path: full,
        ext,
        type,
        size,
        tags,
        group: tags[0] || type
      })
    }
  }
  return results
}

function clusterByTag(files) {
  const groups = {}
  for (const f of files) {
    const key = f.group || 'other'
    if (!groups[key]) groups[key] = []
    groups[key].push(f)
  }
  return groups
}

function findDuplicates(files) {
  const bySize = new Map()
  const dupes = []
  for (const file of files) {
    if (!file.size) continue
    const group = bySize.get(file.size) || []
    group.push(file)
    bySize.set(file.size, group)
  }

  for (const group of bySize.values()) {
    if (group.length < 2) continue
    const seen = new Map()
    for (const file of group) {
      let hash
      try {
        hash = hashFile(file.path)
      } catch {
        continue
      }
      const original = seen.get(hash)
      if (original) {
        dupes.push({ original: original.path, duplicate: file.path, name: file.name })
      } else {
        seen.set(hash, file)
      }
    }
  }
  return dupes
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytesRead
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function suggestClip(files) {
  const suggestions = []
  const clusters = clusterByTag(files)
  for (const [tag, group] of Object.entries(clusters)) {
    if (group.length >= 2) {
      suggestions.push({
        tag,
        count: group.length,
        files: group.map((f) => f.path),
        suggestion: `按"${tag}"聚类 ${group.length} 个文件，可剪合集`
      })
    }
  }
  return suggestions
}

module.exports = { analyzeDir, extractTags, clusterByTag, findDuplicates, suggestClip }
