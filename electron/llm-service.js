// Agent 引擎：云端 LLM + function calling
// 桌面端通过 IPC 调用，工具执行连接 mpv 播放器
// API: DeepSeek / 火山方舟（OpenAI 兼容，环境变量配置 key）
const fs = require('fs')
const path = require('path')
const { normalizeConfig } = require('./model-providers')
const { safeFetch } = require('./safe-fetch')
const { ColibriAdapter } = require('./adapters/colibri-adapter')

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'pause',
      description: '暂停播放',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'resume',
      description: '继续播放',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'seek',
      description: '跳转到指定秒数',
      parameters: {
        type: 'object',
        properties: { seconds: { type: 'number', description: '目标秒数' } },
        required: ['seconds']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'seek_relative',
      description: '相对当前位置快进或后退',
      parameters: {
        type: 'object',
        properties: { seconds: { type: 'number', description: '正数快进，负数后退' } },
        required: ['seconds']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_volume',
      description: '设置音量（0-100）',
      parameters: {
        type: 'object',
        properties: { level: { type: 'number', description: '音量 0-100' } },
        required: ['level']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_subtitle',
      description: '开关字幕',
      parameters: {
        type: 'object',
        properties: { visible: { type: 'boolean', description: 'true显示 false隐藏' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'adjust_volume',
      description: '相对当前音量调高或调低',
      parameters: {
        type: 'object',
        properties: { delta: { type: 'number', description: '音量变化量，正数调高，负数调低' } },
        required: ['delta']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_mute',
      description: '开启或取消静音',
      parameters: {
        type: 'object',
        properties: { muted: { type: 'boolean' } },
        required: ['muted']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_speed',
      description: '设置播放倍速（0.25-4）',
      parameters: {
        type: 'object',
        properties: { rate: { type: 'number' } },
        required: ['rate']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'adjust_speed',
      description: '相对当前倍速加快或减慢',
      parameters: {
        type: 'object',
        properties: { delta: { type: 'number' } },
        required: ['delta']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_picture_mode',
      description: '设置画面呈现方式',
      parameters: {
        type: 'object',
        properties: { mode: { type: 'string', enum: ['original', 'fit', 'fill', 'stretch'] } },
        required: ['mode']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_window_preset',
      description: '设置播放器窗口大小',
      parameters: {
        type: 'object',
        properties: { preset: { type: 'string', enum: ['original', 'half', 'fill', 'fullscreen'] } },
        required: ['preset']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: '截取当前视频画面并让用户选择保存位置',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'print_file',
      description: '打印图片或PDF文件',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string', description: '文件路径' } },
        required: ['file_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'summarize_video',
      description: '总结当前视频内容',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'load_subtitle',
        description: '加载字幕文件（srt/ass/vtt）',
        parameters: {
          type: 'object',
          properties: { file_path: { type: 'string', description: '字幕文件路径' } },
          required: ['file_path']
        }
      }
    }
  ]

const SYSTEM_PROMPT = `你是"AI播放器"的 Agent 助手。用户用自然语言控制播放器，你调用工具执行。
可用工具：暂停/继续、绝对或相对跳转、音量/静音、倍速、字幕、画面模式、窗口模式、截图、加载字幕、打印、视频摘要。摘要工具返回 transcript 时，必须基于 transcript 给出简洁摘要和章节；工具明确失败时不得编造内容。用中文简洁回复。`

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
      this.model = 'deepseek-chat'
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
      return { base: this.apiBase, baseUrl: this.apiBase, key: apiKey || this.apiKey, model: this.model, protocol: 'openai', providerId: 'environment', localOnly: /^http:\/\/(?:localhost|127\.0\.0\.1)(?::|\/)/i.test(this.apiBase || ''), capabilities: { tools: true, streaming: false } }
    }
    if (apiKey.startsWith('sk-')) {
      return { base: 'https://api.deepseek.com/v1', baseUrl: 'https://api.deepseek.com/v1', key: apiKey, model: 'deepseek-chat', protocol: 'openai', providerId: 'deepseek', capabilities: { tools: true, streaming: false } }
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

  async chatAnthropic(messages, config, context) {
    let msgs = messages.map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message.content || '')
    }))
    const toolResults = []
    for (let i = 0; i < 5; i++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
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
            system: SYSTEM_PROMPT,
            messages: msgs,
            tools: TOOLS.map((tool) => ({
              name: tool.function.name,
              description: tool.function.description,
              input_schema: tool.function.parameters
            }))
          }),
          signal: controller.signal
        })
      } catch (error) {
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
        const result = await this.executeTool(call.name, call.input || {}, context)
        toolResults.push({ tool: call.name, args: call.input || {}, result })
        results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result) })
      }
      msgs.push({ role: 'user', content: results })
    }
    return { text: '[达到最大工具调用次数]', toolResults }
  }

  async chatGemini(messages, config, context) {
    let contents = messages.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(message.content || '') }]
    }))
    const toolResults = []
    for (let i = 0; i < 5; i++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      let response
      try {
        response = await safeFetch(config, `${config.base}/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.key)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents,
            tools: [{ functionDeclarations: TOOLS.map((tool) => ({
              name: tool.function.name,
              description: tool.function.description,
              parameters: tool.function.parameters
            })) }]
          }),
          signal: controller.signal
        })
      } catch (error) {
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
        const result = await this.executeTool(call.name, call.args || {}, context)
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

    if (/暂停|停一下|先停|pause/i.test(input)) return ['pause', {}]
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

    if (/完整(?:地)?(?:显示|呈现|看)|看全|看到全部|全部(?:显示|呈现)|不要(?:裁剪|截掉)|不裁剪|适应窗口|保持(?:原始)?比例/.test(input)) {
      return ['set_picture_mode', { mode: 'fit' }]
    }
    if (/原始(?:画面|比例|尺寸)/.test(input)) return ['set_picture_mode', { mode: 'original' }]
    if (/拉伸(?:铺满|填满)|变形铺满/.test(input)) return ['set_picture_mode', { mode: 'stretch' }]
    if (/裁剪铺满|画面铺满|填满画面/.test(input)) return ['set_picture_mode', { mode: 'fill' }]
    return null
  }

  // 执行工具（连接 mpv）
  async executeTool(name, args, context = null) {
    switch (name) {
      case 'pause':
        return { success: true, action: 'pause', desc: '已暂停' }
      case 'resume':
        return { success: true, action: 'resume', desc: '继续播放' }
      case 'seek':
        return { success: true, action: 'seek', value: Math.max(0, Number(args.seconds) || 0), desc: `跳转到 ${Math.max(0, Number(args.seconds) || 0)} 秒` }
      case 'seek_relative': {
        const delta = Number(args.seconds) || 0
        const duration = Number(context?.duration) || Infinity
        const target = Math.max(0, Math.min(duration, (Number(context?.currentTime) || 0) + delta))
        return { success: true, action: 'seek', value: target, desc: `${delta >= 0 ? '快进' : '后退'} ${Math.abs(delta)} 秒` }
      }
      case 'set_volume':
        return { success: true, action: 'set_volume', value: Math.max(0, Math.min(100, Number(args.level) || 0)), desc: `音量设为 ${Math.max(0, Math.min(100, Number(args.level) || 0))}` }
      case 'adjust_volume': {
        const value = Math.max(0, Math.min(100, (Number(context?.volume) || 0) + (Number(args.delta) || 0)))
        return { success: true, action: 'set_volume', value, desc: `音量设为 ${value}` }
      }
      case 'set_mute': {
        const muted = Boolean(args.muted)
        const value = muted ? 0 : Math.max(1, Math.min(100, Number(context?.lastAudibleVolume) || 80))
        return { success: true, action: 'set_volume', value, desc: muted ? '已静音' : '已取消静音' }
      }
      case 'set_speed': {
        const rate = Math.max(0.25, Math.min(4, Number(args.rate) || 1))
        return { success: true, action: 'set_speed', value: rate, desc: `播放速度设为 ${rate} 倍` }
      }
      case 'adjust_speed': {
        const rate = Math.max(0.25, Math.min(4, (Number(context?.playbackRate) || 1) + (Number(args.delta) || 0)))
        return { success: true, action: 'set_speed', value: rate, desc: `播放速度设为 ${rate} 倍` }
      }
      case 'set_picture_mode': {
        const mode = ['original', 'fit', 'fill', 'stretch'].includes(args.mode) ? args.mode : 'fit'
        const names = { original: '原始比例', fit: '完整显示', fill: '裁剪铺满', stretch: '拉伸铺满' }
        return { success: true, action: 'set_picture_mode', value: mode, desc: `画面设为${names[mode]}` }
      }
      case 'set_window_preset': {
        const preset = ['original', 'half', 'fill', 'fullscreen'].includes(args.preset) ? args.preset : 'original'
        const names = { original: '原始窗口', half: '二分之一窗口', fill: '铺满窗口', fullscreen: '全屏窗口' }
        return { success: true, action: 'set_window_preset', value: preset, desc: `已切换为${names[preset]}` }
      }
      case 'screenshot':
        return { success: true, action: 'screenshot', desc: '已打开截图保存' }
      case 'set_subtitle':
        return { success: true, action: 'set_subtitle', value: args.visible, desc: args.visible ? '字幕已开' : '字幕已关' }
      case 'summarize_video':
        return this.prepareSummary(context)
      case 'print_file':
        return { success: true, action: 'print_file', value: args.file_path, desc: '已打开打印任务' }
      case 'load_subtitle':
        return { success: true, action: 'load_subtitle', value: args.file_path, desc: '字幕已加载' }
      default:
        return { error: '未知工具: ' + name }
    }
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

  async chat(messages, apiKey = null, context = null, options = {}) {
    const latestText = messages.length > 0 ? String(messages[messages.length - 1].content || '') : ''
    const local = this.localCommand(latestText)
    if (local) {
      const result = await this.executeTool(local[0], local[1], context)
      return { text: result.desc, toolResults: [{ tool: local[0], args: local[1], result }] }
    }

    const resolved = this.resolveProvider(apiKey)
    const { base, key, model, protocol, providerId, capabilities = {}, requiresKey = true } = resolved
    if (!key && requiresKey) {
      return {
        text: '[未配置 API Key] 请从“功能 → 模型接入中心”选择厂商、型号并保存连接。',
        toolResults: []
      }
    }

    if (protocol === 'anthropic') return this.chatAnthropic(messages, { ...resolved, base, key, model }, context)
    if (protocol === 'gemini') return this.chatGemini(messages, { ...resolved, base, key, model }, context)

    if (providerId === 'colibri') {
      try {
        options.onStatus?.('queued')
        const result = await this.colibri.generate({
          config: resolved,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
          tools: TOOLS,
          signal: options.signal,
          onDelta: options.onDelta,
          onStatus: options.onStatus
        })
        if (result.cancelled && !result.text) result.text = '[已取消生成]'
        return result
      } catch (error) {
        return { text: `[Colibri 错误] ${error instanceof Error ? error.message : String(error)}`, toolResults: [] }
      }
    }

    const systemPrompt = SYSTEM_PROMPT
    let msgs = [{ role: 'system', content: systemPrompt }, ...messages]
    const toolResults = []

    for (let i = 0; i < 5; i++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
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
        if (capabilities.tools !== false) body.tools = TOOLS
        resp = await safeFetch(resolved, `${base}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        })
      } catch (e) {
        return { text: `[网络错误] ${e instanceof Error ? e.message : String(e)}`, toolResults }
      } finally {
        clearTimeout(timer)
      }

      if (!resp.ok) {
        const errText = await resp.text()
        return { text: `[API 错误 ${resp.status}] ${errText}`, toolResults }
      }

      const data = await resp.json()
      const msg = data.choices[0].message

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return { text: msg.content || '(无回复)', toolResults }
      }

      msgs.push(msg)
      for (const tc of msg.tool_calls) {
        let args = {}
        try { args = JSON.parse(tc.function.arguments || '{}') } catch {}
        const result = await this.executeTool(tc.function.name, args, context)
        toolResults.push({ tool: tc.function.name, args, result })
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
      }
    }

    return { text: '[达到最大工具调用次数]', toolResults }
  }
}

module.exports = { AgentEngine }
