const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  ModelPerformanceRouter,
  modelKey,
  normalizeUsage,
  taskKindForPersistentType
} = require('../electron/model-performance-router')

const local = {
  providerId: 'bundled-lite', providerName: '内置模型', model: 'small-local', baseUrl: 'http://127.0.0.1:11555/v1',
  protocol: 'openai', localOnly: true, requiresKey: false, capabilities: { text: true, vision: false, tools: false }
}
const cloud = {
  providerId: 'agnes', providerName: 'Agnes', model: 'agnes-2.0-flash', baseUrl: 'https://example.invalid/v1',
  protocol: 'openai', localOnly: false, requiresKey: true, apiKey: 'fake-key', capabilities: { text: true, vision: false, tools: true }
}

test('performance ledger persists bounded receipts without prompts, text or credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-model-router-'))
  try {
    const router = new ModelPerformanceRouter({ rootDir: root, maxObservations: 3, now: () => 10000 })
    for (let index = 0; index < 5; index += 1) {
      router.recordCall({
        taskKind: 'document', config: cloud, startedAt: 9000, completedAt: 10000,
        success: index !== 1, usage: { prompt_tokens: 100 + index, completion_tokens: 20 },
        prompt: 'must not persist', outputText: 'must not persist'
      })
    }
    const raw = fs.readFileSync(path.join(root, 'model-performance-v1.json'), 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.observations.length, 3)
    assert.doesNotMatch(raw, /secret-never-persist|must not persist/)
    assert.equal(parsed.observations.at(-1).inputTokens, 104)
    assert.equal(parsed.observations.at(-1).outputTokens, 20)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('usage normalization supports OpenAI, Anthropic and Gemini shapes without inventing tokens', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 4 }), { inputTokens: 10, outputTokens: 4, totalTokens: 14, cacheHitTokens: null, cacheMissTokens: null })
  assert.deepEqual(normalizeUsage({ input_tokens: 8, output_tokens: 2 }), { inputTokens: 8, outputTokens: 2, totalTokens: 10, cacheHitTokens: null, cacheMissTokens: null })
  assert.deepEqual(normalizeUsage({ promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 11 }), { inputTokens: 7, outputTokens: 3, totalTokens: 11, cacheHitTokens: null, cacheMissTokens: null })
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 4, prompt_cache_hit_tokens: 6, prompt_cache_miss_tokens: 4 }), { inputTokens: 10, outputTokens: 4, totalTokens: 14, cacheHitTokens: 6, cacheMissTokens: 4 })
  assert.deepEqual(normalizeUsage(null), { inputTokens: null, outputTokens: null, totalTokens: null, cacheHitTokens: null, cacheMissTokens: null })
})

test('hard capability and cloud permission gates run before weighted ranking', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-model-router-gates-'))
  try {
    const router = new ModelPerformanceRouter({ rootDir: root })
    router.updateSettings({ mode: 'auto', objective: 'balanced' })
    const denied = router.select({ taskKind: 'analysis-vision', candidates: [local, cloud], activeKey: modelKey(local), requirements: { vision: true }, cloudAllowed: false })
    assert.equal(denied.selected, null)
    assert.match(denied.reason, /没有满足能力与授权边界/)
    const allowed = router.select({ taskKind: 'analysis-vision', candidates: [local, cloud], activeKey: modelKey(local), requirements: { vision: true }, cloudAllowed: true })
    assert.equal(allowed.selected.providerId, 'agnes')
    assert.match(allowed.reason, /能力硬门/)
    assert.equal(router.validate(local, { requirements: { vision: true }, cloudAllowed: true }).eligible, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('observe mode never switches an eligible active model and auto mode needs real samples before takeover', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-model-router-cold-'))
  try {
    let tick = 1000
    const router = new ModelPerformanceRouter({ rootDir: root, now: () => tick })
    router.updateSettings({ mode: 'observe' })
    let decision = router.select({ taskKind: 'chat', candidates: [local, cloud], activeKey: modelKey(local), cloudAllowed: true })
    assert.equal(decision.selected.providerId, 'bundled-lite')
    router.updateSettings({ mode: 'auto', objective: 'quality' })
    decision = router.select({ taskKind: 'chat', candidates: [local, cloud], activeKey: modelKey(local), cloudAllowed: true })
    assert.equal(decision.selected.providerId, 'bundled-lite')
    assert.match(decision.reason, /样本不足/)
    for (let index = 0; index < 3; index += 1) {
      tick += 1000
      router.recordCall({ taskKind: 'chat', config: cloud, startedAt: tick - 400, completedAt: tick, success: true, usage: { prompt_tokens: 10, completion_tokens: 10 } })
      router.recordQuality({ taskKind: 'chat', config: cloud, score: 96, passed: true })
      router.recordCall({ taskKind: 'chat', config: local, startedAt: tick - 200, completedAt: tick, success: true })
      router.recordQuality({ taskKind: 'chat', config: local, score: 55, passed: false })
    }
    decision = router.select({ taskKind: 'chat', candidates: [local, cloud], activeKey: modelKey(local), cloudAllowed: true })
    assert.equal(decision.selected.providerId, 'agnes')
    assert.ok(decision.ranking[0].score > decision.ranking[1].score)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('unknown cloud price remains unknown instead of becoming zero-cost', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-model-router-cost-'))
  try {
    const router = new ModelPerformanceRouter({ rootDir: root })
    router.recordCall({ taskKind: 'subtitle-translation', config: cloud, startedAt: 0, completedAt: 1000, success: true, usage: { prompt_tokens: 1000, completion_tokens: 200 } })
    const status = router.status([cloud])
    const aggregate = status.models.find((item) => item.key === modelKey(cloud))
    assert.equal(aggregate.cost.status, 'unknown')
    assert.equal(aggregate.cost.estimatedUsd, null)
    assert.match(aggregate.cost.label, /价格未知/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('economy routing compares verified unit prices and reports average observed cost', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-model-router-economy-'))
  try {
    const expensive = {
      ...cloud,
      providerId: 'expensive-cloud',
      model: 'expensive',
      pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 30 }
    }
    const cheap = {
      ...cloud,
      providerId: 'cheap-cloud',
      model: 'cheap',
      pricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.3 }
    }
    const router = new ModelPerformanceRouter({ rootDir: root })
    router.updateSettings({ mode: 'auto', objective: 'economy' })
    for (let index = 0; index < 3; index += 1) {
      router.recordCall({ taskKind: 'chat', config: expensive, startedAt: 0, completedAt: 500, success: true, usage: { prompt_tokens: 1000, completion_tokens: 1000 } })
      router.recordCall({ taskKind: 'chat', config: cheap, startedAt: 0, completedAt: 500, success: true, usage: { prompt_tokens: 1000, completion_tokens: 1000 } })
    }

    const expensiveAggregate = router.aggregate(expensive, 'chat')
    assert.equal(expensiveAggregate.cost.estimatedUsd, 0.04)
    assert.equal(expensiveAggregate.cost.referenceUsdPer1k, 0.04)
    assert.match(expensiveAggregate.cost.label, /\$0\.040000.*平均/)

    const decision = router.select({
      taskKind: 'chat',
      candidates: [expensive, cheap],
      activeKey: modelKey(expensive),
      cloudAllowed: true
    })
    assert.equal(decision.selected.providerId, 'cheap-cloud')
    assert.match(decision.reason, /成本/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('verified cached-input pricing is used when the provider returns cache token counts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-model-router-cache-cost-'))
  try {
    const priced = {
      ...cloud,
      pricing: { cachedInputUsdPerMillion: 0.01, inputUsdPerMillion: 1, outputUsdPerMillion: 2 }
    }
    const router = new ModelPerformanceRouter({ rootDir: root })
    const receipt = router.recordCall({
      taskKind: 'chat', config: priced, startedAt: 0, completedAt: 100,
      success: true,
      usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 }
    })
    assert.equal(receipt.cacheHitTokens, 900)
    assert.equal(receipt.cacheMissTokens, 100)
    assert.equal(receipt.cost.estimatedUsd, 0.000309)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an unrated third model cannot piggyback on another alternative sample gate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-model-router-piggyback-'))
  try {
    const unrated = { ...cloud, providerId: 'deepseek', model: 'deepseek-chat' }
    const router = new ModelPerformanceRouter({ rootDir: root })
    router.updateSettings({ mode: 'auto', objective: 'quality' })
    for (let index = 0; index < 3; index += 1) {
      router.recordCall({ taskKind: 'chat', config: local, startedAt: 0, completedAt: 200, success: true })
      router.recordQuality({ taskKind: 'chat', config: local, score: 60, passed: true })
      router.recordCall({ taskKind: 'chat', config: cloud, startedAt: 0, completedAt: 900, success: true })
      router.recordQuality({ taskKind: 'chat', config: cloud, score: 40, passed: false })
    }
    const decision = router.select({ taskKind: 'chat', candidates: [local, cloud, unrated], activeKey: modelKey(local), cloudAllowed: true })
    assert.notEqual(decision.selected.providerId, 'deepseek')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('persistent task families map to stable model evaluation task kinds', () => {
  assert.equal(taskKindForPersistentType('document.run'), 'document')
  assert.equal(taskKindForPersistentType('analysis.run'), 'analysis')
  assert.equal(taskKindForPersistentType('project.evidence-qa'), 'cross-material-qa')
  assert.equal(taskKindForPersistentType('subtitle.generate'), 'subtitle-translation')
  assert.equal(taskKindForPersistentType('creative.video-generate'), 'creative-video')
  assert.equal(taskKindForPersistentType('creative.recut-short'), 'creative-planning')
  assert.equal(taskKindForPersistentType('download.direct'), null)
})
