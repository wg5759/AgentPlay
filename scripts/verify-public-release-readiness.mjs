import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binaryMode = process.argv.includes('--binary')
const policy = JSON.parse(fs.readFileSync(path.join(root, 'release-public-policy.json'), 'utf8'))

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr || result.stdout}`)
  return result.stdout.split(/\r?\n/).filter(Boolean)
}

const requiredDocs = ['LICENSE', 'README.md', 'SECURITY.md', 'PRIVACY.md', 'TRADEMARKS.md', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md']
for (const name of requiredDocs) {
  if (!fs.existsSync(path.join(root, name))) throw new Error(`源码发布缺少 ${name}`)
}

const forbiddenTracked = git(['ls-files']).filter((filePath) =>
  /^(?:release|resources\/(?:bin|models|ai-runtime))\//.test(filePath) ||
  /\.(?:exe|dll|pdb|gguf|p12|pfx|pem|key|keystore)$/i.test(filePath)
)
if (forbiddenTracked.length) throw new Error(`源码发布误跟踪二进制、模型或凭据文件：${forbiddenTracked.join(', ')}`)

if (binaryMode) {
  if (!policy.binaryRelease?.allowed) throw new Error(`公开二进制发行被策略阻止：${policy.binaryRelease?.reason || '缺少证据'}`)
  const evidencePath = path.join(root, 'binary-source-evidence.json')
  if (!fs.existsSync(evidencePath)) throw new Error('公开二进制发行缺少 binary-source-evidence.json')
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'))
  for (const key of policy.binaryRelease.requiredEvidence || []) {
    if (evidence[key] === undefined || evidence[key] === '') throw new Error(`公开二进制发行缺少证据字段：${key}`)
  }
}

process.stdout.write(`${JSON.stringify({ success: true, mode: binaryMode ? 'binary' : 'source', policy })}\n`)
