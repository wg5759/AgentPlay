const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const recommended = read('README.md').match(/https:\/\/github\.com\/wg5759\/AgentPlay\/releases\/tag\/v[^)\s]+-preview\.\d+/)[0]

test('both quick starts match the README recommended public preview', () => {
  for (const file of ['docs/QUICK_START.md', 'docs/QUICK_START.en.md']) assert.ok(read(file).includes(recommended), `${file} must not recommend an older or unpublished build`)
})
test('English home and redirected Chinese README recommend the same public preview', () => {
  const download = read('docs/index.html').match(/class="button primary" href="([^"]+)"/)
  assert.equal(download?.[1], recommended)
  assert.match(read('docs/index.zh-CN.html'), /http-equiv="refresh" content="0;url=https:\/\/github.com\/wg5759\/AgentPlay\/blob\/master\/README.zh-CN.md"/)
  assert.ok(read('README.zh-CN.md').includes(`href="${recommended}">下载预览版`))
})
test('first-use guides include verifiable local playback and safe package selection', () => {
  const zh = read('docs/QUICK_START.md'), en = read('docs/QUICK_START.en.md')
  assert.match(zh, /三分钟/); assert.match(en, /three-minute/i)
  for (const text of [zh, en]) { assert.match(text, /Get-FileHash/); assert.match(text, /AgentPlay-0\.9\.1-Windows-x64-Standard\.exe/); assert.match(text, /Portable\.zip/); assert.match(text, /Escape|ESC/); assert.doesNotMatch(text, /ExecutionPolicy\s+Bypass|irm\s+.*\|\s*iex/) }
  for (const match of en.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) if (!/^https?:/.test(match[1])) assert.ok(fs.existsSync(path.resolve(root, 'docs', match[1])), match[1])
})
