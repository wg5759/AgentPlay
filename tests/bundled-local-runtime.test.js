const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  assessHardware,
  verifyBundle,
  BundledLocalRuntime
} = require('../electron/bundled-local-runtime')

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

test('bundled model hardware gate uses current free memory and degrades without taking over the PC', () => {
  const recommended = assessHardware({ platform: 'win32', arch: 'x64', totalMemoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 9 * 1024 ** 3, logicalCpus: 8 })
  assert.equal(recommended.eligible, true)
  assert.equal(recommended.contextSize, 2048)
  assert.equal(recommended.threads, 4)

  const limited = assessHardware({ platform: 'win32', arch: 'x64', totalMemoryBytes: 8 * 1024 ** 3, availableMemoryBytes: 4 * 1024 ** 3, logicalCpus: 4 })
  assert.equal(limited.eligible, true)
  assert.equal(limited.tier, 'limited')
  assert.equal(limited.contextSize, 2048)
  assert.equal(limited.threads, 2)

  const busyButUsable = assessHardware({ platform: 'win32', arch: 'x64', totalMemoryBytes: 32 * 1024 ** 3, availableMemoryBytes: 6.6 * 1024 ** 3, logicalCpus: 8 })
  assert.equal(busyButUsable.eligible, true)
  assert.equal(busyButUsable.tier, 'limited')
  assert.equal(busyButUsable.threads, 2)

  const pressured = assessHardware({ platform: 'win32', arch: 'x64', totalMemoryBytes: 32 * 1024 ** 3, availableMemoryBytes: 2.5 * 1024 ** 3, logicalCpus: 8 })
  assert.equal(pressured.eligible, false)
  assert.match(pressured.reason, /当前仅剩 2\.5GB/)
  assert.equal(assessHardware({ platform: 'win32', arch: 'x64', totalMemoryBytes: 4 * 1024 ** 3, availableMemoryBytes: 3 * 1024 ** 3, logicalCpus: 4 }).eligible, false)
  assert.equal(assessHardware({ platform: 'darwin', arch: 'arm64', totalMemoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 8 * 1024 ** 3, logicalCpus: 8 }).eligible, false)
})

test('bundled runtime authenticates GGUF, executable and adjacent dependencies and detects mutation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-bundle-'))
  const modelPath = path.join(root, 'models', 'tiny.gguf')
  const exePath = path.join(root, 'ai-runtime', 'win-x64', 'llama-server.exe')
  const dllPath = path.join(root, 'ai-runtime', 'win-x64', 'ggml.dll')
  fs.mkdirSync(path.dirname(modelPath), { recursive: true })
  fs.mkdirSync(path.dirname(exePath), { recursive: true })
  const model = Buffer.from('GGUFtest-model')
  const exe = Buffer.from('test-executable')
  const dll = Buffer.from('test-dependency')
  fs.writeFileSync(modelPath, model)
  fs.writeFileSync(exePath, exe)
  fs.writeFileSync(dllPath, dll)
  const modelHash = digest(model)
  const manifest = {
    schemaVersion: 1,
    model: { expectedSha256: modelHash },
    artifacts: [
      { role: 'model', path: 'models/tiny.gguf', size: model.length, sha256: modelHash },
      { role: 'llama-server', path: 'ai-runtime/win-x64/llama-server.exe', size: exe.length, sha256: digest(exe) },
      { role: 'runtime-dependency', path: 'ai-runtime/win-x64/ggml.dll', size: dll.length, sha256: digest(dll) }
    ]
  }

  await verifyBundle(root, manifest, { expectedModelSha256: modelHash })
  fs.appendFileSync(dllPath, 'tampered')
  await assert.rejects(() => verifyBundle(root, manifest, { expectedModelSha256: modelHash }), /大小不匹配|校验失败/)
})

test('bundled runtime starts hidden with a minimal environment and a per-process model alias', async () => {
  let invocation = null
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.exitCode = null
  child.kill = () => {
    child.exitCode = 0
    queueMicrotask(() => child.emit('exit', 0))
  }
  const runtime = new BundledLocalRuntime({
    resourceRoot: 'C:\\trusted-ai-player-resources',
    port: 21555,
    spawnImpl: (executable, args, options) => {
      invocation = { executable, args, options }
      return child
    }
  })
  runtime.verified = true
  runtime.profile = () => ({ eligible: true, availableMemoryGb: 8, contextSize: 2048, threads: 3, batchThreads: 3 })
  runtime.waitUntilReady = async (alias) => assert.match(alias, /^ai-player-qwen2\.5-0\.5b-[a-f0-9]{8}$/)

  const status = await runtime.start()
  assert.equal(status.running, true)
  assert.equal(invocation.options.windowsHide, true)
  assert.equal(invocation.options.env.HTTP_PROXY, undefined)
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--host'), invocation.args.indexOf('--host') + 2), ['--host', '127.0.0.1'])
  assert.equal(invocation.args.includes('--gpu-layers'), true)
  assert.equal(invocation.args.includes('0'), true)
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--batch-size'), invocation.args.indexOf('--batch-size') + 2), ['--batch-size', '128'])
  await runtime.stop()
  assert.equal(runtime.status().running, false)
})

test('bundled runtime rechecks free memory before spawn and releases an idle model under pressure', async () => {
  const neverSpawn = new BundledLocalRuntime({
    resourceRoot: 'C:\\trusted-ai-player-resources',
    spawnImpl: () => { throw new Error('must not spawn') }
  })
  neverSpawn.verified = true
  let profiles = 0
  neverSpawn.profile = () => profiles++ === 0
    ? { eligible: true, availableMemoryGb: 6, contextSize: 2048, threads: 2, batchThreads: 2 }
    : { eligible: false, availableMemoryGb: 2.2, reason: '当前可用内存不足' }
  await assert.rejects(() => neverSpawn.start(), /当前可用内存不足/)

  const child = new EventEmitter()
  child.exitCode = null
  child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)) }
  const runtime = new BundledLocalRuntime({ resourceRoot: 'C:\\trusted-ai-player-resources', pressureCheckIntervalMs: 0 })
  runtime.child = child
  runtime.alias = 'pressure-test'
  runtime.state = 'ready'
  runtime.profile = () => ({ availableMemoryGb: 1.8, totalMemoryGb: 32, logicalCpus: 8, threads: 4, batchThreads: 4, eligible: false, tier: 'unsupported', reason: 'pressure', contextSize: 2048 })
  assert.equal(await runtime.checkMemoryPressure(), true)
  assert.equal(runtime.state, 'stopped')
  assert.match(runtime.lastNotice, /1\.8GB.*自动停止/)
})

test('full Windows installer explicitly ships the pinned model, runtime, manifest and licenses', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  const resources = packageJson.build.extraResources
  assert.ok(resources.some((item) => item.from === 'resources/models/Qwen2.5-0.5B-Instruct-Q4_0.gguf'))
  assert.ok(resources.some((item) => item.from === 'resources/ai-runtime/win-x64' && item.filter.includes('llama-server.exe') && item.filter.includes('*.dll')))
  assert.ok(resources.some((item) => item.from === 'resources/bundled-ai-manifest.json'))
  assert.ok(resources.some((item) => item.from === 'resources/licenses'))
  assert.match(packageJson.build.nsis.artifactName, /本地AI版/)
  assert.equal(packageJson.build.compression, 'normal')
  assert.ok(resources.some((item) => item.from === 'resources/bin/win' && item.filter.includes('mpv.com')))
  assert.equal(packageJson.build.win.icon, 'resources/icons/app-icon.ico')
  assert.equal(packageJson.build.nsis.installerIcon, 'resources/icons/app-icon.ico')
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'resources', 'icons', 'app-icon.ico')))

  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  assert.match(preload, /models:start-bundled/)
  assert.match(preload, /models:stop-bundled/)
  assert.match(main, /loading-local-model/)
  assert.match(main, /bundledRuntime\.stop/)
  const llmService = fs.readFileSync(path.join(__dirname, '..', 'electron', 'llm-service.js'), 'utf8')
  assert.doesNotMatch(llmService, /providerId === 'bundled-lite'[^]*?\/no_think/)
  assert.match(llmService, /body\.max_tokens = 512/)
  assert.match(llmService, /body\.temperature = 0\.2/)
})

test('standard Windows installer stays lean while preserving external and cloud model support', () => {
  const config = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.lean.yml'), 'utf8')
  assert.match(config, /AI播放器标准版安装包-\$\{version\}/)
  assert.match(config, /resources\/bin\/win/)
  assert.match(config, /compression: normal/)
  assert.match(config, /mpv\.com/)
  assert.doesNotMatch(config, /Qwen|models\/|ai-runtime|bundled-ai-manifest/)
  assert.match(config, /icon: resources\/icons\/app-icon\.ico/)

  const modelCenter = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ModelCenter.tsx'), 'utf8')
  assert.match(modelCenter, /!item\.bundled \|\| bundledStatus\?\.assetsPresent/)
  assert.match(modelCenter, /当前是标准版，未携带 409MB 模型/)
})
