// Agent 引擎：云端 LLM + function calling
// 桌面端通过 IPC 调用，工具执行连接 mpv 播放器
// API: DeepSeek / 火山方舟（OpenAI 兼容，环境变量配置 key）

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
可用工具：暂停/继续/跳转/音量/字幕。用中文简洁回复。直接执行，不啰嗦。`

class AgentEngine {
  constructor(mpv) {
    this.mpv = mpv
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
    return !!this.apiKey
  }

  // 执行工具（连接 mpv）
  async executeTool(name, args) {
    switch (name) {
      case 'pause':
        return { success: true, action: 'pause', desc: '已暂停' }
      case 'resume':
        return { success: true, action: 'resume', desc: '继续播放' }
      case 'seek':
        return { success: true, action: 'seek', value: args.seconds, desc: `跳转到 ${args.seconds} 秒` }
      case 'set_volume':
        return { success: true, action: 'set_volume', value: args.level, desc: `音量设为 ${args.level}` }
      case 'set_subtitle':
        return { success: true, action: 'set_subtitle', value: args.visible, desc: args.visible ? '字幕已开' : '字幕已关' }
      case 'summarize_video':
        return { success: true, action: 'summarize', desc: '视频摘要需音频转写 API 支持，当前为占位' }
      case 'load_subtitle':
        return { success: true, action: 'load_subtitle', value: args.file_path, desc: '字幕已加载' }
      default:
        return { error: '未知工具: ' + name }
    }
  }

  async chat(messages, apiKey = null) {
    const key = apiKey || this.apiKey
    let base = this.apiBase
    if (apiKey && apiKey !== this.apiKey) {
      if (apiKey.startsWith('sk-')) base = 'https://api.deepseek.com/v1'
      else if (apiKey.length > 50) base = 'https://ark.cn-beijing.volces.com/api/v3'
    }
    if (!key) {
      return {
        text: '[未配置 API key] 请在 Agent 面板填入 DeepSeek 或火山方舟 API key。',
        toolResults: []
      }
    }

    let msgs = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages]
    const toolResults = []

    for (let i = 0; i < 5; i++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      const resp = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify({ model: this.model, messages: msgs, tools: TOOLS }),
        signal: controller.signal
      })
      clearTimeout(timer)

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
        const result = await this.executeTool(tc.function.name, args)
        toolResults.push({ tool: tc.function.name, args, result })
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
      }
    }

    return { text: '[达到最大工具调用次数]', toolResults }
  }
}

module.exports = { AgentEngine }
