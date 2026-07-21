const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const JSZip = require('jszip')
const PptxGenJS = require('pptxgenjs')
const { editPptx, parsePptxEditInstruction } = require('../electron/pptx-editor')
const { DocumentWorkspaceService, classifyTask } = require('../electron/document-workspace-service')

async function buildFixture(filePath) {
  const pptx = new PptxGenJS()
  const s1 = pptx.addSlide()
  s1.addText('年度汇报', { x: 0.5, y: 0.5, w: 9, h: 1, fontSize: 32, bold: true })
  s1.addText('汇报人：张三', { x: 0.5, y: 1.6, w: 9, h: 0.6, fontSize: 18 })
  s1.addNotes('首页备注')
  const s2 = pptx.addSlide()
  s2.addText('第二季度数据', { x: 0.5, y: 0.5, w: 9, h: 0.8, fontSize: 24, bold: true })
  s2.addText([{ text: '收入增长 20%' }, { text: '成本下降 5%' }], { x: 0.8, y: 1.5, w: 8, h: 2, bullet: true, fontSize: 16 })
  const s3 = pptx.addSlide()
  s3.addText('感谢观看', { x: 0.5, y: 2.5, w: 9, h: 1, fontSize: 28 })
  await pptx.writeFile({ fileName: filePath })
}

async function slideTexts(filePath) {
  const archive = await JSZip.loadAsync(fs.readFileSync(filePath))
  const relsXml = await archive.file('ppt/_rels/presentation.xml.rels').async('string')
  const rels = new Map([...relsXml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1]
    const target = /Target="([^"]+)"/.exec(m[0])?.[1]
    return [id, target]
  }))
  const presentationXml = await archive.file('ppt/presentation.xml').async('string')
  const order = [...presentationXml.matchAll(/<p:sldId\b[^>]*>/g)].map((m) => /r:id="([^"]+)"/.exec(m[0])?.[1])
  const texts = []
  for (const rId of order) {
    const target = `ppt/${rels.get(rId)}`
    const xml = await archive.file(target).async('string')
    texts.push([...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join(''))
  }
  return { texts, presentationXml, archive }
}

test('parsePptxEditInstruction reads scoped replace, remove and add; guards conversion and translation', () => {
  assert.deepEqual(parsePptxEditInstruction('把张三替换成李四'), [{ type: 'replace', from: '张三', to: '李四', page: null }])
  assert.deepEqual(parsePptxEditInstruction('把第2页的第二季度替换成第三季度'), [{ type: 'replace', from: '第二季度', to: '第三季度', page: 2 }])
  assert.deepEqual(parsePptxEditInstruction('删除第3页'), [{ type: 'remove', page: 3 }])
  assert.deepEqual(parsePptxEditInstruction('把演示稿改成pdf'), null)
  assert.equal(parsePptxEditInstruction('把标题改成英文'), null)
  const add = parsePptxEditInstruction('在第1页后加一页：新季度规划。目标翻倍。路线全球化')
  assert.equal(add[0].type, 'add')
  assert.equal(add[0].afterPage, 1)
  assert.equal(add[0].title, '新季度规划')
  assert.deepEqual(add[0].bullets, ['目标翻倍', '路线全球化'])
})

test('classifyTask routes deterministic pptx edits local', () => {
  const file = [{ path: '汇报.pptx' }]
  assert.deepEqual(classifyTask(file, '把张三替换成李四', 'auto'), {
    kind: 'pptx-edit',
    outputFormat: 'pptx',
    requiresAi: false,
    summary: '本地页面级编辑 PPTX',
    editOperations: [{ type: 'replace', from: '张三', to: '李四', page: null }]
  })
  assert.equal(classifyTask(file, '把演示稿改成pdf', 'auto').kind, 'convert')
})

test('replace runs across the deck while masters, layouts, theme and notes stay byte-identical', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-replace-'))
  try {
    const fixture = path.join(tempDir, '汇报.pptx')
    const output = path.join(tempDir, '汇报-out.pptx')
    await buildFixture(fixture)
    await editPptx(fixture, output, [{ type: 'replace', from: '张三', to: '李四', page: null }])
    const { texts, archive } = await slideTexts(output)
    assert.ok(texts[0].includes('李四'))
    assert.ok(!texts.join('').includes('张三'))
    const before = await JSZip.loadAsync(fs.readFileSync(fixture))
    const preserved = []
    for (const name of Object.keys(before.files)) {
      if (!before.files[name].dir && /^ppt\/(slideMasters|slideLayouts|theme|notesSlides|media)\//.test(name)) preserved.push(name)
    }
    assert.ok(preserved.length > 0)
    for (const name of preserved) {
      assert.equal(await archive.file(name).async('string'), await before.file(name).async('string'), `${name} 必须逐字不变`)
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('removing a page cleans presentation list, relationships, content types and the part', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-remove-'))
  try {
    const fixture = path.join(tempDir, '汇报.pptx')
    const output = path.join(tempDir, '汇报-out.pptx')
    await buildFixture(fixture)
    const originalBytes = fs.readFileSync(fixture)
    await editPptx(fixture, output, [{ type: 'remove', page: 2 }])
    const { texts, presentationXml, archive } = await slideTexts(output)
    assert.equal(texts.length, 2)
    assert.ok(texts[0].includes('年度汇报'))
    assert.ok(texts[1].includes('感谢观看'))
    assert.ok(!texts.join('').includes('第二季度数据'))
    assert.ok(!archive.file('ppt/slides/slide2.xml'), '被删页面部件必须移除')
    assert.deepEqual(fs.readFileSync(fixture), originalBytes, '原文件不得被改动')
    await assert.rejects(() => editPptx(fixture, path.join(tempDir, 'x.pptx'), [{ type: 'remove', page: 9 }]), /没有第 9 页/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('adding a page reuses an existing layout and lands at the requested position', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-add-'))
  try {
    const fixture = path.join(tempDir, '汇报.pptx')
    const output = path.join(tempDir, '汇报-out.pptx')
    await buildFixture(fixture)
    await editPptx(fixture, output, [{ type: 'add', title: '新季度规划', bullets: ['目标翻倍', '路线全球化'], afterPage: 1 }])
    const { texts, archive } = await slideTexts(output)
    assert.equal(texts.length, 4)
    assert.ok(texts[0].includes('年度汇报'))
    assert.ok(texts[1].includes('新季度规划'), '新页必须落在第 1 页之后')
    assert.ok(texts[1].includes('目标翻倍'))
    assert.ok(texts[1].includes('路线全球化'))
    const newSlideName = Object.keys(archive.files).find((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name) && !['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide3.xml'].includes(name))
    assert.ok(newSlideName)
    const newSlideRels = newSlideName.replace('slides/', 'slides/_rels/').replace('.xml', '.xml.rels')
    assert.ok(archive.file(newSlideRels), '新页必须带版式关系')
    assert.ok((await archive.file(newSlideRels).async('string')).includes('slideLayout'))
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('service.run executes a mixed pptx edit task fully local and records history', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-mixed-'))
  try {
    const fixture = path.join(tempDir, '汇报.pptx')
    await buildFixture(fixture)
    const service = new DocumentWorkspaceService({
      outputRoot: path.join(tempDir, 'outputs'),
      historyRoot: path.join(tempDir, 'history'),
      complete: async () => { throw new Error('不应调用模型') },
      renderPdf: async () => { throw new Error('不应渲染 PDF') }
    })
    const result = await service.run([fixture], '把张三替换成李四\n删除第3页\n在第1页后加一页：新季度规划。目标翻倍。路线全球化', 'auto')
    assert.equal(result.success, true)
    assert.equal(result.plan.kind, 'pptx-edit')
    assert.equal(result.plan.requiresAi, false)
    assert.match(result.summary, /替换 1 处文字/)
    assert.match(result.summary, /删除第 3 页/)
    assert.match(result.summary, /新增页「新季度规划」/)
    const { texts } = await slideTexts(result.outputs[0])
    assert.equal(texts.length, 3)
    assert.ok(texts[0].includes('李四'))
    assert.ok(texts[1].includes('新季度规划'))
    assert.ok(texts[2].includes('第二季度数据'))
    const history = fs.readFileSync(path.join(tempDir, 'history', 'history.jsonl'), 'utf8')
    assert.match(history, /pptx-edit/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('parsePptxEditInstruction reads page move', () => {
  assert.deepEqual(parsePptxEditInstruction('把第3页移到第1页前'), [{ type: 'move', page: 3, beforePage: 1, position: 'before' }])
  assert.deepEqual(parsePptxEditInstruction('把第1页移到第3页后'), [{ type: 'move', page: 1, beforePage: 3, position: 'after' }])
})

test('moving pages reorders the deck while parts stay intact', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-move-'))
  try {
    const fixture = path.join(tempDir, '汇报.pptx')
    const output = path.join(tempDir, '汇报-out.pptx')
    await buildFixture(fixture)
    const originalBytes = fs.readFileSync(fixture)
    await editPptx(fixture, output, [{ type: 'move', page: 3, beforePage: 1, position: 'before' }])
    let { texts } = await slideTexts(output)
    assert.ok(texts[0].includes('感谢观看'))
    assert.ok(texts[1].includes('年度汇报'))
    assert.ok(texts[2].includes('第二季度数据'))

    const output2 = path.join(tempDir, '汇报-out2.pptx')
    await editPptx(fixture, output2, [{ type: 'move', page: 1, beforePage: 3, position: 'after' }])
    ;({ texts } = await slideTexts(output2))
    assert.ok(texts[0].includes('第二季度数据'))
    assert.ok(texts[1].includes('感谢观看'))
    assert.ok(texts[2].includes('年度汇报'))
    assert.deepEqual(fs.readFileSync(fixture), originalBytes)

    await assert.rejects(() => editPptx(fixture, path.join(tempDir, 'x.pptx'), [{ type: 'move', page: 9, beforePage: 1, position: 'before' }]), /超出范围/)
    await assert.rejects(() => editPptx(fixture, path.join(tempDir, 'y.pptx'), [{ type: 'move', page: 1, beforePage: 1, position: 'before' }]), /相同/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
