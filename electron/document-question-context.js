function questionContext(documents, question, maxChars = 6000) {
  const stop = new Set(['这个', '这份', '当前', '文档', '文件', '合同', '什么', '时候', '告诉', '一下', '请问'])
  const words = [...new Set((String(question).toLowerCase().match(/[a-z]{3,}|[\u3400-\u9fff]{2,}/g) || []).flatMap(word => /^[a-z]/.test(word) ? [word] : [3, 2].flatMap(size => Array.from({ length: Math.max(0, word.length - size + 1) }, (_, index) => word.slice(index, index + size)))))].filter(word => !stop.has(word))
  const rows = documents.flatMap(document => String(document.text || '').split(/\r?\n/).map((text, index) => ({ name: document.name, line: index + 1, text, score: words.reduce((sum, word) => sum + (text.toLowerCase().includes(word) ? 1 : 0), 0) })))
  const selected = new Map()
  let used = 0
  const put = row => { const key = `${row.name}:${row.line}`; if (selected.has(key) || !row.text.trim()) return; const room = Math.max(0, maxChars - used - key.length - 6); const hit = words.find(word => row.text.toLowerCase().includes(word)); const offset = row.text.length > room && hit ? Math.max(0, row.text.toLowerCase().indexOf(hit) - Math.min(120, room / 3)) : 0; const text = row.text.slice(offset, offset + room); if (!text) return; selected.set(key, { ...row, text }); used += text.length + key.length + 6 }
  for (const hit of [...rows].sort((a, b) => b.score - a.score).filter(row => row.score > 0)) {
    put(hit)
    for (const neighbor of rows.filter(row => row.name === hit.name && Math.abs(row.line - hit.line) <= 1)) put(neighbor)
    if (used >= maxChars - 80) break
  }
  for (const row of rows) { put(row); if (used >= maxChars - 80) break }
  return [...selected.values()].sort((a, b) => a.name.localeCompare(b.name) || a.line - b.line).map(row => `[${row.name}:L${row.line}] ${row.text}`).join('\n')
}
module.exports = { questionContext }
