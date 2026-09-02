const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { InlinePlaybackService, encodingArgs, parseMpvProbe, canPlayDirect } = require('../electron/inline-playback-service')

test('native encoder plans video and audio caches without an external player window', () => {
  const video = encodingArgs('ffmpeg', 'input.mkv', 'cache.mp4', 'video', 1000000)
  assert.ok(video.includes('libx264'))
  assert.ok(video.includes('aac'))
  assert.ok(video.includes('file,pipe'))
  const audio = encodingArgs('ffmpeg', 'input.wma', 'cache.m4a', 'audio', 1000000)
  assert.ok(audio.includes('-vn'))
  const native = encodingArgs('mpv', 'input.avi', 'cache.mp4', 'video', 1000000)
  assert.ok(native.includes('--ovc=h264_mf'))
  assert.ok(native.includes('--o=cache.mp4'))
  assert.ok(native.includes('--access-references=no'))
  assert.ok(!native.some(arg => arg.includes('--force-window')))
  assert.deepEqual(parseMpvProbe('log\nAP_META|32.000000|mpeg4|1280|704|0||yuv420p\n'), { duration: 32, video: true, audio: false, codec: 'mpeg4', width: 1280, height: 704, audioCodec: '', pixelFormat: 'yuv420p' })
  assert.deepEqual(parseMpvProbe('AP_META|2.000000|(unavailable)|||1|wmav2|\n'), { duration: 2, video: false, audio: true, codec: '(unavailable)', width: 0, height: 0, audioCodec: 'wmav2', pixelFormat: '' })
})

test('preflight prevents silently discarded video, unsupported audio and high-bit-depth tracks', () => {
  const normal = { video: true, codec: 'h264', pixelFormat: 'yuv420p', audio: true, audioCodec: 'aac' }
  assert.equal(canPlayDirect(normal, '.mp4'), true)
  assert.equal(canPlayDirect({ ...normal, codec: 'mpeg4' }, '.mp4'), false)
  assert.equal(canPlayDirect({ ...normal, codec: 'prores' }, '.mov'), false)
  assert.equal(canPlayDirect({ ...normal, audioCodec: 'ac3' }, '.mkv'), false)
  assert.equal(canPlayDirect({ ...normal, pixelFormat: 'yuv420p10le' }, '.mp4'), false)
  assert.equal(canPlayDirect(normal, '.ts'), false)
  assert.equal(canPlayDirect({ video: false, audio: true, audioCodec: 'mp3' }, '.mp3'), true)
})

test('cache preserves source, verifies content and rebuilds when source changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-inline-test-'))
  const source = path.join(root, 'movie.avi')
  fs.writeFileSync(source, 'original')
  let encodes = 0
  const service = new InlinePlaybackService({ cacheDir: path.join(root, 'cache'), ffmpegPath: process.execPath, ffprobePath: process.execPath,
    authorizePath: value => { assert.equal(value, source); return value },
    run: async (_exe, args) => {
      if (args.includes('-show_streams')) return { stdout: JSON.stringify({ format: { duration: '4' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 320, height: 240 }] }) }
      encodes++
      const output = args.at(-1)
      fs.writeFileSync(output, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(128)]))
      return { stdout: '' }
    }
  })
  try {
    const first = await service.prepare(source, { kind: 'video' })
    assert.equal(first.cached, false)
    assert.equal(fs.readFileSync(source, 'utf8'), 'original')
    assert.notEqual(first.path, source)
    assert.equal((await service.prepare(source, { kind: 'video' })).cached, true)
    assert.equal(encodes, 1)
    fs.appendFileSync(first.path, 'tampered')
    assert.equal((await service.prepare(source, { kind: 'video' })).cached, false)
    fs.writeFileSync(source, 'changed')
    assert.notEqual((await service.prepare(source, { kind: 'video' })).path, first.path)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('authorization, remote/playlist input, cancellation and changed sources fail closed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-inline-reject-'))
  const source = path.join(root, 'movie.mp4')
  fs.writeFileSync(source, 'original')
  try {
    const service = new InlinePlaybackService({ cacheDir: path.join(root, 'cache'), ffmpegPath: process.execPath, ffprobePath: process.execPath, authorizePath: () => { throw new Error('unauthorized') } })
    await assert.rejects(service.prepare(source), /unauthorized/)
    await assert.rejects(service.prepare('https://example.com/movie.mp4'), /本地/)
    await assert.rejects(service.prepare(path.join(root, 'secrets.m3u')), /格式/)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(service.prepare(source, { signal: controller.signal }), /取消/)
    const changing = new InlinePlaybackService({ cacheDir: path.join(root, 'cache2'), ffmpegPath: process.execPath, ffprobePath: process.execPath, authorizePath: p => p,
      run: async (_exe, args) => {
        if (args.includes('-show_streams')) return { stdout: JSON.stringify({ format: { duration: '4' }, streams: [{ codec_type: 'video', codec_name: 'h264' }] }) }
        fs.writeFileSync(args.at(-1), Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(128)]))
        fs.appendFileSync(source, 'still writing')
        return { stdout: '' }
      }
    })
    await assert.rejects(changing.prepare(source), /仍在变化/)
    assert.equal(fs.readdirSync(path.join(root, 'cache2')).filter(name => name.endsWith('.mp4')).length, 0)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('video and audio errors use inline preparation and preserve original store identity', () => {
  const view = fs.readFileSync(path.join(__dirname, '../src/components/PlayerView.tsx'), 'utf8')
  assert.match(view, /inlinePlayback\?\.prepare/)
  assert.equal(/window\.aiPlayer\.player\.loadFile\(videoSrc\)/.test(view), false)
  assert.doesNotMatch(view, /openInCompatibilityPlayer/)
  assert.match(view, /setPlaybackSource/)
  assert.match(view, /data-ai-player-audio/)
})

test('external opening and library classification share the expanded media formats', () => {
  const formats = require('../electron/media-formats.json')
  const { getType, ALL_EXTS } = require('../electron/file-service')
  for (const ext of formats.video) { assert.equal(getType(ext), 'video'); assert.ok(ALL_EXTS.includes(ext)) }
  for (const ext of formats.audio) { assert.equal(getType(ext), 'audio'); assert.ok(ALL_EXTS.includes(ext)) }
})

test('startup registers playback before creating the renderer and fullscreen keeps one media tree', () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
  assert.match(main, /registerInlinePlaybackIpc\(\)\s+const win = createWindow\(\)/)
  const shell = fs.readFileSync(path.join(__dirname, '../src/components/Workbench.tsx'), 'utf8')
  assert.doesNotMatch(shell, /if \(theater\) return/)
  assert.match(shell, /workspace-theater/)
})
