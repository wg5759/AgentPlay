const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')
const { TranscriptionService } = require('../electron/transcription-service')
const { DocumentWorkspaceService, classifyTask } = require('../electron/document-workspace-service')

const execFileAsync = promisify(execFile)

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('转写可用性检测：引擎与模型缺一不可', () => {
  const root = tempDir('whisper-avail-')
  try {
    let service = new TranscriptionService({ whisperRoot: root, mpvPath: 'x' })
    assert.equal(service.availability().available, false)
    fs.mkdirSync(path.join(root, 'engine'), { recursive: true })
    fs.writeFileSync(path.join(root, 'engine', 'whisper-cli.exe'), 'x')
    assert.equal(service.availability().available, false)
    fs.writeFileSync(path.join(root, 'ggml-tiny.bin'), 'x')
    assert.equal(service.availability().available, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('转写任务分类：音频转写与 srt，文档不误判', () => {
  assert.deepEqual(classifyTask([{ path: '录音.mp3' }], '转写这段录音', 'auto'), {
    kind: 'transcribe', outputFormat: 'txt', requiresAi: false, summary: '离线语音转写'
  })
  assert.equal(classifyTask([{ path: '会议.wav' }], '生成带时间轴的字幕', 'auto').outputFormat, 'srt')
  assert.notEqual(classifyTask([{ path: '合同.docx' }], '转写这段录音', 'auto').kind, 'transcribe')
})

test('service.run 转写全本地闭环并记录历史', async () => {
  const dir = tempDir('transcribe-run-')
  try {
    const audio = path.join(dir, '录音.mp3')
    fs.writeFileSync(audio, 'fake')
    const service = new DocumentWorkspaceService({
      outputRoot: path.join(dir, 'outputs'),
      historyRoot: path.join(dir, 'history'),
      complete: async () => { throw new Error('不应调用模型') },
      renderPdf: async () => { throw new Error('不应渲染') },
      transcriber: {
        transcribeToFile: async (source, target) => {
          assert.equal(source, audio)
          fs.writeFileSync(target, '今天天气不错\n')
          return { summary: '离线转写完成（6 字）' }
        }
      }
    })
    const result = await service.run([audio], '转写这段录音', 'auto')
    assert.equal(result.success, true)
    assert.equal(result.plan.kind, 'transcribe')
    assert.ok(result.outputs[0].endsWith('-AgentPlay处理版.txt'))
    assert.equal(fs.readFileSync(result.outputs[0], 'utf8').trim(), '今天天气不错')
    assert.match(fs.readFileSync(path.join(dir, 'history', 'history.jsonl'), 'utf8'), /transcribe/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('真实 whisper 中文转写（仅 Windows 且组件在位）', async (t) => {
  if (process.platform !== 'win32') return t.skip('仅 Windows')
  const whisperRoot = path.join(__dirname, '..', 'resources', 'whisper')
  const mpvPath = path.join(__dirname, '..', 'resources', 'bin', 'win', 'mpv.com')
  const service = new TranscriptionService({ whisperRoot, mpvPath })
  const status = service.availability()
  if (!status.available) return t.skip('whisper 组件未就位')
  const wav = path.join(os.tmpdir(), 'agentplay-tts-probe.wav')
  await execFileAsync('powershell.exe', [
    '-NoProfile', '-Command',
    `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav}'); $s.Speak('今天天气不错，我们来测试语音转文字，注册号一二三四五。'); $s.Dispose()`
  ])
  assert.ok(fs.existsSync(wav), 'TTS 没有产出 wav 文件')
  const result = await service.transcribe({ sourcePath: wav, lang: 'zh' })
  assert.ok(result.text.length > 5, `转写结果过短: ${result.text}`)
  assert.match(result.text, /测试|注册|一二三四五|12345/)

  // 中文路径输入必须经暂存闭环（whisper-cli 的 argv 中文路径会直接崩溃）
  const chineseNamed = path.join(os.tmpdir(), '会议录音-测试.wav')
  fs.copyFileSync(wav, chineseNamed)
  const result2 = await service.transcribe({ sourcePath: chineseNamed, lang: 'zh' })
  assert.ok(result2.text.length > 5)
  fs.rmSync(wav, { force: true })
  fs.rmSync(chineseNamed, { force: true })
})
