const { authHeaders, validateProviderUrl } = require('../model-providers')
const { safeFetch } = require('../safe-fetch')

function buildColibriRequest(config, messages, tools = [], options = {}) {
  const body = {
    model: config.model,
    messages,
    stream: options.stream !== false,
    max_completion_tokens: options.maxTokens || 2048,
    temperature: options.temperature ?? 0.7,
    top_p: options.topP ?? 0.9
  }
  if (config.capabilities?.tools === true && tools.length > 0) body.tools = tools
  return body
}

function contentDelta(choice) {
  const content = choice?.delta?.content ?? choice?.message?.content ?? ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((item) => item?.text || '').join('')
  return ''
}

function parseSseEvent(eventText) {
  const data = eventText
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n')
  if (!data || data === '[DONE]') return { done: data === '[DONE]', delta: '', usage: null }
  const payload = JSON.parse(data)
  return {
    done: false,
    delta: contentDelta(payload.choices?.[0]),
    usage: payload.usage || null
  }
}

class ColibriAdapter {
  constructor({ fetchImpl = globalThis.fetch, dnsLookup } = {}) {
    this.fetchImpl = fetchImpl
    this.dnsLookup = dnsLookup
  }

  async generate({ config, messages, tools = [], signal, onDelta, onStatus, maxTokens }) {
    validateProviderUrl(config)
    let text = ''
    let usage = null
    onStatus?.('connecting')
    try {
      const response = await safeFetch(config, `${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(config) },
        body: JSON.stringify(buildColibriRequest(config, messages, tools, { maxTokens })),
        signal
      }, { fetchImpl: this.fetchImpl, dnsLookup: this.dnsLookup })
      if (!response.ok) throw new Error(`Colibri 返回 ${response.status}: ${(await response.text()).slice(0, 1000)}`)

      const contentType = response.headers.get('content-type') || ''
      if (!contentType.includes('text/event-stream')) {
        const body = await response.json()
        text = contentDelta(body.choices?.[0])
        usage = body.usage || null
        if (text) onDelta?.(text)
        return { text: text || '(无回复)', toolResults: [], usage, cancelled: false }
      }

      onStatus?.('streaming')
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Colibri 流式响应没有可读数据')
      const decoder = new TextDecoder()
      let buffer = ''
      let done = false
      while (!done) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n')
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const eventText = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const parsed = parseSseEvent(eventText)
          if (parsed.delta) {
            text += parsed.delta
            onDelta?.(parsed.delta)
          }
          if (parsed.usage) usage = parsed.usage
          if (parsed.done) {
            done = true
            break
          }
          boundary = buffer.indexOf('\n\n')
        }
      }
      return { text: text || '(无回复)', toolResults: [], usage, cancelled: false }
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') {
        onStatus?.('cancelled')
        return { text, toolResults: [], usage, cancelled: true }
      }
      throw error
    }
  }
}

module.exports = { ColibriAdapter, buildColibriRequest, parseSseEvent }
