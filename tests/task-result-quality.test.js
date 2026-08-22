const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { evaluateTaskResult, classifyTaskFailure } = require('../electron/task-result-quality')

test('subtitle quality score verifies a real target-language SRT artifact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-quality-srt-'))
  try {
    const output = path.join(dir, 'translated.srt')
    fs.writeFileSync(output, '1\n00:00:00,000 --> 00:00:02,000\n这是一条有效字幕。\n', 'utf8')
    const quality = evaluateTaskResult('subtitle.generate', { success: true, outputs: [output], count: 1, targetLang: '中文' }, { targetLang: '中文' })
    assert.equal(quality.passed, true)
    assert.ok(quality.score >= quality.threshold)
    assert.equal(quality.reasons.length, 0)
    assert.ok(quality.checks.some((item) => item.id === 'subtitle-cues' && item.passed))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('missing artifacts and partial batches expose stable repairable failure reasons', () => {
  const missing = evaluateTaskResult('media.compress', { success: true, outputs: ['Z:\\missing.mp4'] }, {})
  assert.equal(missing.passed, false)
  assert.ok(missing.reasons.some((item) => item.code === 'ARTIFACT_MISSING' && item.repairable))

  const batch = evaluateTaskResult('media.batch', {
    success: true,
    results: [{ success: true, outputPath: __filename }, { success: false, error: '转写失败' }],
    outputs: [__filename]
  }, { kind: 'transcribe', sources: [{}, {}] })
  assert.equal(batch.passed, false)
  assert.ok(batch.reasons.some((item) => item.code === 'PARTIAL_BATCH' && item.repairable))
})

test('runtime failures are classified into actionable stable codes', () => {
  assert.deepEqual(classifyTaskFailure(new Error('request exceeds the available context size')), {
    code: 'MODEL_CONTEXT_EXCEEDED', message: '模型上下文容量不足，请减少内容或切换大上下文模型', retryable: true
  })
  assert.equal(classifyTaskFailure(new Error('源文件已发生变化')).code, 'SOURCE_CHANGED')
  assert.equal(classifyTaskFailure(new Error('缺少 ffmpeg 组件')).code, 'COMPONENT_MISSING')
})

test('video artifacts require a real supported container signature', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-quality-video-'))
  try {
    const invalid = path.join(dir, 'invalid.mp4')
    const valid = path.join(dir, 'valid.mp4')
    fs.writeFileSync(invalid, Buffer.alloc(2048, 2))
    fs.writeFileSync(valid, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048, 0)]))
    const invalidQuality = evaluateTaskResult('creative.video-generate', { success: true, outputs: [invalid] }, {})
    const validQuality = evaluateTaskResult('creative.video-generate', { success: true, outputs: [valid] }, {})
    assert.equal(invalidQuality.passed, false)
    assert.ok(invalidQuality.reasons.some((item) => item.code === 'INVALID_FORMAT'))
    assert.equal(validQuality.passed, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('media trim quality requires a verified timeline and duration receipt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-quality-trim-'))
  try {
    const output = path.join(dir, 'trimmed.mp4')
    fs.writeFileSync(output, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048, 0)]))
    const spec = { decision: { timeline: { durationSeconds: 16 }, verification: { toleranceSeconds: 0.2 } } }
    const passed = evaluateTaskResult('media.edit-trim', {
      success: true,
      outputs: [output],
      durationSeconds: 16.04,
      expectedDurationSeconds: 16,
      frameProof: { verdict: 'matched', first: { matchDiff: 0.1, margin: 8 }, last: { matchDiff: 0.2, margin: 7 } },
      timelineReceipt: [{ sourceRange: '00:04.000 → 00:20.000', outputRange: '00:00.000 → 00:16.000' }],
      projectCapsule: { schemaVersion: 1, projectId: 'edit-1', versionId: 'version-2', currentPath: output, cursor: 1, versionCount: 2, canUndo: true, canRedo: false }
    }, spec)
    assert.equal(passed.passed, true)
    assert.ok(passed.checks.some((item) => item.id === 'duration-receipt' && item.passed))

    const failed = evaluateTaskResult('media.edit-trim', {
      success: true, outputs: [output], durationSeconds: 14.8, expectedDurationSeconds: 16,
      frameProof: { verdict: 'matched' }, timelineReceipt: []
    }, spec)
    assert.equal(failed.passed, false)
    assert.ok(failed.reasons.some((item) => item.code === 'DURATION_MISMATCH'))
    assert.ok(failed.reasons.some((item) => item.code === 'TIMELINE_RECEIPT_MISSING'))

    const missingProject = evaluateTaskResult('media.edit-trim', {
      success: true, outputs: [output], durationSeconds: 16.04, expectedDurationSeconds: 16,
      frameProof: { verdict: 'matched' },
      timelineReceipt: [{ sourceRange: '00:04.000 → 00:20.000', outputRange: '00:00.000 → 00:16.000' }]
    }, spec)
    assert.equal(missingProject.passed, false)
    assert.ok(missingProject.reasons.some((item) => item.code === 'PROJECT_CAPSULE_MISSING'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('music edit quality requires decoded audio proof instead of trusting an audio stream flag', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-quality-music-'))
  try {
    const output = path.join(dir, 'music-edit.mp4')
    fs.writeFileSync(output, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048, 0)]))
    const spec = { decision: { kind: 'media.add-music', verification: { toleranceSeconds: 0.2 } } }
    const base = {
      success: true,
      outputs: [output],
      durationSeconds: 12.04,
      expectedDurationSeconds: 12,
      timelineReceipt: [{ operation: '添加背景音乐', sourceRange: '00:00.000 → 00:12.000', outputRange: '00:00.000 → 00:12.000' }],
      projectCapsule: { schemaVersion: 1, projectId: 'edit-1', versionId: 'version-2', currentPath: output, cursor: 1, versionCount: 2, canUndo: true, canRedo: false }
    }

    const missingProof = evaluateTaskResult('media.edit-music', base, spec)
    assert.equal(missingProof.passed, false)
    assert.ok(missingProof.reasons.some((item) => item.code === 'AUDIO_PROOF_MISSING'))

    const passed = evaluateTaskResult('media.edit-music', {
      ...base,
      audioProof: {
        schemaVersion: 1,
        method: 'decoded-pcm-s16le-v1',
        verdict: 'matched',
        output: { hasAudio: true, nonSilent: true, samplePeakDbfs: -1.2, overloadFree: true },
        change: { verdict: 'changed', comparedWindows: 3, changedWindows: 3 },
        fades: { verdict: 'matched', fadeIn: { verdict: 'matched' }, fadeOut: { verdict: 'matched' } },
        ducking: { requested: true, configured: true, claim: 'configuration-only' }
      }
    }, spec)
    assert.equal(passed.passed, true)
    assert.ok(passed.checks.some((item) => item.id === 'audio-proof' && item.passed))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('normalized music quality requires an encoded EBU R128 receipt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-quality-loudness-'))
  try {
    const output = path.join(dir, 'normalized-music.mp4')
    fs.writeFileSync(output, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048, 0)]))
    const spec = { decision: { kind: 'media.add-music', audio: { loudness: { enabled: true } }, verification: { toleranceSeconds: 0.2 } } }
    const result = {
      success: true,
      outputs: [output],
      durationSeconds: 12.04,
      expectedDurationSeconds: 12,
      timelineReceipt: [{ operation: '添加背景音乐', sourceRange: '00:00.000 → 00:12.000', outputRange: '00:00.000 → 00:12.000' }],
      audioProof: {
        schemaVersion: 1,
        method: 'decoded-pcm-s16le-v1',
        verdict: 'matched',
        output: { hasAudio: true, nonSilent: true, samplePeakDbfs: -1.2, overloadFree: true },
        change: { verdict: 'changed', comparedWindows: 3, changedWindows: 3 },
        fades: { verdict: 'matched', fadeIn: { verdict: 'matched' }, fadeOut: { verdict: 'matched' } }
      },
      projectCapsule: { schemaVersion: 1, projectId: 'edit-1', versionId: 'version-2', currentPath: output, cursor: 1, versionCount: 2, canUndo: true, canRedo: false }
    }

    const missing = evaluateTaskResult('media.edit-music', result, spec)
    assert.equal(missing.passed, false)
    assert.ok(missing.reasons.some((item) => item.code === 'LOUDNESS_PROOF_MISSING'))

    const passed = evaluateTaskResult('media.edit-music', {
      ...result,
      loudnessProof: { schemaVersion: 1, method: 'ebur128-post-encode-v1', verdict: 'matched', integratedLufs: -16.1, truePeakDbtp: -1.3 }
    }, spec)
    assert.equal(passed.passed, true)
    assert.ok(passed.checks.some((item) => item.id === 'loudness-proof' && item.passed))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('removed-segment media uses the same artifact, duration, timeline and project quality gate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-remove-segment-'))
  try {
    const output = path.join(dir, 'removed.mp4')
    fs.writeFileSync(output, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
    const quality = evaluateTaskResult('media.edit-remove', {
      success: true,
      outputs: [output],
      durationSeconds: 14.03,
      expectedDurationSeconds: 14,
      frameProof: { verdict: 'matched', boundaries: [{ first: { verdict: 'matched', matchDiff: 0.1, margin: 8 }, last: { verdict: 'matched', matchDiff: 0.2, margin: 7 } }] },
      timelineReceipt: [
        { operation: '删除片段', sourceRange: '00:04.000 → 00:20.000', outputRange: '未进入成片' },
        { operation: '保留片段', sourceRange: '00:00.000 → 00:04.000', outputRange: '00:00.000 → 00:04.000' }
      ],
      projectCapsule: { schemaVersion: 1, projectId: 'edit-1', versionId: 'version-2', currentPath: output, cursor: 1, versionCount: 2, canUndo: true, canRedo: false }
    }, { decision: { kind: 'media.remove-segment', verification: { toleranceSeconds: 0.2 } } })

    assert.equal(quality.passed, true)
    assert.equal(quality.score, 100)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('reordered concat quality requires a receipt for every frozen segment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-concat-segments-'))
  try {
    const output = path.join(dir, 'reordered.mp4')
    fs.writeFileSync(output, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
    const spec = {
      decision: {
        kind: 'media.concat-segments',
        timeline: { segments: [{}, {}], durationSeconds: 8 },
        verification: { toleranceSeconds: 0.2 }
      }
    }
    const result = {
      success: true,
      outputs: [output],
      durationSeconds: 8.03,
      expectedDurationSeconds: 8,
      frameProof: { verdict: 'matched', boundaries: [
        { first: { verdict: 'matched', matchDiff: 0.1, margin: 8 }, last: { verdict: 'matched', matchDiff: 0.2, margin: 7 } },
        { first: { verdict: 'matched', matchDiff: 0.1, margin: 8 }, last: { verdict: 'matched', matchDiff: 0.2, margin: 7 } }
      ] },
      timelineReceipt: [
        { operation: '拼接片段 1', sourceRange: '00:08.000 → 00:12.000', outputRange: '00:00.000 → 00:04.000' },
        { operation: '拼接片段 2', sourceRange: '00:00.000 → 00:04.000', outputRange: '00:04.000 → 00:08.000' }
      ],
      projectCapsule: { schemaVersion: 1, projectId: 'edit-1', versionId: 'version-2', currentPath: output, cursor: 1, versionCount: 2, canUndo: true, canRedo: false }
    }

    assert.equal(evaluateTaskResult('media.edit-concat', result, spec).passed, true)
    const incompleteProof = evaluateTaskResult('media.edit-concat', { ...result, frameProof: { verdict: 'matched', boundaries: result.frameProof.boundaries.slice(0, 1) } }, spec)
    assert.equal(incompleteProof.passed, false)
    assert.ok(incompleteProof.reasons.some((item) => item.code === 'FRAME_PROOF_INCOMPLETE'))
    const incomplete = evaluateTaskResult('media.edit-concat', { ...result, timelineReceipt: result.timelineReceipt.slice(0, 1) }, spec)
    assert.equal(incomplete.passed, false)
    assert.ok(incomplete.reasons.some((item) => item.code === 'SEGMENT_RECEIPT_INCOMPLETE'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
