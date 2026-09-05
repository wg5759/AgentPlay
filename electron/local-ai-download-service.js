const crypto = require('crypto')
const fs = require('fs')
const net = require('net')
const path = require('path')
const { once } = require('events')
const { Readable } = require('stream')
const JSZip = require('jszip')
const { isLoopbackHostname, isProtectedAddress } = require('./network-policy')

const DEFAULT_ALLOWED_HOSTS = ['github.com', '.githubusercontent.com']
const SAFE_PATH = /^[a-zA-Z0-9._/-]+$/
const EMIT_INTERVAL_MS = 200

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.tag !== 'string' || !Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new Error('本地 AI 组件包清单无效')
  }
  const checkFile = (file) => {
    if (!SAFE_PATH.test(String(file.path || '')) || file.path.includes('..')) throw new Error('本地 AI 组件包路径无效')
    if (file.archivePath !== undefined && (!SAFE_PATH.test(String(file.archivePath)) || file.archivePath.includes('..') || file.archivePath.startsWith('/'))) throw new Error('本地 AI 压缩包路径无效')
    if (!Number.isFinite(file.size) || file.size <= 0) throw new Error('本地 AI 组件包大小无效')
    if (!/^[a-f0-9]{64}$/.test(String(file.sha256 || ''))) throw new Error('本地 AI 组件包哈希无效')
  }
  for (const asset of manifest.assets) {
    if (!asset.id || typeof asset.url !== 'string') throw new Error('本地 AI 组件包资产无效')
    if (asset.kind === 'zip') {
      if (!Array.isArray(asset.files) || asset.files.length === 0) throw new Error('本地 AI 组件包缺少压缩包文件列表')
      asset.files.forEach(checkFile)
    } else {
      checkFile(asset)
    }
  }
}

function hostAllowed(hostname, allowedHosts) {
  const host = String(hostname || '').toLowerCase()
  return allowedHosts.some((entry) => (entry.startsWith('.') ? host.endsWith(entry) : host === entry))
}

function roleForPath(filePath) {
  if (filePath.endsWith('.exe')) return 'llama-server'
  if (filePath.includes('licenses/')) return 'license'
  return 'runtime-dependency'
}

class LocalAiDownloadService {
  constructor({ installRoot, manifest, fetchImpl, dnsLookup, allowedHosts, localOnly, logger } = {}) {
    if (!installRoot) throw new Error('缺少本地 AI 安装目录')
    validateManifest(manifest)
    this.installRoot = path.resolve(installRoot)
    this.manifest = manifest
    this.fetchImpl = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null)
    if (!this.fetchImpl) throw new Error('当前环境缺少 fetch，无法下载本地 AI 组件')
    this.allowedHosts = allowedHosts || DEFAULT_ALLOWED_HOSTS
    this.localOnly = Boolean(localOnly)
    this.logger = logger || console
    this.active = null
  }

  packInfo() {
    return {
      tag: this.manifest.tag,
      totalBytes: this.manifest.assets.reduce((sum, asset) => sum + asset.size, 0),
      assetCount: this.manifest.assets.length
    }
  }

  targetFor(relativePath) {
    if (!SAFE_PATH.test(relativePath) || relativePath.includes('..')) throw new Error('组件包包含非法路径')
    const resolved = path.resolve(this.installRoot, ...relativePath.split('/'))
    if (resolved !== this.installRoot && !resolved.startsWith(`${this.installRoot}${path.sep}`)) throw new Error('组件包路径越界')
    return resolved
  }

  finalFiles() {
    const files = []
    for (const asset of this.manifest.assets) {
      if (asset.kind === 'zip') files.push(...asset.files)
      else files.push(asset)
    }
    return files
  }

  installState() {
    let presentBytes = 0
    let missing = 0
    const files = this.finalFiles()
    for (const file of files) {
      try {
        const stat = fs.statSync(this.targetFor(file.path))
        if (stat.isFile() && stat.size === file.size) presentBytes += file.size
        else missing += 1
      } catch {
        missing += 1
      }
    }
    return { installed: missing === 0, presentBytes, totalBytes: files.reduce((sum, file) => sum + file.size, 0) }
  }

  status() {
    const state = this.installState()
    return {
      installed: state.installed,
      presentBytes: state.presentBytes,
      totalBytes: state.totalBytes,
      active: Boolean(this.active),
      ...(this.active ? { ...this.active.progress } : {})
    }
  }

  cancel() {
    if (!this.active) return false
    this.active.controller.abort()
    return true
  }

  start({ onProgress } = {}) {
    if (this.active) return this.active.promise
    const controller = new AbortController()
    const progress = {
      stage: 'download',
      currentFile: '',
      fileIndex: 0,
      fileCount: this.manifest.assets.length,
      receivedBytes: 0,
      totalBytes: this.packInfo().totalBytes
    }
    this.active = { controller, progress, promise: null }
    this.active.promise = this.runDownload(controller, progress, onProgress)
      .catch((error) => {
        // Node/Undici can surface cancellation before response headers, while
        // streaming, or during body cleanup. Keep one stable product error at
        // the service boundary regardless of which asynchronous phase won.
        if (controller.signal.aborted) throw new Error('已取消下载')
        throw error
      })
      .finally(() => {
        this.active = null
      })
    return this.active.promise
  }

  async assertUrlAllowed(url) {
    const parsed = new URL(url)
    const loopback = isLoopbackHostname(parsed.hostname)
    if (parsed.protocol !== 'https:' && !(this.localOnly && loopback && parsed.protocol === 'http:')) {
      throw new Error('已拒绝非 HTTPS 下载地址')
    }
    if (loopback) {
      if (!this.localOnly) throw new Error('已拒绝回环下载地址')
      return parsed
    }
    if (!hostAllowed(parsed.hostname, this.allowedHosts)) throw new Error(`已拒绝非白名单下载主机: ${parsed.hostname}`)
    if (net.isIP(parsed.hostname) && isProtectedAddress(parsed.hostname)) throw new Error('已拒绝私网或保留地址')
    // 不对白名单域名做 DNS 预解析拦截：国内常见的 GitHub 加速（hosts 代理、
    // Watt 工具箱等）会把域名指到本机回环反代，TLS 证书校验才是真正的防线。
    return parsed
  }

  async fetchAllowed(url, init) {
    let current = url
    for (let hop = 0; hop <= 5; hop += 1) {
      await this.assertUrlAllowed(current)
      const response = await this.fetchImpl(current, { ...init, redirect: 'manual' })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        try { await response.body?.cancel() } catch { /* 忽略重定向响应体的释放异常 */ }
        if (!location) throw new Error(`下载重定向缺少目标 (${response.status})`)
        current = new URL(location, current).toString()
        continue
      }
      return response
    }
    throw new Error('下载重定向次数过多')
  }

  async assertFileIntegrity(filePath, descriptor, deleteOnFail) {
    const label = descriptor.path || descriptor.id
    const fail = async (message) => {
      if (deleteOnFail) fs.rmSync(filePath, { force: true })
      throw new Error(message)
    }
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size !== descriptor.size) await fail(`组件包大小不匹配: ${label}`)
    const actual = await sha256File(filePath)
    if (actual !== descriptor.sha256) await fail(`组件包 SHA-256 校验失败，已删除损坏文件: ${label}`)
  }

  async fileIntact(file) {
    try {
      const stat = fs.statSync(this.targetFor(file.path))
      return stat.isFile() && stat.size === file.size
    } catch {
      return false
    }
  }

  async streamToFile(asset, filePath, controller, progress, emit) {
    let resumeFrom = 0
    try {
      const stat = fs.statSync(filePath)
      if (stat.isFile()) resumeFrom = stat.size
    } catch { /* 没有可续传的临时文件 */ }
    if (resumeFrom > asset.size) {
      fs.rmSync(filePath, { force: true })
      resumeFrom = 0
    }
    const headers = resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {}
    const response = await this.fetchAllowed(asset.url, { headers, signal: controller.signal })
    let received = resumeFrom
    let append = false
    if (resumeFrom > 0 && response.status === 206) {
      append = true
      progress.receivedBytes += resumeFrom
      emit(true)
    } else if (response.status === 416 && resumeFrom === asset.size) {
      try { await response.body?.cancel() } catch { /* 忽略响应体释放异常 */ }
      progress.receivedBytes += resumeFrom
      emit(true)
      return
    } else if (response.status === 200) {
      received = 0
    } else {
      throw new Error(`组件包下载失败 (${response.status}): ${asset.label || asset.id}`)
    }
    const stream = fs.createWriteStream(filePath, { flags: append ? 'a' : 'w' })
    try {
      const body = Readable.fromWeb(response.body)
      for await (const chunk of body) {
        if (controller.signal.aborted) throw new Error('已取消下载')
        if (!stream.write(chunk)) await once(stream, 'drain')
        received += chunk.length
        progress.receivedBytes += chunk.length
        if (received > asset.size) throw new Error('组件包大小超出清单，已中止')
        emit()
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Error('已取消下载')
      throw error
    } finally {
      stream.end()
      await once(stream, 'close').catch(() => {})
    }
    if (received !== asset.size) throw new Error(`组件包下载不完整: ${asset.label || asset.id}`)
  }

  async downloadFileAsset(asset, controller, progress, emit) {
    const target = this.targetFor(asset.path)
    if (await this.fileIntact(asset)) {
      progress.receivedBytes += asset.size
      emit(true)
      return
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const part = `${target}.part`
    await this.streamToFile(asset, part, controller, progress, emit)
    progress.stage = 'verify'
    progress.currentFile = asset.label || asset.id
    emit(true)
    await this.assertFileIntegrity(part, asset, true)
    fs.renameSync(part, target)
    progress.stage = 'download'
  }

  async downloadZipAsset(asset, controller, progress, emit) {
    const intact = await Promise.all(asset.files.map((file) => this.fileIntact(file)))
    if (intact.every(Boolean)) {
      progress.receivedBytes += asset.size
      emit(true)
      return
    }
    const downloadDir = path.join(this.installRoot, '.dl')
    fs.mkdirSync(downloadDir, { recursive: true })
    const zipPath = path.join(downloadDir, `${asset.id}.zip`)
    let haveZip = false
    if (fs.existsSync(zipPath)) {
      try {
        await this.assertFileIntegrity(zipPath, asset, false)
        haveZip = true
        progress.receivedBytes += asset.size
        emit(true)
      } catch {
        fs.rmSync(zipPath, { force: true })
      }
    }
    if (!haveZip) {
      const part = `${zipPath}.part`
      await this.streamToFile(asset, part, controller, progress, emit)
      progress.stage = 'verify'
      progress.currentFile = asset.label || asset.id
      emit(true)
      await this.assertFileIntegrity(part, asset, true)
      fs.renameSync(part, zipPath)
      progress.stage = 'download'
    }
    progress.stage = 'extract'
    progress.currentFile = asset.label || asset.id
    emit(true)
    const archive = await JSZip.loadAsync(fs.readFileSync(zipPath))
    for (const file of asset.files) {
      if (controller.signal.aborted) throw new Error('已取消下载')
      const entry = archive.file(file.archivePath || file.path)
      if (!entry) throw new Error(`组件包缺少文件: ${file.path}`)
      const buffer = await entry.async('nodebuffer')
      const target = this.targetFor(file.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const temp = `${target}.tmp`
      fs.writeFileSync(temp, buffer)
      await this.assertFileIntegrity(temp, file, true)
      fs.renameSync(temp, target)
    }
    fs.rmSync(zipPath, { force: true })
  }

  writeInstallManifest() {
    const modelAsset = this.manifest.assets.find((asset) => asset.role === 'model')
    const artifacts = []
    for (const asset of this.manifest.assets) {
      if (asset.kind === 'zip') {
        for (const file of asset.files) {
          artifacts.push({ role: roleForPath(file.path), path: file.path, size: file.size, sha256: file.sha256 })
        }
      } else {
        artifacts.push({ role: asset.role || 'file', path: asset.path, size: asset.size, sha256: asset.sha256 })
      }
    }
    const document = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      product: this.manifest.product || 'AgentPlay 本地 AI 组件',
      source: { tag: this.manifest.tag, channel: 'in-app-download' },
      ...(modelAsset ? { model: { expectedSha256: modelAsset.sha256 } } : {}),
      artifacts
    }
    const target = path.join(this.installRoot, 'bundled-ai-manifest.json')
    fs.mkdirSync(this.installRoot, { recursive: true })
    const temp = `${target}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`)
    fs.renameSync(temp, target)
  }

  async runDownload(controller, progress, onProgress) {
    let lastEmit = 0
    const emit = (force = false) => {
      const now = Date.now()
      if (!force && now - lastEmit < EMIT_INTERVAL_MS) return
      lastEmit = now
      try { onProgress?.({ ...progress }) } catch { /* 监听器异常不影响下载 */ }
    }
    for (const asset of this.manifest.assets) {
      progress.stage = 'download'
      progress.currentFile = asset.label || asset.id
      progress.fileIndex += 1
      emit(true)
      if (asset.kind === 'zip') await this.downloadZipAsset(asset, controller, progress, emit)
      else await this.downloadFileAsset(asset, controller, progress, emit)
    }
    progress.stage = 'verify'
    progress.currentFile = '写入安装清单'
    emit(true)
    this.writeInstallManifest()
    progress.stage = 'done'
    progress.receivedBytes = progress.totalBytes
    emit(true)
  }
}

module.exports = {
  DEFAULT_ALLOWED_HOSTS,
  LocalAiDownloadService,
  sha256File,
  validateManifest
}
