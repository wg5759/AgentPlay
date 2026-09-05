const { deflateSync } = require('node:zlib')
const { safeFetch } = require('./safe-fetch')
const { normalizeConfig, validateProviderUrl } = require('./model-providers')

function blueProbeImage() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length)
    const tail = Buffer.alloc(4); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([head, body, tail])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(32, 0); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 2
  const pixels = Buffer.alloc(32 * 97)
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) pixels[y * 97 + 1 + x * 3 + 2] = 255
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64')
}

async function probeTools(config, request) {
  if (config.protocol === 'cli') return 'not-tested'
  validateProviderUrl(config)
  const schema = { type: 'object', properties: { token: { type: 'string' } }, required: ['token'], additionalProperties: false }
  const prompt = 'Call probe_echo with token AP_PROBE. This is a protocol test, no action is performed.'
  const base = config.baseUrl.replace(/\/$/, '')
  let url, headers, body
  if (config.protocol === 'anthropic') {
    url = `${base}/v1/messages`; headers = { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' }
    body = { model: config.model, max_tokens: 256, messages: [{ role: 'user', content: prompt }], tools: [{ name: 'probe_echo', description: 'Echo test token', input_schema: schema }], tool_choice: { type: 'tool', name: 'probe_echo' } }
  } else if (config.protocol === 'gemini') {
    url = `${base}/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey || '')}`; headers = {}
    body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ functionDeclarations: [{ name: 'probe_echo', description: 'Echo test token', parameters: schema }] }], toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['probe_echo'] } } }
  } else {
    url = `${base}/chat/completions`; headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}
    body = { model: config.model, max_tokens: 256, messages: [{ role: 'user', content: prompt }], tools: [{ type: 'function', function: { name: 'probe_echo', description: 'Echo test token', parameters: schema } }], tool_choice: { type: 'function', function: { name: 'probe_echo' } } }
  }
  const response = await request(config, url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
  if (!response.ok) return 'not-verified'
  const data = await response.json()
  const call = config.protocol === 'anthropic' ? data.content?.find(item => item.type === 'tool_use') : config.protocol === 'gemini' ? data.candidates?.[0]?.content?.parts?.find(item => item.functionCall)?.functionCall : data.choices?.[0]?.message?.tool_calls?.[0]?.function
  const args = call?.input || call?.args || (call?.arguments ? JSON.parse(call.arguments) : {})
  return call?.name === 'probe_echo' && args.token === 'AP_PROBE' ? 'verified' : 'not-verified'
}

async function verifyModelCapabilities(input, engine, request = safeFetch) {
  const config = normalizeConfig(input)
  const result = { model: config.model, providerId: config.providerId, text: 'not-verified', vision: 'not-tested', tools: 'not-tested', testedAt: Date.now() }
  try {
    const reply = await engine.completeText([{ role: 'user', content: '只原样回复 AP_PROBE，不加其他文字。' }], config, { maxTokens: 256, timeoutMs: 20000 })
    if (String(reply.text || '').trim().replace(/^['"]|['"]$/g, '') === 'AP_PROBE') result.text = 'verified'
  } catch { /* no credentials or provider errors are returned to the UI */ }
  if (result.text !== 'verified') return { success: false, ...result, message: '未通过最小文本生成，请检查地址、模型名称和连接。' }
  if (config.protocol !== 'cli') {
    try {
      const reply = await engine.completeVisionMultiOnce({ prompt: 'What is the dominant color? Reply with one English color word only.', imageDataUrls: [blueProbeImage()], apiKey: config, timeoutMs: 20000, maxTokens: 256 })
      result.vision = /^blue[.!。]?$/i.test(String(reply.text || '').trim()) ? 'verified' : 'not-verified'
    } catch { result.vision = 'not-verified' }
    try { result.tools = await probeTools(config, request) } catch { result.tools = 'not-verified' }
  }
  const label = status => status === 'verified' ? '已验证' : status === 'not-tested' ? '未检测' : '暂未验证'
  return { success: true, ...result, message: `文本${label(result.text)} · 看图${label(result.vision)} · 工具调用${label(result.tools)}` }
}
module.exports = { verifyModelCapabilities, blueProbeImage }
