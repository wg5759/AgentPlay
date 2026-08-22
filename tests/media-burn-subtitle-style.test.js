const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('child_process')

const { compileBurnSubtitlesDecisionList, burnForceStyle } = require('../electron/media-edit-decision')
const { MediaEditService } = require('../electron/media-edit-service')

const SOURCE = 'D:/视频/纪录片.mp4'
const FFMPEG = process.env.AIPLAYER_FFMPEG || 'C:/Program Files/ffmpeg/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe'
const hasFfmpeg = fs.existsSync(FFMPEG)

test('burn style decision: font size / alignment / color extracted; plain burn unaffected', () => {
  const styled = compileBurnSubtitlesDecisionList({ instruction: '把字幕 D:/视频/字幕.srt 烧进视频，字号大一点，放顶部，黄色', sourcePath: SOURCE })
  assert.deepEqual(styled.subtitle.style, { fontSize: 'large', alignment: 'top', color: '黄色' })
  assert.match(styled.output.suffix, /硬字幕版-大字-顶部-黄色/)

  const small = compileBurnSubtitlesDecisionList({ instruction: '把字幕 D:/视频/字幕.srt 烧进视频，字小一点，红色', sourcePath: SOURCE })
  assert.deepEqual(small.subtitle.style, { fontSize: 'small', color: '红色' })

  const plain = compileBurnSubtitlesDecisionList({ instruction: '把字幕 D:/视频/字幕.srt 烧进视频', sourcePath: SOURCE })
  assert.equal(plain.subtitle.style, undefined)
  assert.equal(plain.output.suffix, '硬字幕版')

  // force_style 映射（SSA 语义：6=顶中 2=底中；颜色 &H00BBGGRR）
  assert.equal(burnForceStyle({ fontSize: 'large', alignment: 'top', color: '黄色' }), 'FontSize=32,Alignment=6,PrimaryColour=&H0000FFFF')
  assert.equal(burnForceStyle({ alignment: 'bottom' }), 'Alignment=2')
  assert.equal(burnForceStyle(null), '')
})

test('real burnSubtitles with style: yellow top large text lands in top band with yellow pixels', { timeout: 180000 }, async (t) => {
  if (!hasFfmpeg) return t.skip('本机无 ffmpeg')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-style-'))
  try {
    const video = path.join(dir, '纪录片.mp4')
    const srt = path.join(dir, '字幕.srt')
    let r = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=c=0x202020:duration=4:size=640x360:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video, '-loglevel', 'error'], { timeout: 60000 })
    assert.equal(r.status, 0, String(r.stderr).slice(0, 200))
    fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:03,500\n样式验收字幕行\n\n', 'utf8')

    const ffprobe = FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe')
    const frames = {
      availability: () => ({ available: true }),
      probeDuration: async (file) => Number(String(spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 30000 }).stdout).trim()),
      run: async (args) => {
        const p = spawnSync(FFMPEG, args, { timeout: 120000 })
        if (p.status !== 0) throw new Error(String(p.stderr).slice(0, 300))
      }
    }
    const service = new MediaEditService({ frames })

    // 默认（白字底部）与 大字号黄色顶部 两版
    const plainOut = path.join(dir, '默认版.mp4')
    const styledOut = path.join(dir, '黄字顶部版.mp4')
    const plainDecision = compileBurnSubtitlesDecisionList({ instruction: `把字幕 ${srt} 烧进视频`, sourcePath: video })
    const styledDecision = compileBurnSubtitlesDecisionList({ instruction: `把字幕 ${srt} 烧进视频，字号大一点，放顶部，黄色`, sourcePath: video })
    await service.burnSubtitles({ sourcePath: video, outputPath: plainOut, decision: plainDecision })
    await service.burnSubtitles({ sourcePath: video, outputPath: styledOut, decision: styledDecision })

    // 抽 2s 帧成 64x36 rgb24 裸数据做像素分析
    const readRgb = (file, name) => {
      const target = path.join(dir, `${name}.rgb`)
      const p = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-ss', '2', '-i', file, '-frames:v', '1', '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-y', target, '-loglevel', 'error'], { timeout: 60000 })
      assert.equal(p.status, 0, String(p.stderr).slice(0, 200))
      return fs.readFileSync(target)
    }
    const W = 64
    // YUV 有限范围会整体压暗（实测亮黄 254→147）：谓词用通道差而非绝对亮度
    const yellowCount = (buf, rowStart, rowEnd) => {
      let count = 0
      for (let y = rowStart; y < rowEnd; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const i = (y * W + x) * 3
          if (buf[i] > 90 && buf[i] - buf[i + 2] > 50 && buf[i + 1] - buf[i + 2] > 50) count += 1
        }
      }
      return count
    }
    const bandInk = (buf, rowStart, rowEnd) => {
      // 字幕本体（任何亮色文字）计数：背景 0x20≈32，文字压缩后仍在 90+
      let count = 0
      for (let y = rowStart; y < rowEnd; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const i = (y * W + x) * 3
          if (Math.max(buf[i], buf[i + 1], buf[i + 2]) > 60) count += 1
        }
      }
      return count
    }
    const src = readRgb(video, 'src')
    const plain = readRgb(plainOut, 'plain')
    const styled = readRgb(styledOut, 'styled')

    // 黄色：样式版全图可见黄像素，默认版（白字）为零
    const styledYellow = yellowCount(styled, 0, 36)
    const plainYellow = yellowCount(plain, 0, 36)
    assert.ok(styledYellow > 20, `样式版应有黄色字幕像素，实测 ${styledYellow}`)
    assert.ok(plainYellow <= 2, `默认白字版不应有黄色像素，实测 ${plainYellow}`)
    // 顶部：样式版顶部带（前 6 行）有字幕像素；默认版字幕在底部（后 6 行）有、顶部几乎没有
    const styledTop = bandInk(styled, 0, 6)
    const plainTop = bandInk(plain, 0, 6)
    const plainBottom = bandInk(plain, 30, 36)
    assert.ok(styledTop > 10, `样式版顶部带应有字幕像素，实测 ${styledTop}`)
    assert.ok(plainBottom > 10 && plainTop <= 2, `默认版字幕应落底部（顶 ${plainTop} / 底 ${plainBottom}）`)
    // 源帧无字幕像素干扰基线
    assert.ok(bandInk(src, 0, 6) === 0 && bandInk(src, 30, 36) === 0, '源视频不应有字幕像素')
    // 时长保持
    const duration = await frames.probeDuration(styledOut)
    assert.ok(Math.abs(duration - 4) < 0.2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
