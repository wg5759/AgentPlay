import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { renderCreativeVideo, synthesizeSystemVoice } = require('../electron/creative-studio-service')

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceArg = process.argv.slice(2).find((value) => !value.startsWith('--'))
const sourcePath = sourceArg || path.resolve(projectRoot, '..', '..', '测试视频-可见画面.mp4')
const imagePath = path.join(projectRoot, 'public', 'icons', 'icon-512.png')
const runtimeRoot = process.argv.includes('--packaged')
  ? path.join(projectRoot, 'release', 'win-unpacked', 'resources')
  : path.join(projectRoot, 'resources')
const mpvPath = path.join(runtimeRoot, 'bin', 'win', process.platform === 'win32' ? 'mpv.com' : 'mpv')
const voiceHelperPath = path.join(runtimeRoot, 'bin', 'win', 'ai-player-voice.exe')

for (const required of [sourcePath, imagePath, mpvPath]) {
  if (!fs.existsSync(required)) throw new Error(`缺少创意渲染探针依赖：${required}`)
}

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-creative-smoke-'))
const voice = await synthesizeSystemVoice({ text: '这是 AI 播放器原创成片的真实渲染测试。', outputDir, helperPath: voiceHelperPath })
const outputPath = path.join(outputDir, 'creative-smoke.mp4')
const result = await renderCreativeVideo({
  mpvPath,
  outputPath,
  onSpawn: (child) => process.stderr.write(`[creative-smoke] ${JSON.stringify(child.spawnargs)}\n`),
  input: {
    sourcePath,
    segments: [{ id: 'source-1', start: 0, end: 2 }],
    shots: [
      { id: 'source', kind: 'source', segmentId: 'source-1', duration: 2, caption: '原片重构段' },
      { id: 'generated', kind: 'generated', assetPath: imagePath, duration: 2, caption: 'AI 新镜头占位素材' }
    ],
    subtitleStyle: 'impact',
    voicePath: voice.outputPath,
    musicPath: sourcePath,
    musicVolume: 0.08
  }
})

if (!result.success || result.bytes < 1000) throw new Error('创意渲染探针没有生成有效 MP4')
process.stdout.write(`${JSON.stringify({ ...result, voiceEngine: voice.engine })}\n`)
