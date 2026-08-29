const MAX_RECENT_MEDIA = 30

function pathKey(src) {
  const value = String(src || '').trim()
  if (/^(?:[a-z]:[\\/]|\\\\)/i.test(value)) return value.replace(/\\/g, '/').toLowerCase()
  return value
}

export function normalizeRecentMedia(value, limit = MAX_RECENT_MEDIA) {
  if (!Array.isArray(value)) return []
  const normalized = value
    .map((item) => {
      const src = typeof item?.src === 'string' ? item.src.trim() : ''
      if (!src) return null
      const fallbackName = src.split(/[\\/]/).pop() || src
      const name = typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : fallbackName
      const openedAt = Number.isFinite(Number(item?.openedAt)) ? Number(item.openedAt) : 0
      return { name, src, openedAt }
    })
    .filter(Boolean)
    .sort((left, right) => right.openedAt - left.openedAt)

  const seen = new Set()
  const result = []
  for (const item of normalized) {
    const key = pathKey(item.src)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(item)
    if (result.length >= Math.max(1, Number(limit) || MAX_RECENT_MEDIA)) break
  }
  return result
}

export function recordRecentMedia(current, item, limit = MAX_RECENT_MEDIA) {
  const src = typeof item?.src === 'string' ? item.src.trim() : ''
  if (!src) return normalizeRecentMedia(current, limit)
  return normalizeRecentMedia([{ ...item, src }, ...(Array.isArray(current) ? current : [])], limit)
}
