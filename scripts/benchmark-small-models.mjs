import { spawn, execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
const serverPath = path.join(root, 'resources', 'ai-runtime', 'win-x64', 'llama-server.exe')

const candidates = [
  {
    name: 'Qwen3-0.6B-Q8_0',
    path: path.join(root, 'resources', 'models', 'Qwen3-0.6B-Q8_0.gguf'),
    systemSuffix: '\n/no_think'
  },
  {
    name: 'Qwen2.5-0.5B-Instruct-Q4_0',
    path: path.join(root, 'resources', 'models', 'qwen2.5-download', 'qwen2.5-0.5b-instruct-q4_0.gguf'),
    systemSuffix: ''
  }
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function requestJson(port, pathname, init = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    signal: AbortSignal.timeout(init.timeoutMs || 120_000),
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }
  })
  if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 1000)}`)
  return response.json()
}

async function waitReady(port, alias, child) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`)
    try {
      const body = await requestJson(port, '/v1/models', { timeoutMs: 1000 })
      if (body.data?.some((item) => item.id === alias)) return
    } catch {}
    await sleep(250)
  }
  throw new Error('ready timeout')
}

async function workingSetMb(pid) {
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).WorkingSet64`
    ], { windowsHide: true })
    return Math.round((Number(stdout.trim()) / 1024 ** 2) * 10) / 10
  } catch {
    return null
  }
}

async function generate(port, alias, messages, maxTokens) {
  const startedAt = performance.now()
  const body = await requestJson(port, '/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: alias,
      messages,
      max_tokens: maxTokens,
      temperature: 0,
      top_p: 0.8
    })
  })
  return {
    milliseconds: Math.round(performance.now() - startedAt),
    completionTokens: body.usage?.completion_tokens ?? null,
    text: String(body.choices?.[0]?.message?.content || '').trim()
  }
}

async function benchmark(candidate, index) {
  const port = 11601 + index
  const alias = `benchmark-${index}`
  let logs = ''
  const loadStartedAt = performance.now()
  const child = spawn(serverPath, [
    '--model', candidate.path,
    '--host', '127.0.0.1', '--port', String(port),
    '--alias', alias,
    '--ctx-size', '2048',
    '--threads', '4', '--threads-batch', '4',
    '--batch-size', '128', '--ubatch-size', '128',
    '--gpu-layers', '0', '--jinja', '--no-webui'
  ], {
    cwd: path.dirname(serverPath),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-8000) })
  child.stderr.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-8000) })
  try {
    await waitReady(port, alias, child)
    const readyMilliseconds = Math.round(performance.now() - loadStartedAt)
    const workingSetAtReadyMb = await workingSetMb(child.pid)
    const control = await generate(port, alias, [
      {
        role: 'system',
        content: `你是播放器指令分类器。只输出一行 JSON，不得解释。可用 action: pause, resume, seek_relative, volume_delta, set_speed, picture_fit。${candidate.systemSuffix}`
      },
      { role: 'user', content: '这个竖屏视频别裁掉下面的人，要把整个画面完整显示出来' }
    ], 48)
    const summary = await generate(port, alias, [
      { role: 'system', content: `你是简洁的视频助手，只用中文回答。${candidate.systemSuffix}` },
      { role: 'user', content: '字幕内容：主人公先发现问题，随后比较三种方案，最后选择风险最低的一种。请用一句话概括。' }
    ], 64)
    const workingSetAfterMb = await workingSetMb(child.pid)
    return {
      name: candidate.name,
      fileSizeMb: Math.round((await import('node:fs')).statSync(candidate.path).size / 1024 ** 2 * 10) / 10,
      threads: 4,
      contextSize: 2048,
      readyMilliseconds,
      workingSetAtReadyMb,
      workingSetAfterMb,
      control,
      summary
    }
  } catch (error) {
    return { name: candidate.name, error: String(error), logs }
  } finally {
    if (child.exitCode === null) child.kill()
  }
}

const results = []
for (let i = 0; i < candidates.length; i += 1) {
  results.push(await benchmark(candidates[i], i))
  await sleep(1000)
}
console.log(JSON.stringify({ testedAt: new Date().toISOString(), results }, null, 2))
