const { Worker } = require('node:worker_threads')
const path = require('node:path')

function extractInWorker(zipPath, installRoot, asset, signal, onFile, timeoutMs = 180000) {
  if (signal.aborted) return Promise.reject(new Error('已取消下载'))
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'component-archive-worker.js'), { workerData: { zipPath, installRoot, asset: { size: asset.size, sha256: asset.sha256, files: asset.files } } })
    let failure, completed = false
    const stop = error => { failure ||= error; void worker.terminate() }
    const abort = () => stop(new Error('已取消下载'))
    const timer = setTimeout(() => stop(new Error('组件解包超时，已保留下载缓存，请稍后重试')), timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    worker.on('message', message => {
      if (message.type === 'complete') completed = true
      if (message.type === 'failure') failure = new Error(message.error)
      if (message.type === 'file' && !signal.aborted) onFile?.(message.path)
    })
    worker.on('error', error => { failure ||= error })
    worker.once('exit', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (failure || code !== 0 || !completed) reject(failure || new Error('组件解包进程未完整结束'))
      else resolve()
    })
  })
}
module.exports = { extractInWorker }
