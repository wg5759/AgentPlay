const fs = require('fs')
const path = require('path')

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']
const PDF_EXT = '.pdf'
const VIDEO_EXTS = [
  '.mp4', '.mkv', '.avi', '.mov', '.flv', '.webm', '.ts', '.m4v', '.wmv',
  '.mp3', '.flac', '.wav', '.aac', '.m4a', '.ogg'
]

function scanDir(dir, recursive = true) {
  const results = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory() && recursive) {
      results.push(...scanDir(full, true))
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase()
      if (VIDEO_EXTS.includes(ext) || IMAGE_EXTS.includes(ext) || ext === PDF_EXT) {
        let size = 0
        try { size = fs.statSync(full).size } catch {}
        results.push({ name: e.name, path: full, ext, size })
      }
    }
  }
  return results
}

function defaultVideoDir() {
  const home = require('os').homedir()
  const candidates = [
    path.join(home, 'Videos'),
    path.join(home, '视频'),
    path.join(home, 'Movies'),
    home
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return home
}

module.exports = { scanDir, defaultVideoDir }
