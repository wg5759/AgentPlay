const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('local playback errors distinguish a growing file from a stable broken file', async () => {
  const policy = await import(pathToFileURL(path.join(root, 'src', 'player-media-error-policy.mjs')).href)
  const opened = { size: 100, mtimeMs: 10 }
  assert.equal(policy.classifyMediaPlaybackError({ localFile: true, openedStat: opened, currentStat: { size: 200, mtimeMs: 20 } }), 'growing')
  assert.equal(policy.classifyMediaPlaybackError({ localFile: true, openedStat: opened, currentStat: { size: 100, mtimeMs: 10 } }), 'stable-error')
  assert.equal(policy.classifyMediaPlaybackError({ localFile: false, openedStat: null, currentStat: null }), 'unavailable')
})

test('HTML5 media error never launches the external compatibility player automatically', () => {
  const view = read('src/components/PlayerView.tsx')
  const errorStart = view.indexOf('const handleVideoPlaybackError')
  const errorEnd = view.indexOf('const dismissPlaybackNotice', errorStart)
  const errorBlock = view.slice(errorStart, errorEnd)
  assert.ok(errorStart >= 0)
  assert.doesNotMatch(errorBlock, /window\.aiPlayer\.player\.loadFile\(videoSrc\)/)
  assert.match(view, /onError=\{\(\) => \{ void handleVideoPlaybackError\(\) \}\}/)
  assert.match(errorBlock, /prepareInlinePlayback/)
  assert.match(view, /视频文件仍在生成，完成后会自动重试/)
  assert.match(view, /文件可能未完成或码流损坏/)
  assert.match(view, /handleLoadedMedia[\s\S]{0,1500}openedMediaStatRef\.current = stat/)
})

test('desktop bridge exposes authorized file stat for playback recovery', () => {
  const main = read('electron/main.js')
  const preload = read('electron/preload.js')
  const types = read('src/types/global.d.ts')
  assert.match(main, /ipcMain\.handle\('files:stat'/)
  assert.match(main, /assertAllowedPath\(filePath\)/)
  assert.match(preload, /stat:\s*\(filePath\)\s*=>\s*ipcRenderer\.invoke\('files:stat', filePath\)/)
  assert.match(types, /stat:\s*\(filePath: string\)/)
})
