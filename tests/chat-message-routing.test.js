const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

test('a background completion cannot steal the active chat reply', async () => {
  let state, finish, stream
  const api = { getState: () => state, setState: patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) } } }
  const taskFns = new Proxy({ createWorkspaceTask: input => ({ id: '', phase: 'waiting', outputs: [], steps: [], evidence: [], ...input }) }, { get: (object, key) => object[key] || (value => value) })
  const exports = {}
  const context = { exports, require: name => {
    if (name === 'zustand') return { create: () => creator => { state = creator(api.setState, api.getState); return api } }
    if (name === 'zustand/middleware') return { persist: creator => creator }
    if (name.includes('playerStore')) return { usePlayerStore: { getState: () => ({}) } }
    if (name.includes('taskLifecycle')) return taskFns
    if (name.includes('agent-runtime-policy')) return { normalizeAgentMode: value => value }
    if (name.includes('attachment-policy')) return { dedupeAttachments: value => value }
    return { applyAgentToolResult: async () => ({}) }
  }, window: { aiPlayer: { ai: { onStream: listener => { stream = listener; return () => {} }, chat: () => new Promise(resolve => { finish = resolve }) } } } }
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/stores/agentStore.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(code, context)
  api.setState({ inputText: '测试问题' })
  const pending = api.getState().send()
  const requestId = api.getState().activeRequestId
  api.getState().addMessage('agent', '后台任务已完成')
  stream({ requestId, delta: '正在回答' })
  finish({ text: '这才是对应的答复', toolResults: [] })
  await pending
  assert.equal(api.getState().messages[1].text, '这才是对应的答复')
  assert.equal(api.getState().messages[2].text, '后台任务已完成')
})
