const net = require('net')
const { isLoopbackHostname, isBlockedMetadataHostname, isProtectedAddress } = require('./network-policy')

const DEFAULT_CAPABILITIES = Object.freeze({
  text: true,
  vision: false,
  tools: true,
  streaming: false,
  computerUse: false,
  maxConcurrency: 4
})

const RAW_PROVIDERS = [
  { id: 'openai', name: 'OpenAI', region: '全球', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.2', 'gpt-5-mini', 'gpt-4.1-mini'], requiresKey: true },
  { id: 'anthropic', name: 'Anthropic Claude', region: '全球', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-sonnet-5', 'claude-opus-4-6', 'claude-sonnet-4-6'], requiresKey: true },
  { id: 'google', name: 'Google Gemini', region: '全球', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-flash'], requiresKey: true },
  { id: 'xai', name: 'xAI Grok', region: '全球', protocol: 'openai', baseUrl: 'https://api.x.ai/v1', models: ['latest', 'grok-4.5'], requiresKey: true },
  { id: 'deepseek', name: 'DeepSeek', region: '中国', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'], requiresKey: true },
  { id: 'mistral', name: 'Mistral AI', region: '欧洲', protocol: 'openai', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large-latest', 'mistral-small-latest'], requiresKey: true },
  { id: 'openrouter', name: 'OpenRouter（聚合）', region: '全球', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: ['openai/gpt-5.2', 'anthropic/claude-sonnet-4.6', 'google/gemini-3.1-pro-preview'], requiresKey: true },
  { id: 'groq', name: 'Groq', region: '全球', protocol: 'openai', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile'], requiresKey: true },
  { id: 'together', name: 'Together AI', region: '全球', protocol: 'openai', baseUrl: 'https://api.together.xyz/v1', models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'], requiresKey: true },
  { id: 'perplexity', name: 'Perplexity', region: '全球', protocol: 'openai', baseUrl: 'https://api.perplexity.ai', models: ['sonar-pro', 'sonar'], requiresKey: true },
  { id: 'qwen', name: '阿里云百炼 / 通义千问', region: '中国', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3-max', 'qwen-plus'], requiresKey: true },
  { id: 'moonshot', name: 'Moonshot / Kimi', region: '中国', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k2.5', 'moonshot-v1-32k'], requiresKey: true },
  { id: 'zhipu', name: '智谱 BigModel', region: '中国', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-5', 'glm-4.7'], requiresKey: true },
  { id: 'volcengine', name: '火山引擎方舟 / 豆包', region: '中国', protocol: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-seed-1-6'], requiresKey: true, modelHint: '方舟通常填写推理接入点 ID' },
  { id: 'baidu', name: '百度千帆 / 文心', region: '中国', protocol: 'openai', baseUrl: 'https://qianfan.baidubce.com/v2', models: ['ernie-5.0', 'ernie-4.5-turbo'], requiresKey: true },
  { id: 'bundled-lite', name: '内置 Qwen2.5-0.5B（离线轻量版）', region: '本机内置', protocol: 'openai', baseUrl: 'http://127.0.0.1:11555/v1', models: ['ai-player-qwen2.5-0.5b'], requiresKey: false, localOnly: true, bundled: true, capabilities: { streaming: false, tools: false, maxConcurrency: 1 }, modelHint: '约 409MB，只用于字幕摘要和一般问答；播放器控制走毫秒级本地路由。默认 4 线程以内、2K 上下文，闲置 5 分钟自动释放。' },
  { id: 'ollama', name: 'Ollama（本机）', region: '本机', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen3:8b', 'deepseek-r1:8b', 'llama3.3'], requiresKey: false, localOnly: true },
  { id: 'lmstudio', name: 'LM Studio（本机）', region: '本机', protocol: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', models: ['local-model'], requiresKey: false, localOnly: true },
  { id: 'vllm', name: 'vLLM / OpenAI 兼容（本机）', region: '本机', protocol: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', models: ['本机模型名'], requiresKey: false, localOnly: true, modelHint: '连接已经启动的 vLLM 或其他 OpenAI 兼容服务；应用不会下载模型。' },
  { id: 'llamacpp', name: 'llama.cpp（本机）', region: '本机', protocol: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', models: ['本机模型名'], requiresKey: false, localOnly: true, modelHint: '连接已经启动的 llama.cpp server；应用不会下载模型。' },
  {
    id: 'colibri',
    name: 'Colibri / GLM-5.2（本机实验）',
    region: '本机',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:8000/v1',
    models: ['glm-5.2-colibri'],
    requiresKey: false,
    localOnly: true,
    capabilities: { streaming: true, tools: false, maxConcurrency: 1 },
    modelHint: '仅连接已运行的 coli serve；文本-only，首次响应可能很慢，不会自动下载约 370GB 权重。'
  },
  { id: 'custom', name: '自定义 OpenAI 兼容接口', region: '自定义', protocol: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', models: ['自定义模型名'], requiresKey: false },
  {
    id: 'fara-local',
    name: 'Microsoft Fara-7B（本机观察实验）',
    region: '本机',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:5000/v1',
    models: ['microsoft/Fara-7B'],
    requiresKey: false,
    localOnly: true,
    computerUseProtocol: 'fara-native',
    roles: ['computerUse'],
    capabilities: { text: false, vision: true, tools: true, computerUse: true, maxConcurrency: 1 },
    modelHint: '只观察和建议，不执行鼠标键盘；支持 vLLM、LM Studio、Ollama 等 OpenAI 兼容本地服务。'
  },
  {
    id: 'fara-foundry',
    name: 'Microsoft Fara（Azure Foundry）',
    region: '云端',
    protocol: 'openai',
    baseUrl: 'https://YOUR-ENDPOINT.inference.ml.azure.com/v1',
    models: ['Fara-7B'],
    requiresKey: true,
    computerUseProtocol: 'fara-native',
    roles: ['computerUse'],
    capabilities: { text: false, vision: true, tools: false, computerUse: true, maxConcurrency: 1 },
    modelHint: '填写你在 Azure Foundry 部署后获得的 endpoint、model 和 API Key；仍保持只观察。'
  }
]

const PROVIDERS = RAW_PROVIDERS.map((provider) => ({
  ...provider,
  roles: provider.roles || ['chat'],
  capabilities: { ...DEFAULT_CAPABILITIES, ...(provider.capabilities || {}) }
}))

function defaultProviderId(role = 'chat') {
  return role === 'computerUse' ? 'fara-local' : 'deepseek'
}

function getProvider(providerId, role = 'chat') {
  const selected = PROVIDERS.find((provider) => provider.id === providerId && provider.roles.includes(role))
  if (selected) return selected
  return PROVIDERS.find((provider) => provider.id === defaultProviderId(role)) || PROVIDERS[0]
}

function normalizeConfig(input = {}, requestedRole = null) {
  const role = requestedRole || input.role || 'chat'
  const provider = getProvider(input.providerId || defaultProviderId(role), role)
  return {
    role,
    providerId: provider.id,
    providerName: provider.name,
    protocol: provider.protocol,
    baseUrl: String(input.baseUrl || provider.baseUrl).replace(/\/+$/, ''),
    model: String(input.model || provider.models[0]),
    apiKey: String(input.apiKey || ''),
    requiresKey: provider.requiresKey,
    localOnly: Boolean(provider.localOnly),
    bundled: Boolean(provider.bundled),
    computerUseProtocol: provider.computerUseProtocol || null,
    capabilities: { ...provider.capabilities }
  }
}

function validateProviderUrl(input) {
  const config = input.capabilities ? input : normalizeConfig(input)
  let parsed
  try {
    parsed = new URL(config.baseUrl)
  } catch {
    throw new Error('API 地址无效')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('API 地址只允许 HTTP 或 HTTPS')
  if (parsed.username || parsed.password) throw new Error('API 地址不得包含账号或密码')
  if (isBlockedMetadataHostname(parsed.hostname)) throw new Error('已拒绝云元数据或链路本地地址')
  if (config.localOnly && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(`${config.providerName} 仅允许连接本机 127.0.0.1/localhost`)
  }
  if (net.isIP(parsed.hostname) && isProtectedAddress(parsed.hostname) && !isLoopbackHostname(parsed.hostname)) {
    throw new Error('已拒绝私网或保留地址；局域网服务需在“本地模型”向导中明确授权')
  }
  return parsed
}

function authHeaders(config) {
  if (config.protocol === 'anthropic') {
    return { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' }
  }
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}
}

function createAbortContext(parentSignal, timeoutMs) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(parentSignal?.reason)
  if (parentSignal) {
    if (parentSignal.aborted) onAbort()
    else parentSignal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs)
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', onAbort)
    }
  }
}

async function listModels(input, options = {}) {
  const config = normalizeConfig(input, input.role)
  validateProviderUrl(config)
  if (config.requiresKey && !config.apiKey) throw new Error('请先填写 API Key')
  const timeoutMs = options.timeoutMs || (config.providerId === 'colibri' ? 60000 : 15000)
  const abort = createAbortContext(options.signal, timeoutMs)
  try {
    const url = config.protocol === 'gemini'
      ? `${config.baseUrl}/models?key=${encodeURIComponent(config.apiKey)}`
      : config.protocol === 'anthropic'
        ? `${config.baseUrl}/v1/models`
        : `${config.baseUrl}/models`
    const { safeFetch } = require('./safe-fetch')
    const response = await safeFetch(config, url, { headers: authHeaders(config), signal: abort.signal }, options)
    if (!response.ok) {
      const error = new Error(`接口返回 ${response.status}: ${(await response.text()).slice(0, 500)}`)
      error.status = response.status
      throw error
    }
    const body = await response.json()
    const items = Array.isArray(body) ? body : body.data || body.models || []
    return items
      .map((item) => typeof item === 'string' ? item : item.id || item.name || item.baseModelId)
      .filter(Boolean)
      .map((name) => String(name).replace(/^models\//, ''))
      .slice(0, 500)
  } finally {
    abort.dispose()
  }
}

async function probeConnection(input, options = {}) {
  const config = normalizeConfig(input, input.role)
  validateProviderUrl(config)
  let models
  let modelsSource = 'endpoint'
  try {
    models = await listModels(config, options)
  } catch (error) {
    if (config.providerId !== 'colibri' || ![404, 405].includes(error?.status)) throw error
    models = [config.model]
    modelsSource = 'configured-fallback'
  }
  if (config.providerId !== 'colibri') return { models, generationVerified: false }

  const abort = createAbortContext(options.signal, options.generationTimeoutMs || 120000)
  try {
    const { safeFetch } = require('./safe-fetch')
    const response = await safeFetch(config, `${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(config) },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: '只回复 OK' }],
        max_completion_tokens: 1,
        temperature: 0,
        stream: false
      }),
      signal: abort.signal
    }, options)
    if (!response.ok) throw new Error(`最小生成探测返回 ${response.status}: ${(await response.text()).slice(0, 500)}`)
    const body = await response.json()
    if (!body?.choices?.[0]?.message) throw new Error('最小生成探测响应格式不兼容')
    let health = null
    const healthUrl = `${config.baseUrl.replace(/\/v1$/i, '')}/health`
    try {
      const healthResponse = await safeFetch(config, healthUrl, { headers: authHeaders(config), signal: abort.signal }, options)
      if (healthResponse.ok) health = await healthResponse.json()
    } catch {
      // /health 是新版本可选扩展；缺失不能掩盖已通过的最小生成验证。
    }
    return { models, modelsSource, generationVerified: true, health }
  } finally {
    abort.dispose()
  }
}

module.exports = {
  DEFAULT_CAPABILITIES,
  PROVIDERS,
  getProvider,
  normalizeConfig,
  validateProviderUrl,
  isLoopbackHostname,
  authHeaders,
  createAbortContext,
  listModels,
  probeConnection
}
