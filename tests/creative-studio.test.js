const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  buildCreativePrompt,
  buildSubtitleAss,
  collectVisualEvidence,
  extractJson,
  normalizeCreativePlan,
  requestCreativePlan,
  validateCreativeTimeline
} = require('../electron/creative-studio-service')

test('creative plan carries bounded visual evidence and explicit multimodal schema', () => {
  const thumbnail = `data:image/jpeg;base64,${Buffer.from('fake-jpeg').toString('base64')}`
  const evidence = collectVisualEvidence([
    { at: 1.2, thumbnail, note: '人物入场', shotSize: '中景', movement: '跟' },
    { at: 2, thumbnail: 'https://example.com/not-allowed.jpg' }
  ])
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].at, 1.2)
  const prompt = buildCreativePrompt({ segments: [], markers: [], cues: [] }, evidence.length)
  assert.match(prompt, /deepAnalysis/)
  assert.match(prompt, /generated/)
  assert.match(prompt, /1 张/)
})

test('OpenAI-compatible plan routing reports a text fallback when the selected model rejects images', async () => {
  let calls = 0
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      calls += 1
      const parsed = JSON.parse(body)
      const content = parsed.messages?.[1]?.content
      if (Array.isArray(content)) {
        response.writeHead(400, { 'Content-Type': 'application/json' })
        response.end('{"error":"image input unsupported"}')
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: '文本回退', shots: [{ id: 's', kind: 'source', segmentId: 'seg', duration: 2 }] }) } }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    const thumbnail = `data:image/jpeg;base64,${Buffer.from('fake-jpeg').toString('base64')}`
    const plan = await requestCreativePlan({
      protocol: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'text-only',
      providerName: '本机测试', requiresKey: false, apiKey: '', localOnly: true, capabilities: {}
    }, {
      mediaName: '测试', markers: [{ thumbnail }], segments: [{ id: 'seg', start: 0, end: 2 }], cues: []
    })
    assert.equal(plan.modality, 'text-evidence')
    assert.match(plan.visualFallbackReason, /拒绝图像输入/)
    assert.equal(calls, 3)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('creative plan parser accepts fenced JSON and rejects unknown source segment ids', () => {
  const raw = extractJson('```json\n{"title":"原创","shots":[]}\n```')
  assert.equal(raw.title, '原创')
  const input = { mediaName: '测试片', segments: [{ id: 's1', start: 0, end: 2, title: '开场' }] }
  const plan = normalizeCreativePlan({
    title: '新版', subtitleStyle: 'impact',
    deepAnalysis: { visual: '画面证据结论', weaknesses: ['节奏拖沓'] },
    shots: [
      { id: 'bad', kind: 'source', segmentId: 'missing', duration: 2 },
      { id: 'new', kind: 'generated', duration: 3, prompt: '抽象光影', caption: '新的表达' }
    ]
  }, input)
  assert.equal(plan.shots.length, 1)
  assert.equal(plan.shots[0].kind, 'generated')
  assert.equal(plan.deepAnalysis.visual, '画面证据结论')
  assert.equal(plan.subtitleStyle, 'impact')
})

test('subtitle packaging creates timed ASS dialogue without accepting ASS injection', () => {
  const ass = buildSubtitleAss([
    { duration: 2.5, caption: '{\\pos(0,0)}第一句' },
    { duration: 1.5, narration: '第二句' }
  ], 'documentary')
  assert.match(ass, /PlayResX: 1280/)
  assert.match(ass, /0:00:00\.00,0:00:02\.50/)
  assert.match(ass, /0:00:02\.50,0:00:04\.00/)
  assert.doesNotMatch(ass, /\\pos/)
})

test('creative timeline requires every generated shot to have a real local asset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-creative-test-'))
  const source = path.join(dir, 'source.mp4')
  const image = path.join(dir, 'shot.png')
  fs.writeFileSync(source, 'video')
  fs.writeFileSync(image, 'image')
  try {
    assert.throws(() => validateCreativeTimeline({
      sourcePath: source, segments: [], shots: [{ kind: 'generated', assetPath: '', duration: 3 }]
    }), /尚未生成或导入/)
    const timeline = validateCreativeTimeline({
      sourcePath: source,
      segments: [{ id: 's1', start: 1, end: 4 }],
      shots: [
        { kind: 'source', segmentId: 's1' },
        { kind: 'generated', assetPath: image, duration: 2 }
      ]
    })
    assert.equal(timeline.length, 2)
    assert.equal(timeline[0].duration, 3)
    assert.equal(timeline[1].duration, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('both Windows installers carry the policy-independent SAPI helper and creative IPC surface', () => {
  const root = path.join(__dirname, '..')
  const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8')
  const lean = fs.readFileSync(path.join(root, 'electron-builder.lean.yml'), 'utf8')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8')
  for (const content of [pkg, lean]) assert.match(content, /ai-player-voice\.exe/)
  for (const channel of ['creative-plan', 'generate-image', 'generate-voice', 'render-creative']) {
    assert.match(main, new RegExp(`studio:${channel}`))
    assert.match(preload, new RegExp(`studio:${channel}`))
  }
  assert.equal(fs.existsSync(path.join(root, 'resources', 'voice-helper', 'Program.cs')), true)
})
