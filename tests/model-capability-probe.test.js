const test = require('node:test')
const assert = require('node:assert/strict')
const { verifyModelCapabilities, blueProbeImage } = require('../electron/model-capability-probe')
test('capability probes verify text, an image answer and tool arguments without executing tools', async () => {
  let calls = 0
  const engine = { completeText: async () => ({ text: 'AP_PROBE' }), completeVisionMultiOnce: async input => { assert.equal(input.imageDataUrls[0], blueProbeImage()); return { text: 'blue' } } }
  const result = await verifyModelCapabilities({ providerId: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'test', apiKey: 'fixture' }, engine, async () => { calls++; return { ok: true, json: async () => ({ choices: [{ message: { tool_calls: [{ function: { name: 'probe_echo', arguments: '{"token":"AP_PROBE"}' } }] } }] }) } })
  assert.equal(result.text, 'verified'); assert.equal(result.vision, 'verified'); assert.equal(result.tools, 'verified'); assert.equal(calls, 1)
})
test('a model list or failed generation never proves capability', async () => {
  const result = await verifyModelCapabilities({ providerId: 'ollama', model: 'fixture' }, { completeText: async () => { throw Error('private credential') } })
  assert.equal(result.success, false); assert.equal(result.vision, 'not-tested'); assert.ok(!JSON.stringify(result).includes('private credential'))
})
