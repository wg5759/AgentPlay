const path = require('path')

// “一个打开入口”分流器：文档格式走文档任务授权令牌，媒体格式走播放器，
// 其余格式跳过。 inspectDocuments 负责校验并返回文档描述； approveDocument
// 负责把文档登记为授权令牌。两者都由 main.js 注入，便于独立测试。
function splitOpenAnyPaths(filePaths, { inspectDocuments, isMediaPath, approveDocument, maxFiles = 20 }) {
  const media = []
  const documents = []
  for (const filePath of (Array.isArray(filePaths) ? filePaths : []).slice(0, maxFiles)) {
    const ext = path.extname(filePath).toLowerCase()
    let documentFile = null
    if (typeof inspectDocuments === 'function') {
      try {
        ;[documentFile] = inspectDocuments([filePath])
      } catch {
        documentFile = null
      }
    }
    if (documentFile) {
      documents.push(approveDocument(documentFile))
      continue
    }
    if (typeof isMediaPath === 'function' && isMediaPath(filePath, ext)) media.push(path.resolve(filePath))
  }
  return { media, documents }
}

module.exports = { splitOpenAnyPaths }

// 路径是否落在任一用户授权过的文件夹内（用于库内文件直接附带为文档任务来源）。
// realpath 归一化后做前缀判断，防符号链接逃逸；两种斜杠都按分隔符处理。
function isPathInsideRoots(filePath, roots, { realpathSync } = {}) {
  const realpath = realpathSync || ((value) => value)
  const normalizeForCompare = (value) => path.resolve(String(value)).replace(/\\/g, '/').toLowerCase()
  let resolved
  try {
    resolved = realpath(filePath)
  } catch {
    return false
  }
  const normalized = normalizeForCompare(resolved)
  return (Array.isArray(roots) ? roots : []).some((root) => {
    let normalizedRoot
    try {
      normalizedRoot = normalizeForCompare(realpath(root))
    } catch {
      return false
    }
    return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`)
  })
}

module.exports = { splitOpenAnyPaths, isPathInsideRoots }
