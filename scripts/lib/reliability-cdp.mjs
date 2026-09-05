import net from 'node:net'
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
export async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
export async function connectCdp(port, type) {
  let target
  for (let i = 0; i < 240; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json()).find(item => item.type === type) } catch {}; if (target?.webSocketDebuggerUrl) break; await delay(250) }
  if (!target?.webSocketDebuggerUrl) throw Error(`CDP unavailable: ${type}`)
  const socket = new WebSocket(target.webSocketDebuggerUrl); const pending = new Map(); let sequence = 0
  socket.onmessage = event => { const value = JSON.parse(event.data), item = pending.get(value.id); if (!item) return; pending.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(Error(value.error.message)) : item.resolve(value.result) }
  socket.onclose = () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('CDP closed')) } pending.clear() }
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  const command = (method, params = {}, timeout = 90000) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)) }, timeout); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })) })
  const evaluate = async expression => { const result = await command('Runtime.evaluate', { expression: `globalThis.__reliabilityPending = Promise.resolve(eval(${JSON.stringify(expression)}))`, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value }
  return { command, evaluate, close: () => socket.close() }
}
export async function until(check, label, timeout = 60000) { const end = Date.now() + timeout; let last; while (Date.now() < end) { try { last = await check(); if (last) return last } catch {} await delay(100) } throw Error(`Not ready: ${label}`) }
