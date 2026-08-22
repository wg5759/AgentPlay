// 远程媒体直链下载：严格 URL 策略（禁凭据、禁元数据/私网、DNS 校验、限重定向、限大小），
// 临时文件 + 原子重命名；进度与取消经回调透出。站点链接（B站/YouTube等）由 yt-dlp 组件负责，不走这里。
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { isProtectedAddress, isFakeIpPlaceholder } = require('./network-policy')

const MAX_REDIRECTS = 3
const MAX_BYTES = 2 * 1024 * 1024 * 1024
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.ts', '.flv', '.avi', '.wmv', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.wav'])

function isMediaUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim())
    if (!['http:', 'https:'].includes(parsed.protocol)) return false
    return VIDEO_EXTENSIONS.has(path.extname(parsed.pathname).toLowerCase())
  } catch {
    return false
  }
}

function extractUrl(text) {
  const match = /https?:\/\/[^\s"'）)】\]]+/i.exec(String(text || ''))
  return match ? match[0] : ''
}

// 常见视频站域名：消息里带这些链接就视为视频下载/拉片意图（含分享口令格式）
const VIDEO_SITE_HOSTS = ['bilibili.com', 'b23.tv', 'douyin.com', 'youtube.com', 'youtu.be', 'tiktok.com', 'ixigua.com', 'kuaishou.com', 'xiaohongshu.com', 'v.qq.com', 'iqiyi.com', 'mgtv.com', 'youku.com', 'sohu.com', 'x.com', 'twitter.com', 'facebook.com', 'fb.watch']

function isVideoSiteUrl(value) {
  try {
    const host = new URL(String(value || '').trim()).hostname.toLowerCase()
    return VIDEO_SITE_HOSTS.some((site) => host === site || host.endsWith('.' + site))
  } catch {
    return false
  }
}

function isDownloadIntent(text) {
  const url = extractUrl(text)
  if (!url) return false
  if (isMediaUrl(url)) return true
  if (isVideoSiteUrl(url)) return true // 视频站链接（含分享口令）一律触发
  if (String(text || '').trim() === url) return true // 裸链接视为下载意图（站点页交给 yt-dlp 解析）
  return /下载|保存|拉片|解剖|分析|双语|字幕|转写|播放/i.test(String(text || ''))
}

function sanitizeFileName(name) {
  const cleaned = String(name || '').split('').map((ch) => {
    const code = ch.codePointAt(0)
    return code < 32 || '<>:"/\\|?*'.includes(ch) ? '_' : ch
  }).join('').trim()
  return cleaned || `远程视频-${Date.now()}`
}
async function assertUrlAllowed(url, { dnsLookup } = {}) {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只支持 http/https 链接')
  if (parsed.username || parsed.password) throw new Error('链接不得包含账号或密码')
  const hostname = parsed.hostname.toLowerCase()
  if (['169.254.169.254', 'metadata.google.internal'].includes(hostname)) throw new Error('已拒绝云元数据地址')
  const lookup = dnsLookup || require('dns').promises.lookup
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  const list = (Array.isArray(addresses) ? addresses : [addresses]).map((item) => item?.address || item)
  if (!list.length) throw new Error('链接域名没有可用地址')
  // 全部落在 VPN fake-ip 占位段：由 VPN 按域名路由，跳过保护段拒绝
  if (list.every((address) => isFakeIpPlaceholder(address))) return parsed
  if (list.some((address) => isProtectedAddress(address))) throw new Error('链接解析到了私网或保留地址，已拒绝')
  return parsed
}

function fileNameFor(parsed, contentType) {
  const base = path.basename(parsed.pathname || '') || '远程视频'
  const decoded = decodeURIComponent(base).split('?')[0]
  if (path.extname(decoded)) return sanitizeFileName(decoded)
  const extByType = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv', 'audio/mpeg': '.mp3' }
  return sanitizeFileName(decoded + (extByType[contentType] || '.mp4'))
}

async function downloadRemoteMedia(url, { destDir, onProgress, onCheckpoint, checkpoint, signal, fetchImpl, dnsLookup } = {}) {
  const fetcher = fetchImpl || globalThis.fetch
  if (!fetcher) throw new Error('当前环境缺少下载能力')
  let current = String(checkpoint?.finalUrl || url || '').trim()
  let response = null
  let resumeTempPath = ''
  let resumeReceived = 0
  if (checkpoint?.tempPath) {
    const candidate = path.resolve(String(checkpoint.tempPath))
    const root = path.resolve(destDir) + path.sep
    if (candidate.startsWith(root) && candidate.endsWith('.agentplay.part') && fs.existsSync(candidate)) {
      resumeTempPath = candidate
      resumeReceived = fs.statSync(candidate).size
    }
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertUrlAllowed(current, { dnsLookup })
    response = await fetcher(current, {
      redirect: 'manual',
      signal,
      ...(resumeReceived > 0 ? { headers: { Range: `bytes=${resumeReceived}-` } } : {})
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new Error(`链接返回 ${response.status} 但没有跳转地址`)
      current = new URL(location, current).toString()
      response = null
      continue
    }
    break
  }
  if (!response) throw new Error('链接重定向次数过多')
  if (!response.ok) throw new Error(`链接返回 ${response.status}，无法下载`)
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (contentType && !contentType.startsWith('video/') && !contentType.startsWith('audio/') && contentType !== 'application/octet-stream') {
    throw new Error(`链接内容不是音视频（${contentType}）；站点链接（B站/YouTube/抖音）请等 yt-dlp 组件，或直接给视频文件直链`)
  }
  const contentLength = Number(response.headers.get('content-length')) || 0
  const contentRange = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(response.headers.get('content-range') || ''))
  const acceptedResume = response.status === 206 && resumeReceived > 0 && Number(contentRange?.[1]) === resumeReceived
  const total = contentRange?.[3] && contentRange[3] !== '*'
    ? Number(contentRange[3])
    : contentLength + (acceptedResume ? resumeReceived : 0)
  if (total > MAX_BYTES) throw new Error('文件超过 2GB 下载上限')
  const parsed = new URL(current)
  fs.mkdirSync(destDir, { recursive: true })
  const checkpointFinalPath = checkpoint?.finalPath ? path.resolve(String(checkpoint.finalPath)) : ''
  const destRoot = path.resolve(destDir) + path.sep
  const finalPath = acceptedResume && checkpointFinalPath.startsWith(destRoot)
    ? checkpointFinalPath
    : path.join(destDir, fileNameFor(parsed, contentType))
  const tempPath = acceptedResume ? resumeTempPath : `${finalPath}.agentplay.part`
  if (!acceptedResume && fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })
  const out = fs.createWriteStream(tempPath, { flags: acceptedResume ? 'a' : 'w' })
  let received = acceptedResume ? resumeReceived : 0
  onCheckpoint?.({ received, total, tempPath, finalPath, finalUrl: current })
  try {
    const reader = response.body.getReader()
    for (;;) {
      if (signal?.aborted) throw new Error('下载已取消')
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > MAX_BYTES) throw new Error('文件超过 2GB 下载上限')
      out.write(Buffer.from(value))
      onProgress?.({ received, total })
      onCheckpoint?.({ received, total, tempPath, finalPath, finalUrl: current })
    }
    await new Promise((resolve, reject) => { out.end((error) => (error ? reject(error) : resolve())) })
    if (total && received !== total) throw new Error(`下载不完整（${received}/${total} 字节）`)
    fs.renameSync(tempPath, finalPath)
    return { outputPath: finalPath, bytes: received, finalUrl: current }
  } catch (error) {
    try { out.destroy() } catch { /* 已关闭 */ }
    throw error
  }
}

module.exports = {
  MAX_BYTES,
  VIDEO_SITE_HOSTS,
  downloadRemoteMedia,
  extractUrl,
  isDownloadIntent,
  isMediaUrl,
  isVideoSiteUrl,
  assertUrlAllowed
}
