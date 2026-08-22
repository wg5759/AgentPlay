const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { compileShiftSubtitlesDecisionList, planEditInstruction, resolveEditClarification } = require('../electron/media-edit-decision')
const { MediaEditService } = require('../electron/media-edit-service')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'useMediaCreativeTasks.ts'), 'utf8')
const runtime = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'usePersistentTaskRuntime.ts'), 'utf8')
const quality = fs.readFileSync(path.join(__dirname, '..', 'electron', 'task-result-quality.js'), 'utf8')

const SOURCE = 'D:/视频/纪录片.mp4'

test('shift-subtitles decision: path+direction+offset compiles, clarifications close, consultation stays out', () => {
  const later = compileShiftSubtitlesDecisionList({ instruction: '把字幕 D:/视频/字幕.srt 延后 2 秒', sourcePath: SOURCE })
  assert.equal(later.kind, 'media.shift-subtitles')
  assert.equal(later.subtitle.path, 'D:/视频/字幕.srt')
  assert.equal(later.shift.direction, 'later')
  assert.equal(later.shift.offsetSeconds, 2)
  assert.equal(later.output.overwrite, false)
  assert.match(later.output.suffix, /调时版-延后/)

  const earlier = compileShiftSubtitlesDecisionList({ instruction: '字幕 D:/视频/字幕.srt 整体提前 0.5 秒', sourcePath: SOURCE })
  assert.equal(earlier.shift.direction, 'earlier')
  assert.equal(earlier.shift.offsetSeconds, 0.5)
  assert.match(earlier.output.suffix, /调时版-提前/)

  // 没有字幕语境但给了 .srt 路径也算无歧义（路径本身即字幕指代）；没有动词/路径/秒数则不形成决策
  const viaPathOnly = compileShiftSubtitlesDecisionList({ instruction: '把 D:/视频/字幕.srt 延后 2 秒', sourcePath: SOURCE })
  assert.equal(viaPathOnly?.kind, 'media.shift-subtitles')
  assert.equal(compileShiftSubtitlesDecisionList({ instruction: '把字幕 D:/视频/字幕.srt 移动 2 秒', sourcePath: SOURCE }), null)
  assert.equal(compileShiftSubtitlesDecisionList({ instruction: '把字幕延后 2 秒', sourcePath: SOURCE }), null)
  assert.equal(compileShiftSubtitlesDecisionList({ instruction: '把字幕 D:/视频/字幕.srt 延后', sourcePath: SOURCE }), null)
  // 本切片只收 .srt
  assert.equal(compileShiftSubtitlesDecisionList({ instruction: '把字幕 D:/视频/字幕.ass 延后 2 秒', sourcePath: SOURCE }), null)

  // 缺文件：追问文件
  const noFile = planEditInstruction({ instruction: '把字幕延后 2 秒', sourcePath: SOURCE })
  assert.equal(noFile.clarification?.reason, 'missing-subtitle-file')
  const resolvedFile = resolveEditClarification({ clarification: noFile.clarification, answer: 'D:/视频/字幕.srt' })
  assert.equal(resolvedFile.decision?.kind, 'media.shift-subtitles')
  assert.equal(resolvedFile.decision?.shift.direction, 'later')
  assert.equal(resolvedFile.decision?.shift.offsetSeconds, 2)

  // 缺秒数：追问秒数
  const noOffset = planEditInstruction({ instruction: '把字幕 D:/视频/字幕.srt 提前', sourcePath: SOURCE })
  assert.equal(noOffset.clarification?.reason, 'missing-offset')
  const resolvedOffset = resolveEditClarification({ clarification: noOffset.clarification, answer: '1.5 秒' })
  assert.equal(resolvedOffset.decision?.shift.direction, 'earlier')
  assert.equal(resolvedOffset.decision?.shift.offsetSeconds, 1.5)

  // 原句文件和秒数都缺：先问文件，给完文件继续只问秒数
  const bare = planEditInstruction({ instruction: '把字幕提前一点', sourcePath: SOURCE })
  assert.equal(bare.clarification?.reason, 'missing-subtitle-file')
  const chained = resolveEditClarification({ clarification: bare.clarification, answer: 'D:/视频/字幕.srt' })
  assert.equal(chained.clarification?.reason, 'missing-offset')
  const done = resolveEditClarification({ clarification: chained.clarification, answer: '2 秒' })
  assert.equal(done.decision?.kind, 'media.shift-subtitles')

  // 询问句不误执行
  assert.equal(planEditInstruction({ instruction: '能不能把字幕延后 2 秒？', sourcePath: SOURCE }).matched, false)
})

test('shift-subtitles wiring: task registered, decision routed, renderer gate accepts, quality checklist covers', () => {
  assert.match(main, /persistentTaskRuntime\.register\('media\.shift-subtitles'/)
  assert.match(main, /decision\.kind === 'media\.shift-subtitles'/)
  assert.match(main, /'media\.shift-subtitles'/)
  assert.match(main, /compileShiftSubtitlesDecisionList/)
  assert.match(main, /media\.edit-burn-subtitles' \|\| type === 'media\.edit-mux-subtitles' \|\| type === 'media\.shift-subtitles'/, '质量修复清单必须含字幕调时')
  assert.match(panel, /'media\.shift-subtitles'/)
  assert.match(panel, /字幕时间调移/)
  assert.match(panel, /isPlayableVideoPath/, '.srt 成果不得自动进播放器')
  assert.match(runtime, /media\.shift-subtitles/)
  assert.match(quality, /media\.shift-subtitles/, '质量核查必须覆盖字幕调时')
})

test('real shiftSubtitles: later/earlier shifts exact, negative cues dropped, GBK decoded, source untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shift-subtitles-'))
  try {
    const service = new MediaEditService({ frames: {} })
    const srt = path.join(dir, '字幕.srt')
    const srtBody = [
      '1\r\n00:00:01,000 --> 00:00:02,500\r\n第一条字幕\r\n',
      '2\r\n00:00:03,000 --> 00:00:04,000\r\n第二条\r\n换行文本\r\n',
      '3\r\n00:00:05,500 --> 00:00:06,000\r\n第三条\r\n'
    ].join('\r\n')
    fs.writeFileSync(srt, srtBody, 'utf8')
    const before = fs.statSync(srt)

    // 延后 2 秒：每条 +2000ms，条目数不变
    const laterOut = path.join(dir, '延后版.srt')
    const laterDecision = compileShiftSubtitlesDecisionList({ instruction: `把字幕 ${srt} 延后 2 秒`, sourcePath: 'D:/视频/x.mp4' })
    const later = await service.shiftSubtitles({ sourcePath: srt, outputPath: laterOut, decision: laterDecision })
    assert.equal(later.cueCount, 3)
    assert.equal(later.droppedCueCount, 0)
    const laterText = fs.readFileSync(laterOut, 'utf8')
    assert.match(laterText, /00:00:03,000 --> 00:00:04,500/)
    assert.match(laterText, /00:00:05,000 --> 00:00:06,000/)
    assert.match(laterText, /00:00:07,500 --> 00:00:08,000/)
    assert.match(laterText, /第二条\r?\n换行文本/, '多行文本必须保留')

    // 提前 2 秒：第一条起点被钳到 0（-1.0→0.5 仍存活），无丢弃
    const earlierOut = path.join(dir, '提前版.srt')
    const earlierDecision = compileShiftSubtitlesDecisionList({ instruction: `把字幕 ${srt} 提前 2 秒`, sourcePath: 'D:/视频/x.mp4' })
    const earlier = await service.shiftSubtitles({ sourcePath: srt, outputPath: earlierOut, decision: earlierDecision })
    assert.equal(earlier.cueCount, 3)
    assert.equal(earlier.droppedCueCount, 0)
    const earlierText = fs.readFileSync(earlierOut, 'utf8')
    assert.match(earlierText, /00:00:00,000 --> 00:00:00,500/, '第一条应钳到 0 起点')
    assert.match(earlierText, /00:00:01,000 --> 00:00:02,000/)
    assert.match(earlierText, /00:00:03,500 --> 00:00:04,000/)

    // 提前 4 秒：第一、二条整体移到 0 点前丢弃（含 end 恰好到 0），第三条存活
    const clampOut = path.join(dir, '钳位版.srt')
    const clampDecision = compileShiftSubtitlesDecisionList({ instruction: `把字幕 ${srt} 提前 4 秒`, sourcePath: 'D:/视频/x.mp4' })
    const clamped = await service.shiftSubtitles({ sourcePath: srt, outputPath: clampOut, decision: clampDecision })
    assert.equal(clamped.cueCount, 1)
    assert.equal(clamped.droppedCueCount, 2)
    const clampText = fs.readFileSync(clampOut, 'utf8')
    assert.ok(!clampText.includes('第一条') && !clampText.includes('第二条'), '移出 0 点的条目必须丢弃')
    assert.match(clampText, /00:00:01,500 --> 00:00:02,000/)
    assert.match(clampText, /^1\r?\n00:00:01,500/, '存活条目必须重新编号为 1')

    // GBK 编码源：能解码且文本不乱码
    const gbkPath = path.join(dir, 'gbk字幕.srt')
    // “中文字幕内容”的 GBK 字节（Python '...'.encode('gbk') 核算）
    const gbkCjk = [0xd6, 0xd0, 0xce, 0xc4, 0xd7, 0xd6, 0xc4, 0xbb, 0xc4, 0xda, 0xc8, 0xdd]
    const gbkBytes = []
    for (const ch of '1\n00:00:01,000 --> 00:00:02,000\n') gbkBytes.push(ch.charCodeAt(0))
    gbkBytes.push(...gbkCjk, 0x0a)
    fs.writeFileSync(gbkPath, Buffer.from(gbkBytes))
    const gbkOut = path.join(dir, 'gbk延后版.srt')
    const gbkDecision = compileShiftSubtitlesDecisionList({ instruction: `把字幕 ${gbkPath} 延后 1 秒`, sourcePath: 'D:/视频/x.mp4' })
    await service.shiftSubtitles({ sourcePath: gbkPath, outputPath: gbkOut, decision: gbkDecision })
    const gbkText = fs.readFileSync(gbkOut, 'utf8')
    assert.ok(gbkText.includes('中文字幕内容'), `GBK 源应正确解码，实际：${gbkText.slice(0, 80)}`)
    assert.match(gbkText, /00:00:02,000 --> 00:00:03,000/)

    // 全部移出 0 点：故障关闭不产出
    await assert.rejects(
      () => service.shiftSubtitles({ sourcePath: srt, outputPath: path.join(dir, '全丢版.srt'), decision: compileShiftSubtitlesDecisionList({ instruction: `把字幕 ${srt} 提前 100 秒`, sourcePath: 'D:/视频/x.mp4' }) }),
      /全部 3 条字幕都会移到 0 点之前/
    )
    // 覆盖已存在成果：故障关闭
    await assert.rejects(() => service.shiftSubtitles({ sourcePath: srt, outputPath: laterOut, decision: laterDecision }), /已存在/)
    // 非 srt/vtt：故障关闭
    const vtt = path.join(dir, 'x.ass')
    fs.writeFileSync(vtt, '[Script Info]\n')
    await assert.rejects(
      () => service.shiftSubtitles({ sourcePath: vtt, outputPath: path.join(dir, 'v.srt'), decision: { schemaVersion: 1, kind: 'media.shift-subtitles', subtitle: { path: vtt }, shift: { direction: 'later', offsetSeconds: 1 }, output: {} } }),
      /只支持 \.srt\/\.vtt/
    )
    // verify 路径（断点续跑复核）：一致通过；被篡改的成果拒绝
    const verified = await service.verify({ sourcePath: srt, outputPath: laterOut, decision: laterDecision })
    assert.equal(verified.cueCount, 3)
    fs.appendFileSync(laterOut, '4\r\n00:00:09,000 --> 00:00:10,000\r\n被加的一条\r\n', 'utf8')
    await assert.rejects(() => service.verify({ sourcePath: srt, outputPath: laterOut, decision: laterDecision }), /与冻结决策不一致/)
    // 源字幕文件始终不动
    const after = fs.statSync(srt)
    assert.deepEqual([after.size, Math.trunc(after.mtimeMs)], [before.size, Math.trunc(before.mtimeMs)])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
