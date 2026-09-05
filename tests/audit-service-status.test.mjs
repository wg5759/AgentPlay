import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyAudit, runAudit } from '../scripts/audit-dependencies.mjs'

test('audit distinguishes clean, vulnerability, unavailable and malformed results', () => {
  assert.equal(classifyAudit({ status: 0, stdout: JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } }) }), 'clean')
  assert.equal(classifyAudit({ status: 1, stdout: JSON.stringify({ metadata: { vulnerabilities: { high: 1 } } }), stderr: 'ERR_SOCKET_TIMEOUT' }), 'vulnerabilities')
  assert.equal(classifyAudit({ status: 1, stderr: 'ERR_SOCKET_TIMEOUT' }), 'unavailable')
  assert.equal(classifyAudit({ status: 0, stdout: 'OK' }), 'error')
})
test('network failure retries once and never becomes a passing audit', t => {
  t.mock.method(console, 'error', () => {})
  let calls = 0
  assert.equal(runAudit([], () => { calls++; return { status: 1, stderr: 'ERR_SOCKET_TIMEOUT' } }), 75)
  assert.equal(calls, 2)
})
