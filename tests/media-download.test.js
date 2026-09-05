const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { agentPanelSource } = require('./helpers/agent-panel-source')

const {
  downloadRemoteMedia,
  extractUrl,
  isDownloadIntent,
  isMediaUrl,
  isPeerTubeUrl,
  isVideoSiteUrl
} = require('../electron/media-download-service')
const peertubeFixture = require('./fixtures/peertube-no-login.json')

const dnsPublic = async () => ({ address: '93.184.216.34' })

function streamOf(chunks) {
  return {
    getReader() {
      let index = 0
      return {
        read: async () => index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined }
      }
    }
  }
}

function fetchReturning(status, { headers = {}, chunks = [], location } = {}) {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    if (status >= 300 && status < 400) return { status, headers: { get: (name) => (name === 'location' ? location : null) } }
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers[name] ?? null },
      body: streamOf(chunks)
    }
  }
  impl.calls = calls
  return impl
}

test('media url and download intent detection', () => {
  assert.equal(isMediaUrl('https://cdn.com/a/v.mp4'), true)
  assert.equal(isMediaUrl('https://cdn.com/page.html'), false)
  assert.equal(isMediaUrl('ftp://cdn.com/v.mp4'), false)
  assert.equal(extractUrl('下载这个 https://cdn.com/v.mp4 谢谢'), 'https://cdn.com/v.mp4')
  assert.equal(isDownloadIntent('下载这个 https://cdn.com/v.mp4'), true)
  assert.equal(isDownloadIntent('https://cdn.com/v.mp4'), true, '裸直链也视为下载意图')
  assert.equal(isDownloadIntent('看一下 https://cdn.com/page'), false)
})

test('video site share text triggers intent, plain pages do not', () => {
  assert.equal(isDownloadIntent('6.17 复制打开抖音，看看【曲率出逃的作品】揭秘企业AI服务 https://v.douyin.com/5zAOagRhFgY/ :9pm 09/19 w@F.UY gOx:/'), true)
  assert.equal(isDownloadIntent('https://www.bilibili.com/video/BV1xx'), true)
  assert.equal(isDownloadIntent('https://youtu.be/dQw4w9WgXcQ'), true)
  assert.equal(isDownloadIntent('看看这个 https://example.com/news'), false)
})

test('X and Facebook links enter the site-video pipeline', () => {
  const urls = [
    'https://x.com/example/status/1234567890',
    'https://twitter.com/example/status/1234567890',
    'https://www.facebook.com/watch/?v=1234567890',
    'https://fb.watch/abc123/'
  ]
  for (const url of urls) {
    assert.equal(isVideoSiteUrl(url), true, `${url} 应交给站点视频下载器`)
    assert.equal(isDownloadIntent(`看看这个 ${url}`), true, `${url} 的分享文字应触发链接处理`)
  }
})

test('public PeerTube watch URLs enter the site-video pipeline without login', () => {
  assert.ok(peertubeFixture.url, 'fixture url must be documented')
  assert.equal(peertubeFixture.loginRequired, false)
  assert.match(String(peertubeFixture.permission || ''), /Public|no-login|Framasoft|regression/i)
  const urls = [peertubeFixture.url, peertubeFixture.legacyUrl, peertubeFixture.embedUrl]
  for (const url of urls) {
    assert.equal(isPeerTubeUrl(url), true, url + ' is a PeerTube watch/embed URL')
    assert.equal(isVideoSiteUrl(url), true, url + ' routes to yt-dlp site video')
    assert.equal(isMediaUrl(url), false, url + ' is not a direct media file link')
    assert.equal(isDownloadIntent('看看这个 ' + url), true, url + ' share text triggers download intent')
    assert.equal(isDownloadIntent(url), true, 'bare ' + url + ' is download intent')
  }
  assert.equal(isPeerTubeUrl('https://peertube.example.org/w/AbCdEfGhIjKlMnOpQrStUv'), true)
  assert.equal(isPeerTubeUrl('https://example.com/w/short'), false, 'short ids under 10 chars are not PeerTube')
  assert.equal(isPeerTubeUrl('https://example.com/blog/w/not-a-video-page-here'), false)
  assert.equal(isPeerTubeUrl('https://framatube.org/a/framasoft/video-channels'), false)
})



test('download writes file atomically with progress and follows redirects', async () => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-dl-'))
  const fetchImpl = async (url) => {
    if (url === 'https://cdn.com/a.mp4') {
      return { status: 302, headers: { get: (name) => (name === 'location' ? 'https://cdn2.com/b.mp4' : null) } }
    }
    return {
      ok: true, status: 200,
      headers: { get: (name) => ({ 'content-type': 'video/mp4', 'content-length': '6' })[name] ?? null },
      body: streamOf([Buffer.from('abc'), Buffer.from('def')])
    }
  }
  const progress = []
  const result = await downloadRemoteMedia('https://cdn.com/a.mp4', {
    destDir, dnsLookup: dnsPublic, fetchImpl,
    onProgress: (p) => progress.push(p)
  })
  assert.equal(result.bytes, 6)
  assert.equal(fs.readFileSync(result.outputPath).toString(), 'abcdef')
  assert.deepEqual(progress, [{ received: 3, total: 6 }, { received: 6, total: 6 }])
  assert.equal(fs.existsSync(`${result.outputPath}.agentplay.part`), false, '临时文件必须已重命名')
})

test('direct media download resumes a persisted partial file with HTTP Range', async (t) => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-resume-'))
  t.after(() => fs.rmSync(destDir, { recursive: true, force: true }))
  const finalPath = path.join(destDir, 'resume.mp4')
  const tempPath = `${finalPath}.agentplay.part`
  fs.writeFileSync(tempPath, 'abc')
  const calls = []
  const checkpoints = []
  const result = await downloadRemoteMedia('https://cdn.com/resume.mp4', {
    destDir,
    dnsLookup: dnsPublic,
    checkpoint: { received: 3, tempPath, finalPath, finalUrl: 'https://cdn.com/resume.mp4' },
    onCheckpoint: (value) => checkpoints.push(value),
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return {
        ok: true,
        status: 206,
        headers: { get: (name) => ({ 'content-type': 'video/mp4', 'content-length': '3', 'content-range': 'bytes 3-5/6' })[name] ?? null },
        body: streamOf([Buffer.from('def')])
      }
    }
  })

  assert.equal(calls[0].options.headers.Range, 'bytes=3-')
  assert.equal(fs.readFileSync(result.outputPath, 'utf8'), 'abcdef')
  assert.equal(result.bytes, 6)
  assert.equal(checkpoints.at(-1).received, 6)
})

test('direct media download waits for the Windows file handle to close before reporting completion', async (t) => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-close-'))
  t.after(() => fs.rmSync(destDir, { recursive: true, force: true }))
  const originalCreateWriteStream = fs.createWriteStream
  const originalRenameSync = fs.renameSync
  const delayedStream = new EventEmitter()
  delayedStream.closed = false
  delayedStream.write = () => true
  delayedStream.end = (callback) => {
    callback()
    setTimeout(() => {
      delayedStream.closed = true
      delayedStream.emit('close')
    }, 20)
  }
  delayedStream.destroy = () => {
    if (delayedStream.closed) return
    delayedStream.closed = true
    delayedStream.emit('close')
  }
  fs.createWriteStream = () => delayedStream
  fs.renameSync = () => {}
  t.after(() => {
    fs.createWriteStream = originalCreateWriteStream
    fs.renameSync = originalRenameSync
  })

  let closed = false
  delayedStream.once('close', () => { closed = true })
  let resolved = false
  const pending = downloadRemoteMedia('https://cdn.com/close.mp4', {
    destDir,
    dnsLookup: dnsPublic,
    fetchImpl: fetchReturning(200, {
      headers: { 'content-type': 'video/mp4', 'content-length': '3' },
      chunks: [Buffer.from('abc')]
    })
  }).then((result) => {
    resolved = true
    return result
  })

  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(resolved, false, 'download promise must not resolve before the write stream closes')
  await pending
  assert.equal(closed, true)
})

test('rejects html pages with a site-link hint and oversized files', async () => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-dl-'))
  await assert.rejects(
    downloadRemoteMedia('https://bilibili.com/video/BV1xx', {
      destDir, dnsLookup: dnsPublic,
      fetchImpl: fetchReturning(200, { headers: { 'content-type': 'text/html' }, chunks: [Buffer.from('<html>')] })
    }),
    /站点链接|yt-dlp/
  )
  await assert.rejects(
    downloadRemoteMedia('https://cdn.com/big.mp4', {
      destDir, dnsLookup: dnsPublic,
      fetchImpl: fetchReturning(200, { headers: { 'content-type': 'video/mp4', 'content-length': String(3 * 1024 * 1024 * 1024) } })
    }),
    /2GB/
  )
})

test('rejects private-address resolutions and url-embedded credentials', async () => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-dl-'))
  await assert.rejects(
    downloadRemoteMedia('https://internal.example/v.mp4', { destDir, dnsLookup: async () => ({ address: '192.168.1.5' }), fetchImpl: fetchReturning(200, { headers: { 'content-type': 'video/mp4' } }) }),
    /私网|保留地址/
  )
  await assert.rejects(
    downloadRemoteMedia('https://user:pass@cdn.com/v.mp4', { destDir, dnsLookup: dnsPublic, fetchImpl: fetchReturning(200, {}) }),
    /账号或密码/
  )
})

test('media download wires IPC, preload, types and agent panel route', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
  const panel = agentPanelSource()
  const types = fs.readFileSync(path.join(__dirname, '..', 'src', 'types', 'global.d.ts'), 'utf8')
  assert.match(main, /ipcMain\.handle\('media:download'/)
  assert.match(main, /AgentPlay 下载/)
  assert.match(preload, /mediaDownload: \{/)
  assert.match(types, /mediaDownload\?: \{/)
  assert.match(panel, /runDownloadTask/)
  // 链接命中后给选择，不直接执行：仅下载 / 下载并拉片
  assert.match(panel, /linkChoice/)
  assert.match(panel, /仅下载/)
  assert.match(panel, /canAnalyze/)
  assert.match(panel, /setLinkChoice\(buildLinkChoice\(detection, text\)\)/)
  assert.match(panel, /mediaDownload\.detect\(text\)/)
  assert.match(panel, /视频下载/)
})
