const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('child_process')

const { compileConcatSourcesDecisionList, planEditInstruction, resolveEditClarification } = require('../electron/media-edit-decision')
const { MediaEditService } = require('../electron/media-edit-service')
const { VideoFrameService } = require('../electron/video-frame-service')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'useMediaCreativeTasks.ts'), 'utf8')
const runtime = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'usePersistentTaskRuntime.ts'), 'utf8')
const quality = fs.readFileSync(path.join(__dirname, '..', 'electron', 'task-result-quality.js'), 'utf8')
const packagedSmoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke-packaged-media-concat-sources.mjs'), 'utf8')

const SOURCE = 'D:/视频/第一段.mp4'
const FFMPEG = process.env.AIPLAYER_FFMPEG || 'C:/Program Files/ffmpeg/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe'
const hasFfmpeg = fs.existsSync(FFMPEG)

test('concat-sources decision: two paths compile in order, missing second source clarifies, resolution closes', () => {
  const decision = compileConcatSourcesDecisionList({ instruction: '把这个视频和 D:/视频/第二段.mp4 拼起来', sourcePath: SOURCE })
  assert.equal(decision.kind, 'media.concat-sources')
  assert.equal(decision.sources.length, 2)
  assert.equal(decision.sources[0].path, SOURCE)
  assert.equal(decision.sources[1].path, 'D:/视频/第二段.mp4')
  assert.equal(decision.output.overwrite, false)
  assert.match(decision.output.suffix, /合并版-2段/)

  // 三素材保序
  const triple = compileConcatSourcesDecisionList({ instruction: '把 D:/视频/第二段.mp4 和 D:/视频/第三段.mp4 接在当前视频后面，合成一个', sourcePath: SOURCE })
  assert.equal(triple.sources.length, 3)
  assert.deepEqual(triple.sources.map((item) => item.path), [SOURCE, 'D:/视频/第二段.mp4', 'D:/视频/第三段.mp4'])

  // 只有一个路径：不形成决策（当前视频不等于第二个素材）
  assert.equal(compileConcatSourcesDecisionList({ instruction: `把 ${SOURCE} 拼起来`, sourcePath: SOURCE }), null)
  // 没有拼接动词：不形成决策
  assert.equal(compileConcatSourcesDecisionList({ instruction: 'D:/视频/第二段.mp4', sourcePath: SOURCE }), null)

  // 缺第二素材：追问，且只追问这一项
  const clarification = planEditInstruction({ instruction: '把两个视频拼起来', sourcePath: SOURCE })
  assert.equal(clarification.matched, true)
  assert.equal(clarification.clarification.reason, 'missing-sources')
  assert.match(clarification.clarification.question, /哪个视频/)

  // 追问收口：只给第二个素材路径即可形成决策
  const resolved = resolveEditClarification({ clarification: clarification.clarification, answer: 'D:/视频/第二段.mp4' })
  assert.equal(resolved.matched, true)
  assert.equal(resolved.decision.kind, 'media.concat-sources')
  assert.deepEqual(resolved.decision.sources.map((item) => item.path), [SOURCE, 'D:/视频/第二段.mp4'])

  // 询问类不误执行
  assert.equal(planEditInstruction({ instruction: '能不能把两个视频拼起来？', sourcePath: SOURCE }).matched, false)
})

test('concat-sources wiring: task registered, decision routed, renderer gate accepts, quality checklist covers', () => {
  assert.match(main, /persistentTaskRuntime\.register\('media\.edit-concat-sources'/)
  assert.match(main, /decision\.kind === 'media\.concat-sources'/)
  assert.match(main, /'media\.edit-concat-sources'/, 'media:trim 路由必须含跨素材拼接')
  assert.match(main, /media\.edit-music' \|\| type === 'media\.edit-concat-sources'/, '质量修复清单必须含跨素材拼接')
  assert.match(main, /compileConcatSourcesDecisionList/)
  assert.match(panel, /'media\.concat-sources'/)
  assert.match(panel, /按顺序合并/)
  assert.match(runtime, /media\.edit-concat-sources/)
  assert.match(quality, /media\.edit-concat-sources/, '质量核查必须覆盖跨素材拼接')
  assert.match(packagedSmoke, /task\.result\?\.frameProof\?\.verdict !== 'matched'/)
  assert.match(packagedSmoke, /2个跨素材片段的首尾帧边界已核对/)
  assert.match(packagedSmoke, /fixtureMeta/)
})

test('concatSources fails before delivery when cross-source frame proof is unavailable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concat-sources-proof-missing-'))
  try {
    const videoA = path.join(dir, 'a.mp4')
    const videoB = path.join(dir, 'b.mp4')
    const output = path.join(dir, 'joined.mp4')
    fs.writeFileSync(videoA, Buffer.alloc(2048, 1))
    fs.writeFileSync(videoB, Buffer.alloc(2048, 2))
    const frames = {
      availability: () => ({ available: true }),
      probeDuration: async (file) => file === videoA ? 4 : file === videoB ? 3 : 7,
      probeHasAudio: async () => false,
      probeDimensions: async () => ({ width: 640, height: 360 }),
      run: async (args) => fs.writeFileSync(args.at(-1), Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
    }
    const decision = compileConcatSourcesDecisionList({ instruction: `把 ${videoA} 和 ${videoB} 拼起来`, sourcePath: videoA })
    await assert.rejects(new MediaEditService({ frames }).concatSources({ sourcePath: videoA, outputPath: output, decision }), /帧边界证明不可用/)
    assert.equal(fs.existsSync(output), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('real concatSources: mixed resolutions + silent source, output duration = sum, sources untouched', { timeout: 180000 }, async (t) => {
  if (!hasFfmpeg) return t.skip('本机无 ffmpeg')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concat-sources-'))
  try {
    const videoA = path.join(dir, '第一段.mp4')
    const videoB = path.join(dir, '第二段.mp4')
    const output = path.join(dir, '合并版.mp4')
    // A：640x360/15fps 有声 4 秒；B：320x240/24fps 无声 3 秒且不同色相（考验帧率、scale+pad 与补静音轨）
    let r = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=640x360:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', videoA, '-loglevel', 'error'], { timeout: 60000 })
    assert.equal(r.status, 0, String(r.stderr).slice(0, 200))
    r = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=3:size=320x240:rate=24,hue=h=90', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoB, '-loglevel', 'error'], { timeout: 60000 })
    assert.equal(r.status, 0, String(r.stderr).slice(0, 200))
    const sizeA = fs.statSync(videoA).size
    const sizeB = fs.statSync(videoB).size

    const frames = new VideoFrameService({ ffmpegPath: FFMPEG, ffprobePath: FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe') })
    const service = new MediaEditService({ frames })
    const decision = compileConcatSourcesDecisionList({ instruction: `把 ${videoA} 和 ${videoB} 拼起来`, sourcePath: videoA })
    const result = await service.concatSources({ sourcePath: videoA, outputPath: output, decision })
    assert.ok(fs.existsSync(output))
    const duration = await frames.probeDuration(output)
    assert.ok(Math.abs(duration - 7) < 0.35, `成果时长必须约等于两段之和 7 秒，实际 ${duration}`)
    assert.ok(await frames.probeHasAudio(output), '成果必须有音轨（无声段补静音）')
    const dims = await frames.probeDimensions(output)
    assert.deepEqual(dims, { width: 640, height: 360 }, '成果分辨率必须跟随第一段')
    assert.equal(result.timelineReceipt.length, 2)
    assert.equal(result.frameProof?.verdict, 'matched', JSON.stringify(result.frameProof))
    assert.equal(result.frameProof.boundaries?.length, 2)
    assert.ok(result.frameProof.boundaries.every((item) => item.first?.verdict === 'matched' && item.last?.verdict === 'matched'))
    assert.match(result.summary, /2个跨素材片段的首尾帧边界已核对/)
    // 源文件不动
    assert.equal(fs.statSync(videoA).size, sizeA)
    assert.equal(fs.statSync(videoB).size, sizeB)
    // 成果已存在必须拒绝覆盖
    await assert.rejects(() => service.concatSources({ sourcePath: videoA, outputPath: output, decision }), /已存在/)
    // verify 路径（断点续跑复核）也要通过
    const verified = await service.verify({ sourcePath: videoA, outputPath: output, decision })
    assert.ok(Math.abs(verified.expectedDurationSeconds - 7) < 0.35)

    const wrongOrderOutput = path.join(dir, '错误顺序.mp4')
    const wrongOrderDecision = compileConcatSourcesDecisionList({ instruction: `把 ${videoB} 和 ${videoA} 拼起来`, sourcePath: videoB })
    await service.concatSources({ sourcePath: videoB, outputPath: wrongOrderOutput, decision: wrongOrderDecision })
    await assert.rejects(
      service.verify({ sourcePath: videoA, outputPath: wrongOrderOutput, decision }),
      /帧边界校验失败/,
      '恢复必须拒绝素材顺序相反但总时长相同的成品'
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
