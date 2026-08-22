const fs = require('fs')
const path = require('path')
const JSZip = require('jszip')

// 电子书服务：Internet Archive 的 Gutenberg 馆藏（公版书，合法免费）。
// epub 解析 → 章节结构；翻译优先离线组件（OPUS-MT 英译中，免费不出机），云模型走既有同意闸。
// 全书与译文都缓存到 userData/ebook-cache，重开即读、重复翻译零消耗。

const DOWNLOAD_BASE = 'https://archive.org/download/'
const FETCH_TIMEOUT_MS = 60000

function assertSafeIdentifier(identifier) {
  const id = String(identifier || '').trim()
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('书目编号无效')
  return id
}

async function fetchBuffer(url, { timeoutMs = FETCH_TIMEOUT_MS, attempts = 3, retryDelayMs = 1500, fetchImpl = globalThis.fetch } = {}) {
  // archive.org 会 302 到各国镜像节点，个别镜像超时是常态：重试 3 次再如实报错
  let lastError = null
  const boundedAttempts = Math.max(1, Math.min(5, Number(attempts) || 1))
  const boundedTimeout = Math.max(10, Math.min(120000, Number(timeoutMs) || FETCH_TIMEOUT_MS))
  const boundedDelay = Math.max(0, Math.min(5000, Number(retryDelayMs) || 0))
  for (let attempt = 0; attempt < boundedAttempts; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), boundedTimeout)
    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers: { 'User-Agent': 'AgentPlay/0.7 (public-domain ebooks)' } })
      if (!response.ok) throw new Error(`下载返回 ${response.status}`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      lastError = error.name === 'AbortError' ? new Error('下载超时，请检查网络后重试') : error
      if (attempt + 1 < boundedAttempts && boundedDelay > 0) await new Promise((resolve) => setTimeout(resolve, boundedDelay))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

// 取书：优先 epub（有章节结构），退而 txt；缓存到本地，重复打开不下载
async function fetchBook(cacheRoot, identifier, fileName, options = {}) {
  const id = assertSafeIdentifier(identifier)
  const safeName = path.basename(String(fileName || ''))
  if (!/\.(epub|txt)$/i.test(safeName)) throw new Error('只支持 epub/txt 书源')
  const dir = path.join(cacheRoot, id)
  const cached = path.join(dir, safeName)
  if (fs.existsSync(cached) && fs.statSync(cached).size > 0) return cached
  const url = `${DOWNLOAD_BASE}${encodeURIComponent(id)}/${encodeURIComponent(safeName)}`
  const buffer = await fetchBuffer(url, options)
  fs.mkdirSync(dir, { recursive: true })
  const tempPath = `${cached}.${process.pid}.tmp`
  fs.writeFileSync(tempPath, buffer)
  fs.renameSync(tempPath, cached)
  return cached
}

function stripXhtml(xhtml) {
  return String(xhtml)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// epub → 章节列表：[{ title, text }]。容器/spine/manifest 全按 OPF 规范走，不猜文件名顺序
async function parseEpubChapters(epubPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(epubPath))
  const containerFile = zip.file('META-INF/container.xml')
  if (!containerFile) throw new Error('不是有效的 epub（缺 container.xml）')
  const containerXml = await containerFile.async('string')
  const opfPath = /<rootfile[^>]*full-path="([^"]+)"/.exec(containerXml)?.[1]
  if (!opfPath) throw new Error('epub 缺少 OPF 入口')
  const opfDir = path.posix.dirname(opfPath)
  const opfXml = await zip.file(opfPath).async('string')
  const manifest = new Map()
  for (const match of opfXml.matchAll(/<item\b[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(match[0])?.[1]
    const href = /\bhref="([^"]+)"/.exec(match[0])?.[1]
    if (id && href) manifest.set(id, href)
  }
  const spineIds = [...opfXml.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)].map((match) => match[1])
  const chapters = []
  for (const idref of spineIds) {
    const href = manifest.get(idref)
    if (!href) continue
    const filePath = opfDir === '.' ? href : `${opfDir}/${href}`
    const file = zip.file(filePath)
    if (!file) continue
    const text = stripXhtml(await file.async('string'))
    if (text.length < 30) continue // 封面/版权页等过短跳过
    const titleMatch = /^(.{2,60})$/m.exec(text.split('\n').find((line) => line.trim()) || '')
    chapters.push({
      title: (titleMatch ? titleMatch[1] : `第 ${chapters.length + 1} 节`).trim().slice(0, 40),
      text
    })
  }
  if (chapters.length === 0) throw new Error('epub 没有可读的章节内容')
  return chapters
}

// txt 公版书 → 章节：Gutenberg 书按空行+大写标题/CHAPTER 行粗分；分不出就按长度切块
function parseTxtChapters(text) {
  const cleaned = String(text).replace(/\r\n/g, '\n')
  const startMarker = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG[^*]*\*\*\*/i.exec(cleaned)
  const endMarker = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG/i.exec(cleaned)
  const body = cleaned.slice(startMarker ? startMarker.index + startMarker[0].length : 0, endMarker ? endMarker.index : undefined)
  const parts = body.split(/\n(?=(?:CHAPTER|Chapter|PART|Part|BOOK|Book)\s+[IVXLCDM\d])/i)
  const chapters = parts
    .map((part) => part.trim())
    .filter((part) => part.length >= 400)
    .map((part, index) => {
      const firstLine = (part.split('\n').find((line) => line.trim()) || '').trim()
      return { title: firstLine.slice(0, 40) || `第 ${index + 1} 节`, text: part }
    })
  if (chapters.length > 1) return chapters
  // 无章节标记：按约 4000 字切块
  const chunks = []
  for (let i = 0; i < body.length; i += 4000) {
    chunks.push({ title: `第 ${chunks.length + 1} 段`, text: body.slice(i, i + 4000) })
  }
  return chunks.filter((chunk) => chunk.text.trim().length > 0)
}

// 译文缓存：userData/ebook-cache/<id>/zh-<engine>-<chapter>.txt
function cacheDirFor(cacheRoot, identifier) {
  try {
    return path.join(cacheRoot, assertSafeIdentifier(identifier))
  } catch {
    // 中文书名等非 ASCII 标识（维基文库 ws: 前缀）：哈希落盘，语义不变
    const crypto = require('crypto')
    return path.join(cacheRoot, 'ext', crypto.createHash('sha1').update(String(identifier)).digest('hex').slice(0, 16))
  }
}

function readTranslationCache(cacheRoot, identifier, engine, chapterIndex) {
  const file = path.join(cacheDirFor(cacheRoot, identifier), `zh-${engine}-${chapterIndex}.txt`)
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function writeTranslationCache(cacheRoot, identifier, engine, chapterIndex, text) {
  const dir = cacheDirFor(cacheRoot, identifier)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `zh-${engine}-${chapterIndex}.txt`)
  const tempPath = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tempPath, text, 'utf8')
  fs.renameSync(tempPath, file)
}

module.exports = { fetchBook, parseEpubChapters, parseTxtChapters, readTranslationCache, writeTranslationCache, stripXhtml, __test: { fetchBuffer } }
