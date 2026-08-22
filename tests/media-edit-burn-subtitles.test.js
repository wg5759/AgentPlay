const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('child_process')

const { compileBurnSubtitlesDecisionList, planEditInstruction, resolveEditClarification } = require('../electron/media-edit-decision')
const { MediaEditService } = require('../electron/media-edit-service')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'useMediaCreativeTasks.ts'), 'utf8')
const runtime = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'usePersistentTaskRuntime.ts'), 'utf8')
const quality = fs.readFileSync(path.join(__dirname, '..', 'electron', 'task-result-quality.js'), 'utf8')

const SOURCE = 'D:/视频/纪录片.mp4'
const FFMPEG = process.env.AIPLAYER_FFMPEG || 'C:/Program Files/ffmpeg/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe'
const hasFfmpeg = fs.existsSync(FFMPEG)

test('burn-subtitles decision: path compiles, missing file clarifies, resolution closes, consultation stays out', () => {
  const decision = compileBurnSubtitlesDecisionList({ instruction: '把字幕 D:/视频/字幕.srt 烧进视频', sourcePath: SOURCE })
  assert.equal(decision.kind, 'media.burn-subtitles')
  assert.equal(decision.subtitle.path, 'D:/视频/字幕.srt')
  assert.equal(decision.subtitle.name, '字幕.srt')
  assert.equal(decision.output.overwrite, false)
  assert.match(decision.output.suffix, /硬字幕版/)

  // 其它烧录动词与字幕格式
  for (const [text, file] of [
    ['把 D:/视频/c.vtt 烧录到视频里', 'D:/视频/c.vtt'],
    ['把这个做成硬字幕，字幕文件是 D:/视频/c.ass', 'D:/视频/c.ass'],
    ['把字幕 D:/视频/c.ssa 压进画面', 'D:/视频/c.ssa']
  ]) {
    const item = compileBurnSubtitlesDecisionList({ instruction: text, sourcePath: SOURCE })
    assert.equal(item?.subtitle.path, file, text)
  }

  // 没有烧录动词：不形成决策
  assert.equal(compileBurnSubtitlesDecisionList({ instruction: 'D:/视频/字幕.srt', sourcePath: SOURCE }), null)
  // 有动词没文件：不形成决策（走追问）
  assert.equal(compileBurnSubtitlesDecisionList({ instruction: '把字幕烧进视频', sourcePath: SOURCE }), null)

  const clarification = planEditInstruction({ instruction: '把字幕烧进视频', sourcePath: SOURCE })
  assert.equal(clarification.matched, true)
  assert.equal(clarification.clarification.reason, 'missing-subtitle')
  assert.match(clarification.clarification.question, /哪个字幕文件/)

  const resolved = resolveEditClarification({ clarification: clarification.clarification, answer: 'D:/视频/字幕.srt' })
  assert.equal(resolved.matched, true)
  assert.equal(resolved.decision.kind, 'media.burn-subtitles')
  assert.equal(resolved.decision.subtitle.path, 'D:/视频/字幕.srt')

  // 询问句不误执行
  assert.equal(planEditInstruction({ instruction: '能不能把字幕烧进视频？', sourcePath: SOURCE }).matched, false)
})

test('burn-subtitles wiring: task registered, decision routed, renderer gate accepts, quality checklist covers', () => {
  assert.match(main, /persistentTaskRuntime\.register\('media\.edit-burn-subtitles'/)
  assert.match(main, /decision\.kind === 'media\.burn-subtitles'/)
  assert.match(main, /'media\.edit-burn-subtitles'/, 'media:trim 路由必须含烧录字幕')
  assert.match(main, /media\.edit-concat-sources' \|\| type === 'media\.edit-burn-subtitles'/, '质量修复清单必须含烧录字幕')
  assert.match(main, /compileBurnSubtitlesDecisionList/)
  assert.match(panel, /'media\.burn-subtitles'/)
  assert.match(panel, /烧录硬字幕/)
  assert.match(runtime, /media\.edit-burn-subtitles/)
  assert.match(quality, /media\.edit-burn-subtitles/, '质量核查必须覆盖烧录字幕')
})

test('real burnSubtitles: srt burned into frames, duration kept, sources untouched', { timeout: 180000 }, async (t) => {
  if (!hasFfmpeg) return t.skip('本机无 ffmpeg')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-subtitles-'))
  try {
    const video = path.join(dir, '纪录片.mp4')
    const srt = path.join(dir, '中文字幕.srt')
    const output = path.join(dir, '硬字幕版.mp4')
    let r = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=640x360:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video, '-loglevel', 'error'], { timeout: 60000 })
    assert.equal(r.status, 0, String(r.stderr).slice(0, 200))
    fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:03,000\n硬字幕验收第一条\n\n', 'utf8')
    const videoBefore = fs.statSync(video)
    const srtBefore = fs.statSync(srt)

    const ffprobe = FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe')
    const frames = {
      availability: () => ({ available: true }),
      probeDuration: async (file) => {
        const p = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 30000 })
        return Number(String(p.stdout).trim())
      },
      run: async (args) => {
        const p = spawnSync(FFMPEG, args, { timeout: 120000 })
        if (p.status !== 0) throw new Error(String(p.stderr).slice(0, 300))
      }
    }
    const service = new MediaEditService({ frames })
    const decision = compileBurnSubtitlesDecisionList({ instruction: `把字幕 ${srt} 烧进视频`, sourcePath: video })
    const result = await service.burnSubtitles({ sourcePath: video, outputPath: output, decision })
    assert.ok(fs.existsSync(output))
    const duration = await frames.probeDuration(output)
    assert.ok(Math.abs(duration - 4) < 0.2, `成果时长必须等于源视频 4 秒，实际 ${duration}`)
    assert.equal(result.timelineReceipt.length, 1)
    assert.match(result.summary, /原文件与字幕文件均未改动/)
    // 源与字幕文件不动
    assert.deepEqual([fs.statSync(video).size, Math.trunc(fs.statSync(video).mtimeMs)], [videoBefore.size, Math.trunc(videoBefore.mtimeMs)])
    assert.deepEqual([fs.statSync(srt).size, Math.trunc(fs.statSync(srt).mtimeMs)], [srtBefore.size, Math.trunc(srtBefore.mtimeMs)])
    // 抽帧验证字幕真的烧进画面：字幕活跃时刻（2s）与源同刻帧差异显著，安静时刻（3.9s）差异小
    const readGray = (file, seconds, name) => {
      const target = path.join(dir, `${name}.gray`)
      const p = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'scale=32:32,format=gray', '-f', 'rawvideo', '-y', target, '-loglevel', 'error'], { timeout: 60000 })
      assert.equal(p.status, 0, String(p.stderr).slice(0, 200))
      return fs.readFileSync(target)
    }
    const meanAbsDiff = (a, b) => {
      let sum = 0
      for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i])
      return sum / a.length
    }
    const activeDiff = meanAbsDiff(readGray(video, 2, 'src-active'), readGray(output, 2, 'out-active'))
    const quietDiff = meanAbsDiff(readGray(video, 3.9, 'src-quiet'), readGray(output, 3.9, 'out-quiet'))
    assert.ok(activeDiff > 0.8, `字幕活跃帧差异应显著（实测 ${activeDiff}）`)
    assert.ok(activeDiff > quietDiff * 2, `字幕活跃帧差异应明显大于安静帧（活跃 ${activeDiff} / 安静 ${quietDiff}）`)
    // 成果已存在必须拒绝覆盖
    await assert.rejects(() => service.burnSubtitles({ sourcePath: video, outputPath: output, decision }), /已存在/)
    // verify 路径（断点续跑复核）也要通过
    const verified = await service.verify({ sourcePath: video, outputPath: output, decision })
    assert.ok(Math.abs(verified.expectedDurationSeconds - 4) < 0.2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
