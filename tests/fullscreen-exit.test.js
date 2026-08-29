const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('desktop fullscreen uses explicit target state and exposes an authoritative readback', () => {
  const main = read('electron/main.js')
  const preload = read('electron/preload.js')
  const types = read('src/types/global.d.ts')

  assert.match(main, /ipcMain\.handle\(['"]window:setFullscreen['"]/)
  assert.match(main, /ipcMain\.handle\(['"]window:isFullscreen['"]/)
  assert.match(main, /setFullScreen\(Boolean\(fullscreen\)\)/)
  assert.match(preload, /setFullscreen:\s*\(fullscreen\)\s*=>\s*ipcRenderer\.invoke\(['"]window:setFullscreen['"]/)
  assert.match(preload, /isFullscreen:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]window:isFullscreen['"]/)
  assert.match(types, /setFullscreen:\s*\(fullscreen:\s*boolean\)\s*=>\s*Promise<boolean>/)
  assert.match(types, /isFullscreen:\s*\(\)\s*=>\s*Promise<boolean>/)
})

test('main process exits fullscreen on native Escape before renderer focus can swallow it', () => {
  const main = read('electron/main.js')
  assert.match(main, /webContents\.on\(['"]before-input-event['"]/)
  assert.match(main, /input\.key\s*===\s*['"]Escape['"]/)
  assert.match(main, /isFullScreen\(\)[\s\S]{0,300}setFullScreen\(false\)/)
})

test('player double click, fullscreen button and Escape request explicit exit state', () => {
  const view = read('src/components/PlayerView.tsx')
  const controls = read('src/components/PlayerControls.tsx')

  assert.match(view, /setFullscreen\(next\)/)
  assert.match(view, /event\.key\s*!==\s*['"]Escape['"][\s\S]{0,500}setFullscreen\(false\)/)
  assert.match(controls, /setFullscreen\(next\)/)
  assert.match(view, /const next = !\(state\.theater \|\| state\.isFullscreen\)/)
  assert.match(controls, /const next = !\(state\.theater \|\| state\.isFullscreen\)/)
  assert.doesNotMatch(view, /next\s*!==\s*state\.isFullscreen[\s\S]{0,180}setPreset\(['"]fullscreen['"]\)/)
  assert.doesNotMatch(controls, /next\s*!==\s*state\.isFullscreen[\s\S]{0,180}setPreset\(['"]fullscreen['"]\)/)
})
