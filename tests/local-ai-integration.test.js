const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  PROVIDERS,
  normalizeConfig,
  validateProviderUrl,
  probeConnection
} = require('../electron/model-providers')
const { safeFetch } = require('../electron/safe-fetch')
const { ModelConfigStore } = require('../electron/model-config-store')
const { ColibriAdapter, buildColibriRequest } = require('../electron/adapters/colibri-adapter')
const { ComputerUseProvider } = require('../electron/adapters/computer-use-provider')
const { ComputerUseOrchestrator, validateRecommendation } = require('../electron/computer-use-orchestrator')
const { ScreenCaptureService } = require('../electron/screen-capture-service')
const { discoverLocalServices } = require('../electron/local-model-discovery')

function createSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().replace(/^encrypted:/, '')
  }
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return `http://127.0.0.1:${address.port}/v1`
}

test('Colibri and Fara providers declare explicit roles and fail closed outside loopback', () => {
  const colibri = PROVIDERS.find((provider) => provider.id === 'colibri')
  const fara = PROVIDERS.find((provider) => provider.id === 'fara-local')

  assert.deepEqual(colibri.roles, ['chat'])
  assert.equal(colibri.capabilities.streaming, true)
  assert.equal(colibri.capabilities.tools, false)
  assert.equal(colibri.capabilities.vision, false)
  assert.equal(colibri.localOnly, true)

  assert.deepEqual(fara.roles, ['computerUse'])
  assert.equal(fara.capabilities.computerUse, true)
  assert.equal(fara.capabilities.vision, true)
  assert.equal(fara.localOnly, true)
  const faraFoundry = PROVIDERS.find((provider) => provider.id === 'fara-foundry')
  assert.deepEqual(faraFoundry.roles, ['computerUse'])
  assert.equal(faraFoundry.computerUseProtocol, 'fara-native')
  assert.equal(faraFoundry.requiresKey, true)

  assert.doesNotThrow(() => validateProviderUrl(normalizeConfig({
    role: 'chat', providerId: 'colibri', baseUrl: 'http://127.0.0.1:8000/v1'
  })))
  assert.throws(() => validateProviderUrl(normalizeConfig({
    role: 'chat', providerId: 'colibri', baseUrl: 'http://192.168.1.5:8000/v1'
  })), /仅允许连接本机/)
  assert.throws(() => validateProviderUrl(normalizeConfig({
    role: 'computerUse', providerId: 'fara-local', baseUrl: 'https://example.com/v1'
  })), /仅允许连接本机/)
  assert.throws(() => validateProviderUrl(normalizeConfig({
    role: 'chat', providerId: 'custom', baseUrl: 'http://192.168.1.20:8000/v1'
  })), /私网或保留地址/)
})

test('provider requests reject private DNS results and every HTTP redirect before fetch follows it', async () => {
  const config = normalizeConfig({
    role: 'chat', providerId: 'custom', baseUrl: 'https://api.example.test/v1', model: 'test'
  })
  let fetchCalls = 0
  await assert.rejects(() => safeFetch(config, 'https://api.example.test/v1/models', {}, {
    dnsLookup: async () => [{ address: '169.254.169.254', family: 4 }],
    fetchImpl: async () => { fetchCalls += 1; return new Response('{}') }
  }), /DNS.*受保护地址/)
  assert.equal(fetchCalls, 0)

  await assert.rejects(() => safeFetch(config, 'https://api.example.test/v1/models', {}, {
    dnsLookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async (_url, options) => {
      fetchCalls += 1
      assert.equal(options.redirect, 'manual')
      return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest' } })
    }
  }), /拒绝 API 重定向/)
  assert.equal(fetchCalls, 1)
})

test('model config schema v1 migrates to independent chat and computer-use roles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-role-config-'))
  const filePath = path.join(dir, 'model-config.json')
  fs.writeFileSync(filePath, JSON.stringify({
    providerId: 'openai',
    model: 'gpt-5.2',
    baseUrl: 'https://api.openai.com/v1',
    encryptedApiKey: Buffer.from('encrypted:chat-secret').toString('base64')
  }))

  try {
    const store = new ModelConfigStore(dir, createSafeStorage())
    assert.equal(store.resolved('chat').apiKey, 'chat-secret')
    assert.equal(store.publicConfig('chat').schemaVersion, 2)

    store.save({
      role: 'computerUse',
      providerId: 'fara-local',
      model: 'microsoft/Fara-7B',
      baseUrl: 'http://127.0.0.1:5000/v1'
    })

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    assert.equal(raw.schemaVersion, 2)
    assert.equal(raw.roles.chat.providerId, 'openai')
    assert.equal(raw.roles.computerUse.providerId, 'fara-local')
    assert.equal(store.resolved('chat').apiKey, 'chat-secret')
    assert.equal(store.resolved('computerUse').model, 'microsoft/Fara-7B')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Colibri requests omit tools by default and stream text deltas', async () => {
  let receivedBody = null
  let authorization = null
  const server = http.createServer((req, res) => {
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      authorization = req.headers.authorization
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n')
      res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n')
      res.end('data: [DONE]\n\n')
    })
  })
  const baseUrl = await listen(server)

  try {
    const config = normalizeConfig({ role: 'chat', providerId: 'colibri', baseUrl, model: 'glm-5.2-colibri' })
    const request = buildColibriRequest(config, [{ role: 'user', content: '你好' }], [{ type: 'function' }])
    assert.equal(Object.hasOwn(request, 'tools'), false)
    assert.equal(request.stream, true)

    const deltas = []
    const result = await new ColibriAdapter().generate({
      config,
      messages: [{ role: 'user', content: '你好' }],
      onDelta: (delta) => deltas.push(delta)
    })
    assert.equal(result.text, '你好')
    assert.deepEqual(deltas, ['你', '好'])
    assert.equal(receivedBody.tools, undefined)
    assert.equal(receivedBody.stream, true)
    assert.equal(authorization, undefined)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('Colibri streaming can be cancelled without discarding text already received', async () => {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"已"}}]}\n\n')
      const timer = setInterval(() => res.write(': keep-alive\n\n'), 50)
      res.on('close', () => clearInterval(timer))
    })
  })
  const baseUrl = await listen(server)
  const controller = new AbortController()

  try {
    const config = normalizeConfig({ role: 'chat', providerId: 'colibri', baseUrl, model: 'glm-5.2-colibri' })
    const result = await new ColibriAdapter().generate({
      config,
      messages: [{ role: 'user', content: '长回答' }],
      signal: controller.signal,
      onDelta: () => controller.abort()
    })
    assert.equal(result.cancelled, true)
    assert.equal(result.text, '已')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('Fara-compatible provider returns a validated observation-only recommendation', async () => {
  let sentBody = null
  const fetchImpl = async (_url, options) => {
    sentBody = JSON.parse(options.body)
    return new Response(JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{
            function: {
              name: 'computer_use',
              arguments: JSON.stringify({ action: 'click', x: 0.5, y: 0.75, button: 'left', reason: '定位播放按钮' })
            }
          }]
        }
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const provider = new ComputerUseProvider({ fetchImpl })
  const observation = {
    frameId: 'frame-1', width: 1000, height: 600, createdAt: Date.now(), dataUrl: 'data:image/png;base64,AA=='
  }
  const config = {
    ...normalizeConfig({ role: 'computerUse', providerId: 'fara-local', baseUrl: 'http://127.0.0.1:5000/v1' }),
    computerUseProtocol: null
  }
  const recommendation = await provider.suggest({ task: '找到播放按钮', observation, config })

  assert.equal(recommendation.frameId, 'frame-1')
  assert.equal(recommendation.action.type, 'click')
  assert.equal(recommendation.action.x, 0.5)
  assert.equal(sentBody.messages[1].content[1].type, 'image_url')
  assert.equal(sentBody.temperature, 0)
})

test('Fara native text protocol is converted to the same observation-only action schema', async () => {
  let sentBody = null
  const provider = new ComputerUseProvider({
    fetchImpl: async (_url, options) => {
      sentBody = JSON.parse(options.body)
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'The play button is centered below the video.\n<tool_call>\n{"name":"computer_use","arguments":{"action":"left_click","coordinate":[500,300]}}\n</tool_call>' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
  })
  const observation = {
    frameId: 'frame-native', width: 1000, height: 600, createdAt: Date.now(), dataUrl: 'data:image/png;base64,AA=='
  }
  const config = normalizeConfig({ role: 'computerUse', providerId: 'fara-local', baseUrl: 'http://127.0.0.1:5000/v1' })
  const recommendation = await provider.suggest({ task: '找到播放按钮', observation, config })
  assert.equal(recommendation.action.type, 'click')
  assert.equal(recommendation.action.x, 0.5)
  assert.equal(recommendation.action.y, 0.5)
  assert.match(recommendation.reason, /play button/i)
  assert.equal(Object.hasOwn(sentBody, 'tools'), false)
  assert.match(sentBody.messages[0].content, /1000x600/)
})

test('Colibri probe falls back from a missing models endpoint and reports optional health', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"missing"}')
    } else if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"choices":[{"message":{"content":"OK"}}]}')
    } else if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"active":0,"queued":0,"completed":3,"rejected":0}')
    } else {
      res.writeHead(404).end()
    }
  })
  const baseUrl = await listen(server)
  try {
    const result = await probeConnection({ role: 'chat', providerId: 'colibri', baseUrl, model: 'glm-5.2-colibri' })
    assert.deepEqual(result.models, ['glm-5.2-colibri'])
    assert.equal(result.modelsSource, 'configured-fallback')
    assert.equal(result.generationVerified, true)
    assert.equal(result.health.completed, 3)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('computer-use orchestrator has no execution path and rejects stale or unsafe actions', async () => {
  const observation = {
    frameId: 'frame-safe', width: 1280, height: 720, createdAt: Date.now(), dataUrl: 'data:image/png;base64,AA=='
  }
  const orchestrator = new ComputerUseOrchestrator({
    capture: async () => observation,
    provider: { suggest: async () => ({
      frameId: 'frame-safe',
      action: { type: 'click', x: 0.25, y: 0.5, button: 'left' },
      reason: '建议位置'
    }) }
  })
  const result = await orchestrator.suggest({ task: '观察界面', config: {} })
  assert.equal(result.mode, 'observe-only')
  assert.equal(result.recommendation.action.type, 'click')
  assert.equal(typeof orchestrator.execute, 'undefined')

  assert.throws(() => validateRecommendation({
    frameId: 'old-frame', action: { type: 'click', x: 0.2, y: 0.2 }
  }, observation), /画面已变化/)
  assert.throws(() => validateRecommendation({
    frameId: 'frame-safe', action: { type: 'shell', command: 'whoami' }
  }, observation), /不支持的动作/)

  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'computer-use-orchestrator.js'), 'utf8')
  assert.doesNotMatch(source, /sendInputEvent|robotjs|child_process|powershell/i)
})

test('computer-use screenshot hides its own modal and restores it without writing a file', async () => {
  const calls = []
  const image = {
    getSize: () => ({ width: 800, height: 450 }),
    toDataURL: () => 'data:image/png;base64,AA=='
  }
  const service = new ScreenCaptureService(() => ({
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: async (source) => calls.push(source.includes("style.display = 'none'") ? 'hide' : 'restore'),
      capturePage: async () => { calls.push('capture'); return image }
    }
  }))
  const observation = await service.capture()
  assert.deepEqual(calls, ['hide', 'capture', 'restore'])
  assert.equal(observation.width, 800)
  assert.match(observation.dataUrl, /^data:image\/png;base64,/)
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'screen-capture-service.js'), 'utf8')
  assert.doesNotMatch(source, /writeFile|createWriteStream/)
  assert.match(source, /input\[type="password"\]/)
  assert.match(source, /autocomplete="cc-number"/)
  assert.match(source, /data-ai-sensitive/)
})

test('opening model settings from computer-use closes the higher observation modal', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8')
  assert.match(appSource, /action === 'model-center'[\s\S]{0,120}setComputerUseOpen\(false\)[\s\S]{0,120}setModelCenterOpen\(true\)/)
})

test('local discovery only performs read-only model probes and maps Colibri by model identity', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' })
    const port = new URL(url).port
    if (port === '11434') {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3:8b' }] }), { status: 200 })
    }
    if (port === '8000') {
      return new Response(JSON.stringify({ data: [{ id: 'glm-5.2-colibri' }] }), { status: 200 })
    }
    return new Response('offline', { status: 503 })
  }

  const results = await discoverLocalServices('chat', { fetchImpl, timeoutMs: 100 })
  assert.deepEqual(results.map((item) => item.providerId).sort(), ['colibri', 'ollama'])
  assert.equal(results.find((item) => item.providerId === 'ollama').models[0], 'qwen3:8b')
  assert.ok(calls.every((call) => call.method === 'GET'))
  assert.ok(calls.every((call) => /\/v1\/models$/.test(call.url)))
})
