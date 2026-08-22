const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('child_process')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')

const { compileEditDecisionList } = require('../electron/media-edit-decision')
const { MediaEditService } = require('../electron/media-edit-service')
const { evaluateTaskResult } = require('../electron/task-result-quality')
const { VideoFrameService } = require('../electron/video-frame-service')

const quality = fs.readFileSync(path.join(__dirname, '..', 'electron', 'task-result-quality.js'), 'utf8')
const service = fs.readFileSync(path.join(__dirname, '..', 'electron', 'media-edit-service.js'), 'utf8')
const realSmoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke-media-edit.mjs'), 'utf8')
const packagedSmoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke-packaged-media-edit.mjs'), 'utf8')

const FFMPEG = process.env.AIPLAYER_FFMPEG || 'C:/Program Files/ffmpeg/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe'
const hasFfmpeg = fs.existsSync(FFMPEG)

function makeFrames() {
  const ffprobe = FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe')
  return {
    availability: () => ({ available: true }),
    probeDuration: async (file) => Number(String(spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 30000 }).stdout).trim()),
    probeHasAudio: async (file) => String(spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], { timeout: 30000 }).stdout).includes('audio'),
    readGrayFrame: async (file, seconds) => {
      const p = spawnSync(FFMPEG, ['-v', 'error', '-ss', Number(seconds).toFixed(3), '-i', file, '-frames:v', '1', '-vf', 'scale=32:32,format=gray', '-f', 'rawvideo', '-'], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
      return p.status === 0 && p.stdout.length === 1024 ? p.stdout : null
    },
    readLastGrayFrame: async (file, boundary) => {
      const start = Math.max(0, Number(boundary) - 0.7)
      const p = spawnSync(FFMPEG, ['-v', 'error', '-ss', start.toFixed(3), '-i', file, '-t', (Number(boundary) - start + 1.05).toFixed(3), '-vf', `select='lte(t,${(Number(boundary) - start - 0.033).toFixed(3)})',scale=32:32,format=gray`, '-vsync', '0', '-f', 'rawvideo', '-'], { timeout: 60000, maxBuffer: 16 * 1024 * 1024 })
      return p.status === 0 && p.stdout.length >= 1024 ? p.stdout.subarray(p.stdout.length - 1024) : null
    },
    run: async (args) => {
      const p = spawnSync(FFMPEG, args, { timeout: 120000 })
      if (p.status !== 0) throw new Error(String(p.stderr).slice(0, 300))
    }
  }
}

test('frame-proof wiring: trim, remove and concat receipts enter the quality and packaged-app gates', () => {
  assert.match(service, /frameProofForTrim/)
  assert.match(service, /帧边界校验失败/)
  assert.match(quality, /'frame-proof', '帧边界证明'/)
  assert.match(quality, /FRAME_BOUNDARY_MISMATCH/)
  assert.match(realSmoke, /removeResult\.frameProof\?\.verdict !== 'matched'/)
  assert.match(realSmoke, /concatResult\.frameProof\?\.verdict !== 'matched'/)
  assert.match(packagedSmoke, /removeTask\.result\?\.frameProof\?\.verdict !== 'matched'/)
  assert.match(packagedSmoke, /concatTask\.result\?\.frameProof\?\.verdict !== 'matched'/)
  assert.match(packagedSmoke, /2个保留片段的首尾帧边界已核对/)
  assert.match(packagedSmoke, /2个拼接片段的首尾帧边界已核对/)
})

test('frame-proof quality: matched is complete, inconclusive is an honest warning, missing/unavailable/mismatch fail closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-proof-quality-'))
  try {
    const output = path.join(dir, 'trimmed.mp4')
    fs.writeFileSync(output, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
    const spec = { decision: { timeline: { durationSeconds: 3 }, verification: { toleranceSeconds: 0.2 } } }
    const base = {
      success: true,
      outputs: [output],
      durationSeconds: 3.02,
      expectedDurationSeconds: 3,
      timelineReceipt: [{ sourceRange: '00:01.000 → 00:04.000', outputRange: '00:00.000 → 00:03.000' }],
      projectCapsule: { schemaVersion: 1, projectId: 'edit-1', versionId: 'version-2', currentPath: output, cursor: 1, versionCount: 2, canUndo: true, canRedo: false }
    }

    const matched = evaluateTaskResult('media.edit-trim', { ...base, frameProof: { verdict: 'matched', first: { matchDiff: 0.1, margin: 8 }, last: { matchDiff: 0.2, margin: 7 } } }, spec)
    assert.equal(matched.passed, true)
    assert.equal(matched.score, 100)
    assert.equal(matched.checks.find((item) => item.id === 'frame-proof')?.passed, true)

    const inconclusive = evaluateTaskResult('media.edit-trim', { ...base, frameProof: { verdict: 'inconclusive', first: { matchDiff: 0, margin: 0 }, last: { matchDiff: 0, margin: 0 } } }, spec)
    assert.equal(inconclusive.passed, true)
    assert.equal(inconclusive.level, 'warning')
    assert.ok(inconclusive.score < 100)
    assert.ok(inconclusive.reasons.some((item) => item.code === 'FRAME_BOUNDARY_INCONCLUSIVE'))

    for (const [label, frameProof, code] of [
      ['missing', undefined, 'FRAME_PROOF_MISSING'],
      ['unavailable', { verdict: 'unavailable' }, 'FRAME_PROOF_UNAVAILABLE'],
      ['mismatch', { verdict: 'mismatch' }, 'FRAME_BOUNDARY_MISMATCH']
    ]) {
      const result = evaluateTaskResult('media.edit-trim', { ...base, ...(frameProof ? { frameProof } : {}) }, spec)
      assert.equal(result.passed, false, `${label} proof must fail closed`)
      assert.ok(result.reasons.some((item) => item.code === code), `${label} proof must expose ${code}`)
    }

    for (const [taskType, kind] of [['media.edit-remove', 'media.remove-segment'], ['media.edit-concat', 'media.concat-segments']]) {
      const specWithProof = { decision: { kind, timeline: { durationSeconds: 3, ...(taskType === 'media.edit-concat' ? { segments: [{}] } : {}) }, verification: { toleranceSeconds: 0.2 } } }
      const missing = evaluateTaskResult(taskType, { ...base }, specWithProof)
      assert.equal(missing.passed, false, `${taskType} 缺帧证明必须失败关闭`)
      assert.ok(missing.reasons.some((item) => item.code === 'FRAME_PROOF_MISSING'))
      const matchedResult = evaluateTaskResult(taskType, { ...base, frameProof: { verdict: 'matched', boundaries: [{ first: { matchDiff: 0.1, margin: 8 }, last: { matchDiff: 0.2, margin: 7 } }] } }, specWithProof)
      assert.equal(matchedResult.passed, true)
      assert.equal(matchedResult.score, 100)
      assert.match(matchedResult.checks.find((item) => item.id === 'frame-proof')?.detail || '', /片段1首差异 0\.1、余量 8；末差异 0\.2、余量 7/)
    }

    const manyBoundaries = Array.from({ length: 6 }, () => ({ first: { matchDiff: 0.1, margin: 8 }, last: { matchDiff: 0.2, margin: 7 } }))
    const boundedDetail = evaluateTaskResult('media.edit-concat', { ...base, frameProof: { verdict: 'matched', boundaries: manyBoundaries } }, { decision: { kind: 'media.concat-segments', timeline: { durationSeconds: 3, segments: [{}] }, verification: { toleranceSeconds: 0.2 } } }).checks.find((item) => item.id === 'frame-proof')?.detail || ''
    assert.match(boundedDetail, /另2个片段见完整回执/)
    assert.doesNotMatch(boundedDetail, /片段5首差异/)

    const crossSourceSpec = { decision: { kind: 'media.concat-sources', sources: [{}, {}], verification: { toleranceSeconds: 0.2 } } }
    const crossSourceBase = { ...base, timelineReceipt: [
      { sourceRange: '00:00.000 → 00:04.000', outputRange: '00:00.000 → 00:04.000' },
      { sourceRange: '00:00.000 → 00:03.000', outputRange: '00:04.000 → 00:07.000' }
    ], durationSeconds: 7, expectedDurationSeconds: 7 }
    const crossSourceMissing = evaluateTaskResult('media.edit-concat-sources', crossSourceBase, crossSourceSpec)
    assert.equal(crossSourceMissing.passed, false)
    assert.ok(crossSourceMissing.reasons.some((item) => item.code === 'FRAME_PROOF_MISSING'))
    const crossSourceMatched = evaluateTaskResult('media.edit-concat-sources', { ...crossSourceBase, frameProof: { verdict: 'matched', boundaries: [
      { first: { verdict: 'matched', matchDiff: 0.1, margin: 8 }, last: { verdict: 'matched', matchDiff: 0.2, margin: 7 } },
      { first: { verdict: 'matched', matchDiff: 0.1, margin: 8 }, last: { verdict: 'matched', matchDiff: 0.2, margin: 7 } }
    ] } }, crossSourceSpec)
    assert.equal(crossSourceMatched.passed, true)
    assert.equal(crossSourceMatched.score, 100)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('trim fails before delivery when frame proof cannot be produced', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-proof-unavailable-'))
  try {
    const source = path.join(dir, 'source.mp4')
    const output = path.join(dir, 'output.mp4')
    fs.writeFileSync(source, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
    const decision = compileEditDecisionList({ instruction: '保留第1秒到第4秒', sourcePath: source })
    const frames = {
      availability: () => ({ available: true }),
      probeDuration: async (file) => path.resolve(file) === path.resolve(source) ? 6 : 3,
      run: async (args) => {
        const tempOutput = args.at(-1)
        fs.writeFileSync(tempOutput, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
      }
    }
    const svc = new MediaEditService({ frames })
    await assert.rejects(svc.trim({ sourcePath: source, outputPath: output, decision }), /帧边界证明不可用/)
    assert.equal(fs.existsSync(output), false, '未获得证明时不得把临时成果交付为正式文件')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('remove fails before delivery when retained-segment frame proof cannot be produced', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-proof-remove-unavailable-'))
  try {
    const source = path.join(dir, 'source.mp4')
    const output = path.join(dir, 'removed.mp4')
    fs.writeFileSync(source, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
    const decision = compileEditDecisionList({ instruction: '删除第1秒到第2秒', sourcePath: source })
    const frames = {
      availability: () => ({ available: true }),
      probeDuration: async (file) => path.resolve(file) === path.resolve(source) ? 6 : 5,
      probeHasAudio: async () => false,
      run: async (args) => {
        const tempOutput = args.at(-1)
        fs.writeFileSync(tempOutput, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
      }
    }
    const svc = new MediaEditService({ frames })
    await assert.rejects(svc.removeSegment({ sourcePath: source, outputPath: output, decision }), /帧边界证明不可用/)
    assert.equal(fs.existsSync(output), false, '删除切点未获证明时不得交付正式文件')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('source mutation during frame proof is rejected before atomic delivery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-proof-source-race-'))
  try {
    const source = path.join(dir, 'source.mp4')
    const output = path.join(dir, 'removed.mp4')
    fs.writeFileSync(source, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
    const decision = compileEditDecisionList({ instruction: '删除第1秒到第2秒', sourcePath: source })
    let mutated = false
    const frames = {
      availability: () => ({ available: true }),
      probeDuration: async (file) => path.resolve(file) === path.resolve(source) ? 6 : 5,
      probeHasAudio: async () => false,
      run: async (args) => fs.writeFileSync(args.at(-1), Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)])),
      readGrayFrame: async () => {
        if (!mutated) {
          mutated = true
          fs.appendFileSync(source, 'changed-during-proof')
        }
        return Buffer.alloc(32 * 32, 10)
      },
      readLastGrayFrame: async () => Buffer.alloc(32 * 32, 10)
    }
    await assert.rejects(new MediaEditService({ frames }).removeSegment({ sourcePath: source, outputPath: output, decision }), /源视频发生变化/)
    assert.equal(fs.existsSync(output), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('frame readers time out and kill a stuck ffmpeg child instead of hanging the task', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-proof-timeout-'))
  try {
    const ffmpegPath = path.join(dir, 'ffmpeg.exe')
    fs.writeFileSync(ffmpegPath, '')
    let killed = 0
    const spawnImpl = () => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => { killed += 1 }
      return child
    }
    const frames = new VideoFrameService({ ffmpegPath, spawnImpl, frameReadTimeoutMs: 20 })
    const started = Date.now()
    assert.equal(await frames.readGrayFrame('stuck.mp4', 1), null)
    assert.equal(await frames.readLastGrayFrame('stuck.mp4', 2), null)
    assert.ok(Date.now() - started < 500, '两次超时必须保持在快速且有界的测试窗口内')
    assert.equal(killed, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('real frame proof: matched on correct trim, mismatch catches shifted cut, uniform content inconclusive', { timeout: 300000 }, async (t) => {
  if (!hasFfmpeg) return t.skip('本机无 ffmpeg')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-proof-'))
  try {
    const frames = makeFrames()
    const svc = new MediaEditService({ frames })
    // 运动内容 6 秒（testsrc2 画面持续变化，判别力强）
    const video = path.join(dir, 'moving.mp4')
    let r = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=640x360:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video, '-loglevel', 'error'], { timeout: 90000 })
    assert.equal(r.status, 0, String(r.stderr).slice(0, 200))

    // 正确剪辑 1.0–4.0：帧证明必须 matched
    const goodOut = path.join(dir, 'good.mp4')
    const decision = compileEditDecisionList({ instruction: '保留第1秒到第4秒', sourcePath: video })
    const good = await svc.trim({ sourcePath: video, outputPath: goodOut, decision })
    assert.equal(good.frameProof?.verdict, 'matched', JSON.stringify(good.frameProof))
    assert.ok(good.frameProof.first.margin > 0.3 && good.frameProof.last.margin > 0.3)

    // 篡改检出：拿 1.3–4.3 的错剪成果冒充 1.0–4.0 的决策，帧证明必须 mismatch
    const badOut = path.join(dir, 'shifted.mp4')
    const shiftedDecision = compileEditDecisionList({ instruction: '保留第1.3秒到第4.3秒', sourcePath: video })
    await svc.trim({ sourcePath: video, outputPath: badOut, decision: shiftedDecision })
    const tamperProof = await svc.frameProofForTrim({ source: video, output: badOut, decision, sourceDuration: 6 })
    assert.equal(tamperProof.verdict, 'mismatch', `错剪 0.3 秒必须被帧边界证明抓出：${JSON.stringify(tamperProof)}`)

    // 删除 1.0–2.0：两个保留段的四个首尾边界都必须 matched
    const removedOut = path.join(dir, 'removed.mp4')
    const removeDecision = compileEditDecisionList({ instruction: '删除第1秒到第2秒', sourcePath: video })
    const removed = await svc.removeSegment({ sourcePath: video, outputPath: removedOut, decision: removeDecision })
    assert.equal(removed.frameProof?.verdict, 'matched', JSON.stringify(removed.frameProof))
    assert.equal(removed.frameProof.boundaries?.length, 2)
    assert.ok(removed.frameProof.boundaries.every((item) => item.first?.verdict === 'matched' && item.last?.verdict === 'matched'))
    assert.match(removed.summary, /2个保留片段的首尾帧边界已核对/)

    // 同时长错删成果不能在恢复时冒充原冻结决策
    const shiftedRemovedOut = path.join(dir, 'removed-shifted.mp4')
    const shiftedRemoveDecision = compileEditDecisionList({ instruction: '删除第1.3秒到第2.3秒', sourcePath: video })
    await svc.removeSegment({ sourcePath: video, outputPath: shiftedRemovedOut, decision: shiftedRemoveDecision })
    let wrongRemoveError = null
    await assert.rejects(
      async () => {
        try { await svc.verify({ sourcePath: video, outputPath: shiftedRemovedOut, decision: removeDecision }) } catch (error) { wrongRemoveError = error; throw error }
      },
      /帧边界校验失败/,
      '恢复必须抓住总时长相同但删除切点错位的成品'
    )
    assert.match(wrongRemoveError?.message || '', /片段\d+(?:首|末)差异/)

    // 同源拼接按口述顺序证明每个片段的首尾边界
    const concatOut = path.join(dir, 'concat.mp4')
    const concatDecision = compileEditDecisionList({ instruction: '把第3秒到第4秒放前面，再接第0秒到第1秒', sourcePath: video })
    const concat = await svc.concatSegments({ sourcePath: video, outputPath: concatOut, decision: concatDecision })
    assert.equal(concat.frameProof?.verdict, 'matched', JSON.stringify(concat.frameProof))
    assert.equal(concat.frameProof.boundaries?.length, 2)
    assert.ok(concat.frameProof.boundaries.every((item) => item.first?.verdict === 'matched' && item.last?.verdict === 'matched'))
    assert.match(concat.summary, /2个拼接片段的首尾帧边界已核对/)

    const wrongOrderOut = path.join(dir, 'concat-wrong-order.mp4')
    const wrongOrderDecision = compileEditDecisionList({ instruction: '把第0秒到第1秒放前面，再接第3秒到第4秒', sourcePath: video })
    await svc.concatSegments({ sourcePath: video, outputPath: wrongOrderOut, decision: wrongOrderDecision })
    await assert.rejects(
      svc.verify({ sourcePath: video, outputPath: wrongOrderOut, decision: concatDecision }),
      /帧边界校验失败/,
      '恢复必须抓住总时长相同但片段顺序相反的成品'
    )

    // 均匀内容（纯色）：如实 inconclusive，不硬判
    const flat = path.join(dir, 'flat.mp4')
    r = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=c=0x304050:duration=6:size=640x360:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', flat, '-loglevel', 'error'], { timeout: 90000 })
    assert.equal(r.status, 0)
    const flatOut = path.join(dir, 'flat-out.mp4')
    const flatDecision = compileEditDecisionList({ instruction: '保留第1秒到第4秒', sourcePath: flat })
    const flatResult = await svc.trim({ sourcePath: flat, outputPath: flatOut, decision: flatDecision })
    assert.equal(flatResult.frameProof?.verdict, 'inconclusive')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
