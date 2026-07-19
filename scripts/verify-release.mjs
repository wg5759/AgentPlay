import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const asar = require(path.join(root, 'node_modules', '.pnpm', '@electron+asar@3.4.1', 'node_modules', '@electron', 'asar'))
const sevenZip = path.join(root, 'node_modules', '.pnpm', '7zip-bin@5.2.0', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
const standard = path.join(root, 'release', `AI播放器标准版安装包-${pkg.version}.exe`)
const localAi = path.join(root, 'release', `AI播放器本地AI版安装包-${pkg.version}.exe`)

function sha256(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex').toUpperCase()
}

function listInstaller(filePath) {
  const result = spawnSync(sevenZip, ['l', filePath], { cwd: root, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`无法枚举安装包：${filePath}\n${result.stderr}`)
  return result.stdout
}

for (const filePath of [standard, localAi, sevenZip]) {
  if (!fs.existsSync(filePath)) throw new Error(`缺少发布验证文件：${filePath}`)
}
const standardList = listInstaller(standard)
const localList = listInstaller(localAi)
for (const required of ['resources\\bin\\win\\mpv.com', 'resources\\bin\\win\\ai-player-voice.exe']) {
  if (!standardList.includes(required) || !localList.includes(required)) throw new Error(`双安装包缺少 ${required}`)
}
for (const required of ['resources\\legal\\LICENSE', 'resources\\legal\\THIRD_PARTY_NOTICES.md', 'resources\\legal\\PRIVACY.md']) {
  if (!standardList.includes(required) || !localList.includes(required)) throw new Error(`双安装包缺少法律与隐私文件：${required}`)
}
for (const required of ['resources\\licenses\\mpv\\LICENSE.GPL', 'resources\\licenses\\mpv\\Copyright', 'resources\\licenses\\mpv\\BUILD_PROVENANCE.md']) {
  if (!standardList.includes(required) || !localList.includes(required)) throw new Error(`双安装包缺少 mpv 许可或来源证据：${required}`)
}
for (const forbidden of ['Qwen2.5-0.5B-Instruct-Q4_0.gguf', 'llama-server.exe', 'bundled-ai-manifest.json']) {
  if (standardList.includes(forbidden)) throw new Error(`标准版误带本地 AI 资源：${forbidden}`)
  if (!localList.includes(forbidden)) throw new Error(`本地 AI 版缺少资源：${forbidden}`)
}

const asarPath = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar')
const asarEntries = asar.listPackage(asarPath)
for (const required of ['\\electron\\creative-studio-service.js', '\\electron\\analysis-studio-service.js']) {
  if (!asarEntries.includes(required)) throw new Error(`正式 ASAR 缺少 ${required}`)
}

const report = {
  version: pkg.version,
  standard: { path: standard, bytes: fs.statSync(standard).size, sha256: sha256(standard) },
  localAi: { path: localAi, bytes: fs.statSync(localAi).size, sha256: sha256(localAi) },
  closure: { standardHasBundledModel: false, localAiHasBundledModel: true, sapiHelperInBoth: true, creativeServiceInAsar: true, legalDocsInBoth: true, mpvLicenseAndProvenanceInBoth: true }
}
const reportPath = path.join(root, 'release', `release-verification-${pkg.version}.json`)
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(report)}\n`)
