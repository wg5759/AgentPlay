// No Electron APIs or network: only a hash-pinned archive and fixed managed targets.
const { workerData, parentPort } = require('node:worker_threads')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const JSZip = require('jszip')
const { Readable } = require('node:stream')
const digest = data => crypto.createHash('sha256').update(data).digest('hex')
async function main() {
  const { zipPath, installRoot, asset } = workerData
  const root = path.resolve(installRoot), bytes = fs.readFileSync(zipPath)
  if (bytes.length !== asset.size || digest(bytes) !== asset.sha256) throw Error('组件压缩包校验失败')
  const archive = await JSZip.loadAsync(bytes)
  for (const file of asset.files) {
    if (!/^[a-zA-Z0-9._/-]+$/.test(file.path) || file.path.includes('..')) throw Error('组件包路径无效')
    const target = path.resolve(root, ...file.path.split('/'))
    if (!target.startsWith(root + path.sep)) throw Error('组件包路径越界')
    const entry = archive.file(file.archivePath || file.path)
    if (!entry) throw Error(`组件包缺少文件: ${file.path}`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temporary = target + '.tmp'
    let fd, received = 0
    const hash = crypto.createHash('sha256')
    try {
      fd = fs.openSync(temporary, 'w')
      for await (const chunk of new Readable({ read() {} }).wrap(entry.nodeStream('nodebuffer'))) {
        received += chunk.length
        if (received > file.size) throw Error(`组件解压大小超出清单: ${file.path}`)
        hash.update(chunk)
        let offset = 0
        while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset)
      }
      fs.closeSync(fd); fd = undefined
      if (received !== file.size || hash.digest('hex') !== file.sha256) throw Error(`组件解压完整性校验失败: ${file.path}`)
      fs.renameSync(temporary, target)
      parentPort.postMessage({ type: 'file', path: file.path })
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd)
      try { fs.unlinkSync(temporary) } catch {}
      throw error
    }
  }
  parentPort.postMessage({ type: 'complete' })
}
main().catch(error => { parentPort.postMessage({ type: 'failure', error: error.message }); process.exitCode = 1 })
