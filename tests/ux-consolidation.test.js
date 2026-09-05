const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { agentPanelSource } = require('./helpers/agent-panel-source')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
const panel = agentPanelSource()
const sidebar = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'Sidebar.tsx'), 'utf8')
const library = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'MediaLibrary.tsx'), 'utf8')
const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8')

test('first-run automation delegates both core packs to verified recoverable installation', () => {
  assert.match(main, /first-run-components\.json/)
  assert.match(main, /void ensureFirstRunComponents\(\{/)
  assert.match(main, /service: whisperDownload/)
  assert.match(main, /service: ytdlpDownload/)
  const recovery = fs.readFileSync(path.join(__dirname, '../electron/first-run-components.js'), 'utf8')
  assert.match(recovery, /item\.service\.start\(\{\}\)/)
  assert.match(recovery, /item\.service\.status\(\)\.installed/)
  assert.match(recovery, /nextRetryAt/)
  assert.doesNotMatch(recovery, /attempts \|\| 0\) >= 3/)
  assert.match(main, /首启自动化/)
})

test('video compress/remux: target bitrate from duration, never overwrites source', () => {
  assert.match(main, /ipcMain\.handle\('media:compress'/)
  assert.match(main, /AgentPlay\$\{mode === 'remux' \? '转码' : '压缩'\}版/)
  assert.match(main, /'-c', 'copy'/)
  assert.match(main, /libx264/)
  assert.match(main, /targetMb \* 8 \* 1024/)
  assert.match(preload, /mediaTools/)
  assert.match(panel, /runCompressTask/)
  assert.match(panel, /压到|压缩/)
  assert.match(panel, /转码/)
})

test('declutter: computer-observe and analysis-studio entries retired, cast advanced folded', () => {
  assert.ok(!sidebar.includes('电脑观察'), '左栏不应再有电脑观察入口')
  assert.ok(!app.includes('AnalysisStudio'), 'App 不应再渲染 AnalysisStudio')
  // analysis-studio 动作改走对话流
  assert.match(app, /分析工作室退役/)
  assert.match(main, /拉片（AI 对话解剖）/)
  // 高级设备功能折叠
  assert.match(library, /showAdvanced/)
  assert.match(library, /高级设备功能（WiFi 传文件 · 互投 · 同步 · DLNA）/)
})
