import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { VideoFrameService, meanAbsDiff } = require('../electron/video-frame-service')
const { MediaEditService } = require('../electron/media-edit-service')
const { compileEditDecisionList } = require('../electron/media-edit-decision')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name) => process.argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || ''
const sourcePath = path.resolve(arg('--source') || '')
if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('用 --source=<绝对视频路径> 指定真实视频')

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
const binDir = arg('--ffmpeg-dir') || path.join(appData, 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin')
const frames = new VideoFrameService({ ffmpegPath: path.join(binDir, 'ffmpeg.exe'), ffprobePath: path.join(binDir, 'ffprobe.exe') })
if (!frames.availability().available) throw new Error(`FFmpeg 不可用：${binDir}`)

const evidenceDir = path.join(root, 'artifacts', 'acceptance', 'media-edit-real')
fs.mkdirSync(evidenceDir, { recursive: true })
const outputPath = path.join(evidenceDir, 'trim-4s-20s.mp4')
const removedOutputPath = path.join(evidenceDir, 'trim-4s-20s-remove-4s-8s.mp4')
const concatOutputPath = path.join(evidenceDir, 'trim-remove-reordered-8s.mp4')
if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true })
if (fs.existsSync(removedOutputPath)) fs.rmSync(removedOutputPath, { force: true })
if (fs.existsSync(concatOutputPath)) fs.rmSync(concatOutputPath, { force: true })

function quickFingerprint(filePath) {
  const stat = fs.statSync(filePath)
  const sample = Math.min(128 * 1024, stat.size)
  const handle = fs.openSync(filePath, 'r')
  const first = Buffer.alloc(sample)
  const last = Buffer.alloc(sample)
  try {
    fs.readSync(handle, first, 0, sample, 0)
    fs.readSync(handle, last, 0, sample, Math.max(0, stat.size - sample))
  } finally {
    fs.closeSync(handle)
  }
  return crypto.createHash('sha256').update(first).update(last).update(String(stat.size)).digest('hex')
}

const sourceBefore = { bytes: fs.statSync(sourcePath).size, fingerprint: quickFingerprint(sourcePath) }
const decision = compileEditDecisionList({ instruction: '我想要第四秒到第20秒的这段视频', sourcePath })
if (!decision) throw new Error('明确剪辑指令未生成决策')
const service = new MediaEditService({ frames })
const result = await service.trim({ sourcePath, outputPath, decision })
const sourceAfter = { bytes: fs.statSync(sourcePath).size, fingerprint: quickFingerprint(sourcePath) }
if (sourceBefore.bytes !== sourceAfter.bytes || sourceBefore.fingerprint !== sourceAfter.fingerprint) throw new Error('源视频被修改')
if (Math.abs(result.durationSeconds - 16) > 0.2) throw new Error(`成品时长不合格：${result.durationSeconds}`)
if (result.frameProof?.verdict !== 'matched') throw new Error(`真实素材首尾帧边界未获得明确匹配证明：${JSON.stringify(result.frameProof)}`)
const trimBeforeDelete = { bytes: fs.statSync(outputPath).size, fingerprint: quickFingerprint(outputPath) }
const removeDecision = compileEditDecisionList({ instruction: '删除第4秒到第8秒', sourcePath: outputPath })
if (!removeDecision || removeDecision.kind !== 'media.remove-segment') throw new Error('明确删除片段指令未生成决策')
const removeResult = await service.removeSegment({ sourcePath: outputPath, outputPath: removedOutputPath, decision: removeDecision })
const trimAfterDelete = { bytes: fs.statSync(outputPath).size, fingerprint: quickFingerprint(outputPath) }
if (trimBeforeDelete.bytes !== trimAfterDelete.bytes || trimBeforeDelete.fingerprint !== trimAfterDelete.fingerprint) throw new Error('继续编辑覆盖了上一版本')
if (Math.abs(removeResult.durationSeconds - 12) > 0.2) throw new Error(`删除片段后的成品时长不合格：${removeResult.durationSeconds}`)
if (removeResult.frameProof?.verdict !== 'matched' || removeResult.frameProof.boundaries?.length !== 2) throw new Error(`删除片段没有证明两个保留片段的首尾边界：${JSON.stringify(removeResult.frameProof)}`)
const removedBeforeConcat = { bytes: fs.statSync(removedOutputPath).size, fingerprint: quickFingerprint(removedOutputPath) }
const concatDecision = compileEditDecisionList({ instruction: '把第8秒到第12秒放前面，再接第0秒到第4秒', sourcePath: removedOutputPath })
if (!concatDecision || concatDecision.kind !== 'media.concat-segments') throw new Error('明确拼接重排指令未生成决策')
const concatResult = await service.concatSegments({ sourcePath: removedOutputPath, outputPath: concatOutputPath, decision: concatDecision })
const removedAfterConcat = { bytes: fs.statSync(removedOutputPath).size, fingerprint: quickFingerprint(removedOutputPath) }
if (removedBeforeConcat.bytes !== removedAfterConcat.bytes || removedBeforeConcat.fingerprint !== removedAfterConcat.fingerprint) throw new Error('拼接重排覆盖了上一版本')
if (Math.abs(concatResult.durationSeconds - 8) > 0.2) throw new Error(`拼接重排后的成品时长不合格：${concatResult.durationSeconds}`)
if (concatResult.frameProof?.verdict !== 'matched' || concatResult.frameProof.boundaries?.length !== 2) throw new Error(`拼接重排没有证明两个片段的首尾边界：${JSON.stringify(concatResult.frameProof)}`)

const orderDir = path.join(evidenceDir, 'order-check')
fs.rmSync(orderDir, { recursive: true, force: true })
fs.mkdirSync(orderDir, { recursive: true })
async function readGrayFrame(filePath, seconds, name) {
  const framePath = path.join(orderDir, `${name}.gray`)
  await frames.run(['-hide_banner', '-nostdin', '-ss', Number(seconds).toFixed(3), '-i', filePath, '-frames:v', '1', '-vf', 'scale=32:32,format=gray', '-f', 'rawvideo', '-y', framePath])
  return fs.readFileSync(framePath)
}
const [sourceFirst, sourceSecond, outputFirst, outputSecond] = await Promise.all([
  readGrayFrame(removedOutputPath, 8.5, 'source-first'),
  readGrayFrame(removedOutputPath, 0.5, 'source-second'),
  readGrayFrame(concatOutputPath, 0.5, 'output-first'),
  readGrayFrame(concatOutputPath, 4.5, 'output-second')
])
const orderEvidence = {
  firstToRequested: meanAbsDiff(outputFirst, sourceFirst),
  firstToWrong: meanAbsDiff(outputFirst, sourceSecond),
  secondToRequested: meanAbsDiff(outputSecond, sourceSecond),
  secondToWrong: meanAbsDiff(outputSecond, sourceFirst)
}
if (!(orderEvidence.firstToRequested < orderEvidence.firstToWrong && orderEvidence.secondToRequested < orderEvidence.secondToWrong)) {
  throw new Error(`拼接顺序画面校验失败：${JSON.stringify(orderEvidence)}`)
}

const receipt = {
  passed: true,
  checkedAt: new Date().toISOString(),
  sourcePath,
  sourceBefore,
  sourceAfter,
  decision,
  result,
  removeDecision,
  removeResult,
  concatDecision,
  concatResult,
  trimBeforeDelete,
  trimAfterDelete,
  removedBeforeConcat,
  removedAfterConcat,
  orderEvidence
}
const receiptPath = path.join(evidenceDir, 'receipt.json')
fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ passed: true, outputPath, removedOutputPath, concatOutputPath, receiptPath, durationSeconds: result.durationSeconds, frameProof: result.frameProof, removedDurationSeconds: removeResult.durationSeconds, removeFrameProof: removeResult.frameProof, concatDurationSeconds: concatResult.durationSeconds, concatFrameProof: concatResult.frameProof, orderEvidence, sourceUnchanged: true, priorVersionsUnchanged: true }, null, 2)}\n`)
