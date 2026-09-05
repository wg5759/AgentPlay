const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.join(__dirname, '..')
const policyPromise = import(pathToFileURL(path.join(root, 'electron', 'agent-runtime-policy.mjs')).href)

test('agent runtime exposes four provider-independent work modes', async () => {
  const { AGENT_MODES, normalizeAgentMode } = await policyPromise
  assert.deepEqual(Object.keys(AGENT_MODES), ['ask', 'plan', 'work', 'auto'])
  assert.equal(normalizeAgentMode('plan'), 'plan')
  assert.equal(normalizeAgentMode('unknown'), 'work')
  assert.equal(AGENT_MODES.work.maxToolCalls, 12)
  assert.equal(AGENT_MODES.auto.maxToolCalls, 24)
})

test('ask and plan are non-executing while work and auto can dispatch tasks', async () => {
  const { canDispatchAgentTask } = await policyPromise
  assert.equal(canDispatchAgentTask('ask'), false)
  assert.equal(canDispatchAgentTask('plan'), false)
  assert.equal(canDispatchAgentTask('work'), true)
  assert.equal(canDispatchAgentTask('auto'), true)
})

test('tool exposure follows mode and keeps a guard against forged tool calls', async () => {
  const { resolveAgentRuntime } = await policyPromise
  const tools = ['pause', 'summarize_video', 'screenshot'].map((name) => ({ function: { name } }))
  const ask = resolveAgentRuntime('ask', tools)
  const plan = resolveAgentRuntime('plan', tools)
  const work = resolveAgentRuntime('work', tools)
  assert.deepEqual(ask.tools.map((tool) => tool.function.name), ['summarize_video'])
  assert.deepEqual(plan.tools, [])
  assert.deepEqual(work.tools.map((tool) => tool.function.name), ['pause', 'summarize_video', 'screenshot'])
  assert.equal(plan.canUseTool('pause'), false)
  assert.equal(ask.canUseTool('pause'), false)
  assert.equal(ask.canUseTool('summarize_video'), true)
})

test('every model receives the same evidence-first completion contract', async () => {
  const { buildAgentSystemPrompt } = await policyPromise
  const prompt = buildAgentSystemPrompt('任务专用规则：只输出两部分。', 'auto')
  assert.match(prompt, /AGENTPLAY_RUNTIME_V1/)
  assert.match(prompt, /检查.*计划.*执行.*验证/s)
  assert.match(prompt, /不得把“已生成”“已调用”或模型自己的文字当成完成证据/)
  assert.match(prompt, /任务专用规则：只输出两部分/)
  assert.match(prompt, /自动模式/)
})

test('renderer, preload and engine wire the selected mode end to end', () => {
  const store = fs.readFileSync(path.join(root, 'src', 'stores', 'agentStore.ts'), 'utf8')
  const router = fs.readFileSync(path.join(root, 'src', 'components', 'agent-panel', 'intentRouter.ts'), 'utf8')
  const settings = fs.readFileSync(path.join(root, 'src', 'components', 'agent-panel', 'RuntimeSettings.tsx'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8')
  const engine = fs.readFileSync(path.join(root, 'electron', 'llm-service.js'), 'utf8')
  assert.match(store, /agentMode:\s*AgentMode/)
  assert.match(store, /mode:\s*options\.mode\s*\|\|\s*get\(\)\.agentMode/)
  assert.match(router, /canDispatchAgentTask\(agentMode\)/)
  assert.match(settings, /工作方式/)
  assert.match(preload, /agentOptions/)
  assert.match(main, /agentOptions/)
  assert.match(engine, /resolveAgentRuntime/)
  assert.match(engine, /const availableTools = pluginEnabled \? listAgentTools\(\) : tools/)
  assert.doesNotMatch(engine, /const TOOLS = \[/)
})

test('engine enforces the mode before its deterministic local fast path', async () => {
  const { AgentEngine } = require('../electron/llm-service')
  const engine = new AgentEngine(null)
  const plan = await engine.chat([{ role: 'user', content: '暂停' }], null, null, { mode: 'plan' })
  assert.equal(plan.toolResults.length, 0)
  assert.match(plan.text, /规划模式/)
  const work = await engine.chat([{ role: 'user', content: '暂停' }], null, null, { mode: 'work' })
  assert.equal(work.toolResults[0].tool, 'pause')
  assert.equal(work.toolResults[0].result.action, 'pause')
  assert.equal(work.run.mode, 'work')
  assert.equal(work.run.budget.toolCalls, 1)
  assert.equal(work.run.steps[0].evidence.verified, false)
})
