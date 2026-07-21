const fs = require('fs')
const path = require('path')
const JSZip = require('jszip')

// DOCX 无损编辑（第二增量）：WordprocessingML 层的确定性编辑——
// 查找替换（含 w:ins/w:del 修订模式）、锚点/序号段落插入、批注、文末追加。
// 未涉及的段落、样式、图片、表格、页眉页脚保持原样；任何一步失败都不写输出文件。

const PARAGRAPH_RE = /<w:p\b[\s\S]*?<\/w:p>/g
const TEXT_NODE_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g
const FORMAT_WORDS = /^(pdf|word|docx|excel|xlsx|pptx?|txt|markdown|md|文本|表格|演示稿|幻灯片)$/i
const LANGUAGE_WORDS = /^(英文|英语|中文|汉语|日语|日文|韩语|法语|德语|西班牙语|俄语)$/
const COMMENTS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml'
const COMMENTS_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'
const MAX_OP_LINES = 200
const MAX_OP_TEXT = 4000

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function unescapeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function visibleText(xml) {
  return [...xml.matchAll(TEXT_NODE_RE)].map((match) => unescapeXml(match[1])).join('')
}

function candidateForms(from) {
  const forms = [from]
  const liTail = /里(?:的)?([^的]+)$/.exec(from)
  if (liTail && liTail[1].length >= 1) forms.push(liTail[1])
  const deTail = /的([^的]+)$/.exec(from)
  if (deTail && deTail[1].length >= 1) forms.push(deTail[1])
  return [...new Set(forms)]
}

function splitLines(value) {
  return String(value).split(/\r?\n|(?<=[。！？；])/).map((line) => line.trim()).filter(Boolean)
}

function parseEditInstruction(instruction) {
  const text = String(instruction || '').trim()
  if (!text) return null
  const operations = []
  const segments = text.split(/[\n]+/).map((segment) => segment.trim()).filter(Boolean)
  for (const rawSegment of segments) {
    const segment = rawSegment.replace(/["'“”‘’«»]/g, '')
    if (segment.length > MAX_OP_TEXT) return null
    let mode = 'normal'
    let body = segment
    const trackPrefix = /^(?:以)?(?:修订模式|留痕模式)[,，、\s]*(.+)$/.exec(body)
    const trackSuffix = /^(.+?)[(（](?:修订模式|留痕)[)）]$/.exec(body)
    if (trackPrefix) { mode = 'track'; body = trackPrefix[1] }
    else if (trackSuffix) { mode = 'track'; body = trackSuffix[1] }
    const replace = /^(?:把|将)\s*([^，。]+?)\s*(?:替换成|替换为|换成|改为|改成)(?:为)?\s*([^，。]+?)$/.exec(body)
    if (replace) {
      const from = replace[1].trim()
      const to = replace[2].trim()
      if (!from || !to) return null
      if (FORMAT_WORDS.test(to) || LANGUAGE_WORDS.test(to)) return null // “改成pdf”是转换、“改成英文”是翻译，不是替换
      const operation = { type: 'replace', from, to }
      if (mode === 'track') operation.mode = 'track'
      operations.push(operation)
      continue
    }
    const comment = /^(?:给|把)\s*([^，。]+?)\s*(?:加上|添加|加条|加)批注[：:]\s*(.+)$/.exec(body)
    if (comment) {
      const anchor = comment[1].trim()
      const commentText = comment[2].trim()
      if (!anchor || !commentText) return null
      operations.push({ type: 'comment', anchor, text: commentText })
      continue
    }
    const insertByIndex = /^在第(\d+)(?:个)?(?:自然)?段(?:之)?(前|后)(?:插入|添加|加上)[：:]?\s*(.+)$/.exec(body)
    if (insertByIndex) {
      const lines = splitLines(insertByIndex[3])
      if (lines.length === 0 || lines.length > MAX_OP_LINES) return null
      operations.push({ type: 'insert', anchor: Number(insertByIndex[1]), position: insertByIndex[2] === '前' ? 'before' : 'after', lines })
      continue
    }
    const insertByAnchor = /^在([^，。]+?)(?:之)?(前|后)(?:插入|添加|加上)[：:]?\s*(.+)$/.exec(body)
    if (insertByAnchor && !/^(文档|文章)?(末尾|文末|最后|结尾)/.test(insertByAnchor[1])) {
      const lines = splitLines(insertByAnchor[3])
      if (lines.length === 0 || lines.length > MAX_OP_LINES) return null
      operations.push({ type: 'insert', anchor: insertByAnchor[1].trim(), position: insertByAnchor[2] === '前' ? 'before' : 'after', lines })
      continue
    }
    const appendTail = /(?:在|到)?(?:文档|文章)?(?:末尾|文末|最后|结尾)(?:处)?(?:加上|添加|追加|补上)[：:]?\s*(.+)$/.exec(body)
    const appendHead = /(?:加上|添加|追加|补上)[：:]?\s*(.+?)\s*(?:到|在)(?:文档|文章)?(?:末尾|文末|最后|结尾)(?:处)?$/.exec(body)
    const append = appendTail || appendHead
    if (append) {
      const lines = splitLines(append[1])
      if (lines.length === 0 || lines.length > MAX_OP_LINES) return null
      operations.push({ type: 'append', lines })
      continue
    }
    return null
  }
  return operations.length > 0 ? operations : null
}

function buildParagraphXml(line) {
  const heading = /^#{1,3}\s+/.exec(line)
  if (heading) {
    const level = Math.min(heading[0].trim().length, 3)
    return `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(line.slice(heading[0].length))}</w:t></w:r></w:p>`
  }
  return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`
}

function paragraphHead(paragraphXml) {
  // <w:p ...> 开标签 + 可选的 w:pPr；保留它们，其余内容可重建
  const openEnd = paragraphXml.indexOf('>', paragraphXml.indexOf('<w:p')) + 1
  const pPrMatch = paragraphXml.slice(openEnd).match(/^<w:pPr>[\s\S]*?<\/w:pPr>/)
  return { head: paragraphXml.slice(0, openEnd) + (pPrMatch ? pPrMatch[0] : ''), openEnd: openEnd + (pPrMatch ? pPrMatch[0].length : 0) }
}

function replaceInParagraph(paragraphXml, from, to, mode, state) {
  const combined = visibleText(paragraphXml)
  if (!combined.includes(from)) return { xml: paragraphXml, count: 0 }
  const count = combined.split(from).length - 1
  if (mode === 'track') {
    const parts = combined.split(from)
    const date = state.date
    let inner = parts[0] ? `<w:r><w:t xml:space="preserve">${escapeXml(parts[0])}</w:t></w:r>` : ''
    for (let index = 1; index < parts.length; index += 1) {
      inner += `<w:del w:id="${state.nextChangeId++}" w:author="AgentPlay" w:date="${date}"><w:r><w:delText xml:space="preserve">${escapeXml(from)}</w:delText></w:r></w:del>`
      inner += `<w:ins w:id="${state.nextChangeId++}" w:author="AgentPlay" w:date="${date}"><w:r><w:t xml:space="preserve">${escapeXml(to)}</w:t></w:r></w:ins>`
      inner += parts[index] ? `<w:r><w:t xml:space="preserve">${escapeXml(parts[index])}</w:t></w:r>` : ''
    }
    const { head } = paragraphHead(paragraphXml)
    return { xml: `${head}${inner}</w:p>`, count }
  }
  const replaced = combined.split(from).join(to)
  // 普通模式：保留段落属性与首个文本节点，其余文本节点清空。
  let used = false
  const xml = paragraphXml.replace(TEXT_NODE_RE, (whole, inner) => {
    if (used) return whole.replace(inner, '')
    used = true
    const spaceAttr = /^\s|\s$/.test(replaced) && !/xml:space="preserve"/.test(whole) ? ' xml:space="preserve"' : ''
    return whole.replace('<w:t', `<w:t${spaceAttr}`).replace(inner, escapeXml(replaced))
  })
  return { xml, count }
}

function applyReplacements(documentXml, replacements) {
  const items = replacements.map(({ from, to, mode }) => ({ from, to, mode: mode || 'normal', candidates: candidateForms(from) }))
  const allText = visibleText(documentXml)
  const unresolved = []
  for (const item of items) {
    item.use = item.candidates.find((candidate) => allText.includes(candidate))
    if (!item.use) unresolved.push(item.from)
  }
  if (unresolved.length > 0) throw new Error(`没有找到要替换的文字：${unresolved.join('、')}；未改动原文件`)
  const state = { date: new Date().toISOString(), nextChangeId: 1 }
  let total = 0
  const xml = documentXml.replace(PARAGRAPH_RE, (paragraphXml) => {
    let current = paragraphXml
    for (const item of items) {
      const result = replaceInParagraph(current, item.use, item.to, item.mode, state)
      current = result.xml
      total += result.count
    }
    return current
  })
  const finalText = visibleText(xml)
  const leftovers = items.filter((item) => finalText.includes(item.use))
  if (total === 0 || leftovers.length > 0) {
    const detail = leftovers.length > 0 ? `（${[...new Set(leftovers.map((item) => item.use))].join('、')} 可能被特殊排版拆分）` : ''
    throw new Error(`未能完整完成替换${detail}；未改动原文件`)
  }
  return { xml, total }
}

function appendParagraphs(documentXml, lines) {
  const paragraphs = lines.map(buildParagraphXml).join('')
  const sectionIndex = documentXml.lastIndexOf('<w:sectPr')
  const insertAt = sectionIndex === -1 ? documentXml.lastIndexOf('</w:body>') : sectionIndex
  if (insertAt === -1) throw new Error('DOCX 结构无效（缺少 w:body）')
  return documentXml.slice(0, insertAt) + paragraphs + documentXml.slice(insertAt)
}

function insertAtParagraph(documentXml, { anchor, position, lines }) {
  const paragraphs = lines.map(buildParagraphXml).join('')
  const anchorCandidates = typeof anchor === 'number' ? null : candidateForms(anchor)
  let counter = 0
  let done = false
  const xml = documentXml.replace(PARAGRAPH_RE, (paragraphXml) => {
    counter += 1
    if (done) return paragraphXml
    const hit = anchorCandidates === null
      ? counter === anchor
      : anchorCandidates.some((candidate) => visibleText(paragraphXml).includes(candidate))
    if (!hit) return paragraphXml
    done = true
    return position === 'before' ? paragraphs + paragraphXml : paragraphXml + paragraphs
  })
  if (!done) {
    const label = anchorCandidates === null ? `第 ${anchor} 段` : anchor
    throw new Error(`没有找到插入位置：${label}；未改动原文件`)
  }
  return xml
}

async function ensureCommentsPart(archive) {
  const existing = archive.file('word/comments.xml')
  let commentsXml = existing
    ? await existing.async('string')
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:comments>'
  const typesFile = archive.file('[Content_Types].xml')
  let typesXml = await typesFile.async('string')
  if (!typesXml.includes('/word/comments.xml')) {
    typesXml = typesXml.replace('</Types>', `<Override PartName="/word/comments.xml" ContentType="${COMMENTS_CONTENT_TYPE}"/></Types>`)
    archive.file('[Content_Types].xml', typesXml)
  }
  const relsFile = archive.file('word/_rels/document.xml.rels')
  let relsXml = await relsFile.async('string')
  if (!relsXml.includes('comments.xml')) {
    const ids = [...relsXml.matchAll(/Id="rId(\d+)"/g)].map((match) => Number(match[1]))
    const nextId = Math.max(0, ...ids) + 1
    relsXml = relsXml.replace('</Relationships>', `<Relationship Id="rId${nextId}" Type="${COMMENTS_REL_TYPE}" Target="comments.xml"/></Relationships>`)
    archive.file('word/_rels/document.xml.rels', relsXml)
  }
  return commentsXml
}

async function applyComments(archive, documentXml, comments) {
  let commentsXml = await ensureCommentsPart(archive)
  let maxId = Math.max(-1, ...[...commentsXml.matchAll(/w:id="(\d+)"/g)].map((match) => Number(match[1])))
  const date = new Date().toISOString()
  let count = 0
  for (const { anchor, text } of comments) {
    const id = maxId + count + 1
    const anchorCandidates = candidateForms(anchor)
    let anchored = false
    documentXml = documentXml.replace(PARAGRAPH_RE, (paragraphXml) => {
      if (anchored) return paragraphXml
      if (!anchorCandidates.some((candidate) => visibleText(paragraphXml).includes(candidate))) return paragraphXml
      anchored = true
      const { head, openEnd } = paragraphHead(paragraphXml)
      const bodyEnd = paragraphXml.length - '</w:p>'.length
      return `${head}<w:commentRangeStart w:id="${id}"/>${paragraphXml.slice(openEnd, bodyEnd)}<w:commentRangeEnd w:id="${id}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r></w:p>`
    })
    if (!anchored) throw new Error(`没有找到批注位置：${anchor}；未改动原文件`)
    const commentXml = `<w:comment w:id="${id}" w:author="AgentPlay" w:date="${date}"><w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p></w:comment>`
    if (commentsXml.includes('</w:comments>')) {
      commentsXml = commentsXml.replace('</w:comments>', `${commentXml}</w:comments>`)
    } else if (/<w:comments\b[^>]*\/>/.test(commentsXml)) {
      // 某些生成器（如 docx 库）输出自闭合的空 comments 根
      commentsXml = commentsXml.replace(/<w:comments\b([^>]*)\/>/, `<w:comments$1>${commentXml}</w:comments>`)
    } else {
      throw new Error('DOCX 的 comments.xml 结构无效；未改动原文件')
    }
    count += 1
  }
  archive.file('word/comments.xml', commentsXml)
  return { xml: documentXml, count }
}

async function editDocx(sourcePath, finalPath, operations) {
  const archive = await JSZip.loadAsync(fs.readFileSync(sourcePath))
  const documentFile = archive.file('word/document.xml')
  if (!documentFile) throw new Error('不是有效的 DOCX（缺少 word/document.xml）')
  let documentXml = await documentFile.async('string')
  const summaries = []
  const replacements = operations.filter((operation) => operation.type === 'replace')
  if (replacements.length > 0) {
    const track = replacements.some((operation) => operation.mode === 'track')
    const result = applyReplacements(documentXml, replacements)
    documentXml = result.xml
    summaries.push(`${track ? '以修订模式' : ''}替换 ${result.total} 处文字`)
  }
  for (const operation of operations) {
    if (operation.type === 'append') {
      documentXml = appendParagraphs(documentXml, operation.lines)
      summaries.push(`文末追加 ${operation.lines.length} 段`)
    } else if (operation.type === 'insert') {
      documentXml = insertAtParagraph(documentXml, operation)
      summaries.push(`${operation.position === 'before' ? '前' : '后'}插入 ${operation.lines.length} 段`)
    }
  }
  const comments = operations.filter((operation) => operation.type === 'comment')
  if (comments.length > 0) {
    const result = await applyComments(archive, documentXml, comments)
    documentXml = result.xml
    summaries.push(`添加 ${result.count} 条批注`)
  }
  archive.file('word/document.xml', documentXml)
  const buffer = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const tempPath = `${finalPath}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(finalPath), { recursive: true })
  fs.writeFileSync(tempPath, buffer)
  fs.renameSync(tempPath, finalPath)
  return summaries.join('；')
}

module.exports = { editDocx, parseEditInstruction }
