import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resources = path.join(root, 'resources')
const runtimeDir = path.join(resources, 'ai-runtime', 'win-x64')
const modelRelativePath = 'models/Qwen2.5-0.5B-Instruct-Q4_0.gguf'

function sha256(filePath) {
  const hash = crypto.createHash('sha256')
  const file = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytesRead
    do {
      bytesRead = fs.readSync(file, buffer, 0, buffer.length, null)
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead)
  } finally {
    fs.closeSync(file)
  }
  return hash.digest('hex')
}

const runtimeFiles = fs.readdirSync(runtimeDir)
  .filter((name) => name === 'llama-server.exe' || name.toLowerCase().endsWith('.dll'))
  .sort()
  .map((name) => `ai-runtime/win-x64/${name}`)

const artifacts = [modelRelativePath, ...runtimeFiles].map((relativePath) => {
  const filePath = path.join(resources, ...relativePath.split('/'))
  return {
    role: relativePath === modelRelativePath ? 'model' : relativePath.endsWith('.exe') ? 'llama-server' : 'runtime-dependency',
    path: relativePath,
    size: fs.statSync(filePath).size,
    sha256: sha256(filePath)
  }
})

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  product: 'AI播放器本地AI版',
  model: {
    id: 'ai-player-qwen2.5-0.5b',
    upstream: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
    quantization: 'Q4_0',
    license: 'Apache-2.0',
    sourceUrl: 'https://modelscope.cn/models/Qwen/Qwen2.5-0.5B-Instruct-GGUF',
    expectedSha256: '7671c0c304e6ce5a7fc577bcb12aba01e2c155cc2efd29b2213c95b18edaf6ed'
  },
  runtime: {
    name: 'llama.cpp',
    tag: 'b10063',
    commit: '7d56da7e546f54fb1fa54ef2bc9ad9a872860ab0',
    license: 'MIT',
    sourceUrl: 'https://github.com/ggml-org/llama.cpp/releases/tag/b10063',
    archiveSha256: '0995838d6d6ec853510181acc2cc09be9f0fe8106c5d3e042dad39f033a5cb03'
  },
  artifacts
}

const output = path.join(resources, 'bundled-ai-manifest.json')
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`wrote ${output} (${artifacts.length} verified artifacts)`)
