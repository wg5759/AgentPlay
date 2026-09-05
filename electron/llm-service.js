// Agent 引擎：云端 LLM + function calling
// 桌面端通过 IPC 调用，工具执行连接 mpv 播放器
// API: DeepSeek / 火山方舟（OpenAI 兼容，环境变量配置 key）
const fs = require('fs')
const path = require('path')
const { normalizeConfig } = require('./model-providers')
const { safeFetch } = require('./safe-fetch')
const { ColibriAdapter } = require('./adapters/colibri-adapter')
const { listAgentTools, getAgentTool, executeAgentTool, listAgentSkillInstructions } = require('./agent-tool-registry')
const { AgentRunLedger } = require('./agent-run-ledger')
const agentRuntimePolicyPromise = import('./agent-runtime-policy.mjs')

const SYSTEM_PROMPT = `你是 AgentPlay 的 Agent 助手。用户用自然语言控制播放器，你调用工具执行。
可用工具：暂停/继续、绝对或相对跳转、音量/静音、倍速、字幕、画面模式、窗口模式、截图、加载字幕、打印、视频摘要。摘要工具返回 transcript 时，必须基于 transcript 给出简洁摘要和章节；工具明确失败时不得编造内容。用中文简洁回复。`

const CAPABILITY_QUESTION_PATTERN = /(?:你是谁|你是什么|你(?:都)?能做什么|你都会什么|你有哪些功能|具体(?:都)?能(?:完成|做)什么(?:任务)?|AgentPlay(?:具体)?能做什么)/i

function productCapabilityAnswer(text) {
  const input = String(text || '').trim()
  if (input.length > 80 || !CAPABILITY_QUESTION_PATTERN.test(input) || /(?:帮我|请你|现在|立即).*(?:下载|剪辑|生成|打开|播放|翻译|删除|处理)/i.test(input)) return ''
  return [
    '我是 AgentPlay：一个本地优先、能实际执行任务的 AI 媒体与内容工作台。',
    '目前可以直接完成：',
    '1. 打开并播放本地视频、音频、图片、PDF、Word、Excel、PPT 等文件；',
    '2. 下载公开视频，并选择“仅下载”或“下载并拉片”；',
    '3. 生成、翻译、校对、调时、封装或烧录字幕；',
    '4. 按全片字幕和关键帧生成专业拉片报告、Word、PPT、表格等成果；',
    '5. 用自然语言截取、删除、拼接视频，添加本地合法音乐，并撤销/重做；',
    '6. 检测并删除长停顿，所有剪辑另存新文件，不覆盖原片；',
    '7. 处理文档、扫描件OCR、表格和多材料证据问答；',
    '8. 接入本地模型、云模型或订阅模型；上云、付费、发布、删除和凭证操作都会先确认。',
    '直接打开文件或描述最终想得到的结果即可。'
  ].join('\n')
}

function chatRequestTimeoutMs(config = {}) {
  if (config.providerId === 'bundled-lite') return 120000
  if (/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/)/i.test(String(config.baseUrl || config.base || ''))) return 90000
  return 30000
}

function timeoutReply(config = {}) {
  const label = config.providerId === 'bundled-lite' ? '本机内置模型' : (config.providerName || '当前模型')
  return `[模型响应超时] ${label}本次生成时间过长，任务已安全停止。可以直接重试；如经常发生，请切换“优先效果”或更快的模型。`
}

function friendlyModelError(error, config = {}) {
  const message = String(error?.message || error || '')
  if (!/exceed(?:s|ed)?\s+(?:the\s+)?available context|exceed_context_size|context (?:size|window)|上下文.{0,8}(?:超过|超限)/i.test(message)) return message
  const counts = [...message.matchAll(/(\d+)\s*tokens?/gi)].map((match) => Number(match[1]))
  const requested = counts[0] || '超出限制'
  const limit = counts[1] || '有限'
  const label = [config.providerName, config.model].filter(Boolean).join('（') + (config.providerName && config.model ? '）' : '')
  return `当前${label || '模型'}一次最多处理约 ${limit} tokens，本次请求约 ${requested} tokens。AgentPlay 将改用分段处理；如果仍失败，可在模型接入中心选择大上下文云模型。`
}

function openAIRequestBody(body, config = {}) {
  const isDeepSeek = config.providerId === 'deepseek' || /^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(config.baseUrl || config.base || '')
  if (!isDeepSeek || !['enabled', 'disabled'].includes(config.thinkingMode)) return body
  return { ...body, thinking: { type: config.thinkingMode } }
}

async function resolveRuntime(mode, tools = null, taskPrompt = SYSTEM_PROMPT) {
  const policy = await agentRuntimePolicyPromise
  const pluginEnabled = tools === null
  const availableTools = pluginEnabled ? listAgentTools() : tools
  const runtime = policy.resolveAgentRuntime(mode, availableTools)
  const skills = pluginEnabled ? listAgentSkillInstructions() : ''
  const combinedPrompt = skills ? `${taskPrompt}\n\n[已启用的本地 Skill]\n${skills}` : taskPrompt
  return { ...runtime, systemPrompt: policy.buildAgentSystemPrompt(combinedPrompt, runtime.mode) }
}

function durationFromText(text, fallback = null) {
  const hour = text.match(/(\d+(?:\.\d+)?|[一二两三四五六七八九十]+)\s*(?:小时|时)/)
  const minute = text.match(/(\d+(?:\.\d+)?|[一二两三四五六七八九十]+)\s*(?:分钟|分)/)
  const second = text.match(/(\d+(?:\.\d+)?|[一二两三四五六七八九十]+)\s*秒/)
  if (!hour && !minute && !second) return fallback
  const parseNumber = (value) => {
    if (!value) return 0
    if (/^\d/.test(value)) return Number(value)
    const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
    if (!value.includes('十')) return digits[value] || 0
    const [left, right] = value.split('十')
    return (left ? digits[left] : 1) * 10 + (right ? digits[right] : 0)
  }
  return (parseNumber(hour?.[1]) * 3600) + (parseNumber(minute?.[1]) * 60) + parseNumber(second?.[1])
}

class AgentEngine {
  constructor(mpv) {
    this.mpv = mpv
    this.colibri = new ColibriAdapter()
    // 优先 DeepSeek，其次火山方舟
    if (process.env.OLLAMA_MODEL) {
      this.apiBase = 'http://localhost:11434/v1'
      this.apiKey = 'ollama'
      this.model = process.env.OLLAMA_MODEL
    } else if (process.env.DEEPSEEK_API_KEY) {
      this.apiBase = 'https://api.deepseek.com/v1'
      this.apiKey = process.env.DEEPSEEK_API_KEY
      this.model = 'deepseek-v4-flash'
      this.thinkingMode = 'disabled'
    } else if (process.env.VOLCENGINE_API_KEY) {
      this.apiBase = 'https://ark.cn-beijing.volces.com/api/v3'
      this.apiKey = process.env.VOLCENGINE_API_KEY
      this.model = 'doubao-seed-1-6-250615'
    } else {
      this.apiBase = null
      this.apiKey = null
      this.model = null
    }
  }

  isAvailable() {
    return Boolean(this.apiBase && (this.apiKey || /^http:\/\/(?:localhost|127\.0\.0\.1)(?::|\/)/i.test(this.apiBase)))
  }

  resolveProvider(apiKey) {
    if (apiKey && typeof apiKey === 'object') {
      const config = normalizeConfig(apiKey, apiKey.role || 'chat')
      return { ...config, base: config.baseUrl, key: config.apiKey }
    }
    if (!apiKey || apiKey === this.apiKey) {
      return { base: this.apiBase, baseUrl: this.apiBase, key: apiKey || this.apiKey, model: this.model, thinkingMode: this.thinkingMode, protocol: 'openai', providerId: 'environment', localOnly: /^http:\/\/(?:localhost|127\.0\.0\.1)(?::|\/)/i.test(this.apiBase || ''), capabilities: { tools: true, streaming: false } }
    }
    if (apiKey.startsWith('sk-')) {
      return { ...normalizeConfig({ providerId: 'deepseek', apiKey }), base: 'https://api.deepseek.com/v1', key: apiKey }
    }
    return {
      base: 'https://ark.cn-beijing.volces.com/api/v3',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      key: apiKey,
      model: process.env.VOLCENGINE_MODEL || 'doubao-seed-1-6-250615',
      protocol: 'openai',
      providerId: 'volcengine',
      capabilities: { tools: true, streaming: false }
    }
  }

  async chatAnthropic(messages, config, context, runtime, ledger) {
    let msgs = messages.map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message.content || '')
    }))
    const toolResults = []
    for (let i = 0; i < runtime.maxToolTurns; i++) {
      if (!ledger.beginTurn()) return { text: '[达到本次任务时间预算]', toolResults }
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; controller.abort() }, chatRequestTimeoutMs(config))
      let response
      try {
        response = await safeFetch(config, `${config.base}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.key,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: 2048,
            system: runtime.systemPrompt,
            messages: msgs,
            ...(runtime.tools.length > 0 ? { tools: runtime.tools.map((tool) => ({
              name: tool.function.name,
              description: tool.function.description,
              input_schema: tool.function.parameters
            })) } : {})
          }),
          signal: controller.signal
        })
      } catch (error) {
        if (timedOut || error?.name === 'AbortError') return { text: timeoutReply(config), toolResults }
        return { text: `[网络错误] ${error instanceof Error ? error.message : String(error)}`, toolResults }
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) return { text: `[API 错误 ${response.status}] ${(await response.text()).slice(0, 1000)}`, toolResults }
      const data = await response.json()
      const blocks = data.content || []
      const calls = blocks.filter((block) => block.type === 'tool_use')
      if (!calls.length) return { text: blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n') || '(无回复)', toolResults }
      msgs.push({ role: 'assistant', content: blocks })
      const results = []
      for (const call of calls) {
        const result = runtime.canUseTool(call.name)
          ? await this.executeTool(call.name, call.input || {}, context, ledger)
          : { success: false, error: `当前${runtime.label}模式不允许工具 ${call.name}` }
        toolResults.push({ tool: call.name, args: call.input || {}, result })
        results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result) })
      }
      msgs.push({ role: 'user', content: results })
    }
    return { text: '[达到最大工具调用次数]', toolResults }
  }

  async chatGemini(messages, config, context, runtime, ledger) {
    let contents = messages.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(message.content || '') }]
    }))
    const toolResults = []
    for (let i = 0; i < runtime.maxToolTurns; i++) {
      if (!ledger.beginTurn()) return { text: '[达到本次任务时间预算]', toolResults }
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; controller.abort() }, chatRequestTimeoutMs(config))
      let response
      try {
        response = await safeFetch(config, `${config.base}/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.key)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: runtime.systemPrompt }] },
            contents,
            ...(runtime.tools.length > 0 ? { tools: [{ functionDeclarations: runtime.tools.map((tool) => ({
              name: tool.function.name,
              description: tool.function.description,
              parameters: tool.function.parameters
            })) }] } : {})
          }),
          signal: controller.signal
        })
      } catch (error) {
        if (timedOut || error?.name === 'AbortError') return { text: timeoutReply(config), toolResults }
        return { text: `[网络错误] ${error instanceof Error ? error.message : String(error)}`, toolResults }
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) return { text: `[API 错误 ${response.status}] ${(await response.text()).slice(0, 1000)}`, toolResults }
      const data = await response.json()
      const content = data.candidates?.[0]?.content
      const parts = content?.parts || []
      const calls = parts.filter((part) => part.functionCall)
      if (!calls.length) return { text: parts.map((part) => part.text || '').filter(Boolean).join('\n') || '(无回复)', toolResults }
      contents.push(content)
      const functionParts = []
      for (const part of calls) {
        const call = part.functionCall
        const result = runtime.canUseTool(call.name)
          ? await this.executeTool(call.name, call.args || {}, context, ledger)
          : { success: false, error: `当前${runtime.label}模式不允许工具 ${call.name}` }
        toolResults.push({ tool: call.name, args: call.args || {}, result })
        functionParts.push({ functionResponse: { name: call.name, response: result } })
      }
      contents.push({ role: 'user', parts: functionParts })
    }
    return { text: '[达到最大工具调用次数]', toolResults }
  }

  localCommand(text) {
    const input = String(text || '').trim()
    if (!input) return null
    if (/^(?:请|帮我)?(?:退出全屏|恢复原始窗口)[。！!\s]*$/.test(input)) return ['set_window_preset', { preset: 'original' }]

    if (/暂停|停一下|先停|停止播放|pause/i.test(input)) return ['pause', {}]
    if (/继续(?:播放)?|恢复播放|接着播|开始播放|^播放(?:一下)?$|resume/i.test(input)) return ['resume', {}]

    if (/取消静音|解除静音|恢复声音|打开声音/.test(input)) return ['set_mute', { muted: false }]
    if (/静音|关掉声音|关闭声音/.test(input)) return ['set_mute', { muted: true }]

    const absoluteVolume = input.match(/(?:音量|声音).*?(?:调到|调大到|调小到|设为|设置为|到)\s*(\d{1,3})(?:\s*%|\s*百分之)?/) ||
      input.match(/(?:音量|声音)\s*(\d{1,3})(?:\s*%|\s*百分之)?/)
    if (absoluteVolume) return ['set_volume', { level: Number(absoluteVolume[1]) }]
    if (/(?:音量|声音).*(?:调大|增大|提高|高一点|大一点|加)/.test(input)) {
      return ['adjust_volume', { delta: Number(input.match(/\d{1,3}/)?.[0] || 10) }]
    }
    if (/(?:音量|声音).*(?:调小|减小|降低|低一点|小一点|减)/.test(input)) {
      return ['adjust_volume', { delta: -Number(input.match(/\d{1,3}/)?.[0] || 10) }]
    }

    if (/正常(?:倍速|速度)|恢复(?:正常|一倍)速度/.test(input)) return ['set_speed', { rate: 1 }]
    const speed = input.match(/(0?\.\d+|[1-4](?:\.\d+)?)\s*(?:倍速|倍|x|×)/i)
    if (speed) return ['set_speed', { rate: Number(speed[1]) }]
    if (/(?:播放|倍速|速度).*(?:快一点|加快|调快)/.test(input)) return ['adjust_speed', { delta: 0.25 }]
    if (/(?:播放|倍速|速度).*(?:慢一点|减慢|调慢)/.test(input)) return ['adjust_speed', { delta: -0.25 }]

    const relativeDuration = durationFromText(input, Number(input.match(/\d+(?:\.\d+)?/)?.[0] || 10))
    if (/(?:往后|向后|快进|前进|跳过)/.test(input)) return ['seek_relative', { seconds: Math.abs(relativeDuration) }]
    if (/(?:往前|向前|后退|倒退|快退|退回)/.test(input)) return ['seek_relative', { seconds: -Math.abs(relativeDuration) }]
    if (/(?:跳到|跳转到|定位到)/.test(input)) {
      const seconds = durationFromText(input, Number(input.match(/\d+(?:\.\d+)?/)?.[0] || 0))
      return ['seek', { seconds }]
    }

    if (/关闭字幕|隐藏字幕|不要字幕/.test(input)) return ['set_subtitle', { visible: false }]
    if (/打开字幕|显示字幕|开启字幕/.test(input)) return ['set_subtitle', { visible: true }]

    if (/截图|截个图|截取(?:当前)?画面/.test(input)) return ['screenshot', {}]

    if (/原始窗口|原始大小窗口/.test(input)) return ['set_window_preset', { preset: 'original' }]
    if (/(?:二分之一|1\s*[/／]\s*2|2\s*[/／]\s*1|半屏|一半)窗口/.test(input)) return ['set_window_preset', { preset: 'half' }]
    if (/铺满窗口|填满窗口|最大化窗口/.test(input)) return ['set_window_preset', { preset: 'fill' }]
    if (/全屏(?:窗口|播放)?|进入全屏/.test(input)) return ['set_window_preset', { preset: 'fullscreen' }]

    if (/完整(?:地)?(?:显示|呈现|看)|看全|看到全部|全部(?:显示|呈现)|不要(?:裁剪|截掉)|不裁剪|适应窗口|保持(?:原始|原)?比例/.test(input)) {
      return ['set_picture_mode', { mode: 'fit' }]
    }
    if (/原始(?:画面|比例|尺寸)/.test(input)) return ['set_picture_mode', { mode: 'original' }]
    if (/拉伸(?:铺满|填满)|变形铺满/.test(input)) return ['set_picture_mode', { mode: 'stretch' }]
    if (/裁剪铺满|画面铺满|填满画面/.test(input)) return ['set_picture_mode', { mode: 'fill' }]
    return null
  }

  // 工具定义、校验、成本与基础执行收敛到 registry；ledger 记录预算和证据。
  async executeTool(name, args, context = null, ledger = null) {
    const tool = getAgentTool(name)
    const ticket = ledger?.beginTool(tool || { name, description: name }, args || {})
    if (ticket && !ticket.allowed) {
      return { success: false, error: ticket.error, tool: name, verified: false, budgetExceeded: true }
    }
    const result = await executeAgentTool(name, args, context, {
      summarize: (summaryContext) => this.prepareSummary(summaryContext)
    })
    ledger?.finishTool(ticket?.step, result)
    return result
  }

  prepareSummary(context) {
    const mediaPath = context?.path
    if (!mediaPath || /^https?:/i.test(mediaPath) || !fs.existsSync(mediaPath)) {
      return { success: false, action: 'summarize', desc: '当前媒体不是可读取的本地文件，无法提取字幕摘要' }
    }
    const parsed = path.parse(mediaPath)
    const candidates = ['.srt', '.vtt', '.ass', '.ssa'].map((ext) => path.join(parsed.dir, parsed.name + ext))
    const subtitlePath = candidates.find((candidate) => fs.existsSync(candidate))
    if (!subtitlePath) {
      return { success: false, action: 'summarize', desc: '当前文件旁没有同名字幕，无法可靠生成内容摘要' }
    }
    try {
      const transcript = fs.readFileSync(subtitlePath, 'utf8')
        .replace(/^\d+\s*$/gm, '')
        .replace(/\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{1,2}:\d{2}:\d{2}[,.]\d{3}/g, '')
        .replace(/^Dialogue:[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,/gm, '')
        .replace(/\{[^}]*\}/g, '')
        .replace(/\\N/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 30000)
      return {
        success: true,
        action: 'summarize',
        desc: `已读取字幕 ${path.basename(subtitlePath)}，请基于 transcript 生成摘要和章节`,
        transcript
      }
    } catch (e) {
      return { success: false, action: 'summarize', desc: `字幕读取失败: ${e.message}` }
    }
  }

  // 无工具调用的通用文本生成入口。文档工作台使用独立 system prompt，
  // 避免把文档任务误路由成暂停、快进等播放器指令。
  async completeText(messages, apiKey = null, options = {}) {
    const runtime = await resolveRuntime(options.mode, [], String(options.systemPrompt || '你是 AgentPlay 助手。'))
    const systemPrompt = runtime.systemPrompt
    // 订阅账号后端（Codex CLI / Claude Code）：不经 resolveProvider 的网络栈，走只读子进程
    const cliProviderId = typeof apiKey === 'object' && apiKey !== null ? apiKey.providerId : null
    if (cliProviderId === 'codex-chatgpt' || cliProviderId === 'claude-code') {
      const { completeViaCodex, completeViaClaude } = require('./cli-model-service')
      const model = typeof apiKey === 'object' && apiKey !== null ? apiKey.model : null
      const result = cliProviderId === 'codex-chatgpt'
        ? await completeViaCodex({ messages, systemPrompt, model, signal: options.signal, timeoutMs: options.timeoutMs, onStatus: options.onStatus })
        : await completeViaClaude({ messages, systemPrompt, model, signal: options.signal, timeoutMs: options.timeoutMs })
      return { text: result.text, provider: cliProviderId, model: model || 'default', usage: null }
    }
    const resolved = this.resolveProvider(apiKey)
    const { base, key, model, protocol, providerId, requiresKey = true } = resolved
    if (!base || !model || (!key && requiresKey)) {
      throw new Error('尚未配置可用模型，请先到“功能 → 模型接入中心”保存连接')
    }

    const normalized = messages.map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message.content || '')
    }))

    if (providerId === 'colibri') {
      const result = await this.colibri.generate({
        config: resolved,
        messages: [{ role: 'system', content: systemPrompt }, ...normalized],
        tools: [],
        signal: options.signal,
        onDelta: options.onDelta,
        onStatus: options.onStatus
      })
      if (!result.text) throw new Error(result.cancelled ? '生成已取消' : '模型没有返回内容')
      return { text: result.text, provider: providerId, model, usage: result.usage || null }
    }

    const controller = new AbortController()
    const abort = () => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) controller.abort()
    const timer = setTimeout(abort, Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 90000)
    try {
      let response
      if (protocol === 'anthropic') {
        response = await safeFetch(resolved, `${base}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens: 4096, system: systemPrompt, messages: normalized }),
          signal: controller.signal
        })
      } else if (protocol === 'gemini') {
        response = await safeFetch(resolved, `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: normalized.map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] }))
          }),
          signal: controller.signal
        })
      } else {
        const headers = { 'Content-Type': 'application/json' }
        if (key) headers.Authorization = `Bearer ${key}`
        response = await safeFetch(resolved, `${base}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(openAIRequestBody({
            model,
            messages: [{ role: 'system', content: systemPrompt }, ...normalized],
            max_tokens: Math.max(1, Number(options.maxTokens) || (providerId === 'bundled-lite' ? 1536 : 4096)),
            temperature: 0.2
          }, resolved)),
          signal: controller.signal
        })
      }
      if (!response.ok) throw new Error(friendlyModelError(`模型 API ${response.status}: ${(await response.text()).slice(0, 1000)}`, resolved))
      const data = await response.json()
      const text = protocol === 'anthropic'
        ? (data.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n')
        : protocol === 'gemini'
          ? (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('\n')
          : data.choices?.[0]?.message?.content
      if (!text) throw new Error('模型没有返回内容')
      return { text, provider: providerId, model, usage: data.usage || data.usageMetadata || null }
    } catch (error) {
      if (controller.signal.aborted) throw new Error(options.signal?.aborted ? '生成已取消' : '文档生成超时')
      throw error
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
  }

  // 多图视觉调用：拉片关键帧等场景一次携带多张图片，labels 与图片一一对应（如 t=MM:SS）
  async completeVisionMulti(options = {}) {
    try {
      return await this.completeVisionMultiOnce(options)
    } catch (error) {
      // 2026-08-24 agnes-2.5-flash 已真实单图返回；仍保留2.0作为端点明确报不支持图片时的历史兼容回退。
      const config = typeof options.apiKey === 'object' && options.apiKey !== null ? options.apiKey : null
      const message = String(error?.message || '')
      const unsupported = /(?:does not support|unsupported).*(image|vision|media|modality|multimodal)|(?:image|vision|multimodal).*(?:unsupported|not supported)|(不支持|不接受).{0,4}(图|图片|图像|多模态)/i.test(message)
      if (config?.providerId === 'agnes' && config.model !== 'agnes-2.0-flash' && unsupported) {
        return this.completeVisionMultiOnce({ ...options, apiKey: { ...config, model: 'agnes-2.0-flash' } })
      }
      throw error
    }
  }

  async completeVisionMultiOnce({ prompt, imageDataUrls = [], labels = [], apiKey = null, systemPrompt, signal, timeoutMs, maxTokens = 4096 } = {}) {
    const runtime = await resolveRuntime('work', [], systemPrompt || '你是 AgentPlay 的图片理解助手。')
    const resolvedSystemPrompt = runtime.systemPrompt
    const resolved = this.resolveProvider(apiKey)
    const { base, key, model, protocol, requiresKey = true } = resolved
    if (!base || !model || (!key && requiresKey)) {
      throw new Error('尚未配置可用模型，请先到“功能 → 模型接入中心”保存连接')
    }
    const images = imageDataUrls.map((dataUrl, index) => {
      const value = String(dataUrl || '')
      if (!/^data:image\/(png|jpe?g|webp|gif|bmp);base64,/.test(value)) throw new Error('图片数据格式无效')
      return {
        dataUrl: value,
        base64: value.split(',', 2)[1],
        mimeType: value.slice(5, value.indexOf(';')),
        label: labels[index] || ''
      }
    })
    if (!images.length) throw new Error('没有可发送的图片')
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const timer = setTimeout(abort, Number(timeoutMs) > 0 ? Number(timeoutMs) : 90000)
    try {
      let response
      if (protocol === 'anthropic') {
        const content = [{ type: 'text', text: prompt }]
        for (const image of images) {
          if (image.label) content.push({ type: 'text', text: image.label })
          content.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } })
        }
        response = await safeFetch(resolved, `${base}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model, max_tokens: maxTokens, system: resolvedSystemPrompt,
            messages: [{ role: 'user', content }]
          }),
          signal: controller.signal
        })
      } else if (protocol === 'gemini') {
        const parts = [{ text: prompt }]
        for (const image of images) {
          if (image.label) parts.push({ text: image.label })
          parts.push({ inlineData: { mimeType: image.mimeType, data: image.base64 } })
        }
        response = await safeFetch(resolved, `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: resolvedSystemPrompt }] },
            contents: [{ role: 'user', parts }]
          }),
          signal: controller.signal
        })
      } else {
        const content = [{ type: 'text', text: prompt }]
        for (const image of images) {
          if (image.label) content.push({ type: 'text', text: image.label })
          content.push({ type: 'image_url', image_url: { url: image.dataUrl } })
        }
        const headers = { 'Content-Type': 'application/json' }
        if (key) headers.Authorization = `Bearer ${key}`
        response = await safeFetch(resolved, `${base}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(openAIRequestBody({
            model,
            messages: [
              { role: 'system', content: resolvedSystemPrompt },
              { role: 'user', content }
            ],
            max_tokens: maxTokens,
            temperature: 0.2
          }, resolved)),
          signal: controller.signal
        })
      }
      if (!response.ok) throw new Error(`视觉模型 API ${response.status}: ${(await response.text()).slice(0, 800)}`)
      const data = await response.json()
      const text = protocol === 'anthropic'
        ? (data.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n')
        : protocol === 'gemini'
          ? (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('\n')
          : data.choices?.[0]?.message?.content
      if (!text) throw new Error('视觉模型没有返回内容')
      return { text, provider: resolved.providerId, model, usage: data.usage || data.usageMetadata || null }
    } catch (error) {
      if (controller.signal.aborted) throw new Error(signal?.aborted ? '图片理解已取消' : '图片理解超时')
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  // 图片理解：携带一张图片(dataURL)的视觉调用，委托多图版本
  async completeVision({ prompt, imageDataUrl, apiKey = null, systemPrompt, signal, timeoutMs } = {}) {
    return this.completeVisionMulti({ prompt, imageDataUrls: [imageDataUrl], apiKey, systemPrompt, signal, timeoutMs, maxTokens: 2048 })
  }

  async chat(messages, apiKey = null, context = null, options = {}) {
    const runtime = await resolveRuntime(options.mode)
    const ledger = new AgentRunLedger({
      requestId: options.requestId,
      mode: runtime.mode,
      maxTurns: runtime.maxToolTurns,
      maxToolCalls: runtime.maxToolCalls,
      maxElapsedMs: runtime.maxElapsedMs
    })
    const finish = (result) => ({
      ...result,
      mode: runtime.mode,
      run: ledger.finish({
        cancelled: result?.cancelled === true,
        failed: /^\[(?:网络错误|API 错误|订阅后端错误|Colibri 错误)/.test(String(result?.text || ''))
      })
    })
    const latestText = messages.length > 0 ? String(messages[messages.length - 1].content || '') : ''
    const capabilityAnswer = productCapabilityAnswer(latestText)
    if (capabilityAnswer) return finish({ text: capabilityAnswer, toolResults: [] })
    const { directIntent } = await import('./intent-policy.mjs')
    const local = directIntent(latestText)?.route === 'player' ? this.localCommand(latestText) : null
    if (local) {
      if (!runtime.canUseTool(local[0])) {
        return finish({ text: `当前为${runtime.label}模式：${runtime.description}。`, toolResults: [] })
      }
      ledger.beginTurn()
      const result = await this.executeTool(local[0], local[1], context, ledger)
      return finish({ text: result.desc || result.error, toolResults: [{ tool: local[0], args: local[1], result }] })
    }

    // 订阅账号后端（Codex CLI / Claude Code）：没有 URL 可言，走只读子进程纯对话（无工具协议）
    const cliProviderId = typeof apiKey === 'object' && apiKey !== null ? apiKey.providerId : null
    if (cliProviderId === 'codex-chatgpt' || cliProviderId === 'claude-code') {
      try {
        const result = await this.completeText(messages, apiKey, { signal: options.signal, timeoutMs: 180000, onStatus: options.onStatus, systemPrompt: SYSTEM_PROMPT, mode: runtime.mode })
        options.onDelta?.(result.text)
        return finish({ text: result.text, toolResults: [] })
      } catch (error) {
        return finish({ text: `[订阅后端错误] ${error instanceof Error ? error.message : String(error)}`, toolResults: [] })
      }
    }

    const resolved = this.resolveProvider(apiKey)
    const { base, key, model, protocol, providerId, capabilities = {}, requiresKey = true } = resolved
    if (!key && requiresKey) {
      return finish({
        text: '[未配置 API Key] 请从“功能 → 模型接入中心”选择厂商、型号并保存连接。',
        toolResults: []
      })
    }

    if (protocol === 'anthropic') return finish(await this.chatAnthropic(messages, { ...resolved, base, key, model }, context, runtime, ledger))
    if (protocol === 'gemini') return finish(await this.chatGemini(messages, { ...resolved, base, key, model }, context, runtime, ledger))

    if (providerId === 'colibri' && runtime.tools.length === 0) {
      try {
        options.onStatus?.('queued')
        const result = await this.colibri.generate({
          config: resolved,
          messages: [{ role: 'system', content: runtime.systemPrompt }, ...messages],
          tools: runtime.tools,
          signal: options.signal,
          onDelta: options.onDelta,
          onStatus: options.onStatus
        })
        if (result.cancelled && !result.text) result.text = '[已取消生成]'
        return finish(result)
      } catch (error) {
        return finish({ text: `[Colibri 错误] ${error instanceof Error ? error.message : String(error)}`, toolResults: [] })
      }
    }

    const systemPrompt = runtime.systemPrompt
    let msgs = [{ role: 'system', content: systemPrompt }, ...messages]
    const toolResults = []

    for (let i = 0; i < runtime.maxToolTurns; i++) {
      if (!ledger.beginTurn()) return finish({ text: '[达到本次任务时间预算]', toolResults })
      // 外层取消信号贯穿工具循环：面板"停止"不再只停个壳
      if (options.signal?.aborted) return finish({ text: '[已取消]', toolResults, cancelled: true })
      const controller = new AbortController()
      const onOuterAbort = () => controller.abort()
      options.signal?.addEventListener('abort', onOuterAbort, { once: true })
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; controller.abort() }, chatRequestTimeoutMs(resolved))
      let resp
      try {
        const headers = { 'Content-Type': 'application/json' }
        if (key) headers.Authorization = `Bearer ${key}`
        const body = { model, messages: msgs }
        if (providerId === 'bundled-lite') {
          body.max_tokens = 512
          body.temperature = 0.2
          body.top_p = 0.8
        }
        if (capabilities.tools !== false && runtime.tools.length > 0) body.tools = runtime.tools
        resp = await safeFetch(resolved, `${base}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(openAIRequestBody(body, resolved)),
          signal: controller.signal
        })
      } catch (e) {
        if (options.signal?.aborted) return finish({ text: '[已取消]', toolResults, cancelled: true })
        if (timedOut || e?.name === 'AbortError') return finish({ text: timeoutReply(resolved), toolResults })
        return finish({ text: `[网络错误] ${e instanceof Error ? e.message : String(e)}`, toolResults })
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onOuterAbort)
      }

      if (!resp.ok) {
        const errText = await resp.text()
        return finish({ text: `[API 错误 ${resp.status}] ${errText}`, toolResults })
      }

      const data = await resp.json()
      const msg = data.choices[0].message

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return finish({ text: msg.content || '(无回复)', toolResults })
      }

      msgs.push(msg)
      for (const tc of msg.tool_calls) {
        let args = {}
        try { args = JSON.parse(tc.function.arguments || '{}') } catch {}
        const result = runtime.canUseTool(tc.function.name)
          ? await this.executeTool(tc.function.name, args, context, ledger)
          : { success: false, error: `当前${runtime.label}模式不允许工具 ${tc.function.name}` }
        toolResults.push({ tool: tc.function.name, args, result })
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
      }
    }

    return finish({ text: '[达到最大工具调用次数]', toolResults })
  }
}

module.exports = { AgentEngine, chatRequestTimeoutMs, friendlyModelError, openAIRequestBody, productCapabilityAnswer, timeoutReply }
