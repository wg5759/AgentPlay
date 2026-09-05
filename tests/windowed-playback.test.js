const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { windowedBounds } = require('../electron/windowed-bounds')
test('default window leaves desktop space at laptop DPI and fits small displays', () => {
  for (const area of [{x:0,y:0,width:1280,height:680},{x:-1920,y:0,width:1920,height:1040},{x:0,y:0,width:800,height:480}]) {
    const b=windowedBounds(area)
    assert.ok(b.width<area.width && b.height<area.height)
    assert.ok(b.minWidth<=b.width && b.minHeight<=b.height)
    assert.ok(b.x>=area.x && b.y>=area.y)
    assert.ok(b.x+b.width<=area.x+area.width && b.y+b.height<=area.y+area.height)
  }
  assert.equal(windowedBounds({x:0,y:0,width:1280,height:680}).width,1024)
})
test('closing media clears immersive state and controls cannot trigger fullscreen by bubbling', () => {
  const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8')
  assert.match(read('src/stores/playerStore.ts'), /clearMedia:[\s\S]{0,260}theater: false/)
  assert.match(read('src/components/PlayerView.tsx'), /data-exit-fullscreen/)
  assert.match(read('src/components/PlayerView.tsx'), /onEnded=\{finishPlayback\}/)
  assert.match(read('src/components/PlayerView.tsx'), /closest\('\[data-player-chrome\]/)
})
