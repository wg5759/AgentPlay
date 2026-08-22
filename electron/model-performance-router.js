const fs = require('fs')
const path = require('path')

const LEDGER_SCHEMA_VERSION = 2
const DEFAULT_SETTINGS = Object.freeze({ mode: 'auto', objective: 'balanced', preference: 'smart' })
const VALID_MODES = new Set(['observe', 'auto'])
const VALID_OBJECTIVES = new Set(['balanced', 'quality', 'speed', 'economy'])
const VALID_PREFERENCES = new Set(['smart', 'local', 'cloud'])

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return { inputTokens: null, outputTokens: null, totalTokens: null, cacheHitTokens: null, cacheMissTokens: null }
  const inputTokens = finiteNumber(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount)
  const outputTokens = finiteNumber(usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount)
  const explicitTotal = finiteNumber(usage.total_tokens ?? usage.totalTokenCount)
  const totalTokens = explicitTotal ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null)
  const cacheHitTokens = finiteNumber(usage.prompt_cache_hit_tokens)
  const cacheMissTokens = finiteNumber(usage.prompt_cache_miss_tokens)
  return { inputTokens, outputTokens, totalTokens, cacheHitTokens, cacheMissTokens }
}

function modelKey(config = {}) {
  let endpoint = ''
  try {
    const parsed = new URL(String(config.baseUrl || ''))
    endpoint = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
  } catch {
    endpoint = config.protocol === 'cli' ? 'cli' : ''
  }
  return [config.providerId || 'unknown', config.model || 'unknown', config.thinkingMode || 'default', endpoint].join('::')
}

function taskKindForPersistentType(type) {
  if (type === 'document.run') return 'document'
  if (type === 'analysis.run') return 'analysis'
  if (type === 'project.evidence-qa') return 'cross-material-qa'
  if (type === 'subtitle.generate') return 'subtitle-translation'
  if (type === 'creative.video-generate') return 'creative-video'
  if (type === 'creative.recut-short') return 'creative-planning'
  return null
}

function supportsVision(config) {
  if (config?.capabilities?.vision === true) return true
  // Agnes 由调用层把不收图的 2.5 自动回退到已验证的 2.0 视觉模型。
  return config?.providerId === 'agnes'
}

function isConfigured(config) {
  if (!config || !config.providerId || !config.model) return false
  if (config.protocol === 'cli' || config.localOnly || config.bundled) return true
  return !config.requiresKey || Boolean(config.apiKey || config.hasApiKey)
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value))
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value))
}

function economyScore(aggregate) {
  if (aggregate.localOnly || aggregate.cost.status === 'local') return 100
  if (aggregate.cost.status === 'subscription') return 55
  const referenceUsdPer1k = finiteNumber(aggregate.cost.referenceUsdPer1k)
  if (referenceUsdPer1k !== null) return clamp(100 - Math.log10(1 + referenceUsdPer1k * 1000) * 25)
  return 35
}

class ModelPerformanceRouter {
  constructor(options = {}) {
    this.rootDir = options.rootDir
    this.filePath = path.join(this.rootDir, 'model-performance-v1.json')
    this.maxObservations = Math.max(1, Number(options.maxObservations) || 500)
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.state = this.read()
  }

  read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      return {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        settings: this.normalizeSettings(raw.settings),
        observations: Array.isArray(raw.observations) ? raw.observations.slice(-this.maxObservations) : [],
        quality: Array.isArray(raw.quality) ? raw.quality.slice(-this.maxObservations) : []
      }
    } catch {
      return { schemaVersion: LEDGER_SCHEMA_VERSION, settings: { ...DEFAULT_SETTINGS }, observations: [], quality: [] }
    }
  }

  normalizeSettings(input = {}) {
    return {
      mode: VALID_MODES.has(input.mode) ? input.mode : DEFAULT_SETTINGS.mode,
      objective: VALID_OBJECTIVES.has(input.objective) ? input.objective : DEFAULT_SETTINGS.objective,
      preference: VALID_PREFERENCES.has(input.preference) ? input.preference : DEFAULT_SETTINGS.preference
    }
  }

  persist() {
    fs.mkdirSync(this.rootDir, { recursive: true })
    const temporary = `${this.filePath}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    try {
      fs.renameSync(temporary, this.filePath)
    } catch {
      fs.copyFileSync(temporary, this.filePath)
      fs.unlinkSync(temporary)
    }
  }

  updateSettings(input = {}) {
    const supplied = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
    const merged = { ...this.state.settings, ...supplied }
    if (input.preference === 'smart' || input.preference === 'local' || input.preference === 'cloud') merged.mode = 'auto'
    this.state.settings = this.normalizeSettings(merged)
    this.persist()
    return { ...this.state.settings }
  }

  costFor(config, usage) {
    if (config.localOnly || config.bundled) return { status: 'local', estimatedUsd: null, referenceUsdPer1k: 0, label: '仅在本机运行' }
    if (config.protocol === 'cli') return { status: 'subscription', estimatedUsd: null, referenceUsdPer1k: null, label: '使用已有订阅，单次价格不可得' }
    const inputPrice = finiteNumber(config.pricing?.inputUsdPerMillion)
    const outputPrice = finiteNumber(config.pricing?.outputUsdPerMillion)
    if (inputPrice === null || outputPrice === null) return { status: 'unknown', estimatedUsd: null, referenceUsdPer1k: null, label: '价格未知，不按免费计算' }
    const referenceUsdPer1k = (inputPrice + outputPrice) / 1000
    if (usage.inputTokens === null || usage.outputTokens === null) return { status: 'unmeasured', estimatedUsd: null, referenceUsdPer1k, label: `参考单价 $${referenceUsdPer1k.toFixed(6)} / 千入+千出` }
    const cachedInputPrice = finiteNumber(config.pricing?.cachedInputUsdPerMillion)
    const hasCacheBreakdown = cachedInputPrice !== null && usage.cacheHitTokens !== null && usage.cacheMissTokens !== null
    const inputCost = hasCacheBreakdown
      ? usage.cacheHitTokens * cachedInputPrice + usage.cacheMissTokens * inputPrice
      : usage.inputTokens * inputPrice
    return {
      status: 'estimated',
      estimatedUsd: (inputCost + usage.outputTokens * outputPrice) / 1_000_000,
      referenceUsdPer1k,
      label: '按返回用量估算'
    }
  }

  recordCall(input = {}) {
    const startedAt = finiteNumber(input.startedAt)
    const completedAt = finiteNumber(input.completedAt) ?? finiteNumber(this.now())
    const usage = normalizeUsage(input.usage)
    const receipt = {
      at: completedAt,
      taskKind: String(input.taskKind || 'general'),
      modelKey: modelKey(input.config),
      providerId: String(input.config?.providerId || 'unknown'),
      model: String(input.config?.model || 'unknown'),
      localOnly: Boolean(input.config?.localOnly || input.config?.bundled),
      success: Boolean(input.success),
      latencyMs: startedAt !== null && completedAt !== null ? Math.max(0, completedAt - startedAt) : null,
      firstTokenMs: finiteNumber(input.firstTokenMs),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      cacheHitTokens: usage.cacheHitTokens,
      cacheMissTokens: usage.cacheMissTokens,
      errorCode: input.errorCode ? String(input.errorCode).slice(0, 80) : null,
      cost: this.costFor(input.config || {}, usage)
    }
    this.state.observations.push(receipt)
    this.state.observations = this.state.observations.slice(-this.maxObservations)
    this.persist()
    return receipt
  }

  recordQuality(input = {}) {
    const receipt = {
      at: finiteNumber(this.now()),
      taskKind: String(input.taskKind || 'general'),
      modelKey: modelKey(input.config),
      score: finiteNumber(input.score),
      passed: Boolean(input.passed)
    }
    this.state.quality.push(receipt)
    this.state.quality = this.state.quality.slice(-this.maxObservations)
    this.persist()
    return receipt
  }

  aggregate(config, taskKind = null) {
    const key = modelKey(config)
    const calls = this.state.observations.filter((item) => item.modelKey === key && (!taskKind || item.taskKind === taskKind))
    const quality = this.state.quality.filter((item) => item.modelKey === key && (!taskKind || item.taskKind === taskKind))
    const successRate = calls.length ? calls.filter((item) => item.success).length / calls.length : null
    const qualityScore = average(quality.map((item) => item.score))
    const latencyMs = average(calls.filter((item) => item.success).map((item) => item.latencyMs))
    const costs = calls.map((item) => item.cost).filter(Boolean)
    const estimatedCosts = costs.filter((item) => item.status === 'estimated').map((item) => item.estimatedUsd)
    const latestCost = costs.at(-1) || this.costFor(config, normalizeUsage(null))
    return {
      key,
      providerId: config.providerId,
      providerName: config.providerName,
      model: config.model,
      localOnly: Boolean(config.localOnly || config.bundled),
      samples: calls.length,
      qualitySamples: quality.length,
      successRate,
      qualityScore,
      latencyMs,
      cost: estimatedCosts.length
        ? { ...latestCost, estimatedUsd: average(estimatedCosts), label: `$${average(estimatedCosts).toFixed(6)} / 次（已记录平均）` }
        : latestCost
    }
  }

  eligibility(config, requirements, cloudAllowed) {
    if (!isConfigured(config)) return { eligible: false, reason: '尚未接入' }
    if (!cloudAllowed && !config.localOnly && !config.bundled) return { eligible: false, reason: '未授权云端' }
    if (requirements.vision && !supportsVision(config)) return { eligible: false, reason: '不支持看图' }
    if (requirements.text !== false && config.capabilities?.text === false) return { eligible: false, reason: '不支持文字' }
    if (requirements.providerId && config.providerId !== requirements.providerId) return { eligible: false, reason: '不符合任务指定能力' }
    return { eligible: true, reason: '' }
  }

  score(aggregate, objective) {
    const quality = aggregate.qualityScore ?? 65
    const success = aggregate.successRate === null ? 65 : aggregate.successRate * 100
    const speed = aggregate.latencyMs === null ? 60 : clamp(100 - Math.log10(Math.max(100, aggregate.latencyMs)) * 18)
    const economy = economyScore(aggregate)
    if (objective === 'quality') return quality * 0.68 + success * 0.22 + speed * 0.07 + economy * 0.03
    if (objective === 'speed') return speed * 0.55 + success * 0.25 + quality * 0.15 + economy * 0.05
    if (objective === 'economy') return economy * 0.55 + success * 0.2 + quality * 0.15 + speed * 0.1
    return quality * 0.32 + success * 0.31 + speed * 0.2 + economy * 0.17
  }

  select(input = {}) {
    const requirements = input.requirements || {}
    const cloudAllowed = Boolean(input.cloudAllowed)
    const unique = [...new Map((input.candidates || []).map((config) => [modelKey(config), config])).values()]
    let eligible = unique.filter((config) => this.eligibility(config, requirements, cloudAllowed).eligible)
    if (this.state.settings.preference === 'local') eligible = eligible.filter((config) => config.localOnly || config.bundled)
    if (this.state.settings.preference === 'cloud') {
      const cloud = eligible.filter((config) => !config.localOnly && !config.bundled)
      if (cloud.length) eligible = cloud
    }
    if (!eligible.length) return { selected: null, reason: '没有满足能力与授权边界的已接入模型', ranking: [] }

    const active = eligible.find((config) => modelKey(config) === input.activeKey)
    const ranking = eligible.map((config) => {
      const aggregate = this.aggregate(config, input.taskKind)
      return { ...aggregate, config, score: this.score(aggregate, this.state.settings.objective) }
    }).sort((left, right) => right.score - left.score)

    if (!active) return { selected: ranking[0].config, reason: '当前模型未通过能力硬门，已选择满足任务能力的已接入模型', ranking }
    if (this.state.settings.mode === 'observe') return { selected: active, reason: '保持当前模型，只记录真实表现', ranking }

    const activeAggregate = ranking.find((item) => item.key === modelKey(active))
    const alternatives = ranking.filter((item) => item.key !== modelKey(active))
    const provenAlternatives = alternatives.filter((item) => (
      item.samples >= 3 && (this.state.settings.objective !== 'quality' || item.qualitySamples >= 3)
    ))
    if (!provenAlternatives.length) return { selected: active, reason: '其他模型真实任务样本不足，暂不自动切换', ranking }
    const best = [activeAggregate, ...provenAlternatives].filter(Boolean).sort((left, right) => right.score - left.score)[0]
    return { selected: best.config, reason: best.key === modelKey(active) ? '当前模型综合表现最好' : '根据真实任务的质量、成功率、速度与可核验成本自动选择', ranking }
  }

  validate(config, options = {}) {
    return this.eligibility(config, options.requirements || {}, Boolean(options.cloudAllowed))
  }

  status(candidates = []) {
    return {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      settings: { ...this.state.settings },
      totalCalls: this.state.observations.length,
      totalQualityChecks: this.state.quality.length,
      models: candidates.map((config) => this.aggregate(config))
    }
  }
}

module.exports = {
  LEDGER_SCHEMA_VERSION,
  ModelPerformanceRouter,
  modelKey,
  normalizeUsage,
  taskKindForPersistentType
}
