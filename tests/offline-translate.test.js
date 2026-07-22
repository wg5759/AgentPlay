const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  OfflineTranslateService,
  isMostlyLatin,
  shouldUseOffline
} = require('../electron/offline-translate-service')
const TRANSLATE_PACK = require('../electron/translate-pack-manifest')

const MODEL_ROOT = path.join(__dirname, '..', 'release', 'translate-pack', 'models')
const REAL_MODEL_PRESENT = process.platform === 'win32' && fs.existsSync(path.join(MODEL_ROOT, 'Xenova', 'opus-mt-en-zh', 'onnx', 'encoder_model_quantized.onnx'))

test('latin-dominance heuristic routes English vs CJK subtitle text', () => {
  assert.equal(isMostlyLatin('Welcome back, everyone.'), true)
  assert.equal(isMostlyLatin('The data grew by forty percent.'), true)
  assert.equal(isMostlyLatin('今天我们来测试语音转文字'), false)
  assert.equal(isMostlyLatin('データを見てみましょう'), false)
  assert.equal(isMostlyLatin('OK, see you tomorrow 好吧'), true)
  assert.equal(isMostlyLatin('OK 好吧'), false)
  assert.equal(isMostlyLatin(''), false)
})

test('offline router only accepts English-dominant cues targeting Chinese', () => {
  const english = Array.from({ length: 10 }, (_, i) => ({ index: i + 1, text: `English line ${i + 1}` }))
  const mixed = english.map((entry, i) => (i < 5 ? { ...entry, text: '中文字幕内容' } : entry))
  assert.equal(shouldUseOffline(english, '中文'), true)
  assert.equal(shouldUseOffline(mixed, '中文'), false)
  assert.equal(shouldUseOffline(english, 'English'), false)
  assert.equal(shouldUseOffline([], '中文'), false)
})

test('availability reports missing files and completes honestly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-pack-'))
  const service = new OfflineTranslateService({ modelRoot: root })
  const empty = service.availability()
  assert.equal(empty.available, false)
  assert.equal(empty.missing.length, 6)
  const dir = path.join(root, 'Xenova', 'opus-mt-en-zh')
  for (const file of ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']) {
    const target = path.join(dir, ...file.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'x')
  }
  assert.equal(service.availability().available, true)
})

test('jsonComplete adapts the subtitle batch contract end to end', async () => {
  const service = new OfflineTranslateService({
    modelRoot: os.tmpdir(),
    pipelineFactory: async () => async (text) => [{ translation_text: `译:${text}` }]
  })
  const prompt = ['把下列字幕逐句翻译成中文', '只返回一个 JSON 对象', JSON.stringify({ items: [{ i: 3, text: 'hello' }, { i: 7, text: 'world' }] })].join('\n')
  const result = await service.jsonComplete({ prompt })
  assert.equal(result.provider, 'offline-opus-mt')
  assert.deepEqual(JSON.parse(result.text), { translations: [{ i: 3, text: '译:hello' }, { i: 7, text: '译:world' }] })
  await assert.rejects(service.jsonComplete({ prompt: '没有批量内容' }), /字幕批量任务/)
})

test('translateLines honours cancellation between lines', async () => {
  const controller = new AbortController()
  let calls = 0
  const service = new OfflineTranslateService({
    modelRoot: os.tmpdir(),
    pipelineFactory: async () => async (text) => {
      calls += 1
      if (calls === 1) controller.abort()
      return [{ translation_text: `译:${text}` }]
    }
  })
  await assert.rejects(service.translateLines(['a', 'b', 'c'], { signal: controller.signal }), /已取消/)
  assert.equal(calls, 1)
})

test('translate pack manifest matches staged assets byte for byte', (t) => {
  if (!fs.existsSync(path.join(__dirname, '..', 'release', 'translate-pack'))) {
    t.skip('组件包暂存目录不存在（CI 不出包）')
    return
  }
  assert.equal(TRANSLATE_PACK.tag, 'translate-pack-v1')
  assert.equal(TRANSLATE_PACK.assets.length, 6)
  for (const asset of TRANSLATE_PACK.assets) {
    assert.match(asset.url, /^https:\/\/github\.com\/wg5759\/AgentPlay\/releases\/download\/translate-pack-v1\//)
    const staged = path.join(__dirname, '..', 'release', 'translate-pack', asset.url.split('/').pop())
    assert.ok(fs.existsSync(staged), `缺少暂存资产 ${staged}`)
    assert.equal(fs.statSync(staged).size, asset.size, asset.id)
    const hash = crypto.createHash('sha256').update(fs.readFileSync(staged)).digest('hex')
    assert.equal(hash, asset.sha256, asset.id)
  }
})

test('subtitle chain prefers offline engine and exposes pack download IPC', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
  const modelCenter = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ModelCenter.tsx'), 'utf8')
  assert.match(main, /pickTranslateEngine/)
  assert.match(main, /ipcMain\.handle\('translatePack:status'/)
  assert.match(main, /ipcMain\.handle\('translatePack:download'/)
  assert.match(main, /translateEntries\(entries, engine\.complete\)/)
  assert.match(main, /complete: engine\.complete, signal: controller\.signal, targetLang/)
  assert.match(preload, /ipcRenderer\.invoke\('translatePack:download'\)/)
  assert.match(preload, /translatePack:status/)
  assert.match(modelCenter, /离线翻译组件 · OPUS-MT 英译中/)
})

test('real OPUS-MT model translates English lines offline', { timeout: 180000 }, async (t) => {
  if (!REAL_MODEL_PRESENT) {
    t.skip('本机没有离线翻译模型暂存（CI 跳过真实推理）')
    return
  }
  const service = new OfflineTranslateService({ modelRoot: MODEL_ROOT })
  assert.equal(service.availability().available, true)
  const outputs = await service.translateLines(['Welcome back, everyone.', 'The data grew by forty percent.'])
  assert.equal(outputs.length, 2)
  for (const line of outputs) assert.match(line, /[一-鿿]/, `译文应含中文：${line}`)
})
