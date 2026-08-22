const test = require('node:test')
const assert = require('node:assert/strict')
const { PublicLinkService, classifyPublicLink, normalizePublicUrl } = require('../electron/public-link-service')
const { videoTime, documentPage, webParagraph, sheetCell, imageRegion, assertEvidenceReference } = require('../electron/evidence-reference')

test('public and synthetic URLs classify across web, PDF, GitHub, RSS, online docs and audio', () => {
  const samples = [
    ['https://example.com/article', 'web'], ['https://example.com/report.pdf', 'public-pdf'],
    ['https://github.com/wg5759/AgentPlay', 'github'], ['https://example.com/feed.rss', 'rss'],
    ['https://docs.google.com/document/d/abc', 'online-document'], ['https://cdn.example.com/audio.mp3', 'audio']
  ]
  for (const [url, kind] of samples) assert.equal(classifyPublicLink(url).kind, kind)
  assert.equal(normalizePublicUrl('https://example.com/a?utm_source=x&id=1#part'), 'https://example.com/a?id=1')
  assert.equal(classifyPublicLink('file:///etc/passwd').matched, false)
})

test('every source kind uses one evidence reference protocol', () => {
  const refs = [videoTime('a.mp4', 4, 8, '台词'), documentPage('a.pdf', 3, '第三页'), webParagraph('https://example.com', 2, '第二段'), sheetCell('a.xlsx', '数据', 'c3', '100'), imageRegion('a.png', { x: 0.1, y: 0.2, width: 0.4, height: 0.5 }, '图表')]
  for (const ref of refs) assert.equal(assertEvidenceReference(ref), ref)
  assert.deepEqual(refs.map((item) => item.evidenceKind), ['video-time', 'document-page', 'web-paragraph', 'sheet-cell', 'image-region'])
  assert.throws(() => assertEvidenceReference(sheetCell('a.xlsx', '', 'bad', '')), /单元格/)
})

function response({ status = 200, type = 'text/html', body = '<title>标题</title><p>第一段公开内容足够长</p>' } = {}) {
  const bytes = new TextEncoder().encode(body)
  return { status, ok: status >= 200 && status < 300, headers: { get: (name) => name.toLowerCase() === 'content-type' ? type : String(bytes.length) }, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }) }
}

test('public preview returns paragraph evidence and never sends credentials', async () => {
  const calls = []
  const service = new PublicLinkService({ dnsLookup: async () => [{ address: '93.184.216.34' }], fetchImpl: async (url, options) => { calls.push({ url, options }); return response() } })
  const result = await service.inspect('https://example.com/article?utm_source=test')
  assert.equal(result.access, 'public')
  assert.equal(result.evidence[0].evidenceKind, 'web-paragraph')
  assert.equal(calls[0].options.credentials, undefined)
  assert.equal(calls[0].options.headers.Authorization, undefined)
})

test('login/paywall, offline and oversized content fail honestly without bypass', async () => {
  const controlled = new PublicLinkService({ dnsLookup: async () => [{ address: '93.184.216.34' }], fetchImpl: async () => response({ status: 403, body: '<title>Sign in</title><p>Login required</p>' }) })
  assert.equal((await controlled.inspect('https://example.com/private')).access, 'controlled')
  const offline = new PublicLinkService({ dnsLookup: async () => [{ address: '93.184.216.34' }], fetchImpl: async () => { throw new Error('offline') } })
  await assert.rejects(offline.inspect('https://example.com/a'), /暂时无法访问.*offline/)
  const huge = new PublicLinkService({ dnsLookup: async () => [{ address: '93.184.216.34' }], fetchImpl: async () => response({ body: 'x'.repeat(2 * 1024 * 1024 + 1) }) })
  await assert.rejects(huge.inspect('https://example.com/huge'), /超过2MB/)
})

test('main, preload and unified conversation wire public links and local evidence inspection', () => {
  const fs = require('node:fs'); const path = require('node:path'); const root = path.join(__dirname, '..')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8')
  const router = fs.readFileSync(path.join(root, 'src', 'components', 'agent-panel', 'intentRouter.ts'), 'utf8')
  assert.match(main, /ipcMain\.handle\('links:handle'/)
  assert.match(main, /ipcMain\.handle\('evidence:inspect-file'/)
  assert.match(preload, /linkContent: \{/)
  assert.match(preload, /evidence: \{/)
  assert.ok(router.indexOf('linkContent.detect') < router.indexOf('mediaDownload.detect'), '普通公开链接必须先于裸链接视频下载误判')
  assert.match(router, /不能绕过访问控制/)
})
