const test = require('node:test')
const assert = require('node:assert/strict')

const { MediaEditConversation } = require('../electron/media-edit-conversation')

test('clarification state stays in the main process and only an opaque token reaches the renderer', () => {
  const conversation = new MediaEditConversation({ idFactory: () => 'clarify-1', now: () => 1000 })
  const first = conversation.plan({ instruction: '保留第4秒之后', sourcePath: 'D:\\Videos\\source.mp4' })

  assert.deepEqual(first, {
    matched: true,
    clarification: {
      id: 'clarify-1',
      reason: 'missing-end',
      question: '要保留到第几秒？',
      sourcePath: 'D:\\Videos\\source.mp4',
      expiresAt: 301000
    }
  })
  assert.equal(JSON.stringify(first).includes('startSeconds'), false)

  const resolved = conversation.plan({
    instruction: '到第20秒',
    sourcePath: 'D:\\Videos\\source.mp4',
    clarificationId: 'clarify-1'
  })
  assert.equal(resolved.decision.kind, 'media.trim')
  assert.deepEqual(resolved.decision.timeline, { startSeconds: 4, endSeconds: 20, durationSeconds: 16 })
  assert.equal(resolved.decision.edl.kind, 'agentplay.edit-decision-list')
  assert.equal(resolved.decision.edl.operations[0].sourceRangeSeconds.start, 4)

  const direct = conversation.plan({ instruction: '删除第4秒到第8秒', sourcePath: 'D:\Videos\source.mp4' })
  assert.equal(direct.decision.edl.decisionKind, 'media.remove-segment')
})

test('unknown, expired or cross-source clarification tokens fail closed', () => {
  let currentTime = 1000
  const conversation = new MediaEditConversation({ idFactory: () => 'clarify-1', now: () => currentTime, ttlMs: 100 })
  conversation.plan({ instruction: '保留第4秒之后', sourcePath: 'D:\\Videos\\source.mp4' })
  assert.throws(() => conversation.plan({ instruction: '到第20秒', sourcePath: 'D:\\Videos\\other.mp4', clarificationId: 'clarify-1' }), /当前源视频不一致/)
  currentTime = 1200
  assert.throws(() => conversation.plan({ instruction: '到第20秒', sourcePath: 'D:\\Videos\\source.mp4', clarificationId: 'clarify-1' }), /已失效/)
  assert.throws(() => conversation.plan({ instruction: '到第20秒', sourcePath: 'D:\\Videos\\source.mp4', clarificationId: 'forged' }), /已失效/)
})

test('cancel and unrelated answers consume pending clarification without creating a decision', () => {
  let nextId = 0
  const conversation = new MediaEditConversation({ idFactory: () => `clarify-${++nextId}` })
  const cancelPlan = conversation.plan({ instruction: '删除视频', sourcePath: 'D:\\Videos\\source.mp4' })
  assert.deepEqual(conversation.plan({ instruction: '算了', sourcePath: 'D:\\Videos\\source.mp4', clarificationId: cancelPlan.clarification.id }), { matched: true, cancelled: true })
  assert.throws(() => conversation.plan({ instruction: '第4秒到第8秒', sourcePath: 'D:\\Videos\\source.mp4', clarificationId: cancelPlan.clarification.id }), /已失效/)

  const unrelatedPlan = conversation.plan({ instruction: '保留第4秒之后', sourcePath: 'D:\\Videos\\source.mp4' })
  assert.deepEqual(conversation.plan({ instruction: '这个视频讲了什么', sourcePath: 'D:\\Videos\\source.mp4', clarificationId: unrelatedPlan.clarification.id }), { matched: false })
})
