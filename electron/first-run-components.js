const fs = require('node:fs')

async function ensureFirstRunComponents({ markerPath, components, log = console, now = Date.now }) {
  let marker = {}
  try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) } catch {}
  const ready = () => components.every(item => item.service.status().installed)
  if (ready() && marker.done) return { done: true, skipped: true }
  if (!marker.done && Number.isFinite(marker.nextRetryAt) && marker.nextRetryAt > now()) return { done: false, deferred: true, nextRetryAt: marker.nextRetryAt }
  const attempts = (Number(marker.attempts) || 0) + 1
  log.info('首启自动化：验证并补齐核心组件')
  const outcomes = await Promise.all(components.map(async item => {
    if (item.service.status().installed) return { id: item.id, installed: true }
    try { await item.service.start({}); return { id: item.id, installed: item.service.status().installed } }
    catch (error) { log.warn(`首启${item.id}组件暂未就绪`, error.message); return { id: item.id, installed: false, failed: true, retryAfterMs: Number.isFinite(error.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 0 } }
  }))
  const done = ready()
  const cooldown = Math.max(Math.min(3600000, 300000 * 2 ** Math.min(attempts - 1, 4)), ...outcomes.map(item => item.retryAfterMs || 0))
  const result = { schemaVersion: 2, done, attempts, at: new Date(now()).toISOString(), nextRetryAt: done ? null : now() + cooldown, components: outcomes }
  const temporary = markerPath + '.tmp'
  fs.writeFileSync(temporary, JSON.stringify(result)); fs.renameSync(temporary, markerPath)
  log.info(done ? '首启自动化：核心组件已完整验证' : '首启自动化：组件未装齐，进度已保留，稍后启动可续传')
  return result
}
module.exports = { ensureFirstRunComponents }
