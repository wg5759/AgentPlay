// 在线媒体库服务：Internet Archive（archive.org）公共领域与授权共享馆藏的检索、选流与直链。
// 法律边界写死在查询里：电影只查公版馆藏（feature_films/public_domain_film/Prelinger/classic_tv），
// 音频只查授权共享馆藏（etree 现场音乐档案=艺人许可录制分享 / librivoxaudio 公版有声书 / publicdomain）。
// 不抓取、不绕开任何付费墙；archive.org 自身的公共图书馆分发对终端用户合法。

const SEARCH_URL = 'https://archive.org/advancedsearch.php'
const METADATA_URL = 'https://archive.org/metadata/'
const DOWNLOAD_BASE = 'https://archive.org/download/'
const FETCH_TIMEOUT_MS = 30000

const COLLECTIONS = {
  movie: 'feature_films OR public_domain_film OR Prelinger OR classic_tv',
  audio: 'etree OR librivoxaudio OR publicdomain',
  book: 'gutenberg'
}
const MEDIATYPE = { movie: 'movies', audio: 'audio', book: 'texts' }

async function fetchWithTimeout(url, options = {}, { timeoutMs = FETCH_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    return await fetchImpl(url, { ...options, signal: controller.signal })
  } catch (error) {
    if (timedOut) throw new Error('网络请求超时，请检查网络后重试', { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJson(url, { timeoutMs = FETCH_TIMEOUT_MS, attempts = 2, fetchImpl = globalThis.fetch } = {}) {
  // archive.org 抖动是常态：超时/5xx 自动重试一次再如实报错
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        url,
        { headers: { 'User-Agent': 'AgentPlay/0.7 (legal public-domain media client)' } },
        { timeoutMs, fetchImpl }
      )
      if (response.ok) return response.json()
      lastError = new Error(`archive.org 返回 ${response.status}`)
      if (response.status < 500) throw lastError
    } catch (error) {
      lastError = error
      if (!/超时|5\d\d/.test(String(error.message))) throw error
    }
  }
  throw lastError
}

// kind: 'movie' | 'audio'；只返回规范化条目，年份/作者尽力而为
async function searchMedia(query, kind = 'movie', { page = 1, rows = 24, timeoutMs, attempts } = {}) {
  const q = String(query || '').trim()
  if (!q) return { items: [], total: 0 }
  if (!COLLECTIONS[kind]) throw new Error(`未知检索类别：${kind}`)
  const fullQuery = `(${q}) AND mediatype:${MEDIATYPE[kind]} AND collection:(${COLLECTIONS[kind]})`
  const url = `${SEARCH_URL}?q=${encodeURIComponent(fullQuery)}&fl[]=identifier&fl[]=title&fl[]=year&fl[]=creator&fl[]=downloads&rows=${rows}&page=${page}&output=json`
  const data = await fetchJson(url, { timeoutMs, attempts })
  const docs = data?.response?.docs || []
  return {
    total: data?.response?.numFound || 0,
    items: docs.map((doc) => ({
      identifier: doc.identifier,
      title: String(doc.title || doc.identifier),
      year: String(doc.year || '').slice(0, 4),
      creator: Array.isArray(doc.creator) ? doc.creator.join('、') : String(doc.creator || ''),
      downloads: Number(doc.downloads) || 0
    }))
  }
}

const VIDEO_EXTS = ['.mp4', '.ogv', '.webm', '.mkv', '.avi', '.mov', '.mpeg', '.mpg']
const AUDIO_EXTS = ['.mp3', '.ogg', '.flac', '.m4a', '.wav']
const SKIP_MARKERS = ['_thumb', '_small', '_bw', '_text', '_djvu', '_scandata', '_meta.sqlite', '_files.xml', '_meta.xml', '_reviews', '__ia_thumb', '_itemimage', '_gif']

function isPlayableFile(name, kind) {
  const lower = String(name || '').toLowerCase()
  if (SKIP_MARKERS.some((marker) => lower.includes(marker))) return false
  const exts = kind === 'audio' ? AUDIO_EXTS : VIDEO_EXTS
  return exts.some((ext) => lower.endsWith(ext))
}

function fileScore(name, size, kind) {
  const lower = String(name || '').toLowerCase()
  let score = 0
  if (kind === 'audio') {
    if (lower.endsWith('.mp3')) score += 100
    else if (lower.endsWith('.ogg')) score += 80
    else if (lower.endsWith('.m4a')) score += 60
    else if (lower.endsWith('.flac')) score += 40
    else if (lower.endsWith('.wav')) score += 20
  } else {
    if (lower.endsWith('.mp4')) score += 100
    else if (lower.endsWith('.webm')) score += 80
    else if (lower.endsWith('.ogv')) score += 70
    else if (lower.endsWith('.mkv')) score += 60
    else if (lower.endsWith('.avi') || lower.endsWith('.mov')) score += 30
    else if (lower.endsWith('.mpeg') || lower.endsWith('.mpg')) score += 20
  }
  // 同名多版本时偏好较小文件（流媒体更顺）
  const mb = (Number(size) || 0) / 1024 / 1024
  if (mb > 0 && mb < 1500) score += Math.max(0, 30 - mb / 50)
  return score
}

// 列出条目的可播放文件（按可播性排序）；无文件时如实返回空
async function listPlayableFiles(identifier, kind = 'movie', { timeoutMs, attempts } = {}) {
  const id = String(identifier || '').trim()
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('条目编号无效')
  const data = await fetchJson(`${METADATA_URL}${encodeURIComponent(id)}`, { timeoutMs, attempts })
  const files = (data?.files || [])
    .filter((file) => isPlayableFile(file.name, kind))
    .map((file) => ({
      name: file.name,
      size: Number(file.size) || 0,
      url: `${DOWNLOAD_BASE}${encodeURIComponent(id)}/${file.name.split('/').map(encodeURIComponent).join('/')}`,
      format: String(file.format || '')
    }))
    .sort((a, b) => fileScore(b.name, b.size, kind) - fileScore(a.name, a.size, kind))
  const title = String(data?.metadata?.title || id)
  return { identifier: id, title, files }
}

// 仅允许 archive.org 的 https 直链进入播放器/下载器（域名白名单，防任意 URL 注入）
function assertArchiveUrl(url) {
  let parsed
  try {
    parsed = new URL(String(url || ''))
  } catch {
    throw new Error('链接无效')
  }
  if (parsed.protocol !== 'https:') throw new Error('只支持 https 链接')
  const host = parsed.hostname.toLowerCase()
  if (host !== 'archive.org' && !host.endsWith('.archive.org')) throw new Error('只允许播放 Internet Archive 的链接')
  return String(url)
}

// 书目文件：epub 优先（有章节结构），txt 兜底
async function listBookFiles(identifier, { timeoutMs, attempts, fetchImpl } = {}) {
  const id = String(identifier || '').trim()
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('条目编号无效')
  const data = await fetchJson(`${METADATA_URL}${encodeURIComponent(id)}`, { timeoutMs, attempts, fetchImpl })
  const files = (data?.files || [])
    .filter((file) => /\.(epub|txt)$/i.test(file.name || '') && !/_(djvu|bw|text)\.txt$/i.test(file.name))
    .map((file) => ({
      name: file.name,
      size: Number(file.size) || 0,
      url: `${DOWNLOAD_BASE}${encodeURIComponent(id)}/${file.name.split('/').map(encodeURIComponent).join('/')}`,
      format: String(file.format || '')
    }))
    .sort((a, b) => Number(/\.epub$/i.test(b.name)) - Number(/\.epub$/i.test(a.name)) || a.size - b.size)
  const title = String(data?.metadata?.title || id)
  const creator = data?.metadata?.creator
  return { identifier: id, title, creator: Array.isArray(creator) ? creator.join('、') : String(creator || ''), files }
}

module.exports = {
  searchMedia,
  listPlayableFiles,
  listBookFiles,
  assertArchiveUrl,
  COLLECTIONS,
  __test: { fetchWithTimeout }
}
