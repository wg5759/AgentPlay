const test = require('node:test')
const assert = require('node:assert/strict')

const { compileEditDecisionList, compileEditHistoryAction, planEditInstruction, resolveEditClarification, portableBasename } = require('../electron/media-edit-decision')

test('edit decision source names are stable across Windows and POSIX runners', () => {
  assert.equal(portableBasename('D:\\Videos\\source.mp4'), 'source.mp4')
  assert.equal(portableBasename('/mnt/videos/source.mp4'), 'source.mp4')
})

test('explicit Chinese trim instruction compiles to a frozen 16-second timeline', () => {
  const decision = compileEditDecisionList({
    instruction: '我想要第四秒到第20秒的这段视频',
    sourcePath: 'D:\\Videos\\source.mp4'
  })

  assert.equal(decision.schemaVersion, 1)
  assert.equal(decision.kind, 'media.trim')
  assert.equal(decision.source.path, 'D:\\Videos\\source.mp4')
  assert.deepEqual(decision.timeline, {
    startSeconds: 4,
    endSeconds: 20,
    durationSeconds: 16
  })
  assert.deepEqual(decision.operations, [{
    type: 'trim',
    sourceStartSeconds: 4,
    sourceEndSeconds: 20,
    targetStartSeconds: 0
  }])
  assert.equal(decision.output.overwrite, false)
})

test('consultation, negation and examples never become executable edit decisions', () => {
  for (const instruction of [
    '能不能截取第4秒到第20秒？',
    '不要截取第4秒到第20秒',
    '比如说保留第4秒到第20秒',
    '如果我说“保留第4秒到第20秒”，你能做到吗？',
    '我想了解第4秒到第20秒发生了什么',
    '帮我看看第4秒到第20秒讲了什么'
  ]) {
    assert.equal(compileEditDecisionList({ instruction, sourcePath: 'D:\\Videos\\source.mp4' }), null, instruction)
  }

})

test('ambiguous or invalid ranges stay in conversation instead of guessing', () => {
  for (const instruction of [
    '帮我剪一下这个视频',
    '保留第4秒之后',
    '保留第20秒到第4秒',
    '保留第4秒到第4秒'
  ]) {
    assert.equal(compileEditDecisionList({ instruction, sourcePath: 'D:\\Videos\\source.mp4' }), null, instruction)
  }

})

test('an edit missing only its end time asks one targeted question without creating a decision', () => {
  const plan = planEditInstruction({
    instruction: '保留第4秒之后',
    sourcePath: 'D:\\Videos\\source.mp4'
  })

  assert.equal(plan.matched, true)
  assert.equal(plan.decision, undefined)
  assert.deepEqual(plan.clarification, {
    schemaVersion: 1,
    kind: 'media.edit-clarification',
    reason: 'missing-end',
    question: '要保留到第几秒？',
    originalInstruction: '保留第4秒之后',
    sourcePath: 'D:\\Videos\\source.mp4',
    known: { operation: 'trim', startSeconds: 4 }
  })
})

test('the next short answer completes the pending edit into the same frozen decision format', () => {
  const pending = planEditInstruction({
    instruction: '保留第4秒之后',
    sourcePath: 'D:\\Videos\\source.mp4'
  }).clarification
  const resolved = resolveEditClarification({ clarification: pending, answer: '到第20秒' })

  assert.equal(resolved.matched, true)
  assert.equal(resolved.decision.kind, 'media.trim')
  assert.deepEqual(resolved.decision.timeline, { startSeconds: 4, endSeconds: 20, durationSeconds: 16 })
  assert.equal(resolved.decision.instruction, '保留第4秒到第20秒')
})

test('an edit missing its start asks only for the start and resolves a remove action', () => {
  const plan = planEditInstruction({ instruction: '删除到第20秒', sourcePath: 'D:\\Videos\\source.mp4' })
  assert.equal(plan.matched, true)
  assert.equal(plan.clarification.reason, 'missing-start')
  assert.equal(plan.clarification.question, '从第几秒开始删除？')

  const resolved = resolveEditClarification({ clarification: plan.clarification, answer: '从第4秒开始' })
  assert.equal(resolved.decision.kind, 'media.remove-segment')
  assert.deepEqual(resolved.decision.timeline, { startSeconds: 4, endSeconds: 20, removedDurationSeconds: 16 })
})

test('a timed edit without an operation asks whether to keep or remove that range', () => {
  const plan = planEditInstruction({ instruction: '处理第4秒到第20秒', sourcePath: 'D:\\Videos\\source.mp4' })
  assert.equal(plan.matched, true)
  assert.equal(plan.clarification.reason, 'missing-operation')
  assert.equal(plan.clarification.question, '第4–20秒要保留还是删除？')

  const resolved = resolveEditClarification({ clarification: plan.clarification, answer: '删除' })
  assert.equal(resolved.decision.kind, 'media.remove-segment')
  assert.deepEqual(resolved.decision.timeline, { startSeconds: 4, endSeconds: 20, removedDurationSeconds: 16 })
})

test('multiple kept ranges without a join instruction ask once before preserving spoken order', () => {
  const plan = planEditInstruction({
    instruction: '保留第0秒到第4秒和第8秒到第12秒',
    sourcePath: 'D:\\Videos\\source.mp4'
  })
  assert.equal(plan.matched, true)
  assert.equal(plan.clarification.reason, 'confirm-join-order')
  assert.equal(plan.clarification.question, '按你刚才说的顺序，把这2段拼成一个新视频吗？')

  const resolved = resolveEditClarification({ clarification: plan.clarification, answer: '按这个顺序拼接' })
  assert.equal(resolved.decision.kind, 'media.concat-segments')
  assert.deepEqual(resolved.decision.timeline.segments.map((segment) => [segment.sourceStartSeconds, segment.sourceEndSeconds]), [[0, 4], [8, 12]])
})

test('a clear request to edit without any time range asks for exactly one range', () => {
  const plan = planEditInstruction({ instruction: '帮我剪一下这个视频', sourcePath: 'D:\\Videos\\source.mp4' })
  assert.equal(plan.matched, true)
  assert.equal(plan.clarification.reason, 'missing-range')
  assert.equal(plan.clarification.question, '要保留哪一段？请告诉我开始和结束时间。')

  const resolved = resolveEditClarification({ clarification: plan.clarification, answer: '第4秒到第20秒' })
  assert.equal(resolved.decision.kind, 'media.trim')
  assert.deepEqual(resolved.decision.timeline, { startSeconds: 4, endSeconds: 20, durationSeconds: 16 })
  assert.deepEqual(planEditInstruction({ instruction: '处理一下这个视频', sourcePath: 'D:\\Videos\\source.mp4' }), { matched: false })
})

test('a pending edit can be cancelled, while unrelated text is released back to normal conversation', () => {
  const pending = planEditInstruction({ instruction: '保留第4秒之后', sourcePath: 'D:\\Videos\\source.mp4' }).clarification
  assert.deepEqual(resolveEditClarification({ clarification: pending, answer: '算了' }), { matched: true, cancelled: true })
  assert.deepEqual(resolveEditClarification({ clarification: pending, answer: '这个视频讲了什么' }), { matched: false })

  const replacement = resolveEditClarification({ clarification: pending, answer: '改成保留第8秒到第12秒' })
  assert.deepEqual(replacement.decision.timeline, { startSeconds: 8, endSeconds: 12, durationSeconds: 4 })
})

test('an invalid time answer repeats the same missing field instead of guessing or starting a task', () => {
  const pending = planEditInstruction({ instruction: '保留第4秒之后', sourcePath: 'D:\\Videos\\source.mp4' }).clarification
  const result = resolveEditClarification({ clarification: pending, answer: '到第2秒' })
  assert.equal(result.matched, true)
  assert.equal(result.decision, undefined)
  assert.equal(result.clarification.reason, 'missing-end')
  assert.equal(result.clarification.question, '结束时间要晚于第4秒，请重新告诉我结束时间。')

  const missingStart = planEditInstruction({ instruction: '删除到第20秒', sourcePath: 'D:\\Videos\\source.mp4' }).clarification
  const invalidStart = resolveEditClarification({ clarification: missingStart, answer: '从第25秒开始' })
  assert.equal(invalidStart.matched, true)
  assert.equal(invalidStart.clarification.reason, 'missing-start')
  assert.equal(invalidStart.clarification.question, '开始时间要早于第20秒，请重新告诉我开始时间。')
})

test('a join clarification accepts reversing the two spoken segments without another question', () => {
  const pending = planEditInstruction({
    instruction: '保留第0秒到第4秒和第8秒到第12秒',
    sourcePath: 'D:\\Videos\\source.mp4'
  }).clarification
  const result = resolveEditClarification({ clarification: pending, answer: '反过来拼' })
  assert.deepEqual(result.decision.timeline.segments.map((segment) => [segment.sourceStartSeconds, segment.sourceEndSeconds]), [[8, 12], [0, 4]])
})

test('only an explicit undo or redo command becomes an edit-history action', () => {
  assert.deepEqual(compileEditHistoryAction('撤销刚才的剪辑'), { action: 'undo', instruction: '撤销刚才的剪辑' })
  assert.deepEqual(compileEditHistoryAction('重做刚才撤销的剪辑'), { action: 'redo', instruction: '重做刚才撤销的剪辑' })
  for (const instruction of ['能不能撤销刚才的剪辑？', '不要撤销', '比如说撤销上一步', '撤销下载任务', '重新剪辑第4秒到第20秒']) {
    assert.equal(compileEditHistoryAction(instruction), null, instruction)
  }
})

test('an explicit remove-range command compiles to one removed timeline segment', () => {
  const decision = compileEditDecisionList({
    instruction: '删除第4秒到第20秒',
    sourcePath: 'D:\\Videos\\source.mp4'
  })

  assert.deepEqual(decision, {
    schemaVersion: 1,
    kind: 'media.remove-segment',
    instruction: '删除第4秒到第20秒',
    source: { path: 'D:\\Videos\\source.mp4', name: 'source.mp4' },
    timeline: { startSeconds: 4, endSeconds: 20, removedDurationSeconds: 16 },
    operations: [{ type: 'remove', sourceStartSeconds: 4, sourceEndSeconds: 20 }],
    output: { container: 'mp4', overwrite: false, suffix: '删除版-00m04s-00m20s' },
    verification: { removedDurationSeconds: 16, toleranceSeconds: 0.2 }
  })

  for (const instruction of ['能不能删除第4秒到第20秒？', '不要删除第4秒到第20秒', '比如删除第4秒到第20秒', '删除视频']) {
    assert.equal(compileEditDecisionList({ instruction, sourcePath: 'D:\\Videos\\source.mp4' }), null, instruction)
  }
})

test('explicit multi-range join preserves the spoken segment order in one frozen timeline', () => {
  const decision = compileEditDecisionList({
    instruction: '把第8秒到第12秒放前面，再接第0秒到第4秒',
    sourcePath: 'D:\\Videos\\source.mp4'
  })

  assert.deepEqual(decision, {
    schemaVersion: 1,
    kind: 'media.concat-segments',
    instruction: '把第8秒到第12秒放前面，再接第0秒到第4秒',
    source: { path: 'D:\\Videos\\source.mp4', name: 'source.mp4' },
    timeline: {
      segments: [
        { sourceStartSeconds: 8, sourceEndSeconds: 12, durationSeconds: 4, targetStartSeconds: 0, targetEndSeconds: 4 },
        { sourceStartSeconds: 0, sourceEndSeconds: 4, durationSeconds: 4, targetStartSeconds: 4, targetEndSeconds: 8 }
      ],
      durationSeconds: 8
    },
    operations: [
      { type: 'append', sourceStartSeconds: 8, sourceEndSeconds: 12, targetStartSeconds: 0 },
      { type: 'append', sourceStartSeconds: 0, sourceEndSeconds: 4, targetStartSeconds: 4 }
    ],
    output: { container: 'mp4', overwrite: false, suffix: '拼接版-2段-00m08s' },
    verification: { expectedDurationSeconds: 8, toleranceSeconds: 0.2 }
  })

  for (const instruction of [
    '能不能把第8秒到第12秒放前面，再接第0秒到第4秒？',
    '不要把第8秒到第12秒和第0秒到第4秒拼起来',
    '比如把第8秒到第12秒放前面，再接第0秒到第4秒',
    '把第8秒到第12秒放前面'
  ]) {
    assert.equal(compileEditDecisionList({ instruction, sourcePath: 'D:\\Videos\\source.mp4' }), null, instruction)
  }
})

test('multi-range joins are bounded to a safe maximum segment count', () => {
  const tooManyRanges = `按顺序拼接${Array.from({ length: 25 }, (_, index) => `第${index}秒到第${index + 1}秒`).join('和')}`
  assert.equal(compileEditDecisionList({ instruction: tooManyRanges, sourcePath: 'D:\\Videos\\source.mp4' }), null)
})
