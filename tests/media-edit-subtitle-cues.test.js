const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { compileCueEditDecisionList, planEditInstruction, resolveEditClarification } = require('../electron/media-edit-decision')
const { MediaEditService } = require('../electron/media-edit-service')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'useMediaCreativeTasks.ts'), 'utf8')
const runtime = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'usePersistentTaskRuntime.ts'), 'utf8')
const quality = fs.readFileSync(path.join(__dirname, '..', 'electron', 'task-result-quality.js'), 'utf8')

const SOURCE = 'D:/视频/纪录片.mp4'

test('cue-edit decision: replace/delete compile with ranges, clarifications chain, video flows unaffected', () => {
  const replace = compileCueEditDecisionList({ instruction: '把字幕 D:/视频/字幕.srt 第3条改成《你好吗》', sourcePath: SOURCE })
  assert.equal(replace.kind, 'media.edit-subtitle-cues')
  assert.deepEqual(replace.cueEdit, { operation: 'replace', index: 3, text: '你好吗' })
  assert.match(replace.output.suffix, /校对版-改第3条/)

  const delOne = compileCueEditDecisionList({ instruction: '删除第3条字幕 D:/视频/字幕.srt', sourcePath: SOURCE })
  assert.deepEqual(delOne.cueEdit, { operation: 'delete', startIndex: 3, endIndex: 3 })
  const delRange = compileCueEditDecisionList({ instruction: '把字幕 D:/视频/字幕.srt 删掉第2到第4条', sourcePath: SOURCE })
  assert.deepEqual(delRange.cueEdit, { operation: 'delete', startIndex: 2, endIndex: 4 })
  const delRange2 = compileCueEditDecisionList({ instruction: '把字幕 D:/视频/字幕.srt 删掉第2条到第4条', sourcePath: SOURCE })
  assert.deepEqual(delRange2.cueEdit, { operation: 'delete', startIndex: 2, endIndex: 4 })
  // 中文数字序号
  const cn = compileCueEditDecisionList({ instruction: '把字幕 D:/视频/字幕.srt 删掉第三条', sourcePath: SOURCE })
  assert.deepEqual(cn.cueEdit, { operation: 'delete', startIndex: 3, endIndex: 3 })
  // 区间替换不支持（一次只能改一条）
  assert.equal(compileCueEditDecisionList({ instruction: '把字幕 D:/视频/字幕.srt 第2到第4条改成《x》', sourcePath: SOURCE }), null)

  // 没给文件但明说"第 N 条字幕"：追问文件而不是落到视频段追问
  const noFile = planEditInstruction({ instruction: '删掉第3条字幕', sourcePath: SOURCE })
  assert.equal(noFile.clarification?.reason, 'missing-subtitle-cueedit-file')
  const resolvedFile = resolveEditClarification({ clarification: noFile.clarification, answer: 'D:/视频/字幕.srt' })
  assert.deepEqual(resolvedFile.decision?.cueEdit, { operation: 'delete', startIndex: 3, endIndex: 3 })

  // 有文件缺序号：追问序号；删除意图直接收口
  const noIndex = planEditInstruction({ instruction: '把字幕 D:/视频/字幕.srt 删掉一些', sourcePath: SOURCE })
  assert.equal(noIndex.clarification?.reason, 'missing-cue-index')
  const resolvedIndex = resolveEditClarification({ clarification: noIndex.clarification, answer: '第2条' })
  assert.deepEqual(resolvedIndex.decision?.cueEdit, { operation: 'delete', startIndex: 2, endIndex: 2 })

  // 改文本意图：先问序号，再问文本，逐项收口
  const replaceIntent = planEditInstruction({ instruction: '把字幕 D:/视频/字幕.srt 改一下', sourcePath: SOURCE })
  assert.equal(replaceIntent.clarification?.reason, 'missing-cue-index')
  const reask = resolveEditClarification({ clarification: replaceIntent.clarification, answer: '第3条' })
  assert.match(reask.clarification?.question || '', /改成什么内容/)
  const done = resolveEditClarification({ clarification: reask.clarification, answer: '改成《新文本》' })
  assert.deepEqual(done.decision?.cueEdit, { operation: 'replace', index: 3, text: '新文本' })

  // 视频段时间流不受影响；询问句不误执行
  assert.equal(planEditInstruction({ instruction: '删除第3秒到第5秒', sourcePath: SOURCE }).decision?.kind, 'media.remove-segment')
  assert.equal(planEditInstruction({ instruction: '能不能删掉第3条字幕？', sourcePath: SOURCE }).matched, false)
})

test('cue-edit wiring: task registered, decision routed, renderer gate accepts, quality checklist covers', () => {
  assert.match(main, /persistentTaskRuntime\.register\('media\.edit-subtitle-cues'/)
  assert.match(main, /decision\.kind === 'media\.edit-subtitle-cues'/)
  assert.match(main, /'media\.edit-subtitle-cues'/)
  assert.match(main, /compileCueEditDecisionList/)
  assert.match(main, /media\.translate-subtitles' \|\| type === 'media\.edit-subtitle-cues'/, '质量修复清单必须含字幕校对')
  assert.match(panel, /'media\.edit-subtitle-cues'/)
  assert.match(panel, /字幕校对/)
  assert.match(runtime, /media\.edit-subtitle-cues/)
  assert.match(quality, /media\.edit-subtitle-cues/, '质量核查必须覆盖字幕校对')
})

test('real editSubtitleCues: replace/delete exact, renumbering, bounds fail closed, source untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-edit-'))
  try {
    const service = new MediaEditService({ frames: {} })
    const srt = path.join(dir, '字幕.srt')
    fs.writeFileSync(srt, '1\r\n00:00:01,000 --> 00:00:02,000\r\n第一条\r\n\r\n2\r\n00:00:02,500 --> 00:00:03,500\r\n第二条\r\n\r\n3\r\n00:00:04,000 --> 00:00:05,000\r\n第三条\r\n\r\n4\r\n00:00:05,500 --> 00:00:06,500\r\n第四条\r\n', 'utf8')
    const before = fs.statSync(srt)

    // 替换第 3 条
    const replaceOut = path.join(dir, '改第3条.srt')
    const replaceDecision = compileCueEditDecisionList({ instruction: `把字幕 ${srt} 第3条改成《改后的第三条》`, sourcePath: 'D:/视频/x.mp4' })
    const replaced = await service.editSubtitleCues({ sourcePath: srt, outputPath: replaceOut, decision: replaceDecision })
    assert.equal(replaced.cueCount, 4)
    const replaceText = fs.readFileSync(replaceOut, 'utf8')
    assert.ok(replaceText.includes('改后的第三条'))
    assert.ok(!replaceText.includes('\n第三条\r'), '原文本应被替换')
    assert.match(replaceText, /3\r?\n00:00:04,000 --> 00:00:05,000\r?\n改后的第三条/, '时间轴必须保持')

    // 删除第 2 到第 3 条：重新编号
    const deleteOut = path.join(dir, '删2到3.srt')
    const deleteDecision = compileCueEditDecisionList({ instruction: `把字幕 ${srt} 删掉第2到第3条`, sourcePath: 'D:/视频/x.mp4' })
    const deleted = await service.editSubtitleCues({ sourcePath: srt, outputPath: deleteOut, decision: deleteDecision })
    assert.equal(deleted.cueCount, 2)
    const deleteText = fs.readFileSync(deleteOut, 'utf8')
    assert.ok(!deleteText.includes('第二条') && !deleteText.includes('第三条'))
    assert.match(deleteText, /^1\r?\n00:00:01,000 --> 00:00:02,000\r?\n第一条/)
    assert.match(deleteText, /2\r?\n00:00:05,500 --> 00:00:06,500\r?\n第四条/, '第四条必须重新编号为 2 且时间轴不变')

    // 越界/全删/覆盖：故障关闭
    await assert.rejects(
      () => service.editSubtitleCues({ sourcePath: srt, outputPath: path.join(dir, 'x1.srt'), decision: compileCueEditDecisionList({ instruction: `把字幕 ${srt} 删掉第9条`, sourcePath: 'D:/视频/x.mp4' }) }),
      /一共 4 条/
    )
    await assert.rejects(
      () => service.editSubtitleCues({ sourcePath: srt, outputPath: path.join(dir, 'x2.srt'), decision: compileCueEditDecisionList({ instruction: `把字幕 ${srt} 删掉第1到第4条`, sourcePath: 'D:/视频/x.mp4' }) }),
      /至少保留一条/
    )
    await assert.rejects(() => service.editSubtitleCues({ sourcePath: srt, outputPath: replaceOut, decision: replaceDecision }), /已存在/)
    // verify 路径：一致通过；被篡改的成果拒绝
    const verified = await service.verify({ sourcePath: srt, outputPath: replaceOut, decision: replaceDecision })
    assert.equal(verified.cueCount, 4)
    fs.appendFileSync(replaceOut, '5\r\n00:00:07,000 --> 00:00:08,000\r\n多加一条\r\n', 'utf8')
    await assert.rejects(() => service.verify({ sourcePath: srt, outputPath: replaceOut, decision: replaceDecision }), /与冻结决策不一致/)
    // 源字幕文件始终不动
    const after = fs.statSync(srt)
    assert.deepEqual([after.size, Math.trunc(after.mtimeMs)], [before.size, Math.trunc(before.mtimeMs)])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
