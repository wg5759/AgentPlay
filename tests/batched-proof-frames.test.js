const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { VideoFrameService } = require('../electron/video-frame-service')
const ffmpeg = process.env.AIPLAYER_FFMPEG || 'C:/Program Files/ffmpeg/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe'

test('batched proof samples match the scalar pixels, including padded source and end frames', { timeout: 120000 }, async t => {
  if (!fs.existsSync(ffmpeg)) return t.skip('ffmpeg unavailable')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-proof-batch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source.mp4')
  const made = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=24:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { windowsHide: true, timeout: 30000 })
  assert.equal(made.status, 0)
  const frames = new VideoFrameService({ ffmpegPath: ffmpeg })
  const requests = [['first', 0], ['first', 0.067], ['first', 0.5], ['last', 1.5], ['last', 2.001], ['first', 2.3]].map(([kind, at], index) => ({ key: String(index), file: source, kind, at, fitWidth: 640, fitHeight: 360 }))
  const batched = await frames.readProofFrames(requests, { signal: t.signal })
  assert.equal(batched.size, 5, 'an empty EOF sample must not invalidate the other batch samples')
  for (const request of requests) {
    const scalar = request.kind === 'last' ? await frames.readLastGrayFrame(source, request.at, { ...request, signal: t.signal }) : await frames.readGrayFrame(source, request.at, { ...request, signal: t.signal })
    assert.deepEqual(batched.get(request.key) || null, scalar, `${request.kind}@${request.at}`)
  }
})
