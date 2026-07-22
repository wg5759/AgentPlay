// 回归验收：控制栏 3 秒自动隐藏 + 鼠标微抖不唤醒 + 真实移动唤醒
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executableArg = process.argv.slice(2).find((value) => value.startsWith('--exe='))
const mediaArg = process.argv.slice(2).find((value) => !value.startsWith('--'))
const executable = executableArg ? path.resolve(executableArg.slice('--exe='.length)) : path.join(root, 'release', 'win-unpacked', 'AI播放器.exe')
import os from 'node:os'
const srcMedia = mediaArg || 'D:/Ai工具升级/测试视频-120秒.mp4'
const mediaPath = path.join(os.tmpdir(), 'autohide-' + Date.now() + path.extname(srcMedia))
fs.copyFileSync(srcMedia, mediaPath)
const port = 19451
const child = spawn(executable, [`--remote-debugging-port=${port}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--window-position=-2400,-2400', mediaPath], { windowsHide: true, shell: false })
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

let websocket
let nextId = 0
const pending = new Map()
function command(method, params = {}) {
  const id = ++nextId
  websocket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, { resolve }))
}
async function probe() {
  const result = await command('Runtime.evaluate', {
    expression: `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('媒体库')); const ae = document.activeElement; return JSON.stringify({ op: b ? getComputedStyle(b).opacity : 'missing', ae: ae ? ae.tagName + '|' + (ae.title || ae.textContent || '').slice(0, 8) : 'none' }) })()`,
    returnByValue: true
  })
  return result.result?.value
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true })
  return result.result?.value
}
async function opacity() {
  const result = await command('Runtime.evaluate', {
    expression: `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('媒体库')); return b ? getComputedStyle(b).opacity : 'missing' })()`,
    returnByValue: true
  })
  return result.result?.value
}
async function ensurePlaying() {
  const state = await evaluate(`(() => { const v = document.querySelector('video[data-ai-player-video="true"]'); if (!v) return 'no-video'; if (v.paused) { v.play().catch(() => {}); return 'replayed' } return 'playing' })()`)
  if (state === 'replayed') console.log('  env: 视频被环境暂停，已恢复播放')
}
async function moveMouse(x, y) {
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
}

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}：期望 ${expected}，实际 ${actual}`)
}

try {
  let page
  for (let i = 0; i < 80 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => p.type === 'page') } catch {}
    if (!page) await delay(250)
  }
  if (!page) throw new Error('页面未就绪')
  websocket = new WebSocket(page.webSocketDebuggerUrl)
  const dbgLogs = []
  websocket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) { pending.get(message.id).resolve(message.result); pending.delete(message.id) }
    else if (message.method === 'Runtime.consoleAPICalled') {
      const text = (message.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
      if (text.includes('[focus-dbg]')) dbgLogs.push(text)
    }
  })
  process.on('exit', () => { if (dbgLogs.length) console.log('--- [focus-dbg] ---'); for (const l of dbgLogs) console.log(l) })
  await new Promise((res, rej) => { websocket.addEventListener('open', res, { once: true }); websocket.addEventListener('error', rej, { once: true }) })
  await command('Runtime.enable')
  await command('Page.bringToFront')
  await command('Emulation.setFocusEmulationEnabled', { enabled: true })
  await delay(6000) // 等播放稳定 + 首个隐藏窗口

  { const p = JSON.parse(await probe()); console.log('  probe', p.ae);   await ensurePlaying()
check('播放中静止 3 秒后控制栏已隐藏', p.op, '0') }

  // 鼠标微抖（±1px）持续 5 秒：不应唤醒
  for (let i = 0; i < 10; i++) {
    await moveMouse(500 + (i % 2), 300)
    await delay(500)
  }
  { const p = JSON.parse(await probe()); console.log('  probe', p.ae); check('鼠标 ±1px 微抖后控制栏仍隐藏', p.op, '0') }

  await ensurePlaying()
  // 真实移动（>4px）：应唤醒
  await moveMouse(500, 300)
  await moveMouse(540, 330)
  await delay(600)
  { const p = JSON.parse(await probe()); console.log('  probe', p.ae); check('真实移动后控制栏重新显示', p.op, '1') }

  await ensurePlaying()
  // 再次静止：3 秒后应重新隐藏
  await delay(3600)
  { const p = JSON.parse(await probe()); console.log('  probe', p.ae); check('再次静止后控制栏重新隐藏', p.op, '0') }

  await ensurePlaying()
  // 真实用户场景：控制栏可见时点击控制按钮（字幕开关，不触碰播放态），按钮焦点用完即还，仍应按点隐藏
  await moveMouse(500, 300)
  await moveMouse(540, 330)
  await delay(600)
  const subBtn = JSON.parse(await evaluate(`(() => { const b = [...document.querySelectorAll('[data-player-chrome="true"] button')].find((x) => x.textContent.trim() === '字幕'); if (!b) return 'null'; const r = b.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }) })()`))
  await moveMouse(subBtn.x, subBtn.y)
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: subBtn.x, y: subBtn.y, button: 'left', clickCount: 1 })
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: subBtn.x, y: subBtn.y, button: 'left', clickCount: 1 })
  await delay(500)
  { const p = JSON.parse(await probe()); console.log('  probe', p.ae); check('点击控制按钮后控制栏显示且焦点已释放', p.op, '1'); if (p.ae.startsWith('BUTTON')) console.log('  note: 焦点仍在按钮上:', p.ae) }
  await delay(3400)
  { const p2 = JSON.parse(await probe()); console.log('  probe', p2.ae); check('点击控制按钮不阻断 3 秒隐藏', p2.op, '0') }
  await delay(3600)
  { const p3 = JSON.parse(await probe()); console.log('  probe(+7s)', p3.ae, p3.op) }

  // 布局不变量：控制栏显隐不得改变窗口内容高度（高度变化会把按钮挪到静止光标下形成显隐循环）
  await moveMouse(500, 300)
  await moveMouse(540, 330)
  await delay(400)
  const heightVisible = await evaluate('innerHeight')
  await delay(3400)
  const heightHidden = await evaluate('innerHeight')
  check('控制栏显隐不改变窗口内容高度', `${heightVisible}→${heightHidden}`, `${heightVisible}→${heightVisible}`)

  // 鼠标停在顶部栏附近（用户最常停放的位置）：不得因布局位移触发显隐循环
  await moveMouse(200, 24)
  await delay(4200)
  { const p4 = JSON.parse(await probe()); console.log('  probe(顶部悬停)', p4.ae, p4.op); check('鼠标停在顶部 4 秒后控制栏仍隐藏', p4.op, '0') }
  await delay(3600)
  { const p5 = JSON.parse(await probe()); console.log('  probe(顶部悬停+8s)', p5.ae, p5.op); check('鼠标停在顶部 8 秒后控制栏仍隐藏（无循环）', p5.op, '0') }

  console.log(failures === 0 ? 'SMOKE_OK 控制栏自动隐藏与鼠标阈值全部通过' : `SMOKE_FAIL ${failures} 项未过`)
} finally {
  try { websocket?.close() } catch {}
  try { child.kill() } catch {}
}
process.exit(failures === 0 ? 0 : 1)
