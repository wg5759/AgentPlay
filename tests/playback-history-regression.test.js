const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('playback history drops source-less records, deduplicates paths and keeps the newest 30', async () => {
  const history = await import(pathToFileURL(path.join(root, 'src', 'player-history.mjs')).href)
  const input = [
    { name: '坏记录.mp3', openedAt: 50 },
    { name: '新版.mp4', src: 'D:\\video\\same.mp4', openedAt: 40 },
    { name: '旧版.mp4', src: 'D:\\video\\same.mp4', openedAt: 20 },
    ...Array.from({ length: 35 }, (_, index) => ({ name: `${index}.mp4`, src: `D:\\video\\${index}.mp4`, openedAt: index }))
  ]

  const normalized = history.normalizeRecentMedia(input)
  assert.equal(normalized.length, 30)
  assert.equal(normalized.some((item) => !item.src), false)
  assert.equal(normalized.filter((item) => item.src === 'D:\\video\\same.mp4').length, 1)
  assert.equal(normalized.find((item) => item.src === 'D:\\video\\same.mp4').name, '新版.mp4')
})

test('recording a dropped file refuses an empty source instead of poisoning persisted history', async () => {
  const history = await import(pathToFileURL(path.join(root, 'src', 'player-history.mjs')).href)
  const existing = [{ name: '原视频.mp4', src: 'D:\\video\\source.mp4', openedAt: 10 }]
  assert.deepEqual(history.recordRecentMedia(existing, { name: '坏记录.mp3', src: '', openedAt: 20 }), existing)
  assert.equal(history.recordRecentMedia(existing, { name: '新视频.mp4', src: 'D:\\video\\new.mp4', openedAt: 30 })[0].name, '新视频.mp4')
})

test('current records exposes the playback ledger independently from task count and desktop drop uses webUtils path', () => {
  const sidebar = read('src/components/Sidebar.tsx')
  const player = read('src/components/PlayerView.tsx')
  const store = read('src/stores/playerStore.ts')

  assert.match(sidebar, /播放记录/)
  assert.match(sidebar, /recentMedia\.map\(/)
  assert.doesNotMatch(sidebar, /recentMedia\.slice\(0, tasks\.length > 0 \? 4 : 10\)/)
  assert.match(player, /files\?\.getPathForFile\?\.\(file\)/)
  assert.match(store, /normalizeRecentMedia/)
  assert.match(store, /version:\s*1/)
  assert.match(store, /migrate:/)
})
