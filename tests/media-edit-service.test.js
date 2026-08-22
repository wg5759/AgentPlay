const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { MediaEditService } = require('../electron/media-edit-service')
const { compileEditDecisionList } = require('../electron/media-edit-decision')

function proofFrameReaders(sourcePath, mapOutputSeconds) {
  const frame = (seconds) => Buffer.alloc(32 * 32, Math.max(0, Math.min(255, Math.round(Number(seconds) * 10))))
  const sourceSeconds = (filePath, seconds) => filePath === sourcePath ? Number(seconds) : mapOutputSeconds(Number(seconds))
  return {
    readGrayFrame: async (filePath, seconds) => frame(sourceSeconds(filePath, seconds)),
    readLastGrayFrame: async (filePath, boundary) => frame(sourceSeconds(filePath, boundary))
  }
}

test('trim re-encodes the exact range, atomically saves a new file and probes its duration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-trim-'))
  try {
    const sourcePath = path.join(dir, 'source.mp4')
    const outputPath = path.join(dir, 'source-AgentPlay剪辑版.mp4')
    fs.writeFileSync(sourcePath, Buffer.from('original-video'))
    const original = fs.readFileSync(sourcePath)
    let runArgs = []
    const frames = {
      availability: () => ({ available: true }),
      probeDuration: async (filePath) => filePath === sourcePath ? 30 : 16.04,
      readGrayFrame: async (filePath, seconds) => filePath !== sourcePath || Math.abs(seconds - 4) < 0.01
        ? Buffer.alloc(32 * 32, 10)
        : Buffer.alloc(32 * 32, 50),
      readLastGrayFrame: async (filePath, boundary) => filePath !== sourcePath || (boundary >= 19.8 && boundary <= 20.1)
        ? Buffer.alloc(32 * 32, 20)
        : Buffer.alloc(32 * 32, 60),
      run: async (args) => {
        runArgs = args
        fs.writeFileSync(args.at(-1), Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
      }
    }
    const service = new MediaEditService({ frames })
    const decision = compileEditDecisionList({ instruction: '保留第4秒到第20秒', sourcePath })

    const result = await service.trim({ sourcePath, outputPath, decision })

    assert.equal(result.success, true)
    assert.equal(result.outputPath, outputPath)
    assert.equal(result.expectedDurationSeconds, 16)
    assert.equal(result.durationSeconds, 16.04)
    assert.equal(result.frameProof?.verdict, 'matched')
    assert.equal(result.timelineReceipt[0].sourceRange, '00:04.000 → 00:20.000')
    assert.deepEqual(fs.readFileSync(sourcePath), original)
    assert.ok(fs.statSync(outputPath).size > 1024)
    assert.ok(runArgs.indexOf('-i') < runArgs.indexOf('-ss'), 'accurate seek must happen after opening the input')
    assert.equal(runArgs[runArgs.indexOf('-ss') + 1], '4.000')
    assert.equal(runArgs[runArgs.indexOf('-t') + 1], '16.000')
    assert.equal(runArgs[runArgs.indexOf('-c:v') + 1], 'libx264')
    assert.notEqual(runArgs.at(-1), outputPath, 'ffmpeg must write a temporary artifact before atomic rename')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('remove-segment joins the retained head and tail with continuous video and audio timelines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-remove-segment-'))
  try {
    const sourcePath = path.join(dir, 'source.mp4')
    const outputPath = path.join(dir, 'source-AgentPlay删除版.mp4')
    fs.writeFileSync(sourcePath, Buffer.from('original-video'))
    const original = fs.readFileSync(sourcePath)
    let runArgs = []
    const frames = {
      availability: () => ({ available: true }),
      probeDuration: async (filePath) => filePath === sourcePath ? 30 : 14.03,
      probeHasAudio: async () => true,
      ...proofFrameReaders(sourcePath, (seconds) => seconds < 4 ? seconds : seconds + 16),
      run: async (args) => {
        runArgs = args
        fs.writeFileSync(args.at(-1), Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
      }
    }
    const service = new MediaEditService({ frames })
    const decision = compileEditDecisionList({ instruction: '删除第4秒到第20秒', sourcePath })

    const result = await service.removeSegment({ sourcePath, outputPath, decision })

    assert.equal(result.success, true)
    assert.equal(result.expectedDurationSeconds, 14)
    assert.equal(result.durationSeconds, 14.03)
    assert.deepEqual(result.timelineReceipt, [
      { operation: '删除片段', sourceRange: '00:04.000 → 00:20.000', outputRange: '未进入成片' },
      { operation: '保留片段', sourceRange: '00:00.000 → 00:04.000', outputRange: '00:00.000 → 00:04.000' },
      { operation: '保留片段', sourceRange: '00:20.000 → 00:30.000', outputRange: '00:04.000 → 00:14.000' }
    ])
    assert.deepEqual(fs.readFileSync(sourcePath), original)
    assert.ok(fs.statSync(outputPath).size > 1024)
    const filter = runArgs[runArgs.indexOf('-filter_complex') + 1]
    assert.match(filter, /\[0:v:0\]trim=start=0\.000:end=4\.000,setpts=PTS-STARTPTS\[v0\]/)
    assert.match(filter, /\[0:v:0\]trim=start=20\.000,setpts=PTS-STARTPTS\[v1\]/)
    assert.match(filter, /\[v0\]\[v1\]concat=n=2:v=1:a=0/)
    assert.match(filter, /\[a0\]\[a1\]concat=n=2:v=0:a=1/)
    assert.notEqual(runArgs.at(-1), outputPath, 'ffmpeg must write a temporary artifact before atomic rename')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('remove-segment recovery re-probes an existing artifact instead of encoding again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-remove-recovery-'))
  try {
    const sourcePath = path.join(dir, 'source.mp4')
    const outputPath = path.join(dir, 'removed.mp4')
    fs.writeFileSync(sourcePath, Buffer.from('original-video'))
    fs.writeFileSync(outputPath, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
    let runCount = 0
    const frames = {
      availability: () => ({ available: true }),
      probeDuration: async (filePath) => filePath === sourcePath ? 30 : 14.03,
      probeHasAudio: async () => true,
      ...proofFrameReaders(sourcePath, (seconds) => seconds < 4 ? seconds : seconds + 16),
      run: async () => { runCount += 1 }
    }
    const service = new MediaEditService({ frames })
    const decision = compileEditDecisionList({ instruction: '删除第4秒到第20秒', sourcePath })

    const result = await service.verify({ sourcePath, outputPath, decision })

    assert.equal(result.expectedDurationSeconds, 14)
    assert.equal(result.durationSeconds, 14.03)
    assert.equal(result.timelineReceipt[0].operation, '删除片段')
    assert.equal(runCount, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('remove-segment supports a silent video and drops stale chapter timestamps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-remove-silent-'))
  try {
    const sourcePath = path.join(dir, 'silent.mp4')
    const outputPath = path.join(dir, 'silent-removed.mp4')
    fs.writeFileSync(sourcePath, Buffer.from('silent-video'))
    let runArgs = []
    const frames = {
      availability: () => ({ available: true }),
      probeDuration: async (filePath) => filePath === sourcePath ? 10 : 5.02,
      probeHasAudio: async () => false,
      ...proofFrameReaders(sourcePath, (seconds) => seconds + 5),
      run: async (args) => {
        runArgs = args
        fs.writeFileSync(args.at(-1), Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
      }
    }
    const decision = compileEditDecisionList({ instruction: '删除第0秒到第5秒', sourcePath })
    const result = await new MediaEditService({ frames }).removeSegment({ sourcePath, outputPath, decision })

    assert.equal(result.durationSeconds, 5.02)
    assert.equal(result.timelineReceipt.length, 2)
    assert.ok(runArgs.includes('-an'))
    assert.equal(runArgs[runArgs.indexOf('-map_chapters') + 1], '-1', 'old chapter timestamps are invalid after deleting timeline material')
    assert.doesNotMatch(runArgs[runArgs.indexOf('-filter_complex') + 1], /\[0:a:0\]/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('concat-segments reorders every requested video and audio range on a continuous output timeline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-concat-segments-'))
  try {
    const sourcePath = path.join(dir, 'source.mp4')
    const outputPath = path.join(dir, 'source-reordered.mp4')
    fs.writeFileSync(sourcePath, Buffer.from('original-video'))
    const original = fs.readFileSync(sourcePath)
    let runArgs = []
    const frames = {
      availability: () => ({ available: true }),
      probeDuration: async (filePath) => filePath === sourcePath ? 20 : 8.03,
      probeHasAudio: async () => true,
      ...proofFrameReaders(sourcePath, (seconds) => seconds < 4 ? seconds + 8 : seconds - 4),
      run: async (args) => {
        runArgs = args
        fs.writeFileSync(args.at(-1), Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
      }
    }
    const decision = compileEditDecisionList({ instruction: '把第8秒到第12秒放前面，再接第0秒到第4秒', sourcePath })
    const result = await new MediaEditService({ frames }).concatSegments({ sourcePath, outputPath, decision })

    assert.equal(result.success, true)
    assert.equal(result.expectedDurationSeconds, 8)
    assert.equal(result.durationSeconds, 8.03)
    assert.deepEqual(result.timelineReceipt, [
      { operation: '拼接片段 1', sourceRange: '00:08.000 → 00:12.000', outputRange: '00:00.000 → 00:04.000' },
      { operation: '拼接片段 2', sourceRange: '00:00.000 → 00:04.000', outputRange: '00:04.000 → 00:08.000' }
    ])
    assert.deepEqual(fs.readFileSync(sourcePath), original)
    const filter = runArgs[runArgs.indexOf('-filter_complex') + 1]
    assert.match(filter, /\[0:v:0\]trim=start=8\.000:end=12\.000,setpts=PTS-STARTPTS\[v0\]/)
    assert.match(filter, /\[0:v:0\]trim=start=0\.000:end=4\.000,setpts=PTS-STARTPTS\[v1\]/)
    assert.match(filter, /\[v0\]\[v1\]concat=n=2:v=1:a=0/)
    assert.match(filter, /\[a0\]\[a1\]concat=n=2:v=0:a=1/)
    assert.equal(runArgs[runArgs.indexOf('-map_chapters') + 1], '-1')
    assert.notEqual(runArgs.at(-1), outputPath, 'ffmpeg must write a temporary artifact before atomic rename')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('concat recovery rejects a corrupted frozen segment list even when the artifact duration matches', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-concat-recovery-'))
  try {
    const sourcePath = path.join(dir, 'source.mp4')
    const outputPath = path.join(dir, 'reordered.mp4')
    fs.writeFileSync(sourcePath, Buffer.from('original-video'))
    fs.writeFileSync(outputPath, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
    const frames = {
      availability: () => ({ available: true }),
      probeDuration: async (filePath) => filePath === sourcePath ? 20 : 8.03,
      probeHasAudio: async () => true,
      run: async () => { throw new Error('recovery must not encode again') }
    }
    const decision = compileEditDecisionList({ instruction: '把第8秒到第12秒放前面，再接第0秒到第4秒', sourcePath })
    decision.timeline.segments = decision.timeline.segments.slice(0, 1)

    await assert.rejects(
      new MediaEditService({ frames }).verify({ sourcePath, outputPath, decision }),
      /拼接时间线无效/
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('concat recovery revalidates every frozen source range against the current source duration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-concat-range-recovery-'))
  try {
    const sourcePath = path.join(dir, 'source.mp4')
    const outputPath = path.join(dir, 'reordered.mp4')
    fs.writeFileSync(sourcePath, Buffer.from('original-video'))
    fs.writeFileSync(outputPath, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
    const frames = {
      availability: () => ({ available: true }),
      probeDuration: async (filePath) => filePath === sourcePath ? 20 : 8.03,
      probeHasAudio: async () => true,
      run: async () => { throw new Error('recovery must not encode again') }
    }
    const decision = compileEditDecisionList({ instruction: '把第18秒到第22秒放前面，再接第0秒到第4秒', sourcePath })

    await assert.rejects(
      new MediaEditService({ frames }).verify({ sourcePath, outputPath, decision }),
      /超出源视频时长/
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('concat recovery refuses an oversized frozen filter graph', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-concat-limit-recovery-'))
  try {
    const sourcePath = path.join(dir, 'source.mp4')
    const outputPath = path.join(dir, 'reordered.mp4')
    fs.writeFileSync(sourcePath, Buffer.from('original-video'))
    fs.writeFileSync(outputPath, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
    const decision = {
      schemaVersion: 1,
      kind: 'media.concat-segments',
      source: { path: sourcePath },
      timeline: {
        segments: Array.from({ length: 25 }, (_, index) => ({ sourceStartSeconds: 0, sourceEndSeconds: 1, durationSeconds: 1, targetStartSeconds: index, targetEndSeconds: index + 1 })),
        durationSeconds: 25
      },
      verification: { toleranceSeconds: 0.2 }
    }
    const frames = {
      availability: () => ({ available: true }),
      probeDuration: async (filePath) => filePath === sourcePath ? 30 : 25.03,
      probeHasAudio: async () => true,
      run: async () => { throw new Error('recovery must not encode again') }
    }

    await assert.rejects(new MediaEditService({ frames }).verify({ sourcePath, outputPath, decision }), /拼接时间线无效/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
