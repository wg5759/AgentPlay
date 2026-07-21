const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const mammoth = require('mammoth')
const ExcelJS = require('exceljs')
const PptxGenJS = require('pptxgenjs')
const JSZip = require('jszip')
const { Document, HeadingLevel, Packer, Paragraph, TextRun } = require('docx')
const { PDFDocument } = require('pdf-lib')
const { editDocx, parseEditInstruction } = require('./docx-editor')
const { editPptx, parsePptxEditInstruction } = require('./pptx-editor')
const { FormulaError, analyzeFormula, columnIndex, columnLetters, evaluateFormula } = require('./formula-engine')

const SUPPORTED_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.srt', '.vtt',
  '.docx', '.doc', '.xlsx', '.pptx', '.pdf',
  '.odt', '.ods', '.odp', '.rtf', '.html', '.htm'
])
const OUTPUT_FORMATS = new Set(['txt', 'md', 'docx', 'xlsx', 'pptx', 'pdf'])
const MAX_SOURCE_BYTES = 25 * 1024 * 1024
const MAX_PROMPT_CHARS = 70000

function cleanFileName(value) {
  return String(value || 'AgentPlay文档')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80) || 'AgentPlay文档'
}

function outputFormatFromInstruction(instruction, fallback = 'docx') {
  const text = String(instruction || '')
  if (/\bPPTX?\b|演示稿|幻灯片/i.test(text)) return 'pptx'
  if (/\bXLSX?\b|Excel|电子表格|工作簿/i.test(text)) return 'xlsx'
  if (/\bPDF\b/i.test(text)) return 'pdf'
  if (/\bMarkdown\b|\.md\b/i.test(text)) return 'md'
  if (/\bTXT\b|纯文本/i.test(text)) return 'txt'
  if (/\bDOCX?\b|Word|文档/i.test(text)) return 'docx'
  return fallback
}

function classifyTask(files, instruction, preferredOutput = 'auto') {
  const text = String(instruction || '').trim()
  const exts = files.map((file) => path.extname(file.path).toLowerCase())
  const outputFormat = preferredOutput && preferredOutput !== 'auto'
    ? preferredOutput
    : outputFormatFromInstruction(text, exts[0] === '.xlsx' ? 'xlsx' : 'docx')

  if (files.length >= 2 && exts.every((ext) => ext === '.pdf') && /合并|拼接|combine|merge/i.test(text)) {
    return { kind: 'pdf-merge', outputFormat: 'pdf', requiresAi: false, summary: `合并 ${files.length} 个 PDF` }
  }
  if (files.length === 1 && exts[0] === '.pdf') {
    const removeMatch = /^删除第\s*([0-9]+(?:\s*[-~到至,，、]\s*[0-9]+)*)\s*页/.exec(text)
    if (removeMatch) return { kind: 'pdf-remove-pages', outputFormat: 'pdf', requiresAi: false, summary: '删除 PDF 指定页', pageList: parsePageList(removeMatch[1]) }
    const extractMatch = /^(?:只要|提取)第\s*([0-9]+)\s*(?:[-~到至]\s*([0-9]+))?\s*页/.exec(text)
    if (extractMatch) return { kind: 'pdf-extract-pages', outputFormat: 'pdf', requiresAi: false, summary: '提取 PDF 页码范围', from: Number(extractMatch[1]), to: Number(extractMatch[2] || extractMatch[1]) }
  }
  if (files.length === 1 && exts[0] === '.pdf' && /拆分|分页|每页|split/i.test(text)) {
    return { kind: 'pdf-split', outputFormat: 'pdf', requiresAi: false, summary: '按页拆分 PDF' }
  }
  if (files.length === 1 && ['.xlsx', '.csv'].includes(exts[0]) && (/去重|清理|空格|公式|trim/i.test(text) || parseCellSet(text))) {
    const hasExplicitFormula = /=\s*[A-Z]+\d+|公式\s*[：:]\s*=/.test(text)
    const requiresAi = /公式/.test(text) && !hasExplicitFormula && !parseCellSet(text)
    return { kind: 'spreadsheet-edit', outputFormat: 'xlsx', requiresAi, summary: requiresAi ? '理解并写入表格公式' : '清理或修改表格' }
  }
  if (files.length === 1 && exts[0] === '.docx') {
    const editOperations = parseEditInstruction(text)
    if (editOperations) return { kind: 'docx-edit', outputFormat: 'docx', requiresAi: false, summary: '本地无损编辑 DOCX', editOperations }
  }
  if (files.length === 1 && exts[0] === '.pptx') {
    const editOperations = parsePptxEditInstruction(text)
    if (editOperations) return { kind: 'pptx-edit', outputFormat: 'pptx', requiresAi: false, summary: '本地页面级编辑 PPTX', editOperations }
  }
  const officeExts = ['.doc', '.docx', '.rtf', '.odt', '.xls', '.xlsx', '.csv', '.ods', '.ppt', '.pptx', '.odp']
  if (files.length === 1 && officeExts.includes(exts[0]) && /高保真|原样|保真/.test(text) && /pdf/i.test(text)) {
    return { kind: 'office-convert', outputFormat: 'pdf', requiresAi: false, summary: '调用本机 Office 引擎高保真转换' }
  }
  const languageRetarget = /改成|变成/.test(text) && /英文|英语|中文|汉语|日语|日文|韩语|法语|德语|西班牙语|俄语/.test(text)
  const pureConversion = !languageRetarget && /转换|转成|转为|导出|改成|变成/.test(text) && !/改写|翻译|总结|提炼|补充|重组|生成|制作/.test(text)
  const readable = files.every((file) => ['.txt', '.md', '.csv', '.json', '.srt', '.vtt', '.docx', '.doc', '.xlsx', '.pptx', '.pdf', '.odt', '.ods', '.odp', '.rtf', '.html', '.htm'].includes(path.extname(file.path).toLowerCase()))
  if (files.length > 0 && pureConversion && readable) {
    return { kind: 'convert', outputFormat, requiresAi: false, summary: `转换为 ${outputFormat.toUpperCase()}` }
  }
  const bundleSet = new Set()
  if (/word|docx|报告/i.test(text)) bundleSet.add('docx')
  if (/excel|xlsx|分析表|工作簿|电子表格/i.test(text)) bundleSet.add('xlsx')
  if (/ppt|演示|汇报|幻灯片/i.test(text)) bundleSet.add('pptx')
  if (/pdf/i.test(text)) bundleSet.add('pdf')
  if (/markdown|\.md/i.test(text)) bundleSet.add('md')
  if (/txt|纯文本|文本文件/i.test(text)) bundleSet.add('txt')
  const hasBundleConnector = /和|与|以及|并且|\+|、|，|,|再加|还要|同时|一套|成套|全家桶|打包|分别|全套/.test(text)
  if (bundleSet.size >= 2 && hasBundleConnector) {
    return { kind: 'ai-bundle', outputFormat: 'bundle', requiresAi: true, summary: `一次生成 ${[...bundleSet].map((format) => format.toUpperCase()).join('、')} 成套成果`, bundleFormats: [...bundleSet] }
  }
  return { kind: 'ai-generate', outputFormat, requiresAi: true, summary: files.length ? '根据文件和要求生成新成果' : '根据要求创建新成果' }
}

function uniqueOutputPath(outputDir, baseName, extension) {
  fs.mkdirSync(outputDir, { recursive: true })
  const safeBase = cleanFileName(baseName)
  let candidate = path.join(outputDir, `${safeBase}.${extension}`)
  let index = 2
  while (fs.existsSync(candidate)) {
    candidate = path.join(outputDir, `${safeBase}-${index}.${extension}`)
    index += 1
  }
  return candidate
}

function temporaryPath(finalPath) {
  return `${finalPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
}

function commitBuffer(finalPath, buffer) {
  const tempPath = temporaryPath(finalPath)
  fs.writeFileSync(tempPath, buffer)
  fs.renameSync(tempPath, finalPath)
}

async function extractText(filePath, ocr = null) {
  const ext = path.extname(filePath).toLowerCase()
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error('所选路径不是文件')
  if (stat.size > MAX_SOURCE_BYTES) throw new Error(`${path.basename(filePath)} 超过 25MB 文档处理上限`)
  if (['.txt', '.md', '.csv', '.json', '.srt', '.vtt'].includes(ext)) {
    return fs.readFileSync(filePath, 'utf8').slice(0, MAX_PROMPT_CHARS)
  }
  if (['.html', '.htm'].includes(ext)) return htmlToText(fs.readFileSync(filePath, 'utf8')).slice(0, MAX_PROMPT_CHARS)
  if (ext === '.rtf') return rtfToText(fs.readFileSync(filePath, 'utf8')).slice(0, MAX_PROMPT_CHARS)
  if (ext === '.doc') return extractLegacyDocText(filePath)
  if (['.odt', '.ods', '.odp'].includes(ext)) return extractOdfText(filePath)
  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath })
    return result.value.slice(0, MAX_PROMPT_CHARS)
  }
  if (ext === '.xlsx') {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)
    const chunks = []
    for (const sheet of workbook.worksheets.slice(0, 8)) {
      chunks.push(`## 工作表：${sheet.name}`)
      let rows = 0
      sheet.eachRow({ includeEmpty: false }, (row) => {
        if (rows >= 300) return
        chunks.push(JSON.stringify(row.values.slice(1).map((value) => {
          if (value && typeof value === 'object' && 'formula' in value) return `=${value.formula}`
          if (value && typeof value === 'object' && 'text' in value) return value.text
          return value ?? ''
        })))
        rows += 1
      })
    }
    return chunks.join('\n').slice(0, MAX_PROMPT_CHARS)
  }
  if (ext === '.pptx') {
    const archive = await JSZip.loadAsync(fs.readFileSync(filePath))
    const slideNames = Object.keys(archive.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((left, right) => Number(left.match(/\d+/)?.[0] || 0) - Number(right.match(/\d+/)?.[0] || 0))
    const chunks = []
    const decodeXml = (value) => String(value || '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    for (let index = 0; index < slideNames.length; index += 1) {
      const xml = await archive.file(slideNames[index]).async('string')
      const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1]).trim()).filter(Boolean)
      chunks.push(`## 第 ${index + 1} 页\n${texts.join('\n')}`)
    }
    return chunks.join('\n\n').slice(0, MAX_PROMPT_CHARS)
  }
  if (ext === '.pdf') return extractPdfText(filePath, ocr)
  throw new Error(`${ext || '该格式'} 暂不支持提取正文`)
}

async function pdfPageCount(filePath) {
  const { getDocumentProxy } = require('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(filePath)))
  try {
    return pdf.numPages
  } finally {
    if (typeof pdf.destroy === 'function') void pdf.destroy()
  }
}

async function extractPdfText(filePath, ocr = null) {
  // 懒加载 unpdf（内嵌 PDF.js）：只在真正处理 PDF 时才载入，避免拖慢应用启动。
  const { getDocumentProxy, extractText: extractPdfPages } = require('unpdf')
  const data = new Uint8Array(fs.readFileSync(filePath))
  let pdf
  try {
    pdf = await getDocumentProxy(data)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/password/i.test(message)) throw new Error('这份 PDF 有打开密码，请先解除密码后再试')
    throw new Error(`PDF 打开失败：${message}`)
  }
  try {
    const { totalPages, text } = await extractPdfPages(pdf, { mergePages: false })
    const pages = Array.isArray(text) ? text : [String(text || '')]
    const maxPages = Math.min(pages.length || pdf.numPages || 0, 200)
    const chunks = []
    for (let index = 0; index < maxPages; index += 1) {
      const pageText = String(pages[index] || '').replace(/[ \t]{2,}/g, ' ').trim()
      if (pageText) chunks.push(`## 第 ${index + 1} 页\n${pageText}`)
    }
    const joined = chunks.join('\n\n').trim()
    if (!joined) {
      if (ocr && typeof ocr.recognizePdf === 'function') {
        const ocrText = await ocr.recognizePdf(filePath).catch(() => null)
        if (ocrText && ocrText.trim()) {
          return `${ocrText.trim()}\n\n（本 PDF 为扫描件，以上文字由系统 OCR 提取，可能有识别误差）`.slice(0, MAX_PROMPT_CHARS)
        }
      }
      throw new Error('这份 PDF 没有可提取的文字层（扫描件或图片型 PDF）；当前系统 OCR 不可用或未识别出文字')
    }
    const total = totalPages || pages.length
    const suffix = total > maxPages ? `\n\n（仅提取前 ${maxPages} 页，共 ${total} 页）` : ''
    return `${joined}${suffix}`.slice(0, MAX_PROMPT_CHARS)
  } finally {
    if (pdf && typeof pdf.destroy === 'function') void pdf.destroy()
  }
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
}

function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|table|ul|ol)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim())
}

// 面向内容提取的轻量 RTF 解析：跳过字体表等元数据组，处理 \par、\'xx、\uN。
// 老 GBK 编码的 \'xx 字节会按 Latin-1 显示（现代 Word 写中文一律用 \uN，不受影响）。
function rtfToText(rtf) {
  const source = String(rtf || '')
  const skipGroups = /^\{\\(?:fonttbl|colortbl|stylesheet|info|pict|object|themedata|colorschememapping|datastore|\*)/i
  function skipGroup(start) {
    let depth = 0
    for (let cursor = start; cursor < source.length; cursor += 1) {
      const char = source[cursor]
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) return cursor + 1
      } else if (char === '\\') cursor += 1
    }
    return source.length
  }
  let output = ''
  let index = 0
  while (index < source.length) {
    const rest = source.slice(index)
    const char = source[index]
    if (char === '{' && skipGroups.test(rest)) {
      index = skipGroup(index)
      continue
    }
    if (char === '{' || char === '}') {
      index += 1
      continue
    }
    if (char === '\\') {
      const hex = /^\\'([0-9a-fA-F]{2})/.exec(rest)
      if (hex) {
        output += String.fromCharCode(parseInt(hex[1], 16))
        index += hex[0].length
        continue
      }
      const unicode = /^\\u(-?\d+)\s?/.exec(rest)
      if (unicode) {
        const code = Number(unicode[1])
        output += String.fromCodePoint(code < 0 ? code + 65536 : code)
        index += unicode[0].length + 1 // 额外跳过回退字符
        continue
      }
      const word = /^\\([a-z]+)(-?\d+)?\s?/i.exec(rest)
      if (word) {
        if (word[1] === 'par' || word[1] === 'line') output += '\n'
        else if (word[1] === 'tab') output += '\t'
        index += word[0].length
        continue
      }
      const symbol = /^\\(.)/.exec(rest)
      if (symbol) {
        output += symbol[1]
        index += 2
        continue
      }
      index += 1
      continue
    }
    if (!/[\r\n]/.test(char)) output += char
    index += 1
  }
  return output.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

async function extractOdfText(filePath) {
  const archive = await JSZip.loadAsync(fs.readFileSync(filePath))
  const contentFile = archive.file('content.xml')
  if (!contentFile) throw new Error('无效的 ODF 文档（缺少 content.xml）')
  const xml = await contentFile.async('string')
  const text = decodeEntities(xml
    .replace(/<text:line-break\s*\/>/g, '\n')
    .replace(/<\/text:(p|h)>/g, '\n')
    .replace(/<\/table:table-cell>/g, ' | ')
    .replace(/<\/table:table-row>/g, '\n')
    .replace(/<\/draw:page>/g, '\n\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/(\s*\|\s*){2,}/g, ' | ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!text) throw new Error('该 ODF 文档没有可提取的文字内容')
  return text.slice(0, MAX_PROMPT_CHARS)
}

async function extractLegacyDocText(filePath) {
  // 懒加载：老式 .doc 是低频路径，不拖慢启动。
  const WordExtractor = require('word-extractor')
  const document = await new WordExtractor().extract(filePath)
  const text = String(document.getBody() || '').trim()
  if (!text) throw new Error('这份 DOC 没有可提取的文字内容')
  return text.slice(0, MAX_PROMPT_CHARS)
}

function slidesFromText(title, content) {
  const lines = String(content || '').split(/\r?\n/).map((line) => line.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '').trim()).filter(Boolean)
  const slides = []
  for (let index = 0; index < lines.length; index += 6) {
    slides.push({ title: index === 0 ? title : `${title}（${Math.floor(index / 6) + 1}）`, bullets: lines.slice(index, index + 6), notes: '' })
  }
  return slides.slice(0, 40)
}

function sheetsFromText(content) {
  const rows = String(content || '').split(/\r?\n/).filter(Boolean).map((line) => [line])
  return [{ name: '内容', rows: [['内容'], ...rows] }]
}

function paragraphFromLine(line) {
  const text = String(line || '').trimEnd()
  if (text.startsWith('### ')) return new Paragraph({ text: text.slice(4), heading: HeadingLevel.HEADING_3 })
  if (text.startsWith('## ')) return new Paragraph({ text: text.slice(3), heading: HeadingLevel.HEADING_2 })
  if (text.startsWith('# ')) return new Paragraph({ text: text.slice(2), heading: HeadingLevel.HEADING_1 })
  if (/^[-*]\s+/.test(text)) return new Paragraph({ text: text.replace(/^[-*]\s+/, ''), bullet: { level: 0 } })
  return new Paragraph({ children: [new TextRun({ text: text || ' ', font: 'Microsoft YaHei', size: 22 })], spacing: { after: 120, line: 360 } })
}

function validateFormula(value) {
  const formula = String(value || '').replace(/^=/, '').trim()
  if (!formula || formula.length > 1000) throw new Error('公式为空或超过 1000 字符上限')
  if (/\b(?:WEBSERVICE|HYPERLINK|RTD|CALL|EXEC|REGISTER\.ID)\s*\(/i.test(formula) || /https?:\/\/|\\\\|\[[^\]]+\]|\|/.test(formula)) {
    throw new Error('已拒绝可能访问外部资源或执行外部调用的公式')
  }
  return formula
}

async function writeDocx(finalPath, title, content) {
  const children = []
  if (title) children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }))
  children.push(...String(content || '').split(/\r?\n/).map(paragraphFromLine))
  const doc = new Document({ sections: [{ properties: {}, children }] })
  commitBuffer(finalPath, await Packer.toBuffer(doc))
}

async function writeWorkbook(finalPath, sheets) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'AgentPlay'
  workbook.created = new Date()
  for (const source of sheets.length ? sheets : [{ name: '结果', rows: [['内容'], ['暂无内容']] }]) {
    const sheet = workbook.addWorksheet(cleanFileName(source.name || '结果').slice(0, 31))
    const rows = Array.isArray(source.rows) ? source.rows : []
    rows.forEach((values, rowIndex) => {
      const row = sheet.addRow(Array.isArray(values) ? values : [values])
      row.eachCell((cell) => {
        if (typeof cell.value === 'string' && cell.value.startsWith('=')) {
          cell.value = { formula: validateFormula(cell.value) }
        }
      })
      if (rowIndex === 0) {
        row.font = { bold: true, color: { argb: 'FFFFFFFF' } }
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } }
      }
    })
    sheet.views = [{ state: 'frozen', ySplit: rows.length > 1 ? 1 : 0 }]
    sheet.columns.forEach((column) => {
      let max = 10
      column.eachCell?.({ includeEmpty: false }, (cell) => { max = Math.max(max, String(cell.text || '').length + 2) })
      column.width = Math.min(42, max)
    })
  }
  workbook.calcProperties.fullCalcOnLoad = true
  const tempPath = temporaryPath(finalPath)
  await workbook.xlsx.writeFile(tempPath)
  fs.renameSync(tempPath, finalPath)
}

async function writePresentation(finalPath, title, slides) {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'AgentPlay'
  pptx.subject = title
  pptx.title = title
  pptx.company = 'AgentPlay'
  pptx.lang = 'zh-CN'
  pptx.theme = {
    headFontFace: 'Microsoft YaHei',
    bodyFontFace: 'Microsoft YaHei',
    lang: 'zh-CN'
  }
  const normalizedSlides = slides.length ? slides : [{ title, bullets: ['内容生成完成'] }]
  normalizedSlides.forEach((item, index) => {
    const slide = pptx.addSlide()
    slide.background = { color: index === 0 ? '071426' : '0B1220' }
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.16, h: 7.5, fill: { color: '2F80ED' }, line: { color: '2F80ED' } })
    slide.addText(String(item.title || `第 ${index + 1} 页`), {
      x: 0.75, y: 0.58, w: 11.4, h: 0.7, fontFace: 'Microsoft YaHei', fontSize: index === 0 ? 30 : 25,
      bold: true, color: 'F8FAFC', margin: 0
    })
    const bullets = Array.isArray(item.bullets) ? item.bullets : String(item.content || '').split(/\r?\n/).filter(Boolean)
    if (bullets.length) {
      slide.addText(bullets.slice(0, 8).map((bullet) => ({
        text: String(bullet), options: { bullet: { indent: 18 }, breakLine: true }
      })), {
        x: 0.95, y: 1.55, w: 11.1, h: 4.9, fontFace: 'Microsoft YaHei', fontSize: 20,
        color: 'DCE7F7', breakLine: false, margin: 0.08, valign: 'top', paraSpaceAfterPt: 12
      })
    }
    slide.addText(`AgentPlay · ${index + 1} / ${normalizedSlides.length}`, {
      x: 9.8, y: 7.08, w: 2.3, h: 0.2, fontSize: 9, color: '64748B', align: 'right', margin: 0
    })
    if (item.notes) slide.addNotes(String(item.notes).split(/\r?\n/))
  })
  const tempPath = `${finalPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp.pptx`
  await pptx.writeFile({ fileName: tempPath })
  fs.renameSync(tempPath, finalPath)
}

function htmlForPdf(title, content) {
  const escape = (value) => String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const paragraphs = String(content || '').split(/\r?\n/).map((line) => {
    if (line.startsWith('# ')) return `<h1>${escape(line.slice(2))}</h1>`
    if (line.startsWith('## ')) return `<h2>${escape(line.slice(3))}</h2>`
    if (/^[-*]\s+/.test(line)) return `<li>${escape(line.replace(/^[-*]\s+/, ''))}</li>`
    return `<p>${escape(line) || '&nbsp;'}</p>`
  }).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:18mm}body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#172033;font-size:11pt;line-height:1.7}h1{font-size:24pt;color:#0b4fab}h2{font-size:17pt;color:#173b66}p{margin:0 0 8pt}li{margin:0 0 6pt}</style></head><body><h1>${escape(title)}</h1>${paragraphs}</body></html>`
}

function parseJsonObject(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try { return JSON.parse(raw) } catch {}
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1))
  throw new Error('模型没有返回可执行的结构化文档方案')
}

function normalizeAiPlan(plan, fallbackFormat) {
  const outputFormat = fallbackFormat
  return {
    title: cleanFileName(plan.title || 'AgentPlay智能文档'),
    summary: String(plan.summary || '已根据要求生成文档'),
    outputFormat,
    content: String(plan.content || ''),
    slides: Array.isArray(plan.slides) ? plan.slides.map((slide) => ({
      title: String(slide?.title || ''),
      bullets: Array.isArray(slide?.bullets) ? slide.bullets.map(String) : [],
      notes: String(slide?.notes || '')
    })).slice(0, 40) : [],
    sheets: Array.isArray(plan.sheets) ? plan.sheets.map((sheet) => ({
      name: String(sheet?.name || '结果'),
      rows: Array.isArray(sheet?.rows) ? sheet.rows.slice(0, 5000).map((row) => Array.isArray(row) ? row.slice(0, 100) : [row]) : []
    })).slice(0, 20) : []
  }
}

function normalizeBundlePlan(raw, formats) {
  const bundle = {
    title: cleanFileName(raw?.title || 'AgentPlay成套文档'),
    summary: String(raw?.summary || '已生成成套成果'),
    sections: {}
  }
  for (const format of Array.isArray(formats) ? formats : []) {
    const section = raw?.[format]
    if (!section) continue
    if (format === 'docx' || format === 'pdf') {
      bundle.sections[format] = {
        title: cleanFileName(section.title || raw.title || 'AgentPlay文档'),
        content: String(section.content || '')
      }
    } else if (format === 'xlsx') {
      const sheets = (Array.isArray(section.sheets) ? section.sheets : []).map((sheet) => ({
        name: String(sheet?.name || '结果'),
        rows: Array.isArray(sheet?.rows) ? sheet.rows.slice(0, 5000).map((row) => (Array.isArray(row) ? row.slice(0, 100) : [row])) : []
      })).slice(0, 20)
      bundle.sections.xlsx = { sheets }
    } else if (format === 'pptx') {
      const slides = (Array.isArray(section.slides) ? section.slides : []).map((slide) => ({
        title: String(slide?.title || ''),
        bullets: Array.isArray(slide?.bullets) ? slide.bullets.map(String) : [],
        notes: String(slide?.notes || '')
      })).slice(0, 40)
      bundle.sections.pptx = { title: String(section.title || raw?.title || ''), slides, content: String(section.content || '') }
    } else if (format === 'md' || format === 'txt') {
      bundle.sections[format] = { content: String(typeof section === 'string' ? section : section.content || '') }
    }
  }
  if (Object.keys(bundle.sections).length === 0) throw new Error('模型没有给出任何可用的成套内容')
  return bundle
}

function columnNumber(value) {
  const letters = String(value || '').toUpperCase()
  if (!/^[A-Z]{1,3}$/.test(letters)) return null
  let number = 0
  for (const char of letters) number = number * 26 + char.charCodeAt(0) - 64
  return number
}

function findHeaderColumn(sheet, headerName) {
  if (!headerName) return null
  const wanted = String(headerName).replace(/列$/, '').trim().toLowerCase()
  const row = sheet.getRow(1)
  let found = null
  row.eachCell((cell, col) => {
    if (String(cell.text || '').trim().toLowerCase() === wanted) found = col
  })
  return found
}

function parseDedupeColumn(instruction, sheet) {
  const match = String(instruction).match(/(?:按|根据)\s*[“"']?([^，。；;"']+?)[”"']?\s*(?:列)?去重/)
  if (!match) return 1
  const asLetters = columnNumber(match[1].trim())
  return asLetters || findHeaderColumn(sheet, match[1]) || 1
}

function parseExplicitFormula(instruction) {
  const target = String(instruction).match(/(?:在|填充到)?\s*([A-Z]{1,3})\s*列/i)
  const formula = String(instruction).match(/(?:公式\s*[：:]?\s*)?(=\s*[(A-Za-z0-9][^\n，。；;]*)/i)
  if (!target || !formula) return null
  return { column: target[1].toUpperCase(), formula: formula[1].replace(/^=\s*/, '=') }
}

function parseCellSet(instruction) {
  const match = /^把\s*\$?([A-Za-z]{1,3})\s*\$?(\d+)\s*(?:改成|改为|设置为|填入|写上)\s*([^，。；;]+)$/.exec(String(instruction || '').trim())
  if (!match) return null
  return { column: match[1].toUpperCase(), row: Number(match[2]), value: match[3].trim() }
}

function coerceCellValue(value) {
  const text = String(value).trim()
  if (text === '') return null
  const numeric = Number(text)
  if (!Number.isNaN(numeric) && /^-?\d+(\.\d+)?$/.test(text)) return numeric
  if (/^(true|false)$/i.test(text)) return /^true$/i.test(text)
  return text
}

function formulaForRow(formula, rowNumber) {
  if (formula.includes('{row}')) return formula.replace(/\{row\}/gi, String(rowNumber))
  return formula.replace(/(\$?[A-Z]{1,3}\$?)2\b/g, `$1${rowNumber}`)
}

function cellValueForRecalc(value) {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number' || typeof value === 'boolean' || value instanceof Date) return value
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    if ('result' in value && (typeof value.result === 'number' || typeof value.result === 'string' || typeof value.result === 'boolean' || value.result instanceof Date)) return value.result
    if ('text' in value) return cellValueForRecalc(value.text)
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('')
    if ('formula' in value) throw new FormulaError('#REF!', '引用了含公式的单元格，超出本地重算能力')
    if ('error' in value) throw new FormulaError('#VALUE!', '引用单元格本身是错误值')
  }
  return String(value)
}

function assertNoCircularReference(formula, targetColumnLetter) {
  let analysis
  try {
    analysis = analyzeFormula(formula)
  } catch (error) {
    if (error instanceof FormulaError) throw new Error(`公式无法解析：${error.message}`)
    throw error
  }
  const targetIndex = columnIndex(targetColumnLetter)
  for (const ref of analysis.cellRefs) {
    if (ref.column === targetColumnLetter) throw new Error(`公式引用了目标列 ${targetColumnLetter} 自身，会形成循环引用`)
  }
  for (const span of analysis.rangeSpans) {
    const from = columnIndex(span.from.column)
    const to = columnIndex(span.to.column)
    if (targetIndex >= Math.min(from, to) && targetIndex <= Math.max(from, to)) {
      throw new Error(`公式区域 ${span.from.column}${span.from.row}:${span.to.column}${span.to.row} 覆盖目标列 ${targetColumnLetter}，会形成循环引用`)
    }
  }
}

function formatRecalcSample(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value)
    return String(Number.isInteger(value) ? value : Number(value.toPrecision(4)))
  }
  return String(value)
}

function verifyWrittenFormulas(sheet, columnLetter, formulaTemplate, sampleRows = 50) {
  const endRow = Math.min(sheet.rowCount, 1 + sampleRows)
  const samples = []
  const errors = []
  let checked = 0
  for (let rowNumber = 2; rowNumber <= endRow; rowNumber += 1) {
    const formula = formulaForRow(String(formulaTemplate).replace(/^=/, ''), rowNumber)
    try {
      const value = evaluateFormula(formula, (ref) => cellValueForRecalc(sheet.getCell(ref.row, columnIndex(ref.column)).value))
      checked += 1
      if (samples.length < 3) samples.push({ row: rowNumber, value: formatRecalcSample(value) })
    } catch (error) {
      if (error instanceof FormulaError) {
        if (error.code === '#NAME?' || error.code === '#REF!') return `已写入；${error.message}，请在 Excel 中打开后核对结果`
        errors.push({ row: rowNumber, code: error.code })
      } else {
        errors.push({ row: rowNumber, code: '#ERROR' })
      }
    }
  }
  if (errors.length > 0) {
    return `重算抽验发现 ${errors.length} 行计算错误（如第 ${errors[0].row} 行 ${errors[0].code}），请检查公式或源数据`
  }
  if (checked === 0) return '已写入；数据行不足，未执行重算抽验'
  const sampleText = samples.map((sample) => `${columnLetter}${sample.row}=${sample.value}`).join('、')
  return `重算抽验 ${checked} 行通过（${sampleText}${endRow < sheet.rowCount ? ' …' : ''}）`
}

async function editSpreadsheet(sourcePath, finalPath, instruction, formulaPlan = null) {
  const workbook = new ExcelJS.Workbook()
  if (path.extname(sourcePath).toLowerCase() === '.csv') await workbook.csv.readFile(sourcePath)
  else await workbook.xlsx.readFile(sourcePath)
  const operations = []
  for (const sheet of workbook.worksheets) {
    const cellSpec = parseCellSet(instruction)
    if (cellSpec) {
      if (cellSpec.row < 1 || cellSpec.row > sheet.rowCount + 1) throw new Error(`行号超出范围：第 ${cellSpec.row} 行（工作表共 ${sheet.rowCount} 行）`)
      sheet.getCell(`${cellSpec.column}${cellSpec.row}`).value = coerceCellValue(cellSpec.value)
      operations.push(`${sheet.name}：${cellSpec.column}${cellSpec.row} 改为 ${cellSpec.value}`)
    }
    if (/清理|空格|trim/i.test(instruction)) {
      sheet.eachRow((row) => row.eachCell((cell) => {
        if (typeof cell.value === 'string') cell.value = cell.value.trim()
      }))
      operations.push(`${sheet.name}：清理文本首尾空格`)
    }
    if (/去重/.test(instruction)) {
      const col = parseDedupeColumn(instruction, sheet)
      const seen = new Set()
      const duplicates = []
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const key = String(sheet.getCell(rowNumber, col).text || '').trim().toLowerCase()
        if (!key) continue
        if (seen.has(key)) duplicates.push(rowNumber)
        else seen.add(key)
      }
      duplicates.reverse().forEach((rowNumber) => sheet.spliceRows(rowNumber, 1))
      operations.push(`${sheet.name}：删除 ${duplicates.length} 行重复数据`)
    }
    const spec = formulaPlan || parseExplicitFormula(instruction)
    if (spec?.column && spec?.formula) {
      const col = columnNumber(spec.column) || findHeaderColumn(sheet, spec.column)
      if (!col) throw new Error(`找不到公式目标列：${spec.column}`)
      const colLetter = columnLetters(col)
      assertNoCircularReference(formulaForRow(String(spec.formula).replace(/^=/, ''), 2), colLetter)
      if (spec.header) sheet.getCell(1, col).value = spec.header
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const formula = validateFormula(formulaForRow(String(spec.formula).replace(/^=/, ''), rowNumber))
        sheet.getCell(rowNumber, col).value = { formula }
      }
      operations.push(`${sheet.name}：向 ${spec.column} 列写入 ${Math.max(0, sheet.rowCount - 1)} 个公式`)
      operations.push(verifyWrittenFormulas(sheet, colLetter, spec.formula))
    }
  }
  workbook.calcProperties.fullCalcOnLoad = true
  const tempPath = temporaryPath(finalPath)
  await workbook.xlsx.writeFile(tempPath)
  fs.renameSync(tempPath, finalPath)
  return operations
}

async function mergePdfs(files, finalPath) {
  const output = await PDFDocument.create()
  let pageCount = 0
  for (const filePath of files) {
    const source = await PDFDocument.load(fs.readFileSync(filePath), { ignoreEncryption: false })
    if (pageCount + source.getPageCount() > 2000) throw new Error('合并后的 PDF 超过 2000 页上限')
    const pages = await output.copyPages(source, source.getPageIndices())
    pages.forEach((page) => output.addPage(page))
    pageCount += pages.length
  }
  commitBuffer(finalPath, await output.save())
  return pageCount
}

function parsePageList(text) {
  const pages = new Set()
  for (const part of String(text).split(/[,，、]/)) {
    const range = /^\s*(\d+)\s*[-~到至]\s*(\d+)\s*$/.exec(part)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      for (let page = Math.min(from, to); page <= Math.max(from, to); page += 1) pages.add(page)
    } else if (/^\s*\d+\s*$/.test(part)) {
      pages.add(Number(part.trim()))
    }
  }
  return [...pages].sort((a, b) => a - b)
}

async function removePdfPages(filePath, finalPath, pageList) {
  const document = await PDFDocument.load(fs.readFileSync(filePath), { ignoreEncryption: false })
  const total = document.getPageCount()
  if (!Array.isArray(pageList) || pageList.length === 0) throw new Error('没有给出要删除的页码')
  for (const page of pageList) {
    if (page < 1 || page > total) throw new Error(`没有第 ${page} 页（共 ${total} 页）`)
  }
  if (pageList.length >= total) throw new Error('不能删除全部页面')
  for (const page of [...pageList].sort((a, b) => b - a)) document.removePage(page - 1)
  commitBuffer(finalPath, await document.save())
  return total - pageList.length
}

async function extractPdfPages(filePath, finalPath, from, to) {
  const source = await PDFDocument.load(fs.readFileSync(filePath), { ignoreEncryption: false })
  const total = source.getPageCount()
  if (from < 1 || to < from || to > total) throw new Error(`页码范围无效（共 ${total} 页）`)
  const output = await PDFDocument.create()
  const pages = await output.copyPages(source, Array.from({ length: to - from + 1 }, (_, index) => from - 1 + index))
  pages.forEach((page) => output.addPage(page))
  commitBuffer(finalPath, await output.save())
  return pages.length
}

async function splitPdf(filePath, outputDir, baseName) {
  const source = await PDFDocument.load(fs.readFileSync(filePath), { ignoreEncryption: false })
  if (source.getPageCount() > 500) throw new Error('一次最多拆分 500 页 PDF')
  const outputs = []
  for (let index = 0; index < source.getPageCount(); index += 1) {
    const output = await PDFDocument.create()
    const [page] = await output.copyPages(source, [index])
    output.addPage(page)
    const finalPath = uniqueOutputPath(outputDir, `${baseName}-第${index + 1}页`, 'pdf')
    commitBuffer(finalPath, await output.save())
    outputs.push(finalPath)
  }
  return outputs
}

class DocumentWorkspaceService {
  constructor({ outputRoot, historyRoot, complete, renderPdf, ocr, officeConvert }) {
    this.outputRoot = outputRoot
    this.historyRoot = historyRoot
    this.complete = complete
    this.renderPdf = renderPdf
    this.ocr = ocr || null
    this.officeConvert = officeConvert || null
  }

  inspect(filePaths) {
    let totalBytes = 0
    const files = filePaths.map((filePath) => {
      const resolved = path.resolve(filePath)
      const stat = fs.statSync(resolved)
      const ext = path.extname(resolved).toLowerCase()
      if (!stat.isFile() || !SUPPORTED_EXTENSIONS.has(ext)) {
        const legacyHint = ['.ppt', '.xls', '.wps', '.et', '.dps'].includes(ext)
          ? '；老式格式请先用 Office 或 WPS 另存为新格式（.docx/.xlsx/.pptx）'
          : ''
        throw new Error(`不支持的文档格式：${ext || path.basename(resolved)}${legacyHint}`)
      }
      if (stat.size > 250 * 1024 * 1024) throw new Error(`${path.basename(resolved)} 超过 250MB 单文件上限`)
      totalBytes += stat.size
      return { path: resolved, name: path.basename(resolved), ext, size: stat.size }
    })
    if (totalBytes > 500 * 1024 * 1024) throw new Error('所选文件总大小超过 500MB 单次处理上限')
    return files
  }

  plan(filePaths, instruction, preferredOutput = 'auto') {
    const files = this.inspect(filePaths)
    const normalizedInstruction = String(instruction || '').trim()
    if (preferredOutput !== 'auto' && !OUTPUT_FORMATS.has(preferredOutput)) throw new Error('不支持的输出格式')
    if (!normalizedInstruction) throw new Error('请用文字或语音说明要完成的任务')
    if (normalizedInstruction.length > 4000) throw new Error('单次任务说明不能超过 4000 字')
    if (!files.length && preferredOutput === 'auto' && !/PPT|演示稿|幻灯片|Excel|表格|PDF|Word|文档|TXT|Markdown/i.test(normalizedInstruction)) {
      throw new Error('没有选择源文件时，请在要求中说明要生成 Word、Excel、PPT、PDF 或文本')
    }
    return { ...classifyTask(files, normalizedInstruction, preferredOutput), files, instruction: normalizedInstruction }
  }

  async buildAiPlan(plan, options = {}) {
    const sourceChunks = []
    for (const file of plan.files) {
      sourceChunks.push(`\n===== ${file.name} =====\n${await extractText(file.path, this.ocr)}`)
    }
    const prompt = [
      `用户要求：${plan.instruction}`,
      `目标格式：${plan.outputFormat}`,
      sourceChunks.join('\n').slice(0, MAX_PROMPT_CHARS),
      '只返回一个 JSON 对象，不要使用 Markdown 代码块。结构：',
      '{"title":"文件标题","summary":"完成说明","outputFormat":"docx|xlsx|pptx|pdf|txt|md","content":"用于Word/PDF/文本的完整正文，使用#标题和-列表","slides":[{"title":"页标题","bullets":["要点"],"notes":"备注"}],"sheets":[{"name":"工作表名","rows":[["表头"],["数据"]]}]}',
      '事实必须来自源文件；资料不足时明确标注，不得编造。Excel公式必须以=开头，PPT每页最多8个要点。'
    ].join('\n')
    const response = await this.complete({
      systemPrompt: '你是 AgentPlay 文档规划器。你只生成严格、可执行、符合指定 JSON 结构的文档数据。',
      prompt,
      signal: options.signal
    })
    return normalizeAiPlan(parseJsonObject(response.text), plan.outputFormat)
  }

  async buildBundlePlan(plan, options = {}) {
    const sourceChunks = []
    for (const file of plan.files) {
      sourceChunks.push(`\n===== ${file.name} =====\n${await extractText(file.path, this.ocr)}`)
    }
    const wanted = plan.bundleFormats.join('、')
    const prompt = [
      `用户要求：${plan.instruction}`,
      `需要产出：${wanted}（只给这些格式各生成一份内容，不要多余格式）`,
      sourceChunks.join('\n').slice(0, MAX_PROMPT_CHARS),
      '只返回一个 JSON 对象，不要使用 Markdown 代码块。结构：',
      '{"title":"总标题","summary":"完成说明","docx":{"title":"报告标题","content":"完整正文，使用#标题和-列表"},"xlsx":{"sheets":[{"name":"工作表名","rows":[["表头"],["数据"]]}]},"pptx":{"slides":[{"title":"页标题","bullets":["要点"],"notes":"备注"}]},"pdf":{"title":"交付文档标题","content":"完整正文"},"md":{"content":"Markdown 正文"},"txt":{"content":"纯文本正文"}}',
      '按需要产出的格式给对应键；事实必须来自源文件；资料不足时明确标注，不得编造；PPT每页最多8个要点；Excel公式必须以=开头。'
    ].join('\n')
    const response = await this.complete({
      systemPrompt: '你是 AgentPlay 成套文档规划器。你只生成严格、可执行、符合指定 JSON 结构的内容。',
      prompt,
      signal: options.signal
    })
    return normalizeBundlePlan(parseJsonObject(response.text), plan.bundleFormats)
  }

  async buildFormulaPlan(plan, options = {}) {
    const sourceText = await extractText(plan.files[0].path, this.ocr)
    const response = await this.complete({
      systemPrompt: '你是 Excel 公式规划器，只返回 JSON。公式使用英文函数名和逗号分隔参数。',
      prompt: `用户要求：${plan.instruction}\n表格样例：\n${sourceText.slice(0, 12000)}\n只返回 {"column":"G","header":"毛利率","formula":"=(D{row}-E{row})/D{row}"}。column也可以是现有表头名。无法确定时不要猜测，返回 {"error":"具体缺少什么"}。`,
      signal: options.signal
    })
    const parsed = parseJsonObject(response.text)
    if (parsed.error) throw new Error(String(parsed.error))
    if (!parsed.column || !parsed.formula) throw new Error('模型没有给出可验证的目标列和公式')
    return { column: String(parsed.column), header: String(parsed.header || ''), formula: String(parsed.formula) }
  }

  async writeGenerated(plan, aiPlan = null) {
    const result = aiPlan || {
      title: cleanFileName(path.parse(plan.files[0]?.name || 'AgentPlay文档').name),
      summary: plan.summary,
      outputFormat: plan.outputFormat,
      content: plan.files.length ? await extractText(plan.files[0].path, this.ocr) : plan.instruction,
      slides: [], sheets: []
    }
    const outputDir = plan.files[0] ? path.dirname(plan.files[0].path) : this.outputRoot
    const sourceBase = path.parse(plan.files[0]?.name || result.title).name
    const baseName = `${cleanFileName(sourceBase)}-AgentPlay处理版`
    const finalPath = uniqueOutputPath(outputDir, baseName, result.outputFormat)
    if (result.outputFormat === 'docx') await writeDocx(finalPath, result.title, result.content)
    else if (result.outputFormat === 'xlsx') await writeWorkbook(finalPath, result.sheets.length ? result.sheets : sheetsFromText(result.content))
    else if (result.outputFormat === 'pptx') await writePresentation(finalPath, result.title, result.slides.length ? result.slides : slidesFromText(result.title, result.content))
    else if (result.outputFormat === 'pdf') {
      if (!this.renderPdf) throw new Error('当前平台没有可用的 PDF 渲染器')
      await this.renderPdf(htmlForPdf(result.title, result.content), finalPath)
    } else commitBuffer(finalPath, Buffer.from(result.content || '', 'utf8'))
    return { outputs: [finalPath], summary: result.summary }
  }

  async writeBundle(plan, bundle) {
    const outputDir = plan.files[0] ? path.dirname(plan.files[0].path) : this.outputRoot
    const baseName = cleanFileName(path.parse(plan.files[0]?.name || bundle.title).name)
    const labels = { docx: '报告', xlsx: '分析', pptx: '汇报', pdf: '交付', md: '文档', txt: '文本' }
    const outputs = []
    for (const [format, section] of Object.entries(bundle.sections)) {
      const finalPath = uniqueOutputPath(outputDir, `${baseName}-AgentPlay处理版-${labels[format] || format}`, format)
      if (format === 'docx') await writeDocx(finalPath, section.title, section.content)
      else if (format === 'xlsx') await writeWorkbook(finalPath, section.sheets)
      else if (format === 'pptx') await writePresentation(finalPath, section.title || bundle.title, section.slides.length ? section.slides : slidesFromText(section.title || bundle.title, section.content))
      else if (format === 'pdf') {
        if (!this.renderPdf) throw new Error('当前平台没有可用的 PDF 渲染器')
        await this.renderPdf(htmlForPdf(section.title, section.content), finalPath)
      } else commitBuffer(finalPath, Buffer.from(section.content || '', 'utf8'))
      outputs.push(finalPath)
    }
    return { outputs, summary: `${bundle.summary}（共 ${outputs.length} 个文件）` }
  }

  recordHistory(plan, result) {
    fs.mkdirSync(this.historyRoot, { recursive: true })
    const record = {
      id: crypto.randomUUID(), createdAt: new Date().toISOString(), instruction: plan.instruction,
      kind: plan.kind, sources: plan.files.map((file) => file.path), outputs: result.outputs,
      summary: result.summary
    }
    fs.appendFileSync(path.join(this.historyRoot, 'history.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
    return record.id
  }

  async run(filePaths, instruction, preferredOutput = 'auto', options = {}) {
    const plan = this.plan(filePaths, instruction, preferredOutput)
    const outputDir = plan.files[0] ? path.dirname(plan.files[0].path) : this.outputRoot
    let result
    if (plan.kind === 'pdf-merge') {
      const finalPath = uniqueOutputPath(outputDir, '合并文档-AgentPlay处理版', 'pdf')
      const pages = await mergePdfs(plan.files.map((file) => file.path), finalPath)
      result = { outputs: [finalPath], summary: `已合并 ${plan.files.length} 个 PDF，共 ${pages} 页` }
    } else if (plan.kind === 'pdf-split') {
      const outputs = await splitPdf(plan.files[0].path, outputDir, `${path.parse(plan.files[0].name).name}-AgentPlay拆分`)
      result = { outputs, summary: `已拆分为 ${outputs.length} 个单页 PDF` }
    } else if (plan.kind === 'pdf-remove-pages') {
      const finalPath = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-AgentPlay处理版`, 'pdf')
      const remaining = await removePdfPages(plan.files[0].path, finalPath, plan.pageList)
      result = { outputs: [finalPath], summary: `已删除 ${plan.pageList.length} 页，剩余 ${remaining} 页` }
    } else if (plan.kind === 'pdf-extract-pages') {
      const finalPath = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-AgentPlay处理版`, 'pdf')
      const count = await extractPdfPages(plan.files[0].path, finalPath, plan.from, plan.to)
      result = { outputs: [finalPath], summary: `已提取第 ${plan.from}-${plan.to} 页（共 ${count} 页）` }
    } else if (plan.kind === 'spreadsheet-edit') {
      const formulaPlan = plan.requiresAi ? await this.buildFormulaPlan(plan, options) : null
      const finalPath = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-AgentPlay处理版`, 'xlsx')
      const operations = await editSpreadsheet(plan.files[0].path, finalPath, plan.instruction, formulaPlan)
      result = { outputs: [finalPath], summary: operations.join('；') || '表格已另存为新文件' }
    } else if (plan.kind === 'docx-edit') {
      const finalPath = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-AgentPlay处理版`, 'docx')
      const summary = await editDocx(plan.files[0].path, finalPath, plan.editOperations)
      result = { outputs: [finalPath], summary: `已无损完成：${summary}；样式与未涉及内容保持原样` }
    } else if (plan.kind === 'pptx-edit') {
      const finalPath = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-AgentPlay处理版`, 'pptx')
      const summary = await editPptx(plan.files[0].path, finalPath, plan.editOperations)
      result = { outputs: [finalPath], summary: `已完成：${summary}；母版、版式与未涉及内容保持原样` }
    } else if (plan.kind === 'office-convert') {
      if (!this.officeConvert) throw new Error('当前平台没有高保真转换引擎（可改用普通转换）')
      const finalPath = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-AgentPlay处理版`, 'pdf')
      const converted = await this.officeConvert.convertToPdf(plan.files[0].path, finalPath)
      result = { outputs: [finalPath], summary: `已用本机 ${converted.engine} 引擎高保真转换为 PDF（保留原版式）` }
    } else if (plan.kind === 'convert' && ['.xlsx', '.csv'].includes(plan.files[0]?.ext) && plan.outputFormat === 'xlsx') {
      const finalPath = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-AgentPlay处理版`, 'xlsx')
      await editSpreadsheet(plan.files[0].path, finalPath, '')
      result = { outputs: [finalPath], summary: '表格已转换并另存为新的 XLSX 文件' }
    } else if (plan.kind === 'ai-bundle') {
      const bundle = await this.buildBundlePlan(plan, options)
      result = await this.writeBundle(plan, bundle)
    } else {
      result = await this.writeGenerated(plan, plan.requiresAi ? await this.buildAiPlan(plan, options) : null)
    }
    const historyId = this.recordHistory(plan, result)
    return { success: true, plan: { kind: plan.kind, requiresAi: plan.requiresAi, outputFormat: plan.outputFormat }, ...result, historyId }
  }
}

module.exports = {
  DocumentWorkspaceService,
  SUPPORTED_EXTENSIONS,
  classifyTask,
  extractText,
  htmlForPdf,
  normalizeAiPlan,
  normalizeBundlePlan,
  parseExplicitFormula,
  pdfPageCount,
  validateFormula
}
