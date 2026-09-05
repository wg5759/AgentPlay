const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const subtitlePolicyPromise = import('../src/subtitle-display-policy.mjs')

test('translated subtitle position can move up and down through bounded presets', async () => {
  const { subtitleLinePercent, shiftSubtitlePosition } = await subtitlePolicyPromise
  assert.equal(subtitleLinePercent('high'), 54)
  assert.equal(subtitleLinePercent('middle'), 70)
  assert.equal(subtitleLinePercent('low'), 84)
  assert.equal(shiftSubtitlePosition('low', 'up'), 'middle')
  assert.equal(shiftSubtitlePosition('middle', 'up'), 'high')
  assert.equal(shiftSubtitlePosition('high', 'up'), 'high')
  assert.equal(shiftSubtitlePosition('high', 'down'), 'middle')
  assert.equal(shiftSubtitlePosition('low', 'down'), 'low')
})

test('player always starts a newly opened video in fit mode and does not restore stale crop mode', () => {
  const store = fs.readFileSync(path.join(__dirname, '..', 'src', 'stores', 'playerStore.ts'), 'utf8')
  const player = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PlayerView.tsx'), 'utf8')
  assert.match(store, /setMedia:[\s\S]*?pictureMode:\s*'fit'/)
  const persisted = store.slice(store.indexOf('partialize:'), store.indexOf('}\n    }\n  )'))
  assert.doesNotMatch(persisted, /pictureMode:\s*s\.pictureMode/)
  assert.match(player, /data-picture-mode=\{pictureMode\}/)
  assert.match(player, /pictureMode === 'fill'[\s\S]*?object-cover[\s\S]*?object-contain/)
})

test('subtitle controls expose explicit up and down movement actions', () => {
  const controls = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PlayerControls.tsx'), 'utf8')
  assert.match(controls, /title="字幕上移"/)
  assert.match(controls, /title="字幕下移"/)
  assert.match(controls, /setSubtitlePosition/)
  assert.match(controls, /setSubtitlePosition\(shiftSubtitlePosition\(subtitlePosition, 'up'\)\)/)
  assert.match(controls, /player-video-controls[^"]*text-white/)
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.css'), 'utf8')
  assert.match(css, /\[data-theme='light'\] \.player-video-controls[\s\S]{0,180}#f8fafc/)
})

test('long media titles are constrained inside the player top bar', () => {
  const workbench = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'Workbench.tsx'), 'utf8')
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.css'), 'utf8')
  assert.match(workbench, /<strong>\{rightOpen \? mediaName \|\| '[^']+'/)
  assert.match(css, /\.workspace-topbar\s*\{[\s\S]{0,160}grid-template-columns:\s*minmax\(0, 1fr\) auto minmax\(44px, 1fr\)/)
  assert.match(css, /\.workspace-topbar-title > div\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1;/)
  assert.match(css, /\.workspace-topbar-title span, \.workspace-topbar-title strong\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/)
})

test('player canvas is a bounded flex container so bottom controls stay in the viewport', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.css'), 'utf8')
  const player = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PlayerView.tsx'), 'utf8')
  assert.match(css, /\.workspace-focus-body\s*\{[^}]*min-height:\s*0;[^}]*flex:\s*1;/)
  assert.match(css, /\.workspace-focus-canvas\s*\{[^}]*display:\s*flex;[^}]*height:\s*100%;[^}]*flex:\s*1\.7;/)
  assert.match(css, /\.workspace-theater\s*\{[^}]*display:\s*flex;[^}]*min-width:\s*0;[^}]*min-height:\s*0;/)
  assert.match(player, /className=\{`[^`]*w-full[^`]*h-full[^`]*min-w-0[^`]*min-h-0[^`]*overflow-hidden/)
})

test('global keyboard shortcuts accept Window or Document targets without crashing', () => {
  const player = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PlayerView.tsx'), 'utf8')
  assert.match(player, /target instanceof Element && target\.matches\(/)
  assert.doesNotMatch(player, /const target = event\.target as HTMLElement \| null[\s\S]{0,100}target\?\.matches/)
})

test('mpv reapplies complete-fit policy after every file load and full-screen remeasures its container', () => {
  const player = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PlayerView.tsx'), 'utf8')
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  for (const newline of ['\n', '\r\n']) {
    const source = player.replace(/\r?\n/g, newline)
    const callback = source.match(/player\.loadFile\(videoSrc\)\.then\((\(loaded\) => \{[\s\S]*?\})\)\r?\n\s*player\.showContainer/)
    assert.ok(callback, 'load callback is wired before showing the container')
    const modes = []
    const applyLoaded = require('node:vm').runInNewContext(`(${callback[1]})`, {
      player: { setPictureMode: value => modes.push(value), setVolume: () => {}, seek: () => {}, play: () => {} },
      usePlayerStore: { getState: () => ({ pictureMode: 'fit' }) }, volume: 50, currentTime: 0, isPlaying: false,
    })
    applyLoaded(false)
    assert.deepEqual(modes, [])
    applyLoaded(true)
    assert.deepEqual(modes, ['fit'])
  }
  assert.match(main, /enter-full-screen[\s\S]{0,180}mpv:remeasure/)
  assert.match(main, /leave-full-screen[\s\S]{0,180}mpv:remeasure/)
})
