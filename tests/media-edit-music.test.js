const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('child_process')

const { compileMusicDecisionList, planEditInstruction, resolveEditClarification } = require('../electron/media-edit-decision')
const { MediaEditService } = require('../electron/media-edit-service')
const { VideoFrameService } = require('../electron/video-frame-service')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'useMediaCreativeTasks.ts'), 'utf8')
const runtime = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'usePersistentTaskRuntime.ts'), 'utf8')
const types = fs.readFileSync(path.join(__dirname, '..', 'src', 'types', 'global.d.ts'), 'utf8')

const SOURCE = 'D:/视频/demo.mp4'
const FFMPEG = process.env.AIPLAYER_FFMPEG || 'C:/Program Files/ffmpeg/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe'
const hasFfmpeg = fs.existsSync(FFMPEG)

test('music decision: path+volume compile, missing-audio clarifies with copyright guard, remove-music stays out', () => {
  const decision = compileMusicDecisionList({ instruction: '给视频加背景音乐 D:/Music/bgm.mp3', sourcePath: SOURCE })
  assert.equal(decision.kind, 'media.add-music')
  assert.equal(decision.audio.path, 'D:/Music/bgm.mp3')
  assert.equal(decision.audio.volume, 0.15)
  assert.equal(decision.audio.duck, true)
  assert.deepEqual(decision.audio.loudness, {
    enabled: true,
    targetLufs: -16,
    targetTruePeakDbtp: -1.5,
    maxTruePeakDbtp: -1,
    lra: 11,
    toleranceLufs: 0.7
  })
  assert.equal(decision.output.overwrite, false)

  const quiet = compileMusicDecisionList({ instruction: '背景音乐音量调到10%，用 D:/Music/bgm.mp3', sourcePath: SOURCE })
  assert.equal(quiet.audio.volume, 0.1)

  const clarification = planEditInstruction({ instruction: '给视频配个背景音乐', sourcePath: SOURCE })
  assert.equal(clarification.clarification.reason, 'missing-audio')
  assert.match(clarification.clarification.question, /合法文件|不会去网上抓/, '必须带版权红线提示')

  // 追问收口：只给路径即可形成决策
  const resolved = resolveEditClarification({ clarification: clarification.clarification, answer: 'D:/Music/钢琴曲.wav' })
  assert.equal(resolved.decision.kind, 'media.add-music')
  assert.equal(resolved.decision.audio.path, 'D:/Music/钢琴曲.wav')

  // 去掉背景音乐不在本切片（不误执行）
  assert.equal(compileMusicDecisionList({ instruction: '去掉背景音乐', sourcePath: SOURCE }), null)
  // 询问/否定类不误执行
  assert.equal(planEditInstruction({ instruction: '能不能加背景音乐', sourcePath: SOURCE }).matched, false)
  for (const instruction of [
    '能不能给视频加背景音乐 D:/Music/bgm.mp3？',
    '比如给视频加背景音乐 D:/Music/bgm.mp3',
    '不要给视频加背景音乐 D:/Music/bgm.mp3'
  ]) assert.equal(compileMusicDecisionList({ instruction, sourcePath: SOURCE }), null, instruction)
})

test('music decision freezes a selected music range, loop policy and final-bus loudness target', () => {
  const decision = compileMusicDecisionList({
    instruction: '给视频加背景音乐 D:/Music/bgm.mp3，用音乐第10秒到第30秒，循环铺满，响度归一到-16 LUFS',
    sourcePath: SOURCE
  })

  assert.deepEqual(decision.audio.selection, { startSeconds: 10, endSeconds: 30, durationSeconds: 20 })
  assert.equal(decision.audio.loop, true)
  assert.deepEqual(decision.audio.loudness, {
    enabled: true,
    targetLufs: -16,
    targetTruePeakDbtp: -1.5,
    maxTruePeakDbtp: -1,
    lra: 11,
    toleranceLufs: 0.7
  })
})

test('music decision honours an explicit play-once and no-normalization request', () => {
  const decision = compileMusicDecisionList({
    instruction: '给视频加背景音乐 D:/Music/bgm.mp3，只播放一次，不要循环，也不要响度归一',
    sourcePath: SOURCE
  })

  assert.equal(decision.audio.loop, false)
  assert.equal(decision.audio.loudness.enabled, false)
})

test('music wiring: task registered, decision routed, renderer gate accepts, timeline edit set updated', () => {
  assert.match(main, /persistentTaskRuntime\.register\('media\.edit-music'/)
  assert.match(main, /decision\.kind === 'media\.add-music'/)
  assert.match(main, /media\.edit-music' \|\| type === 'media\.edit-concat'|media\.edit-trim' \|\| type === 'media\.edit-remove' \|\| type === 'media\.edit-concat' \|\| type === 'media\.edit-music'/, '质量修复清单必须含配乐')
  assert.match(main, /compileMusicDecisionList/)
  assert.match(main, /响度.*LUFS/)
  assert.match(main, /decision\.kind === 'media\.add-music'[\s\S]{0,180}\[sourcePath, assertAllowedPath\(decision\.audio\?\.path \|\| ''\)\]/, '配乐任务快照必须同时冻结视频和音乐文件')
  assert.match(panel, /'media\.add-music'/)
  assert.match(panel, /对白闪避/)
  assert.match(panel, /operation === 'music' \? '音乐' : '源片'/)
  assert.match(panel, /两遍响度/)
  assert.match(runtime, /media\.edit-music/)
  assert.match(types, /selection\?: \{ startSeconds: number; endSeconds: number; durationSeconds: number \}/)
  assert.match(types, /loudness\?: \{ enabled: boolean; targetLufs: number; targetTruePeakDbtp: number; maxTruePeakDbtp: number; lra: number; toleranceLufs: number \}/)
})

test('packaged music acceptance proves the installed conversation path and decoded audio receipt', () => {
  const smokePath = path.join(__dirname, '..', 'scripts', 'smoke-packaged-media-music.mjs')
  assert.ok(fs.existsSync(smokePath), '必须有独立安装态配乐验收脚本')
  const smoke = fs.readFileSync(smokePath, 'utf8')
  assert.match(smoke, /media\.edit-music/)
  assert.match(smoke, /audio-proof/)
  assert.match(smoke, /audioProof\?\.verdict !== 'matched'/)
  assert.match(smoke, /loudness-proof/)
  assert.match(smoke, /loudnessProof\?\.verdict !== 'matched'/)
  assert.match(smoke, /integratedLufs/)
  assert.match(smoke, /samplePeakDbfs/)
  assert.match(smoke, /sourceBefore/)
  assert.match(smoke, /musicBefore/)
})

test('addMusic rejects a music file changed during processing before atomic delivery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-source-mutation-'))
  try {
    const source = path.join(dir, 'source.mp4')
    const music = path.join(dir, 'music.wav')
    const output = path.join(dir, 'output.mp4')
    fs.writeFileSync(source, Buffer.alloc(4096, 1))
    fs.writeFileSync(music, Buffer.alloc(4096, 2))
    const pcm = Buffer.alloc(16000)
    for (let offset = 0; offset + 1 < pcm.length; offset += 2) pcm.writeInt16LE(offset % 8 < 4 ? 2400 : -2400, offset)
    const frames = {
      availability: () => ({ available: true }),
      probeDuration: async (file) => file === music ? 6 : 4,
      probeHasAudio: async (file) => file !== source,
      probeAudioLevels: async () => ({ meanVolumeDbfs: -20, samplePeakDbfs: -3 }),
      readPcmWindow: async () => pcm,
      run: async (args) => {
        const target = args.at(-1)
        fs.writeFileSync(target, Buffer.alloc(4096, 3))
        fs.appendFileSync(music, Buffer.from([9]))
      }
    }
    const service = new MediaEditService({ frames })
    const decision = compileMusicDecisionList({ instruction: `给视频加背景音乐 ${music}，不要响度归一`, sourcePath: source })
    await assert.rejects(() => service.addMusic({ sourcePath: source, outputPath: output, decision }), /音乐文件.*变化/)
    assert.equal(fs.existsSync(output), false, '音乐来源变化时不得留下交付文件')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('real addMusic: mixes local music with ducking, keeps source duration, audio stream present', { timeout: 180000 }, async (t) => {
  if (!hasFfmpeg) return t.skip('本机无 ffmpeg')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-edit-'))
  try {
    const video = path.join(dir, '源视频.mp4')
    const silentVideo = path.join(dir, '无原声视频.mp4')
    const audio = path.join(dir, '配乐.mp3')
    const output = path.join(dir, '配乐版.mp4')
    const silentOutput = path.join(dir, '无原声配乐版.mp4')
    // 4 秒有声视频（440Hz 正弦当"人声"）+ 6 秒音乐（220Hz）
    for (const [file, freq, dur] of [[video, '440', '4'], [audio, '220', '6']]) {
      const args = file === video
        ? ['-y', '-f', 'lavfi', '-i', `testsrc2=duration=${dur}:size=640x360:rate=15`, '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${dur}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file, '-loglevel', 'error']
        : ['-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${dur}`, '-c:a', 'libmp3lame', file, '-loglevel', 'error']
      const r = spawnSync(FFMPEG, args, { timeout: 60000 })
      assert.equal(r.status, 0, String(r.stderr).slice(0, 200))
    }
    const silentBuild = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=640x360:rate=15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', silentVideo, '-loglevel', 'error'], { timeout: 60000 })
    assert.equal(silentBuild.status, 0, String(silentBuild.stderr).slice(0, 200))
    const frames = new VideoFrameService({ ffmpegPath: FFMPEG, ffprobePath: FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe') })
    const service = new MediaEditService({ frames })
    const decision = compileMusicDecisionList({ instruction: `给视频加背景音乐 ${audio}`, sourcePath: video })
    const result = await service.addMusic({ sourcePath: video, outputPath: output, decision })
    assert.ok(fs.existsSync(output))
    const duration = await frames.probeDuration(output)
    assert.ok(Math.abs(duration - 4) < 0.2, `时长必须等于源视频 4 秒，实际 ${duration}`)
    assert.ok(await frames.probeHasAudio(output), '成果必须有音轨')
    assert.equal(result.music.volume, 0.15)
    assert.equal(result.music.duck, true)
    assert.equal(result.audioProof.schemaVersion, 1)
    assert.equal(result.audioProof.method, 'decoded-pcm-s16le-v1')
    assert.equal(result.audioProof.verdict, 'matched')
    assert.equal(result.audioProof.output.nonSilent, true)
    assert.equal(result.audioProof.output.overloadFree, true)
    assert.ok(result.audioProof.output.samplePeakDbfs < -0.05, `样本峰值必须留有余量，实际 ${result.audioProof.output.samplePeakDbfs} dBFS`)
    assert.equal(result.audioProof.change.verdict, 'changed')
    assert.ok(result.audioProof.change.changedWindows > 0)
    assert.equal(result.audioProof.fades.fadeIn.verdict, 'matched')
    assert.equal(result.audioProof.fades.fadeOut.verdict, 'matched')
    assert.deepEqual(result.audioProof.ducking, { requested: true, configured: true, claim: 'configuration-only' })
    assert.equal(result.loudnessProof.schemaVersion, 1)
    assert.equal(result.loudnessProof.method, 'ebur128-post-encode-v1')
    assert.equal(result.loudnessProof.verdict, 'matched')
    assert.ok(Math.abs(result.loudnessProof.integratedLufs - (-16)) <= 0.7, `成片 LUFS 必须靠近 -16，实际 ${result.loudnessProof.integratedLufs}`)
    assert.ok(result.loudnessProof.truePeakDbtp <= -1, `成片 true peak 必须不高于 -1 dBTP，实际 ${result.loudnessProof.truePeakDbtp}`)
    const recovered = await service.verify({ sourcePath: video, outputPath: output, decision })
    assert.equal(recovered.audioProof.verdict, 'matched', '重启恢复必须重新核验已有成片，而不是走普通剪辑时长字段')
    assert.equal(recovered.expectedDurationSeconds, result.expectedDurationSeconds)

    const silentDecision = compileMusicDecisionList({ instruction: `给视频加背景音乐 ${audio}`, sourcePath: silentVideo })
    const silentResult = await service.addMusic({ sourcePath: silentVideo, outputPath: silentOutput, decision: silentDecision })
    assert.equal(silentResult.audioProof.verdict, 'matched')
    assert.equal(silentResult.audioProof.output.nonSilent, true)
    assert.equal(silentResult.audioProof.change.verdict, 'changed')
    assert.deepEqual(silentResult.audioProof.ducking, { requested: true, configured: false, claim: 'configuration-only' })
    // 源文件不动
    assert.ok(fs.statSync(video).size > 0)
    // 时长不符应拒绝：故意篡改 verification 不现实，这里验证不能覆盖已存在成果
    await assert.rejects(() => service.addMusic({ sourcePath: video, outputPath: output, decision }), /已存在/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('real addMusic: selected music range loops instead of replaying the full source track', { timeout: 180000 }, async (t) => {
  if (!hasFfmpeg) return t.skip('本机无 ffmpeg')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-selection-'))
  try {
    const video = path.join(dir, 'silent-video.mp4')
    const music = path.join(dir, 'three-tone.wav')
    const output = path.join(dir, 'selected-loop.mp4')
    const videoBuild = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=320x240:rate=15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', video, '-loglevel', 'error'], { timeout: 60000 })
    assert.equal(videoBuild.status, 0, String(videoBuild.stderr).slice(0, 200))
    const musicBuild = spawnSync(FFMPEG, [
      '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2',
      '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[music]', '-map', '[music]', '-c:a', 'pcm_s16le', music, '-loglevel', 'error'
    ], { timeout: 60000 })
    assert.equal(musicBuild.status, 0, String(musicBuild.stderr).slice(0, 200))
    const frames = new VideoFrameService({ ffmpegPath: FFMPEG, ffprobePath: FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe') })
    const service = new MediaEditService({ frames })
    const decision = compileMusicDecisionList({ instruction: `给视频加背景音乐 ${music}，用音乐第2秒到第4秒，循环铺满`, sourcePath: video })
    const result = await service.addMusic({ sourcePath: video, outputPath: output, decision })
    assert.deepEqual(result.music.selection, { startSeconds: 2, endSeconds: 4, durationSeconds: 2 })
    assert.equal(result.music.loop, true)
    const estimateFrequency = (buffer, durationSeconds) => {
      let crossings = 0
      let previous = buffer.readInt16LE(0)
      for (let offset = 2; offset + 1 < buffer.length; offset += 2) {
        const current = buffer.readInt16LE(offset)
        if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) crossings += 1
        previous = current
      }
      return crossings / (2 * durationSeconds)
    }
    for (const at of [0.8, 3.2]) {
      const pcm = await frames.readPcmWindow(output, at, { durationSeconds: 0.5, sampleRateHz: 16000 })
      const frequency = estimateFrequency(pcm, 0.5)
      assert.ok(frequency >= 850 && frequency <= 910, `第 ${at} 秒应来自选中的 880Hz 音乐段，实测约 ${frequency}Hz`)
    }
    assert.equal(result.loudnessProof.verdict, 'matched')
    const recovered = await service.verify({ sourcePath: video, outputPath: output, decision })
    assert.deepEqual(recovered.music.selection, { startSeconds: 2, endSeconds: 4, durationSeconds: 2 })
    assert.equal(recovered.audioProof.selection.startSeconds, 2)
    const invalidDecision = { ...decision, audio: { ...decision.audio, selection: { startSeconds: 5, endSeconds: 8, durationSeconds: 3 } } }
    await assert.rejects(() => service.addMusic({ sourcePath: video, outputPath: path.join(dir, 'invalid.mp4'), decision: invalidDecision }), /超出文件时长/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('real addMusic: play-once music ends without looping while the video keeps a full audio timeline', { timeout: 180000 }, async (t) => {
  if (!hasFfmpeg) return t.skip('本机无 ffmpeg')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-play-once-'))
  try {
    const video = path.join(dir, 'silent-video.mp4')
    const music = path.join(dir, 'one-second.wav')
    const output = path.join(dir, 'play-once.mp4')
    const videoBuild = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=320x240:rate=15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', video, '-loglevel', 'error'], { timeout: 60000 })
    const musicBuild = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1', '-c:a', 'pcm_s16le', music, '-loglevel', 'error'], { timeout: 60000 })
    assert.equal(videoBuild.status, 0, String(videoBuild.stderr).slice(0, 200))
    assert.equal(musicBuild.status, 0, String(musicBuild.stderr).slice(0, 200))
    const frames = new VideoFrameService({ ffmpegPath: FFMPEG, ffprobePath: FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe') })
    const service = new MediaEditService({ frames })
    const decision = compileMusicDecisionList({ instruction: `给视频加背景音乐 ${music}，只播放一次，不要循环，也不要响度归一`, sourcePath: video })
    const result = await service.addMusic({ sourcePath: video, outputPath: output, decision })
    assert.equal(result.music.loop, false)
    assert.equal(result.loudnessProof.verdict, 'not-requested')
    assert.ok(Math.abs(result.durationSeconds - 4) <= 0.2)
    assert.ok(await frames.probeHasAudio(output), '播放一次的音乐结束后仍须保留完整音轨')
    const active = await frames.readPcmWindow(output, 0.35, { durationSeconds: 0.2, sampleRateHz: 16000 })
    const ended = await frames.readPcmWindow(output, 2.5, { durationSeconds: 0.3, sampleRateHz: 16000 })
    const rms = (buffer) => {
      let sum = 0
      const samples = Math.floor(buffer.length / 2)
      for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
        const value = buffer.readInt16LE(offset) / 32768
        sum += value * value
      }
      return Math.sqrt(sum / samples)
    }
    assert.ok(rms(active) > 0.001, '音乐播放区间必须有可听样本')
    assert.ok(rms(ended) < 0.0002, '音乐结束后不得再次循环')
    const recovered = await service.verify({ sourcePath: video, outputPath: output, decision })
    assert.equal(recovered.music.loop, false)
    assert.equal(recovered.loudnessProof.verdict, 'not-requested')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
