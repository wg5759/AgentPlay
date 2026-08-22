const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { assertEditDecisionList, attachEditDecisionList, buildEditDecisionList } = require('../electron/edit-decision-list')

test('trim decision becomes one canonical material-track-operation-output-quality contract', () => {
  const edl = buildEditDecisionList({
    schemaVersion: 1,
    kind: 'media.trim',
    source: { path: 'D:/Videos/source.mp4', name: 'source.mp4' },
    timeline: { startSeconds: 4, endSeconds: 20, durationSeconds: 16 },
    output: { container: 'mp4', overwrite: false, suffix: '剪辑版-00m04s-00m20s' },
    verification: { expectedDurationSeconds: 16, toleranceSeconds: 0.2 }
  })

  assert.deepEqual(edl, {
    schemaVersion: 1,
    kind: 'agentplay.edit-decision-list',
    decisionKind: 'media.trim',
    materials: [{ id: 'material-video-1', role: 'video', path: 'D:/Videos/source.mp4', name: 'source.mp4' }],
    tracks: [
      { id: 'track-video-1', type: 'video', materialId: 'material-video-1' },
      { id: 'track-audio-1', type: 'audio', materialId: 'material-video-1', optional: true }
    ],
    operations: [{
      id: 'operation-1',
      type: 'trim',
      materialId: 'material-video-1',
      trackIds: ['track-video-1', 'track-audio-1'],
      sourceRangeSeconds: { start: 4, end: 20 },
      targetRangeSeconds: { start: 0, end: 16 }
    }],
    output: { container: 'mp4', overwrite: false, suffix: '剪辑版-00m04s-00m20s' },
    quality: { expectedDurationSeconds: 16, toleranceSeconds: 0.2 }
  })
})

test('remove decision records the removed range on both source media tracks', () => {
  const edl = buildEditDecisionList({
    schemaVersion: 1,
    kind: 'media.remove-segment',
    source: { path: 'D:/Videos/source.mp4', name: 'source.mp4' },
    timeline: { startSeconds: 4, endSeconds: 8, removedDurationSeconds: 4 },
    output: { container: 'mp4', overwrite: false, suffix: '删除版' },
    verification: { removedDurationSeconds: 4, toleranceSeconds: 0.2 }
  })

  assert.deepEqual(edl.operations, [{
    id: 'operation-1',
    type: 'remove',
    materialId: 'material-video-1',
    trackIds: ['track-video-1', 'track-audio-1'],
    sourceRangeSeconds: { start: 4, end: 8 }
  }])
  assert.equal(edl.quality.removedDurationSeconds, 4)
})

test('same-source concat preserves spoken segment order in canonical operations', () => {
  const edl = buildEditDecisionList({
    schemaVersion: 1,
    kind: 'media.concat-segments',
    source: { path: 'D:/Videos/source.mp4', name: 'source.mp4' },
    timeline: { durationSeconds: 8, segments: [
      { sourceStartSeconds: 8, sourceEndSeconds: 12, durationSeconds: 4, targetStartSeconds: 0, targetEndSeconds: 4 },
      { sourceStartSeconds: 0, sourceEndSeconds: 4, durationSeconds: 4, targetStartSeconds: 4, targetEndSeconds: 8 }
    ] },
    output: { container: 'mp4', overwrite: false, suffix: '拼接版' },
    verification: { expectedDurationSeconds: 8, toleranceSeconds: 0.2 }
  })

  assert.deepEqual(edl.operations.map((item) => ({ type: item.type, source: item.sourceRangeSeconds, target: item.targetRangeSeconds })), [
    { type: 'append', source: { start: 8, end: 12 }, target: { start: 0, end: 4 } },
    { type: 'append', source: { start: 0, end: 4 }, target: { start: 4, end: 8 } }
  ])
})

test('cross-source concat binds every append operation to its ordered material', () => {
  const edl = buildEditDecisionList({
    schemaVersion: 1,
    kind: 'media.concat-sources',
    sources: [
      { path: 'D:/Videos/a.mp4', name: 'a.mp4' },
      { path: 'D:/Videos/b.mp4', name: 'b.mp4' }
    ],
    output: { container: 'mp4', overwrite: false, suffix: '合并版-2段' },
    verification: { toleranceSeconds: 0.25 }
  })

  assert.deepEqual(edl.materials.map((item) => [item.id, item.role, item.path]), [
    ['material-video-1', 'video', 'D:/Videos/a.mp4'],
    ['material-video-2', 'video', 'D:/Videos/b.mp4']
  ])
  assert.deepEqual(edl.operations.map((item) => [item.type, item.materialId]), [
    ['append-source', 'material-video-1'],
    ['append-source', 'material-video-2']
  ])
})

test('music decision binds the audio material, selected range, track policy and quality target', () => {
  const edl = buildEditDecisionList({
    schemaVersion: 1,
    kind: 'media.add-music',
    source: { path: 'D:/Videos/source.mp4', name: 'source.mp4' },
    audio: {
      path: 'D:/Music/bgm.wav', volume: 0.15, loop: true, duck: true,
      fadeInSeconds: 1, fadeOutSeconds: 1.5,
      selection: { startSeconds: 2, endSeconds: 6, durationSeconds: 4 },
      loudness: { enabled: true, targetLufs: -16, targetTruePeakDbtp: -1.5, maxTruePeakDbtp: -1, lra: 11, toleranceLufs: 0.7 }
    },
    output: { container: 'mp4', overwrite: false, suffix: '配乐版' },
    verification: { toleranceSeconds: 0.2 }
  })

  assert.deepEqual(edl.materials.map((item) => [item.role, item.path]), [
    ['video', 'D:/Videos/source.mp4'], ['music', 'D:/Music/bgm.wav']
  ])
  assert.deepEqual(edl.operations[0], {
    id: 'operation-1', type: 'mix-music', materialId: 'material-music-1', trackIds: ['track-music-1'],
    sourceRangeSeconds: { start: 2, end: 6 },
    parameters: { volume: 0.15, loop: true, duck: true, fadeInSeconds: 1, fadeOutSeconds: 1.5 }
  })
  assert.equal(edl.quality.loudness.targetLufs, -16)
})

test('burn-subtitles decision binds subtitle material, track and frozen style', () => {
  const edl = buildEditDecisionList({
    schemaVersion: 1,
    kind: 'media.burn-subtitles',
    source: { path: 'D:/Videos/source.mp4', name: 'source.mp4' },
    subtitle: { path: 'D:/Subs/zh.srt', name: 'zh.srt', style: { fontSize: 'large', alignment: 'top', color: '黄色' } },
    output: { container: 'mp4', overwrite: false, suffix: '硬字幕版' },
    verification: { toleranceSeconds: 0.2 }
  })

  assert.deepEqual(edl.materials.map((item) => [item.role, item.path]), [
    ['video', 'D:/Videos/source.mp4'], ['subtitle', 'D:/Subs/zh.srt']
  ])
  assert.deepEqual(edl.operations[0], {
    id: 'operation-1', type: 'burn-subtitles', materialId: 'material-subtitle-1',
    trackIds: ['track-subtitle-1'], parameters: { style: { fontSize: 'large', alignment: 'top', color: '黄色' } }
  })
})

test('subtitle transformations share the canonical subtitle track and keep their frozen parameters', () => {
  const base = {
    schemaVersion: 1,
    source: { path: 'D:/Videos/source.mp4', name: 'source.mp4' },
    subtitle: { path: 'D:/Subs/zh.srt', name: 'zh.srt' },
    output: { container: 'srt', overwrite: false, suffix: '结果版' },
    verification: { toleranceSeconds: 0.2 }
  }
  const cases = [
    [{ ...base, kind: 'media.mux-subtitles', output: { ...base.output, container: 'mp4' } }, 'mux-subtitles', {}],
    [{ ...base, kind: 'media.shift-subtitles', shift: { direction: 'earlier', offsetSeconds: 2 } }, 'shift-subtitles', { direction: 'earlier', offsetSeconds: 2 }],
    [{ ...base, kind: 'media.translate-subtitles', translate: { targetLang: '英文', mode: 'bilingual' } }, 'translate-subtitles', { targetLang: '英文', mode: 'bilingual' }],
    [{ ...base, kind: 'media.edit-subtitle-cues', cueEdit: { operation: 'replace', index: 3, text: '新文本' } }, 'edit-subtitle-cues', { operation: 'replace', index: 3, text: '新文本' }]
  ]

  for (const [decision, operationType, parameters] of cases) {
    const edl = buildEditDecisionList(decision)
    assert.equal(edl.tracks.some((item) => item.id === 'track-subtitle-1' && item.type === 'subtitle'), true)
    assert.deepEqual(edl.operations[0], {
      id: 'operation-1', type: operationType, materialId: 'material-subtitle-1',
      trackIds: ['track-subtitle-1'], parameters
    })
  }
})

test('attached EDL is an execution contract and tampering fails closed', () => {
  const decision = attachEditDecisionList({
    schemaVersion: 1,
    kind: 'media.trim',
    source: { path: 'D:/Videos/source.mp4', name: 'source.mp4' },
    timeline: { startSeconds: 4, endSeconds: 20, durationSeconds: 16 },
    output: { container: 'mp4', overwrite: false, suffix: '剪辑版' },
    verification: { expectedDurationSeconds: 16, toleranceSeconds: 0.2 }
  })
  assert.equal(decision.edl.kind, 'agentplay.edit-decision-list')
  assert.doesNotThrow(() => assertEditDecisionList(decision))

  const tampered = JSON.parse(JSON.stringify(decision))
  tampered.edl.operations[0].sourceRangeSeconds.start = 5
  assert.throws(() => assertEditDecisionList(tampered), /EDL 与冻结决策不一致/)
})

test('packaged media acceptance requires EDL in direct, clarified and persistent task decisions', () => {
  const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke-packaged-media-edit.mjs'), 'utf8')
  assert.match(smoke, /agentplay\.edit-decision-list/)
  assert.match(smoke, /explicitPlan\.decision\.edl/)
  assert.match(smoke, /resolvedPlan\.decision\.edl/)
  assert.match(smoke, /task\.spec\?\.decision\?\.edl/)
})
