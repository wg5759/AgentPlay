const { listModels } = require('./model-providers')

const LOCAL_SERVICE_PRESETS = Object.freeze([
  { id: 'ollama', role: 'chat', name: 'Ollama', providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { id: 'lmstudio', role: 'chat', name: 'LM Studio', providerId: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { id: 'vllm', role: 'chat', name: 'vLLM / OpenAI 兼容服务', providerId: 'vllm', baseUrl: 'http://127.0.0.1:8000/v1' },
  { id: 'llamacpp', role: 'chat', name: 'llama.cpp', providerId: 'llamacpp', baseUrl: 'http://127.0.0.1:8080/v1' },
  { id: 'fara-local', role: 'computerUse', name: 'Microsoft Fara 本地服务', providerId: 'fara-local', baseUrl: 'http://127.0.0.1:5000/v1' }
])

function classifyPreset(preset, models) {
  if (preset.id !== 'vllm') return preset
  const looksLikeColibri = models.some((model) => /(?:colibri|glm[-_. ]?5\.2)/i.test(model))
  return looksLikeColibri
    ? { ...preset, id: 'colibri', name: 'Colibri / GLM-5.2', providerId: 'colibri' }
    : preset
}

async function inspectPreset(preset, options) {
  try {
    const models = await listModels({
      role: preset.role,
      providerId: preset.providerId,
      baseUrl: preset.baseUrl,
      model: ''
    }, {
      fetchImpl: options.fetchImpl,
      dnsLookup: options.dnsLookup,
      timeoutMs: options.timeoutMs || 1800,
      signal: options.signal
    })
    const classified = classifyPreset(preset, models)
    return { ...classified, status: 'ready', models }
  } catch (error) {
    return {
      ...preset,
      status: 'offline',
      models: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

async function discoverLocalServices(role = 'chat', options = {}) {
  const candidates = LOCAL_SERVICE_PRESETS.filter((preset) => preset.role === role)
  const results = await Promise.all(candidates.map((preset) => inspectPreset(preset, options)))
  return options.includeOffline ? results : results.filter((result) => result.status === 'ready')
}

module.exports = { LOCAL_SERVICE_PRESETS, classifyPreset, discoverLocalServices }
