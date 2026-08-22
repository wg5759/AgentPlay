const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  parseSrt,
  buildBilingualSrt,
  buildTranslationOnlySrt,
  chooseOppositeTarget,
  parseTranslationsJson,
  translateEntries
} = require('../electron/subtitle-bilingual-service')
const WHISPER_MANIFEST = require('../electron/whisper-pack-manifest')

const SAMPLE_SRT = `1
00:00:01,000 --> 00:00:03,500
Hello world

2
00:00:04,000 --> 00:00:06,000
This is a test
with two lines

`

test('parseSrt 解析序号、时间轴与多行文本，跳过无效块', () => {
  const entries = parseSrt(SAMPLE_SRT + 'garbage block\n\n')
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0], { index: 1, start: '00:00:01,000', end: '00:00:03,500', text: 'Hello world' })
  assert.equal(entries[1].text, 'This is a test\nwith two lines')
})

test('buildBilingualSrt 原文在上译文在下，缺译保留原文', () => {
  const entries = parseSrt(SAMPLE_SRT)
  const output = buildBilingualSrt(entries, new Map([[1, '你好，世界']]))
  assert.ok(output.includes('Hello world\n你好，世界'))
  const secondBlock = output.split('\n\n')[1]
  assert.equal(secondBlock, '2\n00:00:04,000 --> 00:00:06,000\nThis is a test\nwith two lines\n')
})

test('主字幕只输出目标语言，长中文按时间拆成每屏最多两行', () => {
  const entries = [{
    index: 1,
    start: '00:00:01,000',
    end: '00:00:13,000',
    text: "Building the most comprehensive profile of your company that you've ever seen."
  }]
  const translated = '建立你见过的最全面的公司形象。林迪就像一个队友，会加入你的会议并不断学习；但与普通队友不同，林迪可以同时参加数百场会议。'
  const output = buildTranslationOnlySrt(entries, new Map([[1, translated]]), { targetLang: '中文' })
  const cues = parseSrt(output)
  assert.ok(cues.length >= 2, '长段必须拆成多个随时间推进的字幕 cue')
  assert.doesNotMatch(output, /Building the most comprehensive/)
  assert.equal(cues[0].start, entries[0].start)
  assert.equal(cues.at(-1).end, entries[0].end)
  for (const cue of cues) {
    const lines = cue.text.split('\n')
    assert.ok(lines.length <= 2, `单个字幕不应超过两行：${cue.text}`)
    assert.ok(lines.every((line) => Array.from(line).length <= 16), `中文每行不应超过 16 字：${cue.text}`)
  }

  const naturalOutput = buildTranslationOnlySrt(entries, new Map([[1, '欢迎来到Play探员。这是英语字幕测试。人工智能帮助人们理解视频。']]), { targetLang: '中文' })
  const naturalLines = parseSrt(naturalOutput).flatMap((cue) => cue.text.split('\n'))
  assert.ok(naturalLines.includes('这是英语字幕测试。'), '应优先在句号处分行，不应为了填满 16 字截断下一短句')
  assert.ok(naturalLines.includes('人工智能帮助人们理解视频。'), '完整短句应留在同一行')
})

test('字幕翻译方向与原内容相反：中文转英文，英文转中文', () => {
  assert.equal(chooseOppositeTarget([{ text: '大家好，今天我们介绍公司的新产品和使用方法。' }]), '英文')
  assert.equal(chooseOppositeTarget([{ text: 'Welcome to the product launch. Today we will introduce the new workflow.' }]), '中文')
  assert.equal(chooseOppositeTarget([{ text: '12345' }]), '中文')
})

test('parseTranslationsJson 兼容围栏、字段别名与垃圾条目', () => {
  const map = parseTranslationsJson('```json\n{"translations":[{"i":1,"text":"你好"},{"index":2,"t":"世界"},{"i":0,"text":"丢弃"},{"i":3,"text":""}]}\n```')
  assert.equal(map.get(1), '你好')
  assert.equal(map.get(2), '世界')
  assert.equal(map.size, 2)
  assert.throws(() => parseTranslationsJson('not json'), /不是有效 JSON/)
})

test('translateEntries 按批对齐序号，批失败如实计数不中断', async () => {
  const entries = Array.from({ length: 25 }, (_, index) => ({
    index: index + 1,
    start: `00:00:${String(index).padStart(2, '0')},000`,
    end: `00:00:${String(index + 1).padStart(2, '0')},000`,
    text: `line ${index + 1}`
  }))
  let calls = 0
  const complete = async ({ prompt }) => {
    calls += 1
    if (calls === 2) throw new Error('第二批失败')
    const items = JSON.parse(prompt.split('\n').pop()).items
    return { text: JSON.stringify({ translations: items.map((item) => ({ i: item.i, text: `译${item.text}` })) }) }
  }
  const { translations, failed } = await translateEntries(entries, complete, { batchSize: 20 })
  assert.equal(calls, 2)
  assert.equal(translations.size, 20)
  assert.equal(failed, 5)
  assert.equal(translations.get(1), '译line 1')
  assert.equal(translations.get(20), '译line 20')
  assert.equal(translations.has(21), false)
})

test('translateEntries reports progress and stops before the next batch when cancelled', async () => {
  const entries = Array.from({ length: 25 }, (_, index) => ({
    index: index + 1,
    start: `00:00:${String(index).padStart(2, '0')},000`,
    end: `00:00:${String(index + 1).padStart(2, '0')},000`,
    text: `line ${index + 1}`
  }))
  const controller = new AbortController()
  const progress = []
  let calls = 0
  const complete = async ({ prompt }) => {
    calls += 1
    const items = JSON.parse(prompt.split('\n').pop()).items
    return { text: JSON.stringify({ translations: items.map((item) => ({ i: item.i, text: `translated ${item.i}` })) }) }
  }
  await assert.rejects(
    translateEntries(entries, complete, {
      batchSize: 10,
      signal: controller.signal,
      onProgress: ({ done, total }) => {
        progress.push([done, total])
        controller.abort()
      }
    }),
    (error) => error?.name === 'AbortError'
  )
  assert.equal(calls, 1)
  assert.deepEqual(progress, [[10, 25]])
})

test('translateEntries resumes completed batches without repeating model calls', async () => {
  const entries = Array.from({ length: 4 }, (_, index) => ({ index: index + 1, start: '', end: '', text: `line ${index + 1}` }))
  const checkpoints = []
  const calls = []
  const complete = async ({ prompt }) => {
    const items = JSON.parse(prompt.split('\n').pop()).items
    calls.push(items.map((item) => item.i))
    return { text: JSON.stringify({ translations: items.map((item) => ({ i: item.i, text: `译${item.i}` })) }) }
  }
  const first = await translateEntries(entries.slice(0, 2), complete, { batchSize: 2, onCheckpoint: (value) => checkpoints.push(value) })
  assert.equal(first.translations.size, 2)
  const resumed = await translateEntries(entries, complete, { batchSize: 2, initialTranslations: checkpoints.at(-1).translations })
  assert.deepEqual(calls, [[1, 2], [3, 4]], '已完成的 1/2 不得在恢复后再次发送给模型')
  assert.equal(resumed.translations.size, 4)
})

test('转写组件清单与托管资产哈希锁定', () => {
  const model = WHISPER_MANIFEST.assets.find((asset) => asset.role === 'model')
  const engine = WHISPER_MANIFEST.assets.find((asset) => asset.kind === 'zip')
  assert.equal(model.sha256, 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21')
  assert.equal(model.size, 77691713)
  assert.equal(engine.sha256, 'd824b1e37599f882b396e73f1ee0bfd5d0529f700314c48311dcbd00b803321d')
  assert.ok(engine.files.length > 10)
  assert.ok(WHISPER_MANIFEST.tag, 'whisper-pack-v1')
  for (const asset of WHISPER_MANIFEST.assets) {
    assert.ok(asset.url.startsWith('https://github.com/wg5759/AgentPlay/releases/download/whisper-pack-v1/'), asset.url)
  }
})

test('双语字幕与转写下载的主进程、菜单、渲染层装配', () => {
  const root = path.join(__dirname, '..')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8')
  const playerView = fs.readFileSync(path.join(root, 'src', 'components', 'PlayerView.tsx'), 'utf8')
  const modelCenter = fs.readFileSync(path.join(root, 'src', 'components', 'ModelCenter.tsx'), 'utf8')
  assert.match(main, /subtitle:bilingual-generate/)
  assert.match(main, /自动翻译字幕/)
  assert.match(main, /buildTranslationOnlySrt/)
  assert.match(main, /chooseOppositeTarget/)
  assert.doesNotMatch(main, /AgentPlay双语/)
  assert.match(main, /transcribe:status/)
  assert.match(main, /transcribe:download/)
  assert.match(main, /transcribe:cancel-download/)
  assert.match(preload, /subtitleBilingual/)
  assert.match(preload, /transcribe: \{/)
  assert.match(playerView, /bilingual-subtitle/)
  assert.match(playerView, /generateBilingual/)
  assert.match(playerView, /字幕翻译只支持本地文件/)
  assert.match(modelCenter, /录音转写组件/)
  assert.match(modelCenter, /下载转写组件/)
})
