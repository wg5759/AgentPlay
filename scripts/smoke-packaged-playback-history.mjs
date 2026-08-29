import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executableArg = process.argv.slice(2).find((value) => value.startsWith('--exe='))
const inspectExisting = process.argv.includes('--inspect-existing')
const executable = executableArg
  ? path.resolve(executableArg.slice('--exe='.length))
  : path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe')
const port = 19439
const userDataDir = inspectExisting ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-playback-history-'))

if (!fs.existsSync(executable)) throw new Error(`AgentPlay 不存在：${executable}`)

const child = spawn(executable, [
  `--remote-debugging-port=${port}`,
  ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : [])
], { cwd: path.dirname(executable), windowsHide: true, shell: false })

let websocket
let nextId = 0
const pending = new Map()
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForChildExit(timeoutMs) {
  if (child.exitCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

async function findPage() {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {}
    await delay(250)
  }
  throw new Error('AgentPlay 没有开放播放记录验收页面')
}

function command(method, params = {}) {
  const id = ++nextId
  websocket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const response = await command('Runtime.evaluate', { expression, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || '播放记录验收表达式失败')
  return response.result?.value
}

async function waitForValue(expression, predicate, label, timeoutMs = 7000) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    try {
      last = await evaluate(expression)
      if (predicate(last)) return last
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await delay(100)
  }
  throw new Error(`${label}：${JSON.stringify(last)}`)
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
  await command('Page.enable')

  if (inspectExisting) {
    await waitForValue(`Boolean(document.querySelector('button[aria-label="最近记录"]'))`, (value) => value === true, '新版最近记录入口没有出现')
    await evaluate(`document.querySelector('button[aria-label="最近记录"]')?.click()`)
    const receipt = await waitForValue(`(() => {
      const persisted = JSON.parse(localStorage.getItem('ai-player-store') || 'null')
      const items = Array.isArray(persisted?.state?.recentMedia) ? persisted.state.recentMedia : []
      return {
        version: window.aiPlayer?.version || '',
        storeVersion: persisted?.version ?? null,
        persistedCount: items.length,
        sourceLessCount: items.filter((item) => !item?.src).length,
        visibleCount: document.querySelectorAll('.workspace-recent-item:not(.workspace-task-item)').length,
        hasPlaybackHeading: [...document.querySelectorAll('.workspace-recent-divider')].some((node) => node.textContent?.includes('播放记录'))
      }
    })()`, (value) => value?.hasPlaybackHeading === true, '现有播放记录没有显示')
    assert.equal(receipt.storeVersion, 1)
    assert.equal(receipt.sourceLessCount, 0)
    assert.equal(receipt.visibleCount, receipt.persistedCount)
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
  } else {
    const media = [
    { name: '坏记录.mp3', openedAt: 700 },
    ...Array.from({ length: 6 }, (_, index) => ({
      name: `播放记录-${index + 1}.mp4`,
      src: `D:\\fixture\\playback-history-${index + 1}.mp4`,
      openedAt: 600 - index
    }))
  ]
    const oldPlayerStore = {
    state: {
      volume: 80, subtitleVisible: true, subtitlePosition: 'low', positions: {}, playbackRate: 1,
      lastAudibleVolume: 80, recentMedia: media, favorites: []
    },
    version: 0
  }
    const taskStore = {
    state: {
      tasks: [{ id: 'task-history-smoke', kind: 'download', label: '历史任务', phase: 'completed', outputs: [], createdAt: 1, updatedAt: 1, completedAt: 1 }],
      activeTaskId: 'task-history-smoke', agentMode: 'auto'
    },
    version: 3
  }
    await evaluate(`(() => {
    localStorage.setItem('ai-player-store', ${JSON.stringify(JSON.stringify(oldPlayerStore))})
    localStorage.setItem('agentplay-workspace-tasks', ${JSON.stringify(JSON.stringify(taskStore))})
    location.reload()
    return true
  })()`)

    await waitForValue(`Boolean(document.querySelector('button[aria-label="最近记录"]'))`, (value) => value === true, '新版最近记录入口没有出现')
    await evaluate(`document.querySelector('button[aria-label="最近记录"]')?.click()`)
    const receipt = await waitForValue(`(() => {
    const persisted = JSON.parse(localStorage.getItem('ai-player-store') || 'null')
    return {
      version: window.aiPlayer?.version || '',
      storeVersion: persisted?.version ?? null,
      persistedNames: (persisted?.state?.recentMedia || []).map((item) => item.name),
      persistedSources: (persisted?.state?.recentMedia || []).map((item) => item.src),
      visibleNames: [...document.querySelectorAll('.workspace-recent-item:not(.workspace-task-item) strong')].map((node) => node.textContent || ''),
      visibleTaskCount: document.querySelectorAll('.workspace-task-item').length,
      playbackHeading: [...document.querySelectorAll('.workspace-recent-divider')].map((node) => node.textContent || '').find((text) => text.includes('播放记录')) || ''
    }
  })()`, (value) => Array.isArray(value?.visibleNames) && value.visibleNames.length === 6, '播放记录没有完整显示')

    assert.equal(receipt.storeVersion, 1)
    assert.equal(receipt.persistedNames.length, 6)
    assert.equal(receipt.persistedSources.every(Boolean), true)
    assert.deepEqual(receipt.visibleNames, receipt.persistedNames)
    assert.equal(receipt.visibleTaskCount, 1)
    assert.match(receipt.playbackHeading, /播放记录 · 6/)
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
  }
} finally {
  try { websocket?.close() } catch {}
  if (child.exitCode === null) {
    child.kill()
    await waitForChildExit(5000)
  }
  if (userDataDir) {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  }
}
