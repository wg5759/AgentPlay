const assert = require('node:assert/strict')
const test = require('node:test')

const {
  cuesToEntries,
  formatSrtTimestamp,
  nextLiveBatch,
  runLiveTranslation,
  translateBatch
} = require('../electron/subtitle-bilingual-service')

function makeCues(count, step = 5) {
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    startSeconds: i * step,
    endSeconds: i * step + 3,
    text: `line ${i + 1}`
  }))
}

function jsonComplete(map) {
  return async ({ prompt }) => {
    const items = JSON.parse(prompt.slice(prompt.indexOf('{"items"'))).items
    return { text: JSON.stringify({ translations: items.map((item) => ({ i: item.i, text: map(item) })) }) }
  }
}

test('srt timestamp formats hours, minutes, seconds and millis', () => {
  assert.equal(formatSrtTimestamp(0), '00:00:00,000')
  assert.equal(formatSrtTimestamp(65.25), '00:01:05,250')
  assert.equal(formatSrtTimestamp(3661.5), '01:01:01,500')
})

test('cuesToEntries converts seconds cues to srt entries with 1-based index', () => {
  const entries = cuesToEntries([{ start: 1, end: 2.5, text: '你好' }, { start: 3, end: 4, text: '世界' }])
  assert.deepEqual(entries[0], { index: 1, start: '00:00:01,000', end: '00:00:02,500', text: '你好' })
  assert.equal(entries[1].index, 2)
})

test('nextLiveBatch prioritises cues at or after the play position, then wraps back', () => {
  const cues = makeCues(10)
  const translated = new Map()
  const failed = new Set()
  // 从 22s 开始：index5 的 cue（结束于 23s）正在播，应一并优先
  const batch = nextLiveBatch(cues, translated, failed, 22, 3)
  assert.deepEqual(batch.map((cue) => cue.index), [5, 6, 7])
  // 后面的都译完后回头补前面的
  for (const index of [5, 6, 7, 8, 9, 10]) translated.set(index, 'x')
  const wrapped = nextLiveBatch(cues, translated, failed, 22, 2)
  assert.deepEqual(wrapped.map((cue) => cue.index), [1, 2])
  // 全部译完返回空
  for (const index of [1, 2, 3, 4]) translated.set(index, 'x')
  assert.deepEqual(nextLiveBatch(cues, translated, failed, 0, 5), [])
})

test('live translation walks forward from position and reports batches incrementally', async () => {
  const cues = makeCues(6)
  const batches = []
  const result = await runLiveTranslation({
    cues,
    complete: jsonComplete((item) => `译文${item.i}`),
    getPosition: () => 12,
    batchSize: 2,
    onBatch: ({ batch }) => batches.push(batch.map((cue) => cue.index))
  })
  assert.equal(result.done, true)
  assert.equal(result.translations.size, 6)
  assert.deepEqual(batches, [[3, 4], [5, 6], [1, 2]])
  assert.equal(result.translations.get(4), '译文4')
})

test('live translation re-plans when the user seeks', async () => {
  const cues = makeCues(8)
  let position = 0
  const batches = []
  let calls = 0
  const result = await runLiveTranslation({
    cues,
    complete: async (args) => {
      calls += 1
      if (calls === 1) position = 30 // 第一批翻译期间用户跳到 30s，下一批应从新位置起
      return jsonComplete((item) => `t${item.i}`)(args)
    },
    getPosition: () => position,
    batchSize: 2,
    onBatch: ({ batch }) => batches.push(batch.map((cue) => cue.index))
  })
  assert.deepEqual(batches, [[1, 2], [7, 8], [3, 4], [5, 6]])
  assert.equal(result.translations.size, 8)
})

test('live translation aborts cleanly and keeps partial results', async () => {
  const cues = makeCues(6)
  const controller = new AbortController()
  let calls = 0
  const result = await runLiveTranslation({
    cues,
    complete: async (args) => {
      calls += 1
      if (calls === 2) controller.abort()
      return jsonComplete((item) => `t${item.i}`)(args)
    },
    signal: controller.signal,
    batchSize: 2
  })
  assert.equal(result.cancelled, true)
  assert.equal(result.done, false)
  assert.ok(result.translations.size < 6)
})

test('live translation counts model failures without retry storms', async () => {
  const cues = makeCues(4)
  let calls = 0
  const result = await runLiveTranslation({
    cues,
    complete: async () => { calls += 1; throw new Error('model 500') },
    batchSize: 2
  })
  assert.equal(calls, 2)
  assert.equal(result.failed, 4)
  assert.equal(result.translations.size, 0)
  assert.equal(result.done, true)
})

test('translateBatch returns per-index translations and rejects unknown indices', async () => {
  const entries = [{ index: 1, text: 'a' }, { index: 2, text: 'b' }]
  const map = await translateBatch(entries, async () => ({
    text: JSON.stringify({ translations: [{ i: 1, text: '甲' }, { i: 2, text: '乙' }, { i: 99, text: '越界' }] })
  }))
  assert.equal(map.get(1), '甲')
  assert.equal(map.get(2), '乙')
  assert.equal(map.has(99), false)
})
