const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { agentPanelSource } = require('./helpers/agent-panel-source')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
const guide = fs.readFileSync(path.join(__dirname, '..', 'electron', 'screen-guide-service.js'), 'utf8')
const agentPanel = agentPanelSource()
const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8')
const workbench = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'Workbench.tsx'), 'utf8')
const playerView = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PlayerView.tsx'), 'utf8')
const playerControls = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PlayerControls.tsx'), 'utf8')
const playerStore = fs.readFileSync(path.join(__dirname, '..', 'src', 'stores', 'playerStore.ts'), 'utf8')
const indexCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.css'), 'utf8')
const tailwind = fs.readFileSync(path.join(__dirname, '..', 'tailwind.config.cjs'), 'utf8')

test('screen guide: screenshot to vision model, normalized marks clamped to 0-1000', () => {
  assert.match(guide, /desktopCapturer\.getSources/)
  assert.match(guide, /image_url/)
  assert.match(guide, /clampCoord/)
  assert.match(guide, /Math\.max\(0, Math\.min\(1000/)
  assert.match(guide, /400, 415, 422/)
  assert.match(guide, /不支持看图/)
})

test('screen guide: overlay is transparent, click-through and auto-dismisses; IPC trusted', () => {
  assert.match(main, /transparent: true/)
  assert.match(main, /setIgnoreMouseEvents\(true, \{ forward: true \}\)/)
  assert.match(main, /setTimeout\(dismissGuideOverlay, durationMs\)/)
  assert.match(main, /ipcMain\.handle\('guide:annotate'/)
  assert.match(main, /ipcMain\.handle\('guide:dismiss'/)
  assert.match(preload, /guide: \{/)
  assert.match(preload, /annotate: \(question\) => ipcRenderer\.invoke\('guide:annotate', question\)/)
  assert.match(agentPanel, /屏幕指路/)
  assert.match(agentPanel, /UiIcon name="target"/)
})

test('global hotkey wakes app with voice input; unregistered on quit', () => {
  assert.match(main, /globalShortcut\.register\('CmdOrCtrl\+Shift\+A'/)
  assert.match(main, /'menu:action', 'agent-voice'/)
  assert.match(main, /app\.on\('will-quit'/)
  assert.match(main, /globalShortcut\.unregisterAll\(\)/)
  assert.match(app, /action === 'agent-voice'/)
  assert.match(app, /store\.toggleListening\(\)/)
})

test('theater mode: panes collapse, double-click and Esc enter/exit, controls button wired', () => {
  assert.match(playerStore, /theater: boolean/)
  assert.match(playerStore, /setTheater/)
  assert.match(workbench, /state\) => state\.theater/)
  assert.match(workbench, /theater \? ' workspace-theater'/)
  assert.doesNotMatch(workbench, /if \(theater\) return/)
  assert.match(playerView, /toggleTheaterMode/)
  assert.match(playerView, /event\.key !== 'Escape'/)
  assert.match(playerView, /onFullscreenChanged\(\(fullscreen\)[\s\S]{0,420}theater:\s*fullscreen \? state\.theater : false/)
  assert.match(playerControls, /state\.setTheater\(next\)/)
})

test('frame ask: current video frame goes to vision model, answer returns to chat', () => {
  assert.match(main, /ipcMain\.handle\('guide:askFrame'/)
  assert.match(main, /mpv\.screenshot\(tmpShot\)/)
  assert.match(main, /fsPromises\.unlink\(tmpShot\)/)
  assert.match(guide, /askAboutImage/)
  assert.match(preload, /askFrame: \(input\) => ipcRenderer\.invoke\('guide:askFrame', input\)/)
  assert.match(playerView, /💬 问这帧/)
  assert.match(playerView, /正在看这一帧…/)
})

test('chat video-gen intent routes to Agnes generateVideo and auto-plays result', () => {
  assert.match(agentPanel, /const VIDEO_GENERATION_INTENT/)
  assert.match(agentPanel, /isVideoGenerationIntent/)
  assert.match(agentPanel, /studio\?\.generateVideo/)
  assert.match(agentPanel, /AI 生成视频/)
  assert.match(agentPanel, /ai-player-play-file/)
})

test('four themes live in css variables and style the control layer', () => {
  for (const theme of ['glass', 'light', 'cyber', 'amber']) {
    assert.ok(indexCss.includes(`[data-theme='${theme}']`), `缺主题：${theme}`)
  }
  assert.match(indexCss, /--player-accent2/)
  assert.match(indexCss, /linear-gradient\(135deg, rgb\(var\(--player-accent\)\), rgb\(var\(--player-accent2\)\)\)/)
  assert.match(tailwind, /rgb\(var\(--player-bg\) \/ <alpha-value>\)/)
})
