const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const mammoth = require('mammoth')
const ExcelJS = require('exceljs')
const JSZip = require('jszip')
const { Document, HeadingLevel, Packer, Paragraph, TextRun } = require('docx')
const { PDFDocument } = require('pdf-lib')
const { writePresentation } = require('./pptx-generator')
const { editDocx, parseEditInstruction } = require('./docx-editor')
const { editPptx, parsePptxEditInstruction } = require('./pptx-editor')
const { pdfToDocxLayout } = require('./pdf-to-docx-service')
const { convertImage, parseImageEditInstruction } = require('./image-convert-service')
const { insertImageIntoDocx } = require('./docx-image')
const { writeProfessionalVideoAnalysisDocx } = require('./video-analysis-report-service')
const { redactDocument } = require('./redact-service')
const { bilingualReflow } = require('./bilingual-reflow-service')
const { recoverTableInto } = require('./table-recovery-service')
const { FormulaError, analyzeFormula, columnIndex, columnLetters, evaluateFormula } = require('./formula-engine')
const { fingerprintArtifact } = require('./artifact-fingerprint')

const SUPPORTED_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.srt', '.vtt',
  '.docx', '.doc', '.xlsx', '.pptx', '.pdf',
  '.odt', '.ods', '.odp', '.rtf', '.html', '.htm',
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp',
  '.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.wma'
])
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']
const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.wma']
const OUTPUT_FORMATS = new Set(['txt', 'md', 'docx', 'xlsx', 'pptx', 'pdf'])
const MAX_SOURCE_BYTES = 25 * 1024 * 1024
const MAX_PROMPT_CHARS = 70000
const DEFAULT_CONTEXT_WINDOW = 32768
const DEFAULT_MAX_OUTPUT_TOKENS = 4096
const PROMPT_TOKEN_OVERHEAD = 160

// 中英文混排用保守字符估算；目标不是计费，而是在请求发出前保证不撞模型上下文硬上限。
function estimatePromptTokens(value) {
  const text = String(value || '')
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length
  const other = text.length - cjk
  return Math.ceil(cjk / 1.35 + other / 3.6) + PROMPT_TOKEN_OVERHEAD
}

function uniquePaths(filePaths) {
  const seen = new Set()
  return (Array.isArray(filePaths) ? filePaths : []).filter((filePath) => {
    const key = path.resolve(filePath).replace(/\\/g, '/').toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function splitTextByBudget(text, maxTokens) {
  const maxChars = Math.max(500, Math.floor((maxTokens - PROMPT_TOKEN_OVERHEAD) * 1.45))
  const paragraphs = String(text || '').split(/\n\s*\n/).filter(Boolean)
  const chunks = []
  let current = ''
  for (const paragraph of paragraphs) {
    const pieces = paragraph.length > maxChars
      ? Array.from({ length: Math.ceil(paragraph.length / maxChars) }, (_, index) => paragraph.slice(index * maxChars, (index + 1) * maxChars))
      : [paragraph]
    for (const piece of pieces) {
      const next = current ? `${current}\n\n${piece}` : piece
      if (current && estimatePromptTokens(next) > maxTokens) {
        chunks.push(current)
        current = piece
      } else current = next
    }
  }
  if (current) chunks.push(current)
  return chunks
}

function contextLimitError(error, options = {}) {
  const message = String(error?.message || error || '')
  if (!/exceed(?:s|ed)?\s+(?:the\s+)?available context|exceed_context_size|context (?:size|window)|上下文.{0,8}(?:超过|超限)/i.test(message)) return error
  const counts = [...message.matchAll(/(\d+)\s*tokens?/gi)].map((match) => Number(match[1]))
  const requested = counts[0] || estimatePromptTokens(options.prompt || '')
  const limit = counts[1] || Number(options.contextWindow) || 0
  return new Error(`当前模型一次最多处理约 ${limit || '有限'} tokens，本次请求约 ${requested} tokens。AgentPlay 已尝试分段处理；如仍失败，请选择大上下文云模型后重试。`)
}

function cleanFileName(value) {
  return String(value || 'AgentPlay文档')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80) || 'AgentPlay文档'
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')
}

function buildBundleSourceLedger(plan, sourceText) {
  const statements = String(sourceText || '')
    .split(/\n\s*\n|\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item && !/^={3,}.*={3,}$/.test(item))
    .slice(0, 80)
  if (statements.length === 0) statements.push(String(plan.instruction || '按用户要求创建成果').trim())
  const ledger = {
    schemaVersion: 1,
    kind: 'agentplay.bundle-source-ledger',
    instruction: String(plan.instruction || ''),
    facts: statements.map((statement, index) => ({ id: `F${index + 1}`, statement: statement.slice(0, 1200) }))
  }
  return { ...ledger, sha256: sha256Text(canonicalJson(ledger)) }
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

  if (files.length === 1 && IMAGE_EXTS.includes(exts[0])) {
    const imageEdit = parseImageEditInstruction(text)
    if (imageEdit) return { kind: 'image-convert', outputFormat: imageEdit.format || exts[0].slice(1), requiresAi: false, summary: '本地图片转换', imageEdit }
    if (/描述|介绍|什么|说说|讲讲|提取.*(?:文字|文本)|识别.*(?:文字|内容)|读.*字|OCR|总结|分析|看图/i.test(text)) {
      return { kind: 'image-ask', outputFormat: 'chat', requiresAi: true, summary: '图片理解' }
    }
    throw new Error('图片任务请说明：转成什么格式（png/jpg/webp），或压缩/缩放到什么程度；也可以直接问"这张图里有什么"')
  }
  if (files.length === 1 && AUDIO_EXTS.includes(exts[0]) && /转写|听写|转录|字幕|语音.*文字|识别.*说话|转成文字/.test(text)) {
    return { kind: 'transcribe', outputFormat: /时间轴|srt|时间戳/.test(text) ? 'srt' : 'txt', requiresAi: false, summary: '离线语音转写' }
  }
  if (files.length === 2 && exts[0] === '.docx' && IMAGE_EXTS.includes(exts[1]) && /插图|配图|插到|插入|加入图片|加图|加一(?:张|幅)?图/.test(text)) {
    const anchorMatch = /(?:插到|加到|放在)[“"']?([^“"’”']+?)[”"']?\s*(?:后面|之后|下面)/.exec(text)
    return { kind: 'docx-insert-image', outputFormat: 'docx', requiresAi: false, summary: '本地 DOCX 插图', anchor: anchorMatch ? anchorMatch[1].trim() : null }
  }
  if (files.length === 1 && ['.txt', '.md', '.csv', '.json', '.srt', '.vtt', '.docx', '.xlsx'].includes(exts[0]) && /脱敏|打码|隐私处理|敏感信息/.test(text)) {
    return { kind: 'redact', outputFormat: exts[0] === '.docx' ? 'docx' : exts[0] === '.xlsx' ? 'xlsx' : exts[0].slice(1), requiresAi: false, summary: '文档脱敏' }
  }
  if (files.length === 1 && ['.txt', '.md', '.docx', '.pdf'].includes(exts[0]) && /双语重排|中英对照|双语对照|对照排版|对照版/.test(text)) {
    return { kind: 'bilingual-reflow', outputFormat: 'docx', requiresAi: true, summary: '双语对照排版' }
  }
  if (files.length === 1 && ['.pdf', ...IMAGE_EXTS].includes(exts[0]) && /表格恢复|恢复表格|提取表格|识别表格|表格转|转成?(Excel|xlsx|电子表格)/i.test(text)) {
    return { kind: 'table-recovery', outputFormat: 'xlsx', requiresAi: false, summary: '扫描表格恢复为 XLSX' }
  }
  if (files.length === 1 && exts[0] === '.pdf' && /(?:高级文档解析|OCR).*(?:提取|识别)|(?:提取|识别).*(?:扫描|文字|文本).*(?:PDF|文档)|扫描.*(?:PDF|文档).*(?:文字|文本)/i.test(text)) {
    return { kind: 'text-extract', outputFormat: /(?:Markdown|\.md\b)/i.test(text) ? 'md' : 'txt', requiresAi: false, summary: '扫描文档文字提取' }
  }
  if (files.length === 1 && ['.docx', '.pptx'].includes(exts[0]) && /提取图片|导出图片|把.*图片.*拿|抠图/.test(text)) {
    return { kind: 'extract-images', outputFormat: 'files', requiresAi: false, summary: '提取文档内嵌图片' }
  }
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
  if (files.length === 1 && ['.xlsx', '.csv'].includes(exts[0]) && (/去重|清理|空格|公式|trim|柱状图|柱形图|条形图|折线图|饼图|透视表/i.test(text) || parseCellSet(text))) {
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
  if (files.length === 1 && exts[0] === '.pdf' && /高保真|原样|保真/.test(text) && /word|docx/i.test(text)) {
    return { kind: 'pdf-hifi-docx', outputFormat: 'docx', requiresAi: false, summary: '本地版式重建为 Word' }
  }
  const languageRetarget = /改成|变成/.test(text) && /英文|英语|中文|汉语|日语|日文|韩语|法语|德语|西班牙语|俄语/.test(text)
  const bundleSet = new Set()
  if (/word|docx|报告/i.test(text)) bundleSet.add('docx')
  if (/excel|xlsx|分析表|工作簿|电子表格/i.test(text)) bundleSet.add('xlsx')
  if (/ppt|演示|汇报|幻灯片/i.test(text)) bundleSet.add('pptx')
  if (/pdf/i.test(text)) bundleSet.add('pdf')
  if (/markdown|\.md/i.test(text)) bundleSet.add('md')
  if (/txt|纯文本|文本文件/i.test(text)) bundleSet.add('txt')
  // 成套判断必须在纯转换之前："做成ppt，再转成PDF"是两种格式的成套任务，不能被"转成"劫走
  const hasBundleConnector = /和|与|以及|并且|\+|、|，|,|再|然后|接着|随后|一并|再加|还要|同时|一套|成套|全家桶|打包|分别|全套/.test(text)
  if (bundleSet.size >= 2 && hasBundleConnector) {
    return { kind: 'ai-bundle', outputFormat: 'bundle', requiresAi: true, summary: `一次生成 ${[...bundleSet].map((format) => format.toUpperCase()).join('、')} 成套成果`, bundleFormats: [...bundleSet] }
  }
  // 内容级修改（改字体/样式/排版）不是纯转换，必须走模型生成
  const contentRestyle = /字体|字号|加粗|斜体|排版|水印|页眉|页脚|行距|边距/.test(text)
  const pureConversion = !languageRetarget && !contentRestyle && /转换|转成|转为|导出|改成|变成/.test(text) && !/改写|翻译|总结|提炼|补充|重组|生成|制作/.test(text)
  const readable = files.every((file) => ['.txt', '.md', '.csv', '.json', '.srt', '.vtt', '.docx', '.doc', '.xlsx', '.pptx', '.pdf', '.odt', '.ods', '.odp', '.rtf', '.html', '.htm'].includes(path.extname(file.path).toLowerCase()))
  if (files.length > 0 && pureConversion && readable) {
    return { kind: 'convert', outputFormat, requiresAi: false, summary: `转换为 ${outputFormat.toUpperCase()}` }
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

async function extractText(filePath, ocr = null, ocrOptions = {}) {
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
      const texts = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1]).trim()).filter(Boolean)
      chunks.push(`## 第 ${index + 1} 页\n${texts.join('\n')}`)
    }
    return chunks.join('\n\n').slice(0, MAX_PROMPT_CHARS)
  }
  if (ext === '.pdf') return extractPdfText(filePath, ocr, ocrOptions)
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

async function extractPdfText(filePath, ocr = null, ocrOptions = {}) {
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
        const ocrResult = await ocr.recognizePdf(filePath, ocrOptions).catch(() => null)
        const ocrText = typeof ocrResult === 'string' ? ocrResult : String(ocrResult?.text || '')
        if (ocrText.trim()) {
          const engineNote = ocrResult?.engine === 'unlimited-ocr'
            ? '高级文档 OCR'
            : ocrResult?.engine === 'fallback'
              ? '本机轻量 OCR（高级服务不可用，已自动回退）'
              : '系统 OCR'
          return `${ocrText.trim()}\n\n（本 PDF 为扫描件，以上文字由${engineNote}提取，可能有识别误差）`.slice(0, MAX_PROMPT_CHARS)
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
        content: String(section.content || ''),
        factIds: Array.isArray(section.factIds) ? section.factIds.map(String) : []
      }
    } else if (format === 'xlsx') {
      const sheets = (Array.isArray(section.sheets) ? section.sheets : []).map((sheet) => ({
        name: String(sheet?.name || '结果'),
        rows: Array.isArray(sheet?.rows) ? sheet.rows.slice(0, 5000).map((row) => (Array.isArray(row) ? row.slice(0, 100) : [row])) : []
      })).slice(0, 20)
      bundle.sections.xlsx = { sheets, factIds: Array.isArray(section.factIds) ? section.factIds.map(String) : [] }
    } else if (format === 'pptx') {
      const slides = (Array.isArray(section.slides) ? section.slides : []).map((slide) => ({
        title: String(slide?.title || ''),
        bullets: Array.isArray(slide?.bullets) ? slide.bullets.map(String) : [],
        notes: String(slide?.notes || '')
      })).slice(0, 40)
      bundle.sections.pptx = { title: String(section.title || raw?.title || ''), slides, content: String(section.content || ''), factIds: Array.isArray(section.factIds) ? section.factIds.map(String) : [] }
    } else if (format === 'md' || format === 'txt') {
      bundle.sections[format] = { content: String(typeof section === 'string' ? section : section.content || ''), factIds: Array.isArray(section?.factIds) ? section.factIds.map(String) : [] }
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

async function extractEmbeddedImages(filePath, targetDir) {
  const archive = await JSZip.loadAsync(fs.readFileSync(filePath))
  const mediaNames = Object.keys(archive.files).filter((name) => /^(word|ppt)\/media\/[^/]+$/.test(name) && !archive.files[name].dir)
  if (mediaNames.length === 0) throw new Error('这份文档里没有内嵌图片')
  fs.mkdirSync(targetDir, { recursive: true })
  for (const name of mediaNames) {
    const buffer = await archive.file(name).async('nodebuffer')
    fs.writeFileSync(path.join(targetDir, path.basename(name)), buffer)
  }
  return mediaNames.length
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

const CHART_TYPE_RULES = [[/柱状图|柱形图/, 51], [/条形图/, 57], [/折线图/, 4], [/饼图/, 5]]
function parseExcelEnrichIntent(text) {
  const chartRule = CHART_TYPE_RULES.find(([rule]) => rule.test(text))
  const pivot = /透视表/.test(text)
  if (!chartRule && !pivot) return null
  let rowField = ''
  let valueField = ''
  const pivotMatch = /按\s*([^，。；、]+?)\s*(?:列)?\s*(?:汇总|统计|求和)\s*([^，。；、]+?)\s*(?:列)?\s*$/.exec(String(text).trim())
  if (pivotMatch) { rowField = pivotMatch[1].trim(); valueField = pivotMatch[2].trim() }
  return { chartType: chartRule ? chartRule[1] : 0, chartTitle: '数据图表', pivot, rowField, valueField }
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
  constructor({ outputRoot, historyRoot, complete, renderPdf, ocr, officeConvert, imageWindow, transcriber, describeImage, tableOcr }) {
    this.outputRoot = outputRoot
    this.historyRoot = historyRoot
    this.complete = complete
    this.renderPdf = renderPdf
    this.ocr = ocr || null
    this.tableOcr = tableOcr || null
    this.officeConvert = officeConvert || null
    this.imageWindow = imageWindow || null
    this.transcriber = transcriber || null
    this.describeImage = describeImage || null
  }

  inspect(filePaths) {
    let totalBytes = 0
    const files = uniquePaths(filePaths).map((filePath) => {
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

  async preflight(filePaths, instruction, preferredOutput = 'auto', options = {}) {
    const plan = this.plan(filePaths, instruction, preferredOutput)
    const contextWindow = Math.max(1024, Number(options.contextWindow) || DEFAULT_CONTEXT_WINDOW)
    const maxOutputTokens = Math.max(256, Math.min(Number(options.maxOutputTokens) || DEFAULT_MAX_OUTPUT_TOKENS, Math.floor(contextWindow * 0.35)))
    if (!plan.requiresAi) return { estimatedTokens: 0, contextWindow, maxOutputTokens, exceedsSingleCall: false }
    const sources = []
    for (const file of plan.files) sources.push(`===== ${file.name} =====\n${await extractText(file.path, this.ocr)}`)
    const estimatedTokens = estimatePromptTokens(`${plan.instruction}\n${sources.join('\n\n')}`) + maxOutputTokens
    return { estimatedTokens, contextWindow, maxOutputTokens, exceedsSingleCall: estimatedTokens > contextWindow }
  }

  async buildAiPlan(plan, options = {}) {
    const sourceChunks = []
    for (const file of plan.files) {
      sourceChunks.push(`\n===== ${file.name} =====\n${await extractText(file.path, this.ocr)}`)
    }
    const fixedParts = [
      `用户要求：${plan.instruction}`,
      `目标格式：${plan.outputFormat}`,
      '只返回一个 JSON 对象，不要使用 Markdown 代码块。结构：',
      '{"title":"文件标题","summary":"完成说明","outputFormat":"docx|xlsx|pptx|pdf|txt|md","content":"用于Word/PDF/文本的完整正文，使用#标题和-列表","slides":[{"title":"页标题","bullets":["要点"],"notes":"备注"}],"sheets":[{"name":"工作表名","rows":[["表头"],["数据"]]}]}',
      '事实必须来自源文件；资料不足时明确标注，不得编造。Excel公式必须以=开头，PPT每页最多8个要点。'
    ]
    const sourceText = this.truncateAtParagraph(sourceChunks.join('\n'))
    const prompt = [fixedParts[0], fixedParts[1], sourceText, ...fixedParts.slice(2)].join('\n')
    const contextWindow = Math.max(1024, Number(options.contextWindow) || DEFAULT_CONTEXT_WINDOW)
    const maxOutputTokens = Math.max(256, Math.min(Number(options.maxOutputTokens) || DEFAULT_MAX_OUTPUT_TOKENS, Math.floor(contextWindow * 0.35)))
    const systemPrompt = '你是 AgentPlay 文档规划器。你只生成严格、可执行、符合指定 JSON 结构的文档数据。'
    options.onStatus?.('正在生成内容')
    try {
      if (estimatePromptTokens(`${systemPrompt}\n${prompt}`) + maxOutputTokens <= contextWindow) {
        const response = await this.complete({ systemPrompt, prompt, signal: options.signal, timeoutMs: 180000, maxTokens: maxOutputTokens, modelConfig: options.modelConfig })
        return normalizeAiPlan(parseJsonObject(response.text), plan.outputFormat)
      }

      const sectionSystem = '你是 AgentPlay 长文档分段整理器。只依据当前分段保留事实、条款、数字、主体和结论；使用清晰标题与列表，不输出 JSON，不引入外部事实。'
      const sectionPrefix = `用户要求：${plan.instruction}\n目标格式：${plan.outputFormat}\n当前仅处理以下一个分段：\n`
      const sectionBudget = Math.max(420, contextWindow - maxOutputTokens - estimatePromptTokens(`${sectionSystem}\n${sectionPrefix}`) - 80)
      const chunks = splitTextByBudget(sourceText, sectionBudget)
      const sections = []
      for (let index = 0; index < chunks.length; index++) {
        options.onStatus?.(`正文较长，正在分段理解 ${index + 1}/${chunks.length}`)
        const response = await this.complete({
          systemPrompt: sectionSystem,
          prompt: `${sectionPrefix}${chunks[index]}`,
          signal: options.signal,
          timeoutMs: 180000,
          maxTokens: maxOutputTokens,
          responseMode: 'section',
          modelConfig: options.modelConfig
        })
        sections.push(`## 第 ${index + 1} 段整理\n${String(response.text || '').trim()}`)
      }
      const merged = sections.join('\n\n')
      const finalPrompt = [fixedParts[0], fixedParts[1], merged, ...fixedParts.slice(2)].join('\n')
      if (estimatePromptTokens(`${systemPrompt}\n${finalPrompt}`) + maxOutputTokens <= contextWindow) {
        options.onStatus?.('正在合并分段结果')
        const response = await this.complete({ systemPrompt, prompt: finalPrompt, signal: options.signal, timeoutMs: 180000, maxTokens: maxOutputTokens, modelConfig: options.modelConfig })
        const result = normalizeAiPlan(parseJsonObject(response.text), plan.outputFormat)
        result.summary = `${result.summary}（已完成 ${chunks.length} 个分段处理）`
        return result
      }
      return normalizeAiPlan({
        title: path.parse(plan.files[0]?.name || 'AgentPlay智能文档').name,
        summary: `已按 ${chunks.length} 个分段完成整理`,
        content: merged,
        slides: plan.outputFormat === 'pptx' ? slidesFromText('分段整理结果', merged) : [],
        sheets: plan.outputFormat === 'xlsx' ? sheetsFromText(merged) : []
      }, plan.outputFormat)
    } catch (error) {
      throw contextLimitError(error, { prompt, contextWindow })
    }
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
      signal: options.signal,
      modelConfig: options.modelConfig
    })
    return normalizeBundlePlan(parseJsonObject(response.text), plan.bundleFormats)
  }

  // 段落边界截断：超长时在尾部 2000 字内回退到最后一个空行，避免把句子拦腰切断
  truncateAtParagraph(text, maxChars = MAX_PROMPT_CHARS) {
    const value = String(text || '')
    if (value.length <= maxChars) return value
    const boundary = value.lastIndexOf('\n\n', maxChars)
    return boundary > 0 && boundary > maxChars - 2000 ? value.slice(0, boundary) : value.slice(0, maxChars)
  }

  // 单格式生成：每次只让模型产出一种格式，单次调用小、快、失败不拖死其它格式
  async buildSectionPlan(plan, format, sourceText, sourceLedger, options = {}) {
    const schemas = {
      docx: '{"title":"报告标题","content":"完整正文，使用#标题和-列表","factIds":["F1"]}',
      pdf: '{"title":"交付文档标题","content":"完整正文，使用#标题和-列表","factIds":["F1"]}',
      md: '{"content":"Markdown 正文","factIds":["F1"]}',
      txt: '{"content":"纯文本正文","factIds":["F1"]}',
      xlsx: '{"sheets":[{"name":"工作表名","rows":[["表头"],["数据"]]}],"factIds":["F1"]}',
      pptx: '{"title":"演示稿标题","slides":[{"title":"页标题","bullets":["要点"],"notes":"备注"}],"factIds":["F1"]}'
    }
    const prompt = [
      `用户要求：${plan.instruction}`,
      `本次只生成 ${format.toUpperCase()} 一种格式的内容，不要输出其它格式。`,
      `以下是本成果包唯一允许使用的冻结事实底稿（SHA-256 ${sourceLedger.sha256}）：`,
      JSON.stringify(sourceLedger),
      '只返回一个 JSON 对象，不要使用 Markdown 代码块。结构：',
      schemas[format] || schemas.txt,
      'factIds 必须列出本成果实际使用的底稿事实编号，不得填写底稿不存在的编号。事实只能来自冻结底稿；资料不足时明确标注，不得编造；PPT每页最多8个要点；Excel公式必须以=开头。'
    ].join('\n')
    const response = await this.complete({
      systemPrompt: '你是 AgentPlay 文档规划器。你只生成严格、可执行、符合指定 JSON 结构的文档数据。',
      prompt,
      signal: options.signal,
      timeoutMs: 180000,
      modelConfig: options.modelConfig
    })
    const raw = { title: plan.files[0]?.name || 'AgentPlay文档', [format]: parseJsonObject(response.text) }
    const section = normalizeBundlePlan(raw, [format]).sections[format]
    const allowed = new Set(sourceLedger.facts.map((fact) => fact.id))
    const factIds = [...new Set((section.factIds || []).map(String))]
    if (factIds.length === 0) throw new Error(`${format.toUpperCase()} 没有声明使用的事实底稿编号`)
    const unknown = factIds.find((id) => !allowed.has(id))
    if (unknown) throw new Error(`${format.toUpperCase()} 引用了底稿中不存在的事实编号 ${unknown}`)
    return { ...section, factIds, sourceLedgerSha256: sourceLedger.sha256 }
  }

  async buildBundleSections(plan, options = {}) {
    const sourceChunks = []
    for (const file of plan.files) {
      sourceChunks.push(`\n===== ${file.name} =====\n${await extractText(file.path, this.ocr)}`)
    }
    const sourceText = this.truncateAtParagraph(sourceChunks.join('\n'))
    const sourceLedger = buildBundleSourceLedger(plan, sourceText)
    const sections = {}
    const failures = {}
    const resumedBundle = options.resumeCheckpoint?.bundle
    if (resumedBundle?.sourceLedgerSha256 === sourceLedger.sha256 && resumedBundle.sections && typeof resumedBundle.sections === 'object') {
      const allowedFacts = new Set(sourceLedger.facts.map((fact) => fact.id))
      for (const format of plan.bundleFormats) {
        const section = resumedBundle.sections[format]
        const factIds = Array.isArray(section?.factIds) ? [...new Set(section.factIds.map(String))] : []
        if (!section || factIds.length === 0 || factIds.some((id) => !allowedFacts.has(id)) || section.sourceLedgerSha256 !== sourceLedger.sha256) continue
        sections[format] = JSON.parse(JSON.stringify({ ...section, factIds }))
      }
    }
    const total = plan.bundleFormats.length
    for (let index = 0; index < plan.bundleFormats.length; index++) {
      const format = plan.bundleFormats[index]
      if (sections[format]) {
        options.onStatus?.(`已从检查点恢复 ${format.toUpperCase()}（${index + 1}/${total}）`)
        continue
      }
      options.onStatus?.(`正在生成 ${format.toUpperCase()}（${index + 1}/${total}）`)
      try {
        sections[format] = await this.buildSectionPlan(plan, format, sourceText, sourceLedger, options)
        options.onCheckpoint?.({
          stage: 'bundle-section-complete',
          bundle: { sourceLedgerSha256: sourceLedger.sha256, sections: JSON.parse(JSON.stringify(sections)) }
        })
      } catch (error) {
        if (options.signal?.aborted) throw error
        failures[format] = error instanceof Error ? error.message : String(error)
      }
    }
    if (!Object.keys(sections).length) {
      throw new Error(`全部格式生成失败：${Object.values(failures)[0] || '未知原因'}`)
    }
    return { sections, failures, sourceLedger }
  }

  async buildFormulaPlan(plan, options = {}) {
    const sourceText = await extractText(plan.files[0].path, this.ocr)
    const response = await this.complete({
      systemPrompt: '你是 Excel 公式规划器，只返回 JSON。公式使用英文函数名和逗号分隔参数。',
      prompt: `用户要求：${plan.instruction}\n表格样例：\n${sourceText.slice(0, 12000)}\n只返回 {"column":"G","header":"毛利率","formula":"=(D{row}-E{row})/D{row}"}。column也可以是现有表头名。无法确定时不要猜测，返回 {"error":"具体缺少什么"}。`,
      signal: options.signal,
      modelConfig: options.modelConfig
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
    const outputDir = plan.outputDir ? path.resolve(plan.outputDir) : plan.files[0] ? path.dirname(plan.files[0].path) : this.outputRoot
    const sourceBase = path.parse(plan.files[0]?.name || result.title).name
    const baseName = `${cleanFileName(sourceBase)}-AgentPlay处理版`
    const finalPath = uniqueOutputPath(outputDir, baseName, result.outputFormat)
    if (result.outputFormat === 'docx' && plan.kind === 'video-analysis') {
      await writeProfessionalVideoAnalysisDocx(finalPath, {
        title: result.title,
        content: result.content,
        frames: result.reportAssets?.frames || []
      })
    } else if (result.outputFormat === 'docx') await writeDocx(finalPath, result.title, result.content)
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
    const baseName = cleanFileName(path.parse(plan.files[0]?.name || 'AgentPlay成套文档').name)
    const labels = { docx: '报告', xlsx: '分析', pptx: '汇报', pdf: '交付', md: '文档', txt: '文本' }
    const outputs = []
    const bindings = []
    for (const [format, section] of Object.entries(bundle.sections)) {
      const finalPath = uniqueOutputPath(outputDir, `${baseName}-AgentPlay处理版-${labels[format] || format}`, format)
      if (format === 'docx') await writeDocx(finalPath, section.title, section.content)
      else if (format === 'xlsx') await writeWorkbook(finalPath, section.sheets)
      else if (format === 'pptx') await writePresentation(finalPath, section.title || baseName, section.slides.length ? section.slides : slidesFromText(section.title || baseName, section.content))
      else if (format === 'pdf') {
        if (!this.renderPdf) throw new Error('当前平台没有可用的 PDF 渲染器')
        await this.renderPdf(htmlForPdf(section.title, section.content), finalPath)
      } else commitBuffer(finalPath, Buffer.from(section.content || '', 'utf8'))
      outputs.push(finalPath)
      bindings.push({ path: finalPath, format, factIds: section.factIds || [], sourceLedgerSha256: section.sourceLedgerSha256 || bundle.sourceLedger?.sha256 || '' })
    }
    const failureNotes = Object.entries(bundle.failures || {})
    const summary = `已生成 ${outputs.length} 个文件${failureNotes.length ? `；${failureNotes.map(([format, reason]) => `${format.toUpperCase()} 失败（${reason}）`).join('；')}，可重试` : ''}`
    return {
      outputs,
      summary,
      failures: bundle.failures,
      bundle: {
        sourceLedger: bundle.sourceLedger,
        requestedFormats: [...plan.bundleFormats],
        bindings
      }
    }
  }

  createDeliveryReceipt(plan, result) {
    const sources = plan.files.map((file) => {
      const stat = fs.statSync(file.path)
      return { path: file.path, name: file.name, bytes: stat.size, sha256: fingerprintArtifact(file.path).sha256 }
    })
    const bindingByPath = new Map((result.bundle?.bindings || []).map((item) => [path.resolve(item.path), item]))
    const artifacts = (result.outputs || []).map((outputPath) => {
      const resolved = path.resolve(outputPath)
      const fingerprint = fingerprintArtifact(resolved)
      const binding = bindingByPath.get(resolved)
      return {
        path: resolved,
        name: path.basename(resolved),
        kind: fingerprint.kind,
        format: String(binding?.format || (fingerprint.kind === 'directory' ? 'directory' : path.extname(resolved).slice(1))).toLowerCase(),
        bytes: fingerprint.bytes,
        sha256: fingerprint.sha256,
        ...(Number.isFinite(fingerprint.fileCount) ? { fileCount: fingerprint.fileCount } : {}),
        ...(binding ? { factIds: [...binding.factIds], sourceLedgerSha256: binding.sourceLedgerSha256 } : {})
      }
    })
    let bundle
    if (plan.kind === 'ai-bundle') {
      const requestedFormats = [...plan.bundleFormats]
      const completedFormats = artifacts.map((item) => item.format)
      const failures = { ...(result.failures || {}) }
      const sourceLedgerSha256 = String(result.bundle?.sourceLedger?.sha256 || '')
      const bindingsValid = artifacts.length > 0 && artifacts.every((artifact) => (
        artifact.sourceLedgerSha256 === sourceLedgerSha256
        && Array.isArray(artifact.factIds)
        && artifact.factIds.length > 0
      ))
      const complete = requestedFormats.every((format) => completedFormats.includes(format))
        && Object.keys(failures).length === 0
        && bindingsValid
      bundle = {
        requestedFormats,
        completedFormats,
        failedFormats: failures,
        sourceLedgerSha256,
        sourceLedger: result.bundle?.sourceLedger || null,
        consistency: {
          verdict: complete ? 'matched' : 'partial',
          sharedSourceLedger: bindingsValid
        }
      }
    }
    return {
      schemaVersion: 1,
      kind: 'agentplay.delivery-receipt',
      createdAt: new Date().toISOString(),
      status: bundle && bundle.consistency.verdict !== 'matched' ? 'partial' : 'complete',
      instructionSha256: sha256Text(plan.instruction),
      sources,
      artifacts,
      ...(bundle ? { bundle } : {})
    }
  }

  recordHistory(plan, result) {
    fs.mkdirSync(this.historyRoot, { recursive: true })
    const record = {
      id: crypto.randomUUID(), createdAt: new Date().toISOString(), instruction: plan.instruction,
      kind: plan.kind, sources: plan.files.map((file) => file.path), outputs: result.outputs,
      summary: result.summary,
      deliveryReceipt: result.deliveryReceipt
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
    } else if (plan.kind === 'transcribe') {
      if (!this.transcriber) throw new Error('当前平台没有可用的转写引擎')
      const ext = plan.outputFormat === 'srt' ? 'srt' : 'txt'
      const finalPath = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-AgentPlay处理版`, ext)
      const transcription = await this.transcriber.transcribeToFile(plan.files[0].path, finalPath, { timestamps: plan.outputFormat === 'srt' })
      result = { outputs: [finalPath], summary: transcription.summary }
    } else if (plan.kind === 'image-convert') {
      if (!this.imageWindow) throw new Error('当前平台没有可用的图片转换器')
      const finalPath = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-AgentPlay处理版`, plan.imageEdit.format || plan.files[0].ext.slice(1))
      const converted = await convertImage({ sourcePath: plan.files[0].path, finalPath, instruction: plan.instruction, createWindow: this.imageWindow })
      result = { outputs: [finalPath], summary: `已转换为 ${converted.format.toUpperCase()}（${(converted.bytes / 1024).toFixed(0)}KB）` }
    } else if (plan.kind === 'image-ask') {
      if (!this.describeImage) throw new Error('当前平台没有图片理解能力')
      options.onStatus?.('正在理解图片内容')
      const answer = await this.describeImage(plan.files[0].path, plan.instruction, options)
      result = { outputs: [], summary: answer, chatOnly: true }
    } else if (plan.kind === 'text-extract') {
      options.onStatus?.('正在识别扫描文档文字')
      const content = await extractText(plan.files[0].path, this.ocr, {
        signal: options.signal,
        cloudApproved: options.cloudApproved === true
      })
      const finalPath = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-AgentPlay文字提取`, plan.outputFormat)
      commitBuffer(finalPath, Buffer.from(content, 'utf8'))
      result = { outputs: [finalPath], summary: `已提取扫描文档文字并保存为 ${plan.outputFormat.toUpperCase()}` }
    } else if (plan.kind === 'docx-insert-image') {
      const finalPath = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-AgentPlay处理版`, 'docx')
      const inserted = await insertImageIntoDocx(plan.files[0].path, plan.files[1].path, finalPath, { anchor: plan.anchor })
      result = { outputs: [finalPath], summary: `已把图片插入文档（${inserted.width}×${inserted.height}${plan.anchor ? `，位置：${plan.anchor} 之后` : '，文档末尾'}）` }
    } else if (plan.kind === 'extract-images') {
      const targetDir = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-图片`, 'dir').replace(/\.dir$/, '')
      const extracted = await extractEmbeddedImages(plan.files[0].path, targetDir)
      result = { outputs: [targetDir], summary: `已提取 ${extracted} 张内嵌图片到 ${targetDir}` }
    } else if (plan.kind === 'spreadsheet-edit') {
      const formulaPlan = plan.requiresAi ? await this.buildFormulaPlan(plan, options) : null
      const finalPath = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-AgentPlay处理版`, 'xlsx')
      const operations = await editSpreadsheet(plan.files[0].path, finalPath, plan.instruction, formulaPlan)
      // 图表/透视表：Excel COM 确定性生成（只动已另存的输出文件；无引擎时如实报错）
      const enrich = parseExcelEnrichIntent(plan.instruction)
      if (enrich) {
        if (!this.officeConvert) throw new Error('生成图表/透视表需要本机安装 Excel（或 WPS 表格）；当前环境没有转换引擎')
        await this.officeConvert.excelEnrich(finalPath, enrich)
        if (enrich.chartType) operations.push('已生成图表页')
        if (enrich.pivot) operations.push('已生成透视表页')
      }
      result = { outputs: [finalPath], summary: operations.filter(Boolean).join('；') || '表格已另存为新文件' }
    } else if (plan.kind === 'docx-edit') {
      const finalPath = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-AgentPlay处理版`, 'docx')
      const summary = await editDocx(plan.files[0].path, finalPath, plan.editOperations)
      result = { outputs: [finalPath], summary: `已无损完成：${summary}；样式与未涉及内容保持原样` }
    } else if (plan.kind === 'redact') {
      const finalPath = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-AgentPlay处理版`, plan.outputFormat)
      const summary = await redactDocument(plan.files[0].path, finalPath)
      result = { outputs: [finalPath], summary }
    } else if (plan.kind === 'bilingual-reflow') {
      const sourceText = await extractText(plan.files[0].path, this.ocr)
      const finalPath = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-中英对照`, 'docx')
      const { summary } = await bilingualReflow({ sourceText, title: plan.files[0].name, complete: this.complete, finalPath })
      result = { outputs: [finalPath], summary }
    } else if (plan.kind === 'table-recovery') {
      if (!this.tableOcr) throw new Error('表格 OCR 通道未就绪')
      const sourcePath = plan.files[0].path
      const ext = path.extname(sourcePath).toLowerCase()
      const workbook = new ExcelJS.Workbook()
      let sheets = 0
      let totalRows = 0
      if (ext === '.pdf') {
        const pages = await this.tableOcr.wordsForPdf(sourcePath)
        for (const page of pages) {
          try {
            const info = await recoverTableInto(workbook, page.words, `第 ${page.page} 页`)
            sheets += 1
            totalRows += info.rows
          } catch { /* 该页无表格结构，跳过 */ }
        }
      } else {
        const words = await this.tableOcr.wordsForImage(sourcePath)
        const info = await recoverTableInto(workbook, words, '表格1')
        sheets = 1
        totalRows = info.rows
      }
      if (!sheets) throw new Error('没有检测到多列表格结构（可能是普通文字页，建议裁掉无关区域或提高清晰度）')
      const finalPath = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-表格恢复`, 'xlsx')
      await workbook.xlsx.writeFile(finalPath)
      result = { outputs: [finalPath], summary: `表格恢复完成：${sheets} 个工作表、共 ${totalRows} 行（词级 OCR 聚类，边界单元格建议人工抽查）` }
    } else if (plan.kind === 'pptx-edit') {
      const finalPath = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-AgentPlay处理版`, 'pptx')
      const summary = await editPptx(plan.files[0].path, finalPath, plan.editOperations)
      result = { outputs: [finalPath], summary: `已完成：${summary}；母版、版式与未涉及内容保持原样` }
    } else if (plan.kind === 'office-convert') {
      if (!this.officeConvert) throw new Error('当前平台没有高保真转换引擎（可改用普通转换）')
      const finalPath = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-AgentPlay处理版`, 'pdf')
      const converted = await this.officeConvert.convertToPdf(plan.files[0].path, finalPath)
      result = { outputs: [finalPath], summary: `已用本机 ${converted.engine} 引擎高保真转换为 PDF（保留原版式）` }
    } else if (plan.kind === 'pdf-hifi-docx') {
      const finalPath = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-AgentPlay处理版`, 'docx')
      const rebuilt = await pdfToDocxLayout(plan.files[0].path, finalPath)
      result = { outputs: [finalPath], summary: `已按版式重建为 Word（${rebuilt.pages} 页还原行/段落与标题层级；图片与复杂分栏暂不还原）` }
    } else if (plan.kind === 'convert' && ['.xlsx', '.csv'].includes(plan.files[0]?.ext) && plan.outputFormat === 'xlsx') {
      const finalPath = uniqueOutputPath(outputDir, `${path.parse(plan.files[0].name).name}-AgentPlay处理版`, 'xlsx')
      await editSpreadsheet(plan.files[0].path, finalPath, '')
      result = { outputs: [finalPath], summary: '表格已转换并另存为新的 XLSX 文件' }
    } else if (plan.kind === 'ai-bundle') {
      const bundle = await this.buildBundleSections(plan, options)
      result = await this.writeBundle(plan, bundle)
    } else {
      let aiPlan = null
      if (plan.requiresAi) {
        const resumedPlan = options.resumeCheckpoint?.aiPlan
        aiPlan = resumedPlan && typeof resumedPlan === 'object'
          ? JSON.parse(JSON.stringify(resumedPlan))
          : await this.buildAiPlan(plan, options)
        if (!resumedPlan) options.onCheckpoint?.({ stage: 'ai-plan-ready', aiPlan })
      }
      result = await this.writeGenerated(plan, aiPlan)
    }
    result.deliveryReceipt = this.createDeliveryReceipt(plan, result)
    options.onCheckpoint?.({ stage: 'outputs-written', result })
    const historyId = this.recordHistory(plan, result)
    options.onCheckpoint?.({ stage: 'history-written', result: { ...result, historyId } })
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
  buildBundleSourceLedger,
  parseExcelEnrichIntent,
  parseExplicitFormula,
  pdfPageCount,
  validateFormula,
  estimatePromptTokens,
  splitTextByBudget
}
