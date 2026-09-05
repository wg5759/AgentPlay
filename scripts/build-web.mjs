import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { execFileSync } from 'node:child_process'

const distDir = path.resolve('dist')
const pollMs = 500
const stableMs = 3000
const pwaGraceMs = 12000
// Windows Defender/慢盘在渲染 chunks 后可能还要数分钟才落盘；允许 CI 覆盖，但默认给足稳定产物窗口。
const deadlineMs = Math.max(120000, Number(process.env.AGENTPLAY_BUILD_TIMEOUT_MS) || 300000)
let coreStableSince = 0

fs.rmSync(distDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

function nonEmpty(file) {
  return fs.existsSync(file) && fs.statSync(file).size > 0
}

function coreArtifactsReady() {
  const required = ['index.html', 'manifest.webmanifest'].map((name) => path.join(distDir, name))
  if (!required.every(nonEmpty)) return false
  const assetsDir = path.join(distDir, 'assets')
  if (!fs.existsSync(assetsDir)) return false
  const assets = fs.readdirSync(assetsDir).filter((name) => /\.(?:js|css)$/.test(name))
  return assets.some((name) => name.endsWith('.js')) && assets.some((name) => name.endsWith('.css')) &&
    assets.every((name) => nonEmpty(path.join(assetsDir, name)))
}

function currentBuildArtifactsReady() {
  return coreArtifactsReady() && nonEmpty(path.join(distDir, 'sw.js'))
}

function collectPrecacheAssets() {
  const included = new Set(['index.html', 'manifest.webmanifest'])
  for (const folder of ['assets', 'icons']) {
    const root = path.join(distDir, folder)
    if (!fs.existsSync(root)) continue
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile()) included.add(`${folder}/${entry.name}`)
    }
  }
  return [...included].filter((relative) => nonEmpty(path.join(distDir, relative))).sort()
}

function writeFallbackServiceWorker() {
  const assets = collectPrecacheAssets()
  const revision = crypto.createHash('sha256')
  for (const relative of assets) {
    revision.update(relative)
    revision.update(fs.readFileSync(path.join(distDir, relative)))
  }
  const cacheName = `agentplay-web-${revision.digest('hex').slice(0, 16)}`
  const urls = assets.map((relative) => `./${relative}`)
  const source = `const CACHE=${JSON.stringify(cacheName)};\nconst ASSETS=${JSON.stringify(urls)};\nself.addEventListener('install',(event)=>event.waitUntil(caches.open(CACHE).then((cache)=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));\nself.addEventListener('activate',(event)=>event.waitUntil(caches.keys().then((keys)=>Promise.all(keys.filter((key)=>key.startsWith('agentplay-web-')&&key!==CACHE).map((key)=>caches.delete(key)))).then(()=>self.clients.claim())));\nself.addEventListener('fetch',(event)=>{if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;event.respondWith(caches.match(event.request).then((cached)=>cached||fetch(event.request).then((response)=>{if(!response||response.status!==200)return response;const copy=response.clone();caches.open(CACHE).then((cache)=>cache.put(event.request,copy));return response;}).catch(()=>event.request.mode==='navigate'?caches.match('./index.html'):undefined)));});\n`
  fs.writeFileSync(path.join(distDir, 'sw.js'), source, 'utf8')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function writeBuildInfo() {
  const source = crypto.createHash('sha256')
  const walk = root => { for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) { const file = path.join(root, entry.name); if (entry.isDirectory()) walk(file); else if (entry.isFile()) { source.update(file.replaceAll('\\', '/')); source.update(fs.readFileSync(file)) } } }
  walk('src'); walk('electron'); source.update(fs.readFileSync('package.json'))
  let commit = 'source-export'
  try { commit = execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim() } catch { /* exported source has no .git */ }
  fs.writeFileSync(path.join(distDir, 'build-info.json'), JSON.stringify({ version: JSON.parse(fs.readFileSync('package.json', 'utf8')).version, commit, sourceSha256: source.digest('hex') }))
}

const worker = new Worker(new URL('./vite-build-worker.mjs', import.meta.url))
let workerResult = null
worker.on('message', (message) => { workerResult = message })
worker.on('error', (error) => { workerResult = { success: false, error: error.stack || error.message } })

try {
  const startedAt = Date.now()
  while (Date.now() - startedAt < deadlineMs) {
    if (workerResult?.success === false) throw new Error(workerResult.error || 'Vite 构建线程失败')
    if (currentBuildArtifactsReady()) {
      await worker.terminate()
      writeBuildInfo()
      console.log('verified current Vite/PWA artifacts; exiting')
      process.exit(0)
    }
    if (coreArtifactsReady()) {
      if (!coreStableSince) coreStableSince = Date.now()
      if (Date.now() - coreStableSince >= stableMs + pwaGraceMs) {
        await worker.terminate()
        writeFallbackServiceWorker()
        if (!currentBuildArtifactsReady()) throw new Error('回退 Service Worker 生成后产物仍不完整')
        writeBuildInfo()
        console.log('verified current Vite artifacts and generated a deterministic fallback service worker; exiting')
        process.exit(0)
      }
    } else {
      coreStableSince = 0
    }
    if (workerResult?.success && coreArtifactsReady()) {
      writeFallbackServiceWorker()
      if (!currentBuildArtifactsReady()) throw new Error('Vite 返回成功但 PWA 产物不完整')
      writeBuildInfo()
      console.log('verified current Vite artifacts and completed the missing service worker; exiting')
      process.exit(0)
    }
    await delay(pollMs)
  }
  throw new Error(`Vite 构建未在 ${Math.round(deadlineMs / 1000)} 秒内形成稳定产物`)
} catch (error) {
  await worker.terminate()
  console.error(error)
  process.exit(1)
}
