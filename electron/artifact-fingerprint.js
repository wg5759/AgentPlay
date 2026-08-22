const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

function fingerprintArtifact(targetPath) {
  const resolved = path.resolve(targetPath)
  const stat = fs.statSync(resolved)
  if (stat.isFile()) {
    return {
      kind: 'file',
      bytes: stat.size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex')
    }
  }
  if (!stat.isDirectory()) throw new Error('成果既不是文件也不是目录')
  const hash = crypto.createHash('sha256')
  let bytes = 0
  let fileCount = 0
  const visit = (directory, prefix = '') => {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const fullPath = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('成果目录不得包含符号链接')
      if (entry.isDirectory()) {
        hash.update(`D\0${relative}\0`)
        visit(fullPath, relative)
      } else if (entry.isFile()) {
        const fileStat = fs.statSync(fullPath)
        hash.update(`F\0${relative}\0${fileStat.size}\0`)
        hash.update(fs.readFileSync(fullPath))
        bytes += fileStat.size
        fileCount += 1
      }
    }
  }
  visit(resolved)
  return { kind: 'directory', bytes, fileCount, sha256: hash.digest('hex') }
}

module.exports = { fingerprintArtifact }
