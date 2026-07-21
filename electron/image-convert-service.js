// 图片格式互转与缩放：用应用内 Chromium 的 canvas 解码/编码，零新依赖。
// 隐藏 BrowserWindow 由 main.js 注入；输出格式限 canvas 可编码的 png/jpeg/webp。
const path = require('path')

const INPUT_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.ico']
const OUTPUT_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp'])
const MIME_BY_FORMAT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
const MAX_CANVAS_EDGE = 8192

function parseImageEditInstruction(instruction) {
  const text = String(instruction || '').trim()
  if (!text) return null
  const formatMatch = /(?:转成|转为|改成|变成|转换为|导出为?)\s*(png|jpe?g|jpg|webp)/i.exec(text)
  const wantsResize = /压缩|缩小|缩放|调整尺寸|改尺寸|分辨率|宽度|质量|画质/.test(text)
  if (!formatMatch && !wantsResize) return null
  const result = {
    format: formatMatch ? (formatMatch[1].toLowerCase() === 'jpeg' ? 'jpeg' : formatMatch[1].toLowerCase()) : null,
    scale: null,
    maxWidth: null,
    quality: null
  }
  const scaleMatch = /(?:压缩到|缩小到|缩放为?|变成)\s*(?:原来的\s*)?(\d{1,3})\s*%/.exec(text) || /(一半|减半)/.exec(text)
  if (scaleMatch) result.scale = scaleMatch[1] && /^\d+$/.test(scaleMatch[1]) ? Number(scaleMatch[1]) / 100 : 0.5
  const widthMatch = /(?:宽度|宽)\s*(?:调到|为|到)?\s*(\d{2,5})\s*(?:px|像素)?/i.exec(text)
  if (widthMatch) result.maxWidth = Number(widthMatch[1])
  const qualityMatch = /(?:质量|画质)\s*(\d{1,3})\s*%?/.exec(text)
  if (qualityMatch) result.quality = Math.min(100, Math.max(1, Number(qualityMatch[1]))) / 100
  if (result.scale && (result.scale <= 0 || result.scale > 1)) return null
  return result
}

function normalizeImageEdit(sourcePath, instruction, options = {}) {
  const ext = path.extname(sourcePath).toLowerCase()
  if (!INPUT_EXTS.includes(ext)) throw new Error(`不支持的图片格式：${ext || '未知'}（支持 ${INPUT_EXTS.join('/')}）`)
  const edit = parseImageEditInstruction(instruction)
  if (!edit) throw new Error('没有识别出图片任务：请说明要转成什么格式，或压缩/缩放到什么程度')
  const targetFormat = edit.format || ext.slice(1)
  if (!OUTPUT_FORMATS.has(targetFormat)) throw new Error(`暂不能输出 ${targetFormat} 格式（可输出 png/jpg/webp）`)
  return { sourcePath, targetFormat, ...edit, ...options }
}

async function convertImage({ sourcePath, finalPath, instruction, createWindow }) {
  const edit = normalizeImageEdit(sourcePath, instruction)
  const win = await createWindow({ width: 64, height: 64 })
  try {
    const sourceUrl = `file:///${String(sourcePath).replace(/\\/g, '/')}`
    const script = `(async () => {
      const img = new Image()
      await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = () => reject(new Error('图片解码失败'))
        img.src = ${JSON.stringify(sourceUrl)}
      })
      let width = img.naturalWidth
      let height = img.naturalHeight
      if (!width || !height) throw new Error('图片尺寸无效')
      const scale = ${edit.scale ?? 'null'}
      const maxWidth = ${edit.maxWidth ?? 'null'}
      const maxEdge = ${MAX_CANVAS_EDGE}
      let ratio = scale || 1
      if (maxWidth && width > maxWidth) ratio = Math.min(ratio, maxWidth / width)
      if (Math.max(width, height) * ratio > maxEdge) ratio = maxEdge / Math.max(width, height)
      width = Math.max(1, Math.round(width * ratio))
      height = Math.max(1, Math.round(height * ratio))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      ${edit.targetFormat === 'jpg' || edit.targetFormat === 'jpeg' ? "ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);" : ''}
      ctx.drawImage(img, 0, 0, width, height)
      return canvas.toDataURL(${JSON.stringify(MIME_BY_FORMAT[edit.targetFormat])}, ${edit.quality ?? 0.92})
    })()`
    const dataUrl = await win.webContents.executeJavaScript(script, true)
    const base64 = String(dataUrl).split(',')[1]
    if (!base64) throw new Error('图片编码失败')
    const fs = require('fs')
    fs.mkdirSync(path.dirname(finalPath), { recursive: true })
    const tempPath = `${finalPath}.${process.pid}.tmp`
    fs.writeFileSync(tempPath, Buffer.from(base64, 'base64'))
    fs.renameSync(tempPath, finalPath)
    return { format: edit.targetFormat, bytes: fs.statSync(finalPath).size, scale: edit.scale, maxWidth: edit.maxWidth }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

module.exports = { convertImage, parseImageEditInstruction, normalizeImageEdit, INPUT_EXTS, OUTPUT_FORMATS }
