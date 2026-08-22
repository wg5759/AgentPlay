const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { compileShiftSubtitlesDecisionList, compileCueEditDecisionList } = require('../electron/media-edit-decision')
const { MediaEditService } = require('../electron/media-edit-service')

const SOURCE = 'D:/视频/纪录片.mp4'

test('vtt decision: shift and cue-edit compile with container vtt', () => {
  const shift = compileShiftSubtitlesDecisionList({ instruction: '把字幕 D:/视频/字幕.vtt 延后 2 秒', sourcePath: SOURCE })
  assert.equal(shift.kind, 'media.shift-subtitles')
  assert.equal(shift.subtitle.path, 'D:/视频/字幕.vtt')
  assert.equal(shift.output.container, 'vtt')
  const edit = compileCueEditDecisionList({ instruction: '把字幕 D:/视频/字幕.vtt 删掉第2条', sourcePath: SOURCE })
  assert.equal(edit.kind, 'media.edit-subtitle-cues')
  assert.equal(edit.output.container, 'vtt')
  // srt 路径保持 srt 容器
  assert.equal(compileShiftSubtitlesDecisionList({ instruction: '把字幕 D:/视频/字幕.srt 延后 2 秒', sourcePath: SOURCE }).output.container, 'srt')
})

test('real vtt shift + cue edit: both time forms parsed, output stays valid vtt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtt-edit-'))
  try {
    const service = new MediaEditService({ frames: {} })
    const vtt = path.join(dir, '字幕.vtt')
    // 混合两种合法写法：省略小时的 MM:SS.mmm 与完整 HH:MM:SS.mmm；含 cue 标识行
    fs.writeFileSync(vtt, 'WEBVTT\n\n1\n00:01.000 --> 00:02.500\n第一条 VTT\n\ncue-2\n00:00:03.000 --> 00:00:04.000\n第二条\n换行\n', 'utf8')
    const before = fs.statSync(vtt)

    // 延后 2 秒
    const shiftOut = path.join(dir, '调时版.vtt')
    const shiftDecision = compileShiftSubtitlesDecisionList({ instruction: `把字幕 ${vtt} 延后 2 秒`, sourcePath: 'D:/视频/x.mp4' })
    const shifted = await service.shiftSubtitles({ sourcePath: vtt, outputPath: shiftOut, decision: shiftDecision })
    assert.equal(shifted.cueCount, 2)
    const shiftText = fs.readFileSync(shiftOut, 'utf8')
    assert.ok(shiftText.startsWith('WEBVTT'), '成果必须保留 WEBVTT 头')
    assert.match(shiftText, /00:00:03\.000 --> 00:00:04\.500/, '第一条（原无小时写法）应 +2s 且输出完整小时形式')
    assert.match(shiftText, /00:00:05\.000 --> 00:00:06\.000/)
    assert.match(shiftText, /第二条\r?\n换行/, '多行文本保留')

    // 删除第 1 条
    const editOut = path.join(dir, '校对版.vtt')
    const editDecision = compileCueEditDecisionList({ instruction: `把字幕 ${vtt} 删掉第1条`, sourcePath: 'D:/视频/x.mp4' })
    const edited = await service.editSubtitleCues({ sourcePath: vtt, outputPath: editOut, decision: editDecision })
    assert.equal(edited.cueCount, 1)
    const editText = fs.readFileSync(editOut, 'utf8')
    assert.ok(editText.startsWith('WEBVTT'))
    assert.ok(!editText.includes('第一条 VTT'))
    assert.match(editText, /00:00:03\.000 --> 00:00:04\.000/)

    // verify 路径
    const verified = await service.verify({ sourcePath: vtt, outputPath: shiftOut, decision: shiftDecision })
    assert.equal(verified.cueCount, 2)
    // 源文件不动
    const after = fs.statSync(vtt)
    assert.deepEqual([after.size, Math.trunc(after.mtimeMs)], [before.size, Math.trunc(before.mtimeMs)])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
