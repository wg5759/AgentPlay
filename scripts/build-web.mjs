import { build } from 'vite'
import fs from 'node:fs'
import path from 'node:path'

let artifactPoll = null
let stableSince = 0
const distDir = path.resolve('dist')
fs.rmSync(distDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

function currentBuildArtifactsReady() {
  const dist = distDir
  const required = ['index.html', 'manifest.webmanifest', 'sw.js'].map((name) => path.join(dist, name))
  if (!required.every((file) => fs.existsSync(file) && fs.statSync(file).size > 0)) return false
  const assetsDir = path.join(dist, 'assets')
  if (!fs.existsSync(assetsDir)) return false
  const assets = fs.readdirSync(assetsDir).filter((name) => /\.(?:js|css)$/.test(name))
  return assets.some((name) => name.endsWith('.js')) && assets.some((name) => name.endsWith('.css')) &&
    assets.every((name) => fs.statSync(path.join(assetsDir, name)).size > 0)
}

try {
  const artifactsComplete = new Promise((resolve) => {
    artifactPoll = setInterval(() => {
      if (!currentBuildArtifactsReady()) {
        stableSince = 0
        return
      }
      if (!stableSince) stableSince = Date.now()
      if (Date.now() - stableSince >= 3000) resolve()
    }, 500)
  })
  await Promise.race([build(), artifactsComplete])
  clearInterval(artifactPoll)
  console.log('verified current Vite/PWA artifacts; exiting')
  process.exit(0)
} catch (error) {
  clearInterval(artifactPoll)
  console.error(error)
  process.exit(1)
}
