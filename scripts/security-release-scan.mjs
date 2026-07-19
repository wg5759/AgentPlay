import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { collectSanitizedUrls, isTextPath, scanText } from './security-scan-lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const includeHistory = process.argv.includes('--history')
const includePackaged = process.argv.includes('--packaged')
const maxTextBytes = 2 * 1024 * 1024

function git(args, encoding = 'utf8') {
  const result = spawnSync('git', args, { cwd: root, encoding, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr || result.stdout}`)
  return result.stdout
}

function readText(filePath) {
  const stat = fs.statSync(filePath)
  if (!stat.isFile() || stat.size > maxTextBytes) return null
  return fs.readFileSync(filePath, 'utf8')
}

function currentFiles() {
  return git(['ls-files', '-co', '--exclude-standard', '-z'], 'buffer')
    .toString('utf8').split('\0').filter(Boolean)
}

function historyBlobs() {
  const objects = git(['rev-list', '--objects', '--all']).split(/\r?\n/).filter(Boolean)
  const unique = new Map()
  for (const entry of objects) {
    const split = entry.indexOf(' ')
    if (split < 0) continue
    const oid = entry.slice(0, split)
    const filePath = entry.slice(split + 1)
    if (isTextPath(filePath) && !unique.has(oid)) unique.set(oid, filePath)
  }
  return unique
}

function walk(directory) {
  if (!fs.existsSync(directory)) return []
  const output = []
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, item.name)
    if (item.isDirectory()) output.push(...walk(fullPath))
    else output.push(fullPath)
  }
  return output
}

const findings = []
const endpointMap = new Map()
let scannedCurrent = 0
let scannedHistory = 0
let scannedPackaged = 0

for (const relative of currentFiles()) {
  if (!isTextPath(relative)) continue
  const fullPath = path.join(root, relative)
  if (!fs.existsSync(fullPath)) continue
  const text = readText(fullPath)
  if (text === null) continue
  scannedCurrent++
  findings.push(...scanText(`worktree:${relative.replaceAll('\\', '/')}`, text))
  for (const item of collectSanitizedUrls(relative.replaceAll('\\', '/'), text)) {
    const key = `${item.endpoint}|${item.source}`
    endpointMap.set(key, item)
  }
}

if (includeHistory) {
  for (const [oid, filePath] of historyBlobs()) {
    const size = Number(git(['cat-file', '-s', oid]).trim())
    if (!Number.isFinite(size) || size > maxTextBytes) continue
    const text = git(['cat-file', '-p', oid])
    scannedHistory++
    findings.push(...scanText(`history:${oid.slice(0, 12)}:${filePath}`, text))
  }
}

if (includePackaged) {
  const packagedRoot = path.join(root, 'release', 'win-unpacked', 'resources')
  for (const fullPath of walk(packagedRoot)) {
    const relative = path.relative(packagedRoot, fullPath)
    if (!isTextPath(relative)) continue
    const text = readText(fullPath)
    if (text === null) continue
    scannedPackaged++
    findings.push(...scanText(`packaged:${relative.replaceAll('\\', '/')}`, text))
  }
}

const dedupedFindings = [...new Map(findings.map((item) => [`${item.source}|${item.line}|${item.rule}`, item])).values()]
const endpoints = [...endpointMap.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint) || a.source.localeCompare(b.source))
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  scope: { current: true, history: includeHistory, packaged: includePackaged },
  scanned: { currentFiles: scannedCurrent, historyBlobs: scannedHistory, packagedFiles: scannedPackaged },
  findings: dedupedFindings,
  endpoints
}

const releaseDir = path.join(root, 'release')
fs.mkdirSync(releaseDir, { recursive: true })
const reportPath = path.join(releaseDir, 'security-release-scan.json')
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)

if (dedupedFindings.length) {
  process.stderr.write(`安全扫描发现 ${dedupedFindings.length} 个高置信候选（报告不包含秘密值）：\n`)
  for (const item of dedupedFindings) process.stderr.write(`- ${item.rule} ${item.source}:${item.line}\n`)
  process.exit(1)
}
process.stdout.write(`${JSON.stringify({ success: true, reportPath, scanned: report.scanned, endpointCount: endpoints.length })}\n`)
