import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { BundledLocalRuntime, directJson } = require('../electron/bundled-local-runtime')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resourceRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'resources')
const runtime = new BundledLocalRuntime({ resourceRoot })

try {
  const start = Date.now()
  const status = await runtime.start()
  const response = await directJson(11555, '/v1/chat/completions', {
    method: 'POST',
    timeoutMs: 120000,
    body: {
      model: status.model,
      messages: [{ role: 'user', content: '请用一句简短中文回答：你能在不连接云端的情况下工作吗？' }],
      max_tokens: 64,
      temperature: 0.2,
      top_p: 0.8
    }
  })
  console.log(JSON.stringify({
    state: status.state,
    resourceRoot,
    model: status.model,
    hardware: status.hardware,
    answer: response.choices?.[0]?.message?.content,
    usage: response.usage,
    totalSeconds: Math.round((Date.now() - start) / 10) / 100
  }, null, 2))
} finally {
  await runtime.stop()
}
