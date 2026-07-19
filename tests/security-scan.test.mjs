import assert from 'node:assert/strict'
import test from 'node:test'
import { collectSanitizedUrls, scanText } from '../scripts/security-scan-lib.mjs'

test('secret scanner reports location and rule without returning the secret value', () => {
  const value = `sk-${'A'.repeat(32)}`
  const findings = scanText('fixture.txt', `token=${value}`)
  assert.deepEqual(findings, [{ source: 'fixture.txt', line: 1, rule: 'openai-key' }])
  assert.equal(JSON.stringify(findings).includes(value), false)
})

test('secret scanner ignores explicit placeholder values', () => {
  assert.deepEqual(scanText('fixture.txt', `key=sk-${'x'.repeat(32)}`), [])
})

test('endpoint inventory strips query strings, fragments and credentials', () => {
  const endpoints = collectSanitizedUrls('fixture.txt', 'https://user:pass@example.com/v1?q=secret#token')
  assert.deepEqual(endpoints, [{ source: 'fixture.txt', endpoint: 'https://example.com/v1' }])
})
