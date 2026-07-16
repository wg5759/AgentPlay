async function searchSubtitle(name, apiKey) {
  if (!apiKey) return null
  try {
    const resp = await fetch(
      'https://api.opensubtitles.com/api/v1/subtitles?query=' +
        encodeURIComponent(name) +
        '&languages=zh,en',
      { headers: { 'Api-Key': apiKey, 'User-Agent': 'AIPlayer/1.0' }, signal: AbortSignal.timeout(10000) }
    )
    const data = await resp.json()
    if (data.data && data.data.length > 0) {
      return data.data.slice(0, 5).map((s) => ({
        id: s.id,
        language: s.attributes.language,
        release: s.attributes.release,
        url: s.attributes.url
      }))
    }
  } catch {
    /* 网络错误返回 null */
  }
  return null
}

module.exports = { searchSubtitle }
