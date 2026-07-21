// 构建"录音转写组件包"：whisper.cpp 引擎（win-x64）+ ggml-tiny 模型，输出到
// release/whisper-pack/ 并生成应用内置清单 electron/whisper-pack-manifest.js（含真实 SHA-256）。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const whisperDir = path.join(root, 'resources', 'whisper')
const outDir = path.join(root, 'release', 'whisper-pack')
const TAG = 'whisper-pack-v1'
const BASE_URL = `https://github.com/wg5759/AgentPlay/releases/download/${TAG}`

function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytesRead
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead)
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

const modelPath = path.join(whisperDir, 'ggml-tiny.bin')
const engineZipSource = path.join(whisperDir, 'whisper-bin-x64.zip')
for (const required of [modelPath, engineZipSource]) {
  if (!fs.existsSync(required)) throw new Error(`缺少组件包源文件: ${required}`)
}

fs.mkdirSync(outDir, { recursive: true })
const engineOut = path.join(outDir, 'whisper-bin-x64.zip')
fs.copyFileSync(engineZipSource, engineOut)
const modelOut = path.join(outDir, 'ggml-tiny.bin')
fs.copyFileSync(modelPath, modelOut)

// 引擎 zip 内文件清单（解压后逐文件校验）
const engineFiles = []
const archive = await JSZip.loadAsync(fs.readFileSync(engineZipSource))
for (const name of Object.keys(archive.files)) {
  if (name.endsWith('/')) continue
  const buffer = await archive.file(name).async('nodebuffer')
  engineFiles.push({
    path: `engine/${name.replace(/^Release\//, '')}`,
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex')
  })
}

const manifest = {
  schemaVersion: 1,
  tag: TAG,
  product: 'AgentPlay 录音转写组件（whisper.cpp + ggml-tiny）',
  assets: [
    {
      id: 'model-ggml-tiny',
      kind: 'file',
      label: 'ggml-tiny 模型',
      path: 'ggml-tiny.bin',
      role: 'model',
      url: `${BASE_URL}/ggml-tiny.bin`,
      size: fs.statSync(modelOut).size,
      sha256: sha256File(modelOut)
    },
    {
      id: 'whisper-engine-win-x64',
      kind: 'zip',
      label: 'whisper.cpp 引擎',
      url: `${BASE_URL}/whisper-bin-x64.zip`,
      size: fs.statSync(engineOut).size,
      sha256: sha256File(engineOut),
      files: engineFiles
    }
  ]
}

const moduleSource = `// 本文件由 scripts/package-whisper-pack.mjs 生成，请勿手改。
// 组件包托管在 GitHub Release 的 ${TAG} 标签；SHA-256 与发布资产一一对应。
module.exports = ${JSON.stringify(manifest, null, 2)}
`
fs.writeFileSync(path.join(root, 'electron', 'whisper-pack-manifest.js'), moduleSource)
fs.writeFileSync(path.join(outDir, 'WHISPER-PACK-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const totalMb = (manifest.assets.reduce((sum, asset) => sum + asset.size, 0) / 1024 / 1024).toFixed(1)
console.log(`转写组件包已生成: ${outDir}（${totalMb} MB，${engineFiles.length} 个引擎文件）`)
