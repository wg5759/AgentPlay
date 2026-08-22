const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { compileTranslateSubtitlesDecisionList, planEditInstruction, resolveEditClarification } = require('../electron/media-edit-decision')
const { MediaEditService } = require('../electron/media-edit-service')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'useMediaCreativeTasks.ts'), 'utf8')
const runtime = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'usePersistentTaskRuntime.ts'), 'utf8')
const quality = fs.readFileSync(path.join(__dirname, '..', 'electron', 'task-result-quality.js'), 'utf8')

const SOURCE = 'D:/视频/纪录片.mp4'

// 与云端/离线引擎同构的 complete 假引擎：解析 prompt 尾部的 {"items":[...]}，逐条回译
function fakeEngine(mapper, label = '测试引擎') {
  return {
    label,
    complete: async ({ prompt }) => {
      const items = JSON.parse(String(prompt).slice(String(prompt).indexOf('{"items"'))).items
      return { text: JSON.stringify({ translations: items.map((item) => ({ i: item.i, text: mapper(item.text) })) }) }
    }
  }
}

test('translate-subtitles decision: target/mode compile, missing file or target clarifies, consultation stays out', () => {
  const toEn = compileTranslateSubtitlesDecisionList({ instruction: '把字幕 D:/视频/字幕.srt 翻译成英文', sourcePath: SOURCE })
  assert.equal(toEn.kind, 'media.translate-subtitles')
  assert.equal(toEn.subtitle.path, 'D:/视频/字幕.srt')
  assert.equal(toEn.translate.targetLang, '英文')
  assert.equal(toEn.translate.mode, 'translated')
  assert.match(toEn.output.suffix, /英译版/)

  const toZh = compileTranslateSubtitlesDecisionList({ instruction: '把字幕 D:/视频/字幕.srt 译成中文', sourcePath: SOURCE })
  assert.equal(toZh.translate.targetLang, '中文')
  assert.match(toZh.output.suffix, /中译版/)

  const bilingual = compileTranslateSubtitlesDecisionList({ instruction: '把字幕 D:/视频/字幕.srt 翻译成双语', sourcePath: SOURCE })
  assert.equal(bilingual.translate.mode, 'bilingual')
  assert.equal(bilingual.translate.targetLang, 'auto')
  assert.match(bilingual.output.suffix, /双语版/)

  // 没有翻译动词/没有路径/没有目标：不形成决策
  assert.equal(compileTranslateSubtitlesDecisionList({ instruction: '把字幕 D:/视频/字幕.srt 处理一下', sourcePath: SOURCE }), null)
  assert.equal(compileTranslateSubtitlesDecisionList({ instruction: '把字幕翻译成英文', sourcePath: SOURCE }), null)
  assert.equal(compileTranslateSubtitlesDecisionList({ instruction: '把字幕 D:/视频/字幕.srt 翻译一下', sourcePath: SOURCE }), null)

  // 缺文件：不接管（可能指当前视频的双语生成），不形成决策也不追问
  assert.equal(planEditInstruction({ instruction: '把字幕翻译成英文', sourcePath: SOURCE }).matched, false)

  // 缺目标（有路径）：追问语言
  const noTarget = planEditInstruction({ instruction: '把字幕 D:/视频/字幕.srt 翻译一下', sourcePath: SOURCE })
  assert.equal(noTarget.clarification?.reason, 'missing-translate-target')
  const resolvedTarget = resolveEditClarification({ clarification: noTarget.clarification, answer: '中文' })
  assert.equal(resolvedTarget.decision?.translate.targetLang, '中文')
  const resolvedBilingual = resolveEditClarification({ clarification: noTarget.clarification, answer: '双语' })
  assert.equal(resolvedBilingual.decision?.translate.mode, 'bilingual')

  // 询问句不误执行
  assert.equal(planEditInstruction({ instruction: '能不能把字幕翻译成英文？', sourcePath: SOURCE }).matched, false)
})

test('translate-subtitles wiring: task registered, decision routed with frozen engine, renderer gate accepts, quality covers', () => {
  assert.match(main, /persistentTaskRuntime\.register\('media\.translate-subtitles'/)
  assert.match(main, /decision\.kind === 'media\.translate-subtitles'/)
  assert.match(main, /'media\.translate-subtitles'/)
  assert.match(main, /compileTranslateSubtitlesDecisionList/)
  assert.match(main, /engineChoice === 'offline'/)
  assert.match(main, /resolveTaskModelRoute\(task\.spec\.modelRoute\)/, '云端引擎必须走冻结路由重建')
  assert.match(main, /ensureCloudConsent\(`把字幕原文发送给 \$\{engine\.label\} 翻译成\$\{targetLang\}；视频文件不会上传`\)/, '云端翻译必须先过同意框')
  assert.match(main, /media\.shift-subtitles' \|\| type === 'media\.translate-subtitles'/, '质量修复清单必须含字幕翻译')
  assert.match(panel, /'media\.translate-subtitles'/)
  assert.match(panel, /翻译字幕/)
  assert.match(runtime, /media\.translate-subtitles/)
  assert.match(quality, /media\.translate-subtitles/, '质量核查必须覆盖字幕翻译')
})

test('real translateSubtitles: translated/bilingual outputs verified, failures fail closed, source untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-subtitles-'))
  try {
    const service = new MediaEditService({ frames: {} })
    const srt = path.join(dir, '字幕.srt')
    fs.writeFileSync(srt, '1\r\n00:00:01,000 --> 00:00:02,500\r\n你好，世界\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n今天天气不错\r\n', 'utf8')
    const before = fs.statSync(srt)

    // 中→英（译文模式）
    const enOut = path.join(dir, '英译版.srt')
    const enDecision = compileTranslateSubtitlesDecisionList({ instruction: `把字幕 ${srt} 翻译成英文`, sourcePath: 'D:/视频/x.mp4' })
    const enResult = await service.translateSubtitles({
      sourcePath: srt, outputPath: enOut, decision: enDecision,
      engine: fakeEngine((text) => ({ '你好，世界': 'Hello, world', '今天天气不错': 'Nice weather today' })[text] || `EN:${text}`)
    })
    assert.equal(enResult.targetLang, '英文')
    const enText = fs.readFileSync(enOut, 'utf8')
    assert.ok(enText.includes('Hello, world'), enText)
    assert.ok(!enText.includes('你好'), '译文模式不应残留原文')
    assert.match(enText, /00:00:01,000 --> 00:00:02,500/)

    // 中→英双语（原文在上、译文在下、时间轴一致）
    const biOut = path.join(dir, '双语版.srt')
    const biDecision = compileTranslateSubtitlesDecisionList({ instruction: `把字幕 ${srt} 翻译成双语`, sourcePath: 'D:/视频/x.mp4' })
    const biResult = await service.translateSubtitles({
      sourcePath: srt, outputPath: biOut, decision: biDecision,
      engine: fakeEngine((text) => `EN:${text}`)
    })
    assert.equal(biResult.mode, 'bilingual')
    assert.equal(biResult.targetLang, '英文', '中文源的双语目标应自动判成英文')
    const biText = fs.readFileSync(biOut, 'utf8')
    assert.ok(biText.includes('你好，世界\nEN:你好，世界'), `双语应原文在上译文在下：${biText.slice(0, 200)}`)

    // 批次失败：故障关闭不交付
    await assert.rejects(
      () => service.translateSubtitles({
        sourcePath: srt, outputPath: path.join(dir, '失败版.srt'),
        decision: enDecision,
        engine: { label: '坏引擎', complete: async () => { throw new Error('引擎报错') } }
      }),
      /未能可靠翻译|拒绝交付/
    )
    assert.ok(!fs.existsSync(path.join(dir, '失败版.srt')), '失败时不得产出成果文件')

    // 译文语言不符（引擎返回纯中文当中译英成果）：交付闸门拒绝
    await assert.rejects(
      () => service.translateSubtitles({
        sourcePath: srt, outputPath: path.join(dir, '错语言版.srt'),
        decision: enDecision,
        engine: fakeEngine((text) => text)
      }),
      /没有检测到英文文本/
    )

    // 覆盖已存在成果：故障关闭
    await assert.rejects(
      () => service.translateSubtitles({ sourcePath: srt, outputPath: enOut, decision: enDecision, engine: fakeEngine((text) => `EN:${text}`) }),
      /已存在/
    )
    // verify 路径（断点续跑复核）：结构+语言复核通过
    const verified = await service.verify({ sourcePath: srt, outputPath: enOut, decision: enDecision })
    assert.equal(verified.sourceCueCount, 2)
    // 源字幕文件始终不动
    const after = fs.statSync(srt)
    assert.deepEqual([after.size, Math.trunc(after.mtimeMs)], [before.size, Math.trunc(before.mtimeMs)])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
