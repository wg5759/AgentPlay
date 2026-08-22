const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('child_process')

const { compileMuxSubtitlesDecisionList, planEditInstruction, resolveEditClarification } = require('../electron/media-edit-decision')
const { MediaEditService } = require('../electron/media-edit-service')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'useMediaCreativeTasks.ts'), 'utf8')
const runtime = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'usePersistentTaskRuntime.ts'), 'utf8')
const quality = fs.readFileSync(path.join(__dirname, '..', 'electron', 'task-result-quality.js'), 'utf8')

const SOURCE = 'D:/视频/纪录片.mp4'
const FFMPEG = process.env.AIPLAYER_FFMPEG || 'C:/Program Files/ffmpeg/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe'
const hasFfmpeg = fs.existsSync(FFMPEG)

test('mux-subtitles decision: soft-mux verbs compile, burn verbs stay with burn, clarification closes', () => {
  const decision = compileMuxSubtitlesDecisionList({ instruction: '把字幕 D:/视频/字幕.srt 封装进视频', sourcePath: SOURCE })
  assert.equal(decision.kind, 'media.mux-subtitles')
  assert.equal(decision.subtitle.path, 'D:/视频/字幕.srt')
  assert.equal(decision.output.overwrite, false)
  assert.match(decision.output.suffix, /软字幕版/)
  assert.equal(decision.verification.requireSubtitleStream, true)

  // 其它软封装说法
  assert.equal(compileMuxSubtitlesDecisionList({ instruction: '给这个视频加个软字幕 D:/视频/字幕.vtt', sourcePath: SOURCE })?.subtitle.path, 'D:/视频/字幕.vtt')
  assert.equal(compileMuxSubtitlesDecisionList({ instruction: '把 D:/视频/字幕.ass 外挂到视频里', sourcePath: SOURCE })?.kind, 'media.mux-subtitles')

  // 烧录动词不会被误判成封装
  assert.equal(compileMuxSubtitlesDecisionList({ instruction: '把字幕 D:/视频/字幕.srt 烧进视频', sourcePath: SOURCE }), null)
  // 只有 .srt 路径+封装动词（无"字幕"字样）也是无歧义封装意图
  assert.equal(compileMuxSubtitlesDecisionList({ instruction: '把 D:/视频/字幕.srt 封装一下', sourcePath: SOURCE })?.kind, 'media.mux-subtitles')
  // 没有路径：不形成决策
  assert.equal(compileMuxSubtitlesDecisionList({ instruction: '把字幕封装进视频', sourcePath: SOURCE }), null)

  // 缺文件：追问
  const clarification = planEditInstruction({ instruction: '把字幕封装进视频', sourcePath: SOURCE })
  assert.equal(clarification.matched, true)
  assert.equal(clarification.clarification.reason, 'missing-subtitle-mux')
  assert.match(clarification.clarification.question, /可开关的软字幕/)

  const resolved = resolveEditClarification({ clarification: clarification.clarification, answer: 'D:/视频/字幕.srt' })
  assert.equal(resolved.matched, true)
  assert.equal(resolved.decision.kind, 'media.mux-subtitles')
  assert.equal(resolved.decision.subtitle.path, 'D:/视频/字幕.srt')

  // 烧录的缺文件追问不受封装影响
  const burnClarification = planEditInstruction({ instruction: '把字幕烧进视频', sourcePath: SOURCE })
  assert.equal(burnClarification.clarification?.reason, 'missing-subtitle')
  // 询问句不误执行
  assert.equal(planEditInstruction({ instruction: '能不能把字幕封装进视频？', sourcePath: SOURCE }).matched, false)
})

test('mux-subtitles wiring: task registered, decision routed, renderer gate accepts, quality checklist covers', () => {
  assert.match(main, /persistentTaskRuntime\.register\('media\.edit-mux-subtitles'/)
  assert.match(main, /decision\.kind === 'media\.mux-subtitles'/)
  assert.match(main, /'media\.edit-mux-subtitles'/)
  assert.match(main, /compileMuxSubtitlesDecisionList/)
  assert.match(main, /media\.edit-burn-subtitles' \|\| type === 'media\.edit-mux-subtitles'/, '质量修复清单必须含软字幕封装')
  assert.match(panel, /'media\.mux-subtitles'/)
  assert.match(panel, /封装软字幕/)
  assert.match(runtime, /media\.edit-mux-subtitles/)
  assert.match(quality, /media\.edit-mux-subtitles/, '质量核查必须覆盖软字幕封装')
})

test('real muxSubtitles: soft subtitle track muxed without re-encode, duration kept, sources untouched', { timeout: 180000 }, async (t) => {
  if (!hasFfmpeg) return t.skip('本机无 ffmpeg')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mux-subtitles-'))
  try {
    const video = path.join(dir, '纪录片.mp4')
    const srt = path.join(dir, '中文字幕.srt')
    const output = path.join(dir, '软字幕版.mp4')
    let r = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=640x360:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video, '-loglevel', 'error'], { timeout: 60000 })
    assert.equal(r.status, 0, String(r.stderr).slice(0, 200))
    fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:03,000\n封装验收字幕\n\n', 'utf8')
    const videoBefore = fs.statSync(video)
    const srtBefore = fs.statSync(srt)

    const ffprobe = FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe')
    const probeStream = (file, selector, entries) => {
      const p = spawnSync(ffprobe, ['-v', 'error', '-select_streams', selector, '-show_entries', entries, '-of', 'csv=p=0', file], { timeout: 30000 })
      return String(p.stdout).trim()
    }
    const frames = {
      availability: () => ({ available: true }),
      probeDuration: async (file) => Number(probeStream(file, 'v:0', 'format=duration') || String(spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 30000 }).stdout).trim()),
      probeHasSubtitle: async (file) => probeStream(file, 's:0', 'stream=index').length > 0,
      run: async (args) => {
        const p = spawnSync(FFMPEG, args, { timeout: 120000 })
        if (p.status !== 0) throw new Error(String(p.stderr).slice(0, 300))
      }
    }
    const service = new MediaEditService({ frames })
    const decision = compileMuxSubtitlesDecisionList({ instruction: `把字幕 ${srt} 封装进视频`, sourcePath: video })
    const startedAt = Date.now()
    const result = await service.muxSubtitles({ sourcePath: video, outputPath: output, decision })
    const elapsedMs = Date.now() - startedAt
    assert.ok(fs.existsSync(output))
    const duration = Number(String(spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', output], { timeout: 30000 }).stdout).trim())
    assert.ok(Math.abs(duration - 4) < 0.2, `成果时长必须等于源视频 4 秒，实际 ${duration}`)
    // 字幕轨在位且是 mov_text
    assert.match(probeStream(output, 's:0', 'stream=codec_name'), /mov_text/)
    // 音画流不重编码：仍是 h264/aac，且秒级完成（copy 应远快于重编码）
    assert.match(probeStream(output, 'v:0', 'stream=codec_name'), /h264/)
    assert.match(probeStream(output, 'a:0', 'stream=codec_name'), /aac/)
    assert.ok(elapsedMs < 20000, `copy 封装应秒级完成，实际 ${elapsedMs}ms`)
    assert.equal(result.timelineReceipt.length, 1)
    assert.match(result.summary, /可开关的软字幕轨/)
    // 源视频与字幕文件不动
    assert.deepEqual([fs.statSync(video).size, Math.trunc(fs.statSync(video).mtimeMs)], [videoBefore.size, Math.trunc(videoBefore.mtimeMs)])
    assert.deepEqual([fs.statSync(srt).size, Math.trunc(fs.statSync(srt).mtimeMs)], [srtBefore.size, Math.trunc(srtBefore.mtimeMs)])
    // 覆盖已存在成果：故障关闭
    await assert.rejects(() => service.muxSubtitles({ sourcePath: video, outputPath: output, decision }), /已存在/)
    // verify 路径（断点续跑复核）：时长+字幕轨双核验通过
    const verified = await service.verify({ sourcePath: video, outputPath: output, decision })
    assert.ok(Math.abs(verified.expectedDurationSeconds - 4) < 0.2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
