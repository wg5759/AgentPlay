const test = require('node:test')
const assert = require('node:assert/strict')
const { classifyPublicLink, normalizePublicUrl } = require('../electron/public-link-service')

test('public/synthetic intake corpus meets the fixed classification and dedupe gate', () => {
  const domains = [
    ['https://example.com/a', 'web'], ['https://example.com/a.pdf', 'public-pdf'], ['https://github.com/a/b', 'github'],
    ['https://raw.githubusercontent.com/a/b/main/a.txt', 'github'], ['https://example.com/feed.rss', 'rss'],
    ['https://example.com/news.atom', 'rss'], ['https://docs.google.com/document/d/a', 'online-document'],
    ['https://docs.qq.com/doc/a', 'online-document'], ['https://example.com/a.mp3', 'audio'],
    ['https://youtube.com/watch?v=a', 'video-site'], ['https://x.com/a/status/1', 'video-site'], ['https://example.com/a.mp4', 'media']
  ]
  const corpus = Array.from({ length: 10 }, () => domains).flat()
  const correct = corpus.filter(([url, expected]) => classifyPublicLink(url).kind === expected).length
  assert.ok(correct / corpus.length >= 0.99, `链接类型准确率不足：${correct}/${corpus.length}`)
  const variants = ['https://example.com/a?id=1&utm_source=x#p', 'https://example.com/a?utm_medium=y&id=1', 'https://example.com/a?id=1&utm_campaign=z']
  assert.equal(new Set(variants.map(normalizePublicUrl)).size, 1, '追踪参数和片段不得制造重复来源')
})
