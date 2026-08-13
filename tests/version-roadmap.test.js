const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const roadmap = fs.readFileSync(path.join(__dirname, '..', 'ROADMAP.md'), 'utf8')

function section(start, end) {
  const startAt = roadmap.indexOf(start)
  assert.notEqual(startAt, -1, `missing roadmap section: ${start}`)
  const endAt = end ? roadmap.indexOf(end, startAt + start.length) : roadmap.length
  assert.notEqual(endAt, -1, `missing roadmap boundary: ${end}`)
  return roadmap.slice(startAt, endAt)
}

function checkboxCount(content, checked) {
  const marker = checked ? 'x' : ' '
  return (content.match(new RegExp(`^- \\[${marker}\\] `, 'gm')) || []).length
}

test('0.8.0 is feature-frozen while signed public release remains incomplete', () => {
  const content = section('### 0.8.0 冻结与发布收尾', '### 0.9.0：')
  assert.match(content, /功能开发完成率：\*\*100%（已冻结）\*\*/)
  assert.match(content, /稳定公开发布闭环：\*\*50%（3\/6）\*\*/)
  assert.equal(checkboxCount(content, true), 3)
  assert.equal(checkboxCount(content, false), 3)
  assert.match(content, /SignPath/)
  assert.match(content, /不得把未签名候选写成稳定公开版/)
})

test('0.9.0 owns the usable conversational media editor v1 with 25 open acceptance items', () => {
  const content = section('### 0.9.0：', '### 0.9.1：')
  assert.match(content, /功能交付完成率：\*\*0%（0\/25）\*\*/)
  assert.equal(checkboxCount(content, true), 5, 'only the reusable foundations may be checked')
  assert.equal(checkboxCount(content, false), 25)
  assert.match(content, /EditDecisionList v1/)
  assert.match(content, /第 4 秒到第 20 秒/)
  assert.match(content, /合法公版\/授权录音/)
  assert.match(content, /不得擅自下载商业录音/)
  assert.match(content, /轻量时间线回执、预览、撤销/)
})

test('0.9.1 keeps professional semantic and multitrack editing behind the v1 dependency', () => {
  const content = section('### 0.9.1：', '### 0.9.2 ')
  assert.match(content, /功能交付完成率：\*\*0%（0\/25）\*\*/)
  assert.equal(checkboxCount(content, true), 0)
  assert.equal(checkboxCount(content, false), 25)
  assert.match(content, /删掉废话、停顿、重复和跑题段落/)
  assert.match(content, /多轨对白、音乐、环境声和音效/)
  assert.match(content, /个人编辑 Skill/)
  assert.match(content, /不以复刻剪映全部界面为目标/)
})

test('roadmap reflects the current public source and stable release boundary', () => {
  assert.doesNotMatch(roadmap, /本轮尚未推送或公开发布/)
  assert.doesNotMatch(roadmap, /0\.7\.6` 公开发布仍需完成/)
  assert.match(roadmap, /源码已通过 PR #16 合入公开 `master`/)
  assert.match(roadmap, /`0\.7\.6` 已完成公开 Release/)
})
