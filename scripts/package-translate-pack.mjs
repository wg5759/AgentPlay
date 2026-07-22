// 构建"离线翻译组件包"：OPUS-MT en→zh（transformers.js + onnxruntime，q8 量化）模型文件，
// 输出到 release/translate-pack/ 并生成应用内置清单 electron/translate-pack-manifest.js（含真实 SHA-256）。
// GitHub Release 资产名不能带路径，统一用 opus-mt-en-zh--<相对路径> 扁平命名。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modelsDir = path.join(root, 'release', 'translate-pack', 'models')
const modelDir = path.join(modelsDir, 'Xenova', 'opus-mt-en-zh')
const outDir = path.join(root, 'release', 'translate-pack')
const TAG = 'translate-pack-v1'
const BASE_URL = `https://github.com/wg5759/AgentPlay/releases/download/${TAG}`
const FILES = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx'
]

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

const assets = []
for (const relative of FILES) {
  const source = path.join(modelDir, ...relative.split('/'))
  if (!fs.existsSync(source)) throw new Error(`缺少组件包源文件: ${source}`)
  const flatName = `opus-mt-en-zh--${relative.replace(/\//g, '--')}`
  const staged = path.join(outDir, flatName)
  fs.copyFileSync(source, staged)
  assets.push({
    id: `opus-mt-en-zh-${relative.split('/').pop().replace(/\W+/g, '-')}`,
    kind: 'file',
    label: `OPUS-MT 英译中模型（${relative}）`,
    path: `models/Xenova/opus-mt-en-zh/${relative}`,
    role: relative.endsWith('.onnx') ? 'model' : 'config',
    url: `${BASE_URL}/${flatName}`,
    size: fs.statSync(staged).size,
    sha256: sha256File(staged)
  })
}

const manifest = {
  schemaVersion: 1,
  tag: TAG,
  product: 'AgentPlay 离线翻译组件（OPUS-MT 英译中，transformers.js + onnxruntime）',
  assets
}

const moduleSource = `// 本文件由 scripts/package-translate-pack.mjs 生成，请勿手改。
// 组件包托管在 GitHub Release 的 ${TAG} 标签；SHA-256 与发布资产一一对应。
module.exports = ${JSON.stringify(manifest, null, 2)}
`
fs.writeFileSync(path.join(root, 'electron', 'translate-pack-manifest.js'), moduleSource)
fs.writeFileSync(path.join(outDir, 'TRANSLATE-PACK-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const totalMb = (assets.reduce((sum, asset) => sum + asset.size, 0) / 1024 / 1024).toFixed(1)
console.log(`离线翻译组件包已生成: ${outDir}（${totalMb} MB，${assets.length} 个文件）`)
