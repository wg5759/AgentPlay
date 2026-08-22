const path = require('path')
const fs = require('fs')
const { assertUrlAllowed } = require('./media-download-service')
const { webParagraph } = require('./evidence-reference')

const MAX_TEXT_BYTES = 2 * 1024 * 1024
const TRACKING_PARAMS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'])
const VIDEO_HOSTS = ['bilibili.com', 'b23.tv', 'douyin.com', 'youtube.com', 'youtu.be', 'tiktok.com', 'x.com', 'twitter.com', 'facebook.com', 'fb.watch']

function normalizePublicUrl(value) {
  const parsed = new URL(String(value || '').trim())
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('只支持不含账号密码的公开 http/https 链接')
  parsed.hash = ''
  for (const key of [...parsed.searchParams.keys()]) if (TRACKING_PARAMS.has(key.toLowerCase())) parsed.searchParams.delete(key)
  return parsed.toString()
}

function classifyPublicLink(value) {
  let parsed
  try { parsed = new URL(normalizePublicUrl(value)) } catch { return { matched: false, kind: 'unknown', url: '' } }
  const host = parsed.hostname.toLowerCase()
  const ext = path.extname(parsed.pathname).toLowerCase()
  let kind = 'web'
  if (VIDEO_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`))) kind = 'video-site'
  else if (['.mp4', '.mkv', '.mov', '.webm'].includes(ext)) kind = 'media'
  else if (ext === '.pdf') kind = 'public-pdf'
  else if (['.mp3', '.m4a', '.wav', '.ogg', '.flac'].includes(ext)) kind = 'audio'
  else if (host === 'github.com' || host.endsWith('.github.com') || host === 'raw.githubusercontent.com') kind = 'github'
  else if (/\.(rss|xml|atom)$/i.test(parsed.pathname) || /(?:^|[?&])(feed|format)=(rss|atom)/i.test(parsed.search)) kind = 'rss'
  else if (['docs.google.com', 'docs.qq.com', 'feishu.cn', 'notion.site', 'notion.so'].some((domain) => host === domain || host.endsWith(`.${domain}`))) kind = 'online-document'
  return { matched: true, kind, url: parsed.toString(), host }
}

function stripMarkup(value) {
  return String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim()
}

function accessControlled(status, contentType, text) {
  if ([401, 403, 407, 451].includes(Number(status))) return true
  if (!/text|html|xml|json/i.test(contentType)) return false
  const sample = String(text || '').slice(0, 20000)
  return /(?:sign in|log in|login required|subscribe to continue|paywall|access denied|请登录|登录后|付费后|订阅后|无权访问)/i.test(sample)
}

async function readBounded(response) {
  const reader = response.body?.getReader?.()
  if (!reader) return Buffer.from(await response.arrayBuffer()).subarray(0, MAX_TEXT_BYTES)
  const chunks = []; let total = 0
  for (;;) {
    const { done, value } = await reader.read(); if (done) break
    total += value.byteLength
    if (total > MAX_TEXT_BYTES) throw new Error('公开内容超过2MB预览上限，请下载后作为本地文件处理')
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

class PublicLinkService {
  constructor({ fetchImpl = globalThis.fetch, dnsLookup } = {}) { this.fetch = fetchImpl; this.dnsLookup = dnsLookup }
  detect(text) {
    const url = /https?:\/\/[^\s"'）)】\]]+/i.exec(String(text || ''))?.[0] || ''
    return classifyPublicLink(url)
  }
  async inspect(value, { signal } = {}) {
    const detected = classifyPublicLink(value)
    if (!detected.matched) throw new Error('没有可识别的公开链接')
    await assertUrlAllowed(detected.url, { dnsLookup: this.dnsLookup })
    let response
    try { response = await this.fetch(detected.url, { redirect: 'manual', signal, headers: { Accept: 'text/html,application/rss+xml,application/atom+xml,application/json,application/pdf;q=0.8,*/*;q=0.5', 'User-Agent': 'AgentPlay/0.9 public-content-preview' } }) } catch (error) { throw new Error(`公开链接暂时无法访问：${error instanceof Error ? error.message : String(error)}`) }
    if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error('公开链接发生跳转，请使用最终公开地址；不会自动跟随到登录或追踪页面')
    const contentType = String(response.headers.get('content-type') || '').toLowerCase()
    const bytes = await readBounded(response)
    const text = /text|html|xml|json/i.test(contentType) ? bytes.toString('utf8') : ''
    if (accessControlled(response.status, contentType, text)) return { ...detected, access: 'controlled', status: response.status, title: '', excerpt: '', evidence: [], reason: '链接需要登录、订阅、付费或额外访问权限；AgentPlay不会绕过访问控制' }
    if (!response.ok) throw new Error(`公开链接返回 ${response.status}`)
    if (detected.kind === 'public-pdf' || contentType.includes('application/pdf')) return { ...detected, kind: 'public-pdf', access: 'public', status: response.status, title: path.basename(new URL(detected.url).pathname) || '公开 PDF', excerpt: '公开 PDF 已识别；下载后可提取、翻译或加入项目', evidence: [], bytes: bytes.length }
    const title = stripMarkup(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] || /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text)?.[1] || detected.host)
    const paragraphs = (detected.kind === 'rss' ? [...text.matchAll(/<(?:title|description|summary|content)[^>]*>([\s\S]*?)<\/(?:title|description|summary|content)>/gi)].map((match) => stripMarkup(match[1])) : [...text.matchAll(/<(?:p|li|h[1-3])[^>]*>([\s\S]*?)<\/(?:p|li|h[1-3])>/gi)].map((match) => stripMarkup(match[1]))).filter((item) => item.length >= 8).slice(0, 20)
    const fallback = stripMarkup(text).slice(0, 1200)
    const usable = paragraphs.length ? paragraphs : fallback ? [fallback] : []
    return { ...detected, access: 'public', status: response.status, title, excerpt: usable.slice(0, 4).join('\n').slice(0, 1200), evidence: usable.map((item, index) => webParagraph(detected.url, index + 1, item)), bytes: bytes.length }
  }
  async download(value, destDir, { signal } = {}) {
    const preview = await this.inspect(value, { signal })
    if (preview.access !== 'public') throw new Error(preview.reason || '链接不是无需授权的公开内容')
    await assertUrlAllowed(preview.url, { dnsLookup: this.dnsLookup })
    const response = await this.fetch(preview.url, { redirect: 'manual', signal, headers: { 'User-Agent': 'AgentPlay/0.9 public-content-download' } })
    if (!response.ok || [301, 302, 303, 307, 308].includes(response.status)) throw new Error(`公开内容下载返回 ${response.status}`)
    const bytes = await readBounded(response)
    fs.mkdirSync(destDir, { recursive: true })
    const parsed = new URL(preview.url)
    const ext = path.extname(parsed.pathname) || (String(response.headers.get('content-type') || '').includes('pdf') ? '.pdf' : '.html')
    const base = (path.basename(parsed.pathname, path.extname(parsed.pathname)) || preview.kind || '公开内容').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80)
    let outputPath = path.join(destDir, `${base}${ext}`); let index = 2
    while (fs.existsSync(outputPath)) { outputPath = path.join(destDir, `${base}-${index}${ext}`); index += 1 }
    const temp = `${outputPath}.${process.pid}.tmp`; fs.writeFileSync(temp, bytes); fs.renameSync(temp, outputPath)
    return { ...preview, outputPath, bytes: bytes.length }
  }
}

module.exports = { PublicLinkService, classifyPublicLink, normalizePublicUrl, accessControlled, MAX_TEXT_BYTES }
