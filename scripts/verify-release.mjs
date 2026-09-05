import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseDirectory = path.resolve(root, process.argv.find(value => value.startsWith('--release-dir='))?.slice('--release-dir='.length) || 'release')
const require = createRequire(import.meta.url)
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const asar = require(path.join(root, 'node_modules', '.pnpm', '@electron+asar@3.4.1', 'node_modules', '@electron', 'asar'))
const sevenZip = path.join(root, 'node_modules', '.pnpm', '7zip-bin@5.2.0', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
const standard = path.join(releaseDirectory, `AgentPlay-标准版安装包-${pkg.version}.exe`)
const portable = path.join(releaseDirectory, `AgentPlay-${pkg.version}-Windows-x64-Portable.zip`)

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

for (const filePath of [standard, portable, sevenZip]) {
  if (!fs.existsSync(filePath)) throw new Error(`缺少发布验证文件：${filePath}`)
}
const standardList = listInstaller(standard)
const portableList = listInstaller(portable)
for (const required of ['resources\\bin\\win\\mpv.com', 'resources\\bin\\win\\ai-player-voice.exe']) {
  if (!standardList.includes(required)) throw new Error(`标准版安装包缺少 ${required}`)
}
for (const required of ['resources\\legal\\LICENSE', 'resources\\legal\\THIRD_PARTY_NOTICES.md', 'resources\\legal\\PRIVACY.md']) {
  if (!standardList.includes(required)) throw new Error(`标准版安装包缺少法律与隐私文件：${required}`)
}
for (const required of ['resources\\licenses\\mpv\\LICENSE.GPL', 'resources\\licenses\\mpv\\Copyright', 'resources\\licenses\\mpv\\BUILD_PROVENANCE.md']) {
  if (!standardList.includes(required)) throw new Error(`标准版安装包缺少 mpv 许可或来源证据：${required}`)
}
// 单安装包模式：本地 AI 组件一律应用内下载，标准版不得携带模型与运行时。
for (const forbidden of ['Qwen2.5-0.5B-Instruct-Q4_0.gguf', 'llama-server.exe', 'bundled-ai-manifest.json']) {
  if (standardList.includes(forbidden)) throw new Error(`标准版误带本地 AI 资源：${forbidden}`)
  if (portableList.includes(forbidden)) throw new Error(`标准便携包误带本地 AI 资源：${forbidden}`)
}

for (const required of ['AgentPlay.exe', 'resources\\app.asar', 'resources\\bin\\win\\mpv.com', 'resources\\legal\\LICENSE']) {
  if (!portableList.includes(required)) throw new Error(`标准便携包缺少 ${required}`)
}

function authenticode(filePath) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:AGENTPLAY_SIGNATURE_TARGET',
    '[ordered]@{',
    "status = [string]$signature.Status",
    "subject = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { '' }",
    "thumbprint = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Thumbprint } else { '' }",
    "timestamped = [bool]($null -ne $signature.TimeStamperCertificate)",
    '} | ConvertTo-Json -Compress',
  ].join('\n')
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64')
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const windowsPowerShellModulePath = [
    path.join(systemRoot, 'system32', 'WindowsPowerShell', 'v1.0', 'Modules'),
    path.join(programFiles, 'WindowsPowerShell', 'Modules'),
  ].join(path.delimiter)
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      PSModulePath: windowsPowerShellModulePath,
      AGENTPLAY_SIGNATURE_TARGET: filePath,
    },
  })
  if (result.status !== 0) throw new Error(`无法读取 Authenticode 状态：${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout.trim())
}

const asarPath = path.join(releaseDirectory, 'win-unpacked', 'resources', 'app.asar')
const asarEntries = asar.listPackage(asarPath)
for (const required of [
  '\\electron\\creative-studio-service.js',
  '\\electron\\analysis-studio-service.js',
  '\\electron\\local-ai-download-service.js',
  '\\electron\\local-ai-pack-manifest.js'
]) {
  if (!asarEntries.includes(required)) throw new Error(`正式 ASAR 缺少 ${required}`)
}

const report = {
  version: pkg.version,
  standard: {
    path: path.relative(root, standard).split(path.sep).join('/'),
    bytes: fs.statSync(standard).size,
    sha256: sha256(standard)
  },
  portable: {
    path: path.relative(root, portable).split(path.sep).join('/'),
    bytes: fs.statSync(portable).size,
    sha256: sha256(portable)
  },
  signing: {
    installer: authenticode(standard),
    application: authenticode(path.join(releaseDirectory, 'win-unpacked', 'AgentPlay.exe'))
  },
  closure: {
    standardHasBundledModel: false,
    localAiDeliveredByInAppDownload: true,
    sapiHelperIncluded: true,
    creativeServiceInAsar: true,
    localAiDownloadServiceInAsar: true,
    legalDocsIncluded: true,
    mpvLicenseAndProvenanceIncluded: true
  }
}
const reportPath = path.join(releaseDirectory, `release-verification-${pkg.version}.json`)
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(report)}\n`)
