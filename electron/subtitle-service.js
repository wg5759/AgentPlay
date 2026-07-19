const fs = require('fs')
const os = require('os')
const path = require('path')

async function searchSubtitle(name, apiKey) {
  if (!apiKey) return { success: false, error: '未配置 OpenSubtitles API key' }
  try {
    const resp = await fetch(
      'https://api.opensubtitles.com/api/v1/subtitles?query=' +
        encodeURIComponent(name) +
        '&languages=zh,en',
      { headers: { 'Api-Key': apiKey, 'User-Agent': 'AIPlayer/1.0' }, signal: AbortSignal.timeout(10000) }
    )
    if (!resp.ok) return { success: false, error: `OpenSubtitles API ${resp.status}` }
    const data = await resp.json()
    if (data.data && data.data.length > 0) {
      return {
        success: true,
        data: data.data.slice(0, 5).map((s) => ({
          id: s.id,
          fileId: s.attributes.files?.[0]?.file_id,
          fileName: s.attributes.files?.[0]?.file_name || s.attributes.release,
          language: s.attributes.language,
          release: s.attributes.release,
        })).filter((s) => s.fileId)
      }
    }
    return { success: false, error: '未找到字幕' }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

async function downloadSubtitle(fileId, apiKey) {
  if (!apiKey) return { success: false, error: '未配置 OpenSubtitles API key' }
  try {
    const ticket = await fetch('https://api.opensubtitles.com/api/v1/download', {
      method: 'POST',
      headers: {
        'Api-Key': apiKey,
        'User-Agent': 'AIPlayer/1.0',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ file_id: Number(fileId) }),
      signal: AbortSignal.timeout(10000)
    })
    if (!ticket.ok) return { success: false, error: `OpenSubtitles 下载授权 ${ticket.status}` }
    const info = await ticket.json()
    if (!info.link) return { success: false, error: '字幕服务未返回下载地址' }
    const response = await fetch(info.link, { signal: AbortSignal.timeout(20000) })
    if (!response.ok) return { success: false, error: `字幕下载失败 ${response.status}` }
    const data = Buffer.from(await response.arrayBuffer())
    if (data.length > 20 * 1024 * 1024) return { success: false, error: '字幕文件异常过大' }
    const safeName = path.basename(info.file_name || `subtitle-${fileId}.srt`).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    const outputDir = path.join(os.tmpdir(), 'ai-player-subtitles')
    fs.mkdirSync(outputDir, { recursive: true })
    const outputPath = path.join(outputDir, `${Date.now()}-${safeName}`)
    fs.writeFileSync(outputPath, data)
    return { success: true, path: outputPath, fileName: safeName }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

module.exports = { searchSubtitle, downloadSubtitle }
