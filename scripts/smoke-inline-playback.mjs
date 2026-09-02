import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const { InlinePlaybackService } = require('../electron/inline-playback-service.js')
const value = key => process.argv.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3)
const ffmpeg = value('ffmpeg')
const ffprobe = value('ffprobe')
const mpv = value('mpv')
assert.ok(ffmpeg && ffprobe && mpv, 'Pass explicit --ffmpeg, --ffprobe and --mpv paths')
const root = fs.mkdtempSync(path.join(path.resolve('release'), 'inline-playback-smoke-'))
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const allowed = new Set()
const service = new InlinePlaybackService({ cacheDir: path.join(root, 'cache'), ffmpegPath: ffmpeg, ffprobePath: ffprobe, mpvPath: mpv,
  authorizePath: p => { assert.ok(allowed.has(p)); return p }
})
const cases = [
  ['mpeg4.mp4', ['-c:v', 'mpeg4', '-c:a', 'aac']],
  ['mpeg4.avi', ['-c:v', 'mpeg4', '-c:a', 'mp3']],
  ['wmv.wmv', ['-c:v', 'wmv2', '-c:a', 'wmav2']],
  ['mpeg2.ts', ['-c:v', 'mpeg2video', '-c:a', 'mp2']],
  ['ffv1.mkv', ['-c:v', 'ffv1', '-c:a', 'flac']],
  ['prores.mov', ['-c:v', 'prores_ks', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s16le']],
  ['h264.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']],
  ['h264-ac3.mkv', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'ac3']],
  ['audio.wma', ['-vn', '-c:a', 'wmav2']],
  ['audio.aiff', ['-vn', '-c:a', 'pcm_s24be']],
  ['audio.ac3', ['-vn', '-c:a', 'ac3']],
  ['audio.flac', ['-vn', '-c:a', 'flac']],
  ['audio.opus', ['-vn', '-c:a', 'libopus']]
]
const receipts = []
for (const [name, codec] of cases) {
  const source = path.join(root, name)
  const generated = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '2', ...codec, source], { windowsHide: true, encoding: 'utf8' })
  assert.equal(generated.status, 0, generated.stderr)
  allowed.add(source)
  const before = hash(source)
  const result = await service.prepare(source)
  assert.equal(hash(source), before)
  assert.equal((await service.prepare(source)).cached, true)
  receipts.push({ name, ...result, sourceUnchanged: true })
  console.log(`PASS ${name} -> ${result.kind} in-app cache`)
}
const nativeOnly = new InlinePlaybackService({ cacheDir: path.join(root, 'native-cache'), mpvPath: mpv, authorizePath: p => { assert.ok(allowed.has(p)); return p } })
for (const name of ['mpeg4.mp4', 'audio.wma']) {
  const result = await nativeOnly.prepare(path.join(root, name))
  assert.equal(result.backend, 'mpv')
  receipts.push({ name, nativeOnly: true, ...result })
  console.log(`PASS bundled native backend: ${name}`)
}
const original = value('original')
if (original) {
  allowed.add(original)
  const before = hash(original)
  const result = await service.prepare(original)
  assert.equal(hash(original), before)
  receipts.push({ name: path.basename(original), ...result, sourceUnchanged: true })
  console.log(`PASS original media: ${path.basename(original)}`)
}
fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify(receipts, null, 2))
console.log(JSON.stringify({ passed: receipts.length, receipt: path.join(root, 'receipt.json') }))
