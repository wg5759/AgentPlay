import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const platformDir = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
const mpvName = process.platform === 'win32' ? 'mpv.exe' : 'mpv'
const renderBinary = path.join(root, 'resources', 'bin', platformDir, mpvName)
const voiceBinary = process.platform === 'win32'
  ? path.join(root, 'resources', 'bin', 'win', 'ai-player-voice.exe')
  : process.platform === 'darwin' ? '/usr/bin/say' : ['/usr/bin/espeak-ng', '/usr/local/bin/espeak-ng'].find(fs.existsSync)
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  webPlayer: fs.existsSync(path.join(root, 'dist', 'index.html')),
  desktopShell: true,
  multimodalPlanning: true,
  advancedCreativeRender: fs.existsSync(renderBinary),
  renderBinary: fs.existsSync(renderBinary) ? path.relative(root, renderBinary) : null,
  systemVoice: Boolean(voiceBinary && fs.existsSync(voiceBinary)),
  systemVoiceBinary: voiceBinary && fs.existsSync(voiceBinary) ? voiceBinary : null
}
const outputDir = path.join(root, 'release')
fs.mkdirSync(outputDir, { recursive: true })
const outputPath = path.join(outputDir, `platform-capabilities-${process.platform}-${process.arch}.json`)
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(report)}\n`)
if (process.argv.includes('--require-creative') && (!report.advancedCreativeRender || !report.systemVoice)) process.exit(2)
