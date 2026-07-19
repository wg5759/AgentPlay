const { authHeaders, validateProviderUrl } = require('../model-providers')
const { safeFetch } = require('../safe-fetch')
const { validateRecommendation } = require('../computer-use-orchestrator')

const OBSERVE_ONLY_PROMPT = `你是 AI 播放器的只观察电脑操作助手。
你会看到当前 AI 播放器窗口截图，只能建议下一步，不得执行操作。
不得建议 shell、终端、脚本、文件删除、系统设置、支付、登录或发送消息。
优先识别播放器内部的低风险按钮。每次只返回一个动作。`

const COMPUTER_USE_TOOL = {
  type: 'function',
  function: {
    name: 'computer_use',
    description: '只建议一个界面动作，不执行',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'double_click', 'right_click', 'type', 'scroll', 'key', 'wait', 'done', 'ask_user'] },
        x: { type: 'number', description: '0 到 1 的归一化横坐标' },
        y: { type: 'number', description: '0 到 1 的归一化纵坐标' },
        button: { type: 'string', enum: ['left', 'right'] },
        text: { type: 'string' },
        deltaY: { type: 'number' },
        key: { type: 'string' },
        reason: { type: 'string' }
      },
      required: ['action', 'reason']
    }
  }
}

function parseJsonText(content) {
  const text = String(content || '').trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)
  return JSON.parse(fenced ? fenced[1] : text)
}

function extractRecommendation(body, observation) {
  const message = body?.choices?.[0]?.message
  const call = message?.tool_calls?.find((item) => item?.function?.name === 'computer_use')
  const raw = call ? JSON.parse(call.function.arguments || '{}') : parseJsonText(message?.content)
  return validateRecommendation({ ...raw, frameId: observation.frameId }, observation)
}

function faraNativePrompt(observation) {
  return `You are a computer-use model observing an AI media player at ${observation.width}x${observation.height} pixels.
You must only recommend one next action. Nothing will be executed automatically.
Never propose terminal, shell, file deletion, system settings, payment, login, messaging, URL navigation or web search.
Allowed actions are left_click, type, scroll, key, wait, terminate.
Return thoughts followed by exactly:
<tool_call>
{"name":"computer_use","arguments":{"action":"left_click","coordinate":[x,y]}}
</tool_call>
Coordinates are pixels in the ${observation.width}x${observation.height} image.`
}

function mapFaraNativeAction(argumentsValue) {
  const args = argumentsValue || {}
  const action = String(args.action || '').toLowerCase()
  const coordinate = Array.isArray(args.coordinate) ? args.coordinate : []
  if (action === 'left_click' || action === 'click') {
    return { type: 'click', x: coordinate[0], y: coordinate[1], button: 'left' }
  }
  if (action === 'mouse_move') return { type: 'mouse_move', x: coordinate[0], y: coordinate[1] }
  if (action === 'type' || action === 'input_text') return { type: 'type', text: String(args.text ?? args.text_value ?? '') }
  if (action === 'scroll') return { type: 'scroll', deltaY: -Number(args.pixels || 0) }
  if (action === 'key' || action === 'keypress') {
    return { type: 'key', key: Array.isArray(args.keys) ? args.keys.join('+') : String(args.keys || '') }
  }
  if (action === 'wait') return { type: 'wait' }
  if (action === 'terminate') return { type: args.status === 'success' ? 'done' : 'ask_user' }
  return { type: action }
}

function extractFaraNativeRecommendation(body, observation) {
  const content = String(body?.choices?.[0]?.message?.content || '')
  const match = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i.exec(content)
  if (!match) throw new Error('Fara 响应缺少 <tool_call> 动作块')
  const call = JSON.parse(match[1])
  if (call.name && call.name !== 'computer_use') throw new Error('Fara 返回了未知工具')
  const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
  return validateRecommendation({
    frameId: observation.frameId,
    action: mapFaraNativeAction(args),
    reason: content.slice(0, match.index).trim() || 'Fara 未提供动作理由'
  }, observation)
}

class ComputerUseProvider {
  constructor({ fetchImpl = globalThis.fetch, dnsLookup } = {}) {
    this.fetchImpl = fetchImpl
    this.dnsLookup = dnsLookup
  }

  async suggest({ task, observation, config, signal }) {
    validateProviderUrl(config)
    if (config.requiresKey && !config.apiKey) throw new Error('Computer Use 服务尚未配置 API Key')
    const nativeFara = config.computerUseProtocol === 'fara-native'
    const body = nativeFara ? {
      model: config.model,
      temperature: 0,
      max_completion_tokens: 512,
      messages: [
        { role: 'system', content: faraNativePrompt(observation) },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: observation.dataUrl } },
            { type: 'text', text: `Task: ${task}\nFrame: ${observation.frameId}\nRecommend one action only.` }
          ]
        }
      ]
    } : {
      model: config.model,
      temperature: 0,
      max_completion_tokens: 512,
      messages: [
        { role: 'system', content: OBSERVE_ONLY_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: `任务：${task}\n当前画面编号：${observation.frameId}` },
            { type: 'image_url', image_url: { url: observation.dataUrl } }
          ]
        }
      ],
      tools: [COMPUTER_USE_TOOL],
      tool_choice: { type: 'function', function: { name: 'computer_use' } }
    }
    const response = await safeFetch(config, `${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(config) },
      body: JSON.stringify(body),
      signal
    }, { fetchImpl: this.fetchImpl, dnsLookup: this.dnsLookup })
    if (!response.ok) throw new Error(`Computer Use 服务返回 ${response.status}: ${(await response.text()).slice(0, 1000)}`)
    const responseBody = await response.json()
    return nativeFara
      ? extractFaraNativeRecommendation(responseBody, observation)
      : extractRecommendation(responseBody, observation)
  }
}

module.exports = {
  OBSERVE_ONLY_PROMPT,
  COMPUTER_USE_TOOL,
  faraNativePrompt,
  mapFaraNativeAction,
  extractRecommendation,
  extractFaraNativeRecommendation,
  ComputerUseProvider
}
