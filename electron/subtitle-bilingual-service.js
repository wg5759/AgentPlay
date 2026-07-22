// 双语字幕服务：SRT 解析、批量翻译对齐、双语合成（原文在上、译文在下）。
// 翻译经 complete 注入（云端模型），批失败保留原文并如实计数，不静默。

function parseSrt(srtText) {
  const entries = []
  const blocks = String(srtText || '').replace(/\r\n/g, '\n').split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.trim().split('\n').filter(Boolean)
    if (lines.length < 2) continue
    const timeLine = lines.find((line) => /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(line))
    if (!timeLine) continue
    const timeIndex = lines.indexOf(timeLine)
    const [start, end] = timeLine.split('-->').map((part) => part.trim())
    entries.push({
      index: entries.length + 1,
      start,
      end,
      text: lines.slice(timeIndex + 1).join('\n').trim()
    })
  }
  return entries
}

function formatSrtEntries(entries) {
  return entries.map((entry) => `${entry.index}\n${entry.start} --> ${entry.end}\n${entry.text}`).join('\n\n') + '\n'
}

function buildBilingualSrt(entries, translations) {
  return entries.map((entry) => {
    const translated = translations.get(entry.index)
    const text = translated ? `${entry.text}\n${translated}` : entry.text
    return `${entry.index}\n${entry.start} --> ${entry.end}\n${text}`
  }).join('\n\n') + '\n'
}

function parseTranslationsJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed
  try { parsed = JSON.parse(raw) } catch {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) parsed = JSON.parse(raw.slice(start, end + 1))
    else throw new Error('翻译结果不是有效 JSON')
  }
  const list = Array.isArray(parsed?.translations) ? parsed.translations : []
  const map = new Map()
  for (const item of list) {
    const index = Number(item?.i ?? item?.index)
    const translated = String(item?.text ?? item?.t ?? '').trim()
    if (Number.isInteger(index) && index > 0 && translated) map.set(index, translated)
  }
  return map
}

async function translateBatch(entries, complete, { targetLang = '中文', signal } = {}) {
  const items = entries.map((entry) => ({ i: entry.index, text: entry.text }))
  const prompt = [
    '把下列字幕逐句翻译成' + targetLang + '，保持原意与口语化，不要合并或拆句，不要解释。',
    '只返回一个 JSON 对象，结构 {"translations":[{"i":序号,"text":"译文"}]}，序号必须与输入一致。',
    JSON.stringify({ items })
  ].join('\n')
  const response = await complete({
    systemPrompt: '你是字幕翻译器，只输出指定结构的 JSON。',
    prompt,
    signal
  })
  const map = parseTranslationsJson(response.text)
  const translations = new Map()
  for (const [index, text] of map) {
    if (entries.some((entry) => entry.index === index)) translations.set(index, text)
  }
  return translations
}

async function translateEntries(entries, complete, { batchSize = 20, targetLang = '中文', signal } = {}) {
  const translations = new Map()
  let failed = 0
  for (let start = 0; start < entries.length; start += batchSize) {
    const batch = entries.slice(start, start + batchSize)
    try {
      const map = await translateBatch(batch, complete, { targetLang, signal })
      for (const [index, text] of map) translations.set(index, text)
      failed += batch.filter((entry) => !translations.has(entry.index)).length
    } catch {
      failed += batch.length
    }
  }
  return { translations, failed }
}

// —— 实时双语字幕：从当前播放位置向前翻译，跳过/seek 自动重排 ——

function formatSrtTimestamp(seconds) {
  const value = Math.max(0, Number(seconds) || 0)
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const secs = Math.floor(value % 60)
  const millis = Math.round((value % 1) * 1000)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`
}

// parseSubtitleCues 给的是秒级 {start,end,text}；合成 SRT 需要字符串时间轴
function cuesToEntries(cues) {
  return (Array.isArray(cues) ? cues : []).map((cue, order) => ({
    index: order + 1,
    start: formatSrtTimestamp(cue.start),
    end: formatSrtTimestamp(cue.end),
    text: String(cue.text || '').trim()
  })).filter((entry) => entry.text)
}

// 取下一批待译：优先当前播放位置（含正在播的）之后，全部译完再回头补前面的
function nextLiveBatch(cues, translations, failed, position, batchSize = 20) {
  const pending = cues.filter((cue) => !translations.has(cue.index) && !failed.has(cue.index))
  if (!pending.length) return []
  const upcoming = pending.filter((cue) => cue.endSeconds >= position - 0.5)
  return (upcoming.length ? upcoming : pending).slice(0, batchSize)
}

async function runLiveTranslation({ cues, complete, getPosition = () => 0, onBatch = null, signal, batchSize = 20, targetLang = '中文' }) {
  const translations = new Map()
  const failed = new Set()
  while (translations.size + failed.size < cues.length) {
    if (signal?.aborted) return { translations, failed: failed.size, done: false, cancelled: true }
    const batch = nextLiveBatch(cues, translations, failed, Number(getPosition()) || 0, batchSize)
    if (!batch.length) break
    try {
      const map = await translateBatch(batch, complete, { targetLang, signal })
      for (const entry of batch) {
        if (map.has(entry.index)) translations.set(entry.index, map.get(entry.index))
        else failed.add(entry.index)
      }
    } catch (error) {
      if (signal?.aborted) return { translations, failed: failed.size, done: false, cancelled: true }
      for (const entry of batch) failed.add(entry.index)
    }
    await onBatch?.({ batch, translations, failed })
  }
  return { translations, failed: failed.size, done: true, cancelled: false }
}

module.exports = { parseSrt, formatSrtEntries, buildBilingualSrt, parseTranslationsJson, translateEntries, translateBatch, formatSrtTimestamp, cuesToEntries, nextLiveBatch, runLiveTranslation }
