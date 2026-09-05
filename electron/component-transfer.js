const fs = require('node:fs')
const { Readable } = require('node:stream')
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')

function fault(message, retryable = false, retryAfterMs = 0) { return Object.assign(new Error(message), { retryable, retryAfterMs }) }
function retryable(error) {
  if (typeof error?.retryable === 'boolean') return error.retryable
  return /^(?:UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED)$/.test(error?.cause?.code || error?.code || '')
}

async function transferAttempt(service, asset, file, parentSignal, progress, emit, base, deadline) {
  if (parentSignal.aborted) throw fault('已取消下载')
  let offset = 0
  try { offset = fs.statSync(file).size } catch {}
  if (offset === asset.size) {
    try { await service.assertFileIntegrity(file, asset, false); progress.receivedBytes = base + offset; emit(true); return } catch { offset = 0 }
  }
  if (offset > asset.size) offset = 0
  const controller = new AbortController()
  const abort = () => controller.abort(fault('已取消下载'))
  parentSignal.addEventListener('abort', abort, { once: true })
  if (parentSignal.aborted) abort()
  let idle
  const arm = (ms, message) => { clearTimeout(idle); idle = setTimeout(() => controller.abort(fault(message, true)), ms) }
  const total = setTimeout(() => controller.abort(fault('组件下载达到本次时间上限，进度已保留，请稍后续传')), Math.max(1, deadline - Date.now()))
  arm(service.headersTimeoutMs, '组件下载连接超时，正在保留续传进度')
  let response, body, writer, writerError, closed
  try {
    response = await service.fetchAllowed(asset.url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: controller.signal })
    if (offset && response.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '')
      if (!range || Number(range[1]) !== offset || Number(range[2]) < offset || Number(range[2]) >= asset.size || Number(range[3]) !== asset.size) throw fault('组件续传范围与已保存进度不一致，未改动临时文件')
    } else if (response.status === 200) offset = 0
    else {
      const value = response.headers.get('retry-after')
      const retryAfterMs = !value ? 0 : /^\d+$/.test(value) ? Number(value) * 1000 : Math.max(0, Date.parse(value) - Date.now())
      throw fault(`组件包下载失败 (${response.status})：${asset.label || asset.id}`, [408, 429, 500, 502, 503, 504].includes(response.status) && retryAfterMs <= service.maxRetryDelayMs, retryAfterMs)
    }
    arm(service.idleTimeoutMs, '组件下载数据接收停滞超时，正在保留续传进度')
    let received = offset
    progress.receivedBytes = base + received; emit(true)
    writer = fs.createWriteStream(file, { flags: offset ? 'a' : 'w' })
    closed = new Promise(resolve => writer.once('close', resolve))
    writer.on('error', error => { writerError = error; controller.abort(error) })
    body = Readable.fromWeb(response.body, { signal: controller.signal })
    for await (const chunk of body) {
      if (controller.signal.aborted) throw controller.signal.reason
      if (received + chunk.length > asset.size) throw fault('组件包大小超出清单，已中止')
      arm(service.idleTimeoutMs, '组件下载数据接收停滞超时，正在保留续传进度')
      if (!writer.write(chunk)) await once(writer, 'drain')
      received += chunk.length; progress.receivedBytes = base + received; emit()
    }
    if (received !== asset.size) throw fault(`组件包下载不完整：${asset.label || asset.id}`, true)
  } catch (error) {
    throw writerError || (controller.signal.aborted ? controller.signal.reason : error)
  } finally {
    clearTimeout(idle); clearTimeout(total); parentSignal.removeEventListener('abort', abort)
    body?.destroy()
    if (!body) { try { await response?.body?.cancel() } catch {} }
    if (writer) { if (!writer.destroyed) writer.end(); await closed }
  }
  if (writerError) throw writerError
  if (parentSignal.aborted) throw fault('已取消下载')
}

async function transferWithRecovery(service, asset, file, controller, progress, emit) {
  const base = progress.receivedBytes, deadline = Date.now() + service.totalTimeoutMs
  for (let attempt = 1; attempt <= service.maxAttempts; attempt++) {
    try { return await transferAttempt(service, asset, file, controller.signal, progress, emit, base, deadline) }
    catch (error) {
      if (controller.signal.aborted) throw fault('已取消下载')
      if (attempt === service.maxAttempts || !retryable(error) || Date.now() >= deadline) throw error
      const wait = Math.max(error.retryAfterMs || 0, service.retryDelayMs * attempt)
      if (Date.now() + wait >= deadline) throw fault('组件下载达到本次时间上限，进度已保留')
      progress.currentFile = `${asset.label || asset.id}（续传重试 ${attempt + 1}/${service.maxAttempts}）`; emit(true)
      await delay(wait, undefined, { signal: controller.signal }).catch(() => { throw fault('已取消下载') })
    }
  }
}
module.exports = { transferWithRecovery }
