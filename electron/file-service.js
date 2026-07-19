const fs = require('fs')
const path = require('path')

const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.webm', '.ts', '.m4v', '.wmv']
const AUDIO_EXTS = ['.mp3', '.flac', '.wav', '.aac', '.m4a', '.ogg', '.wma']
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg', '.ico', '.tif', '.tiff']
const TEXT_EXTS = [
  '.txt', '.md', '.json', '.csv', '.xml', '.html', '.htm', '.css', '.js', '.ts', '.tsx',
  '.jsx', '.py', '.java', '.c', '.cpp', '.h', '.sh', '.yml', '.yaml', '.ini', '.conf',
  '.log', '.bat', '.ps1', '.sql', '.toml', '.env'
]
const PDF_EXT = '.pdf'
const OFFICE_EXTS = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp']
const SUBTITLE_EXTS = ['.srt', '.ass', '.ssa', '.vtt']

const ALL_EXTS = [...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS, PDF_EXT, ...TEXT_EXTS, ...OFFICE_EXTS, ...SUBTITLE_EXTS]

function getType(ext) {
  if (VIDEO_EXTS.includes(ext)) return 'video'
  if (AUDIO_EXTS.includes(ext)) return 'audio'
  if (IMAGE_EXTS.includes(ext)) return 'image'
  if (ext === PDF_EXT) return 'pdf'
  if (TEXT_EXTS.includes(ext)) return 'text'
  if (OFFICE_EXTS.includes(ext)) return 'office'
  if (SUBTITLE_EXTS.includes(ext)) return 'subtitle'
  return 'other'
}

function scanDir(dir, recursive = true, depth = 0) {
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
    if (e.isDirectory() && recursive) {
      results.push(...scanDir(full, true, depth + 1))
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase()
      if (ALL_EXTS.includes(ext)) {
        let size = 0
        try { size = fs.statSync(full).size } catch {}
        results.push({ name: e.name, path: full, ext, size, type: getType(ext) })
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
    path.join(home, 'Documents'),
    path.join(home, '文档'),
    home
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return home
}

module.exports = { scanDir, defaultVideoDir, getType, ALL_EXTS }
