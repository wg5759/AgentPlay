import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { MediaEditProjectStore } = require('../electron/media-edit-project-store')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name) => process.argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || ''
const sourcePath = path.resolve(arg('--source') || '')
const outputPath = path.resolve(arg('--output') || path.join(root, 'artifacts', 'acceptance', 'media-edit-real', 'trim-4s-20s.mp4'))
if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('用 --source=<绝对视频路径> 指定真实原片')
if (!fs.existsSync(outputPath)) throw new Error(`缺少真实裁剪成片：${outputPath}`)

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

const evidenceDir = path.join(root, 'artifacts', 'acceptance', 'media-edit-history')
const stateDir = path.join(evidenceDir, 'state')
fs.mkdirSync(evidenceDir, { recursive: true })
const resolvedStateDir = path.resolve(stateDir)
if (!resolvedStateDir.startsWith(`${path.resolve(evidenceDir)}${path.sep}`) || path.basename(resolvedStateDir) !== 'state') throw new Error(`拒绝清理非验收状态目录：${resolvedStateDir}`)
if (fs.existsSync(resolvedStateDir)) fs.rmSync(resolvedStateDir, { recursive: true, force: true })
const before = { source: sha256(sourcePath), output: sha256(outputPath) }
const decision = { schemaVersion: 1, kind: 'media.trim', timeline: { startSeconds: 4, endSeconds: 20, durationSeconds: 16 } }
const first = new MediaEditProjectStore({ rootDir: stateDir })
const recorded = first.recordTrim({ taskId: 'real-trim-4s-20s', sourcePath, outputPath, decision })
const undone = first.navigate({ currentPath: outputPath, direction: 'undo' })
const afterRestart = new MediaEditProjectStore({ rootDir: stateDir })
const redone = afterRestart.navigate({ currentPath: sourcePath, direction: 'redo' })
const after = { source: sha256(sourcePath), output: sha256(outputPath) }

if (recorded.versionCount !== 2 || recorded.currentPath !== outputPath) throw new Error('项目胶囊没有记录真实成片')
if (!undone.success || undone.currentPath !== sourcePath || !undone.canRedo) throw new Error('撤销没有回到原片')
if (!redone.success || redone.currentPath !== outputPath || !redone.canUndo) throw new Error('重启后重做没有回到成片')
if (before.source !== after.source || before.output !== after.output) throw new Error('撤销/重做不应修改原片或成片')

const receipt = {
  passed: true,
  checkedAt: new Date().toISOString(),
  sourcePath,
  outputPath,
  before,
  after,
  recorded,
  undone,
  redone,
  statePath: path.join(stateDir, 'media-edit-projects-v1.json')
}
const receiptPath = path.join(evidenceDir, 'receipt.json')
fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ passed: true, receiptPath, versionCount: recorded.versionCount, undoPath: undone.currentPath, redoPath: redone.currentPath, filesUnchanged: true }, null, 2)}\n`)
