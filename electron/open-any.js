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
