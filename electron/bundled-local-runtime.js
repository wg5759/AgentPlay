const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const BUNDLED_PORT = 11555
const BUNDLED_PROVIDER_ID = 'bundled-lite'
const MODEL_PREFIX = 'ai-player-qwen2.5-0.5b'
const LOCKED_MODEL_SHA256 = '7671c0c304e6ce5a7fc577bcb12aba01e2c155cc2efd29b2213c95b18edaf6ed'
const MIN_START_AVAILABLE_GB = 3
const PRESSURE_STOP_AVAILABLE_GB = 2

function assessHardware(input = {}) {
  const platform = input.platform || process.platform
  const arch = input.arch || process.arch
  const totalMemoryBytes = input.totalMemoryBytes ?? os.totalmem()
  const availableMemoryBytes = input.availableMemoryBytes ?? os.freemem()
  const logicalCpus = input.logicalCpus ?? os.cpus().length
  const totalMemoryGb = Math.round((totalMemoryBytes / 1024 ** 3) * 10) / 10
  const availableMemoryGb = Math.round((availableMemoryBytes / 1024 ** 3) * 10) / 10
  const supportedPlatform = platform === 'win32' && arch === 'x64'
  const enoughTotalMemory = totalMemoryGb >= 8
  const enoughAvailableMemory = availableMemoryGb >= MIN_START_AVAILABLE_GB
  const enoughCpu = logicalCpus >= 2
  const eligible = supportedPlatform && enoughTotalMemory && enoughAvailableMemory && enoughCpu
  const resourceConstrained = totalMemoryGb < 12 || availableMemoryGb < 8
  const tier = !eligible ? 'unsupported' : resourceConstrained ? 'limited' : 'recommended'
  const threads = Math.max(1, Math.min(resourceConstrained ? 2 : 4, Math.ceil(logicalCpus / 2)))
  const reason = !supportedPlatform
    ? '内置运行时当前只支持 Windows x64'
    : !enoughTotalMemory
      ? '物理内存要求至少 8GB，建议继续使用外部或云端模型'
      : !enoughAvailableMemory
        ? `当前仅剩 ${availableMemoryGb}GB 可用内存；至少需要 ${MIN_START_AVAILABLE_GB}GB，请先关闭占用较大的程序`
      : !enoughCpu
        ? '至少需要 2 个逻辑处理器'
        : tier === 'limited'
          ? `当前可用内存 ${availableMemoryGb}GB，将降为 ${threads} 线程以减少对其他程序的影响`
          : '适合运行内置 Qwen2.5-0.5B 轻量模型；默认采用共存友好配置'
  return {
    platform,
    arch,
    totalMemoryGb,
    availableMemoryGb,
    logicalCpus,
    eligible,
    tier,
    reason,
    contextSize: 2048,
    threads,
    batchThreads: threads
  }
}

function assertInside(root, candidate) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(candidate)
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('本地 AI 清单包含越界路径')
  }
  return resolved
}

function assertPlainPath(root, filePath) {
  const relative = path.relative(root, filePath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('本地 AI 资源路径无效')
  let cursor = root
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment)
    const stat = fs.lstatSync(cursor)
    if (stat.isSymbolicLink()) throw new Error(`本地 AI 资源不得使用符号链接或目录联接: ${segment}`)
  }
  const real = fs.realpathSync.native(filePath)
  const normalizedReal = path.resolve(real).toLowerCase()
  const normalizedExpected = path.resolve(fs.realpathSync.native(root), relative).toLowerCase()
  if (normalizedReal !== normalizedExpected) throw new Error('本地 AI 资源真实路径不一致')
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

async function verifyBundle(resourceRoot, manifest = null, options = {}) {
  const root = path.resolve(resourceRoot)
  const document = manifest || JSON.parse(fs.readFileSync(path.join(root, 'bundled-ai-manifest.json'), 'utf8'))
  if (document.schemaVersion !== 1 || !Array.isArray(document.artifacts)) throw new Error('本地 AI 资源清单版本无效')
  const lockedModelHash = options.expectedModelSha256 || LOCKED_MODEL_SHA256
  if (document.model?.expectedSha256 !== lockedModelHash) {
    throw new Error('内置模型来源哈希与产品锁定值不一致')
  }

  for (const artifact of document.artifacts) {
    if (!/^[a-zA-Z0-9._/-]+$/.test(String(artifact.path || ''))) throw new Error('本地 AI 清单路径格式无效')
    const filePath = assertInside(root, path.join(root, ...artifact.path.split('/')))
    assertPlainPath(root, filePath)
    const before = fs.statSync(filePath)
    if (!before.isFile() || before.size !== artifact.size) throw new Error(`本地 AI 资源大小不匹配: ${artifact.path}`)
    const actual = await hashFile(filePath)
    const after = fs.statSync(filePath)
    if (!sameIdentity(before, after)) throw new Error(`本地 AI 资源在认证期间发生变化: ${artifact.path}`)
    if (actual !== artifact.sha256) throw new Error(`本地 AI 资源校验失败: ${artifact.path}`)
    if (artifact.role === 'model') {
      if (artifact.sha256 !== lockedModelHash) throw new Error('内置模型文件哈希与锁定来源不一致')
      const descriptor = fs.openSync(filePath, 'r')
      const magic = Buffer.alloc(4)
      try { fs.readSync(descriptor, magic, 0, 4, 0) } finally { fs.closeSync(descriptor) }
      if (magic.toString('ascii') !== 'GGUF') throw new Error('内置模型不是有效 GGUF 文件')
    }
  }
  return document
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

function directJson(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : null
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      agent: false,
      timeout: options.timeoutMs || 2000,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : undefined
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`本地模型返回 ${response.statusCode}`))
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('本地模型响应不是有效 JSON')) }
      })
    })
    request.on('timeout', () => request.destroy(new Error('本地模型响应超时')))
    request.on('error', reject)
    if (body) request.write(body)
    request.end()
  })
}

class BundledLocalRuntime {
  constructor(options = {}) {
    this.resourceRoot = options.resourceRoot
    this.spawnImpl = options.spawnImpl || spawn
    this.port = options.port || BUNDLED_PORT
    this.child = null
    this.alias = null
    this.state = 'stopped'
    this.lastError = ''
    this.logTail = ''
    this.startPromise = null
    this.verified = false
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60 * 1000
    this.idleTimer = null
    this.leases = 0
    this.pressureCheckIntervalMs = options.pressureCheckIntervalMs ?? 10 * 1000
    this.pressureTimer = null
    this.lastNotice = ''
    this.activeProfile = null
  }

  profile() {
    return assessHardware()
  }

  paths() {
    return {
      manifest: path.join(this.resourceRoot, 'bundled-ai-manifest.json'),
      runtimeDir: path.join(this.resourceRoot, 'ai-runtime', 'win-x64'),
      executable: path.join(this.resourceRoot, 'ai-runtime', 'win-x64', 'llama-server.exe'),
      model: path.join(this.resourceRoot, 'models', 'Qwen2.5-0.5B-Instruct-Q4_0.gguf')
    }
  }

  status() {
    const paths = this.paths()
    const liveProfile = this.profile()
    const running = this.state === 'ready' && Boolean(this.child && this.child.exitCode === null)
    const hardware = running && this.activeProfile
      ? {
          ...liveProfile,
          tier: this.activeProfile.tier,
          contextSize: this.activeProfile.contextSize,
          threads: this.activeProfile.threads,
          batchThreads: this.activeProfile.batchThreads,
          reason: `内置模型正以 ${this.activeProfile.threads} 线程运行；当前可用内存 ${liveProfile.availableMemoryGb}GB`
        }
      : liveProfile
    const assetsPresent = fs.existsSync(paths.manifest) && fs.existsSync(paths.executable) && fs.existsSync(paths.model)
    return {
      state: this.state,
      running,
      assetsPresent,
      modelName: 'Qwen2.5-0.5B Instruct Q4_0',
      modelSizeMb: 409,
      providerId: BUNDLED_PROVIDER_ID,
      baseUrl: `http://127.0.0.1:${this.port}/v1`,
      model: this.alias || MODEL_PREFIX,
      hardware,
      idleReleaseMinutes: Math.round(this.idleTimeoutMs / 60000),
      lastNotice: this.lastNotice,
      lastError: this.lastError
    }
  }

  appendLog(chunk) {
    this.logTail = `${this.logTail}${String(chunk || '')}`.slice(-12000)
  }

  async waitUntilReady(alias, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.child || this.child.exitCode !== null) throw new Error(`本地模型进程提前退出：${this.logTail.slice(-1000)}`)
      try {
        const body = await directJson(this.port, '/v1/models')
        if (Array.isArray(body.data) && body.data.some((item) => item.id === alias)) return
      } catch {
        // The model is still loading. Keep polling the loopback endpoint.
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error('内置模型加载超时')
  }

  async start() {
    if (this.state === 'ready' && this.child?.exitCode === null) {
      this.scheduleIdleStop()
      return this.status()
    }
    if (this.startPromise) return this.startPromise
    this.startPromise = this.startInternal().finally(() => { this.startPromise = null })
    return this.startPromise
  }

  async startInternal() {
    const hardware = this.profile()
    if (!hardware.eligible) throw new Error(hardware.reason)
    const paths = this.paths()
    this.state = 'verifying'
    this.lastError = ''
    try {
      if (!this.verified) {
        await verifyBundle(this.resourceRoot)
        this.verified = true
      }
      const launchHardware = this.profile()
      if (!launchHardware.eligible) throw new Error(launchHardware.reason)
      if (!(await isPortFree(this.port))) throw new Error(`本地 AI 端口 ${this.port} 已被其他程序占用`)

      const alias = `${MODEL_PREFIX}-${crypto.randomBytes(4).toString('hex')}`
      const args = [
        '--model', paths.model,
        '--host', '127.0.0.1', '--port', String(this.port),
        '--alias', alias,
        '--ctx-size', String(launchHardware.contextSize),
        '--threads', String(launchHardware.threads), '--threads-batch', String(launchHardware.batchThreads),
        '--batch-size', '128', '--ubatch-size', '128',
        '--gpu-layers', '0', '--jinja', '--no-webui'
      ]
      this.state = 'loading'
      this.logTail = ''
      this.activeProfile = launchHardware
      this.child = this.spawnImpl(paths.executable, args, {
        cwd: paths.runtimeDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          LANG: 'C.UTF-8'
        }
      })
      this.child.stdout?.on('data', (chunk) => this.appendLog(chunk))
      this.child.stderr?.on('data', (chunk) => this.appendLog(chunk))
      this.child.once('exit', (code) => {
        if (this.state !== 'stopped') {
          this.state = 'error'
          this.lastError = `本地模型进程已退出 (${code ?? 'unknown'})`
        }
      })
      await this.waitUntilReady(alias)
      this.alias = alias
      this.state = 'ready'
      this.lastNotice = ''
      this.scheduleIdleStop()
      this.startPressureMonitor()
      return this.status()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.state = 'error'
      await this.stop(false)
      this.state = 'error'
      throw error
    }
  }

  async stop(clearError = true, notice = '') {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.pressureTimer) clearInterval(this.pressureTimer)
    this.pressureTimer = null
    const child = this.child
    this.child = null
    this.alias = null
    this.activeProfile = null
    if (child && child.exitCode === null) child.kill()
    this.state = 'stopped'
    if (clearError) this.lastError = ''
    this.lastNotice = notice
    return this.status()
  }

  retain() {
    this.leases += 1
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  release() {
    this.leases = Math.max(0, this.leases - 1)
    this.scheduleIdleStop()
    void this.checkMemoryPressure()
  }

  scheduleIdleStop() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.leases > 0 || this.state !== 'ready' || !this.child || this.child.exitCode !== null || this.idleTimeoutMs <= 0) return
    this.idleTimer = setTimeout(() => { void this.stop() }, this.idleTimeoutMs)
    this.idleTimer.unref?.()
  }

  async checkMemoryPressure() {
    if (this.leases > 0 || this.state !== 'ready' || !this.child || this.child.exitCode !== null) return false
    const availableMemoryGb = this.profile().availableMemoryGb
    if (availableMemoryGb >= PRESSURE_STOP_AVAILABLE_GB) return false
    await this.stop(true, `系统可用内存降至 ${availableMemoryGb}GB，已自动停止内置模型并释放资源`)
    return true
  }

  startPressureMonitor() {
    if (this.pressureTimer) clearInterval(this.pressureTimer)
    this.pressureTimer = null
    if (this.pressureCheckIntervalMs <= 0) return
    this.pressureTimer = setInterval(() => { void this.checkMemoryPressure() }, this.pressureCheckIntervalMs)
    this.pressureTimer.unref?.()
  }
}

module.exports = {
  BUNDLED_PORT,
  BUNDLED_PROVIDER_ID,
  MODEL_PREFIX,
  LOCKED_MODEL_SHA256,
  MIN_START_AVAILABLE_GB,
  PRESSURE_STOP_AVAILABLE_GB,
  assessHardware,
  verifyBundle,
  directJson,
  BundledLocalRuntime
}
