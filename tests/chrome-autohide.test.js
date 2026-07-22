const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const policyPromise = import('../src/player-ui-policy.mjs')

test('mouse wake threshold ignores sub-pixel/optical jitter but honours real movement', async () => {
  const { isRealMouseActivity } = await policyPromise
  assert.equal(isRealMouseActivity(null, { x: 10, y: 10 }), true)
  assert.equal(isRealMouseActivity({ x: 100, y: 100 }, { x: 101, y: 100 }), false)
  assert.equal(isRealMouseActivity({ x: 100, y: 100 }, { x: 102, y: 101 }), false)
  assert.equal(isRealMouseActivity({ x: 100, y: 100 }, { x: 104, y: 100 }), true)
  assert.equal(isRealMouseActivity({ x: 100, y: 100 }, { x: 100, y: 96 }), true)
  assert.equal(isRealMouseActivity({ x: 100, y: 100 }, { x: 103, y: 103 }, 4), false) // 单轴均未超阈
})

test('auto hide policy unchanged: only while playing and unblocked', async () => {
  const { PLAYER_CHROME_HIDE_DELAY_MS, PLAYER_MOUSE_WAKE_THRESHOLD_PX, shouldAutoHideControls } = await policyPromise
  assert.equal(PLAYER_CHROME_HIDE_DELAY_MS, 3000)
  assert.ok(PLAYER_MOUSE_WAKE_THRESHOLD_PX >= 3 && PLAYER_MOUSE_WAKE_THRESHOLD_PX <= 8)
  assert.equal(shouldAutoHideControls({ hasMedia: true, playing: true }), true)
  assert.equal(shouldAutoHideControls({ hasMedia: true, playing: false }), false)
  assert.equal(shouldAutoHideControls({ hasMedia: true, playing: true, blocked: true }), false)
  assert.equal(shouldAutoHideControls({ hasMedia: false, playing: true }), false)
})

test('player view routes mousemove through the jitter threshold and closes subtitle panel after tasks', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PlayerView.tsx'), 'utf8')
  assert.match(view, /onMouseMove=\{handleMouseMove\}/)
  assert.match(view, /isRealMouseActivity\(last, next\)/)
  assert.doesNotMatch(view, /onMouseMove=\{handleUserActivity\}/)
  // 离开控件区域只重新武装隐藏计时、不强制显示，否则隐藏瞬间 pointerleave 会再显示形成抖动循环
  assert.match(view, /onInteractionEnd={scheduleAutoHide}/)
  assert.match(view, /onPointerLeave={scheduleAutoHide}/)
  assert.doesNotMatch(view, /onPointerLeave={handleUserActivity}/)
  // 菜单栏只随有无媒体切换，不随控制栏显隐：显隐改变客户区高度会把按钮挪到静止光标下形成循环
  assert.match(view, /setPlaybackChromeVisible\(!isMedia\)/)
  assert.doesNotMatch(view, /setPlaybackChromeVisible\(controlsVisible/)
  // 点击控制控件后必须立即归还焦点，否则隐藏计时到点看到焦点在控制区会永久放弃隐藏
  assert.match(view, /onClickCapture=\{releaseChromeFocus\}/)
  assert.match(view, /onPointerUpCapture=\{releaseChromeFocus\}/)
  assert.match(view, /\]\ button, \[data-player-chrome="true"\]\ input, \[data-player-chrome="true"\]\ select/)
  // 双语生成/实时翻译成功后必须关闭字幕面板，否则 blocked 永远为真、控制栏永不隐藏
  const bilingualBlock = view.slice(view.indexOf('const generateBilingual'), view.indexOf('const liveRequestIdRef'))
  assert.match(bilingualBlock, /setSubtitlePanelOpen\(false\)/)
  const liveBlock = view.slice(view.indexOf('const toggleLiveTranslate'), view.indexOf('useEffect(() => {\n    if (!liveSub) return'))
  assert.match(liveBlock, /setSubtitlePanelOpen\(false\)/)
})
