import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const executableArg = process.argv.slice(2).find((value) => value.startsWith('--exe='))
const executable = executableArg ? path.resolve(executableArg.slice('--exe='.length)) : path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe')
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-download-entry-'))
const port = 19334
if (!fs.existsSync(executable)) throw new Error(`缺少桌面验收文件：${executable}`)

const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--window-position=-2400,-2400'], {
  cwd: path.dirname(executable),
  windowsHide: true,
  shell: false
})
let websocket
let nextId = 0
const pending = new Map()

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForChildExit(timeoutMs) {
  if (child.exitCode !== null) return
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

async function findPage() {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch { /* 应用尚未就绪 */ }
    await delay(250)
  }
  throw new Error('正式 EXE 没有在 60 秒内开放验收页面')
}

function command(method, params = {}) {
  const id = ++nextId
  websocket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression, awaitPromise = false) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || '页面表达式执行失败')
  return response.result?.value
}

async function waitFor(expression, label) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (await evaluate(expression)) return
    await delay(250)
  }
  throw new Error(`等待超时：${label}`)
}

async function submitLink(url) {
  await evaluate(`(() => {
    const input = document.querySelector('.agent-composer input')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(url)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await delay(100)
  const clicked = await evaluate(`(() => {
    const input = document.querySelector('.agent-composer input')
    const send = input?.parentElement?.querySelector('button[aria-label="发送"]')
    if (!send) return false
    send.click()
    return true
  })()`)
  if (!clicked) throw new Error('没有找到可用的发送按钮')
  await waitFor(`document.body.innerText.includes('这个链接想怎么处理？')`, '链接处理选择卡')
  const state = await evaluate(`(() => {
    const text = document.body.innerText
    return {
      downloadOnly: text.includes('仅下载'),
      downloadAndAnalysis: text.includes('下载并拉片'),
      guidance: text.includes('下载后自动出深度报告')
    }
  })()`)
  if (!Object.values(state).every(Boolean)) throw new Error(`链接选择不完整：${JSON.stringify(state)}`)
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('先不处理'))
    button?.click()
    return Boolean(button)
  })()`)
  await delay(100)
  return state
}

try {
  const page = await findPage()
  websocket = new WebSocket(page.webSocketDebuggerUrl)
  websocket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  await new Promise((resolve, reject) => {
    websocket.addEventListener('open', resolve, { once: true })
    websocket.addEventListener('error', reject, { once: true })
  })
  await command('Runtime.enable')
  await waitFor(`window.aiPlayer?.version === ${JSON.stringify(expectedVersion)}`, '版本桥接')
  await waitFor(`Boolean(document.querySelector('.agent-composer input'))`, '统一对话输入框')

  const x = await submitLink('https://x.com/chrsaravia/status/2032301380015157715')
  const facebook = await submitLink('https://www.facebook.com/watch/?v=1234567890')
  const peertube = await submitLink('https://framatube.org/w/ff2EVqgHrQX5WJyJJc7Uax')
  process.stdout.write(`${JSON.stringify({ version: expectedVersion, x, facebook, peertube })}\n`)
  websocket.send(JSON.stringify({ id: ++nextId, method: 'Browser.close', params: {} }))
  await delay(1000)
} finally {
  try { websocket?.close() } catch { /* 已关闭 */ }
  if (child.exitCode === null) child.kill()
  await waitForChildExit(5000)
  const resolvedProfile = path.resolve(profileDir)
  const tempRoot = path.resolve(os.tmpdir()) + path.sep
  if (!resolvedProfile.startsWith(tempRoot) || !path.basename(resolvedProfile).startsWith('agentplay-download-entry-')) {
    throw new Error(`refusing to clean unexpected profile path: ${resolvedProfile}`)
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(resolvedProfile, { recursive: true, force: true })
      break
    } catch (error) {
      if (!['EPERM', 'EBUSY'].includes(error?.code) || attempt === 7) throw error
      await delay(500)
    }
  }
}
