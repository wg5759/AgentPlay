const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const JSZip = require('jszip')
const mammoth = require('mammoth')
const { Document, Footer, Header, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } = require('docx')
const { editDocx, parseEditInstruction } = require('../electron/docx-editor')
const { DocumentWorkspaceService, classifyTask } = require('../electron/document-workspace-service')

async function buildComplexFixture(filePath) {
  const doc = new Document({
    sections: [{
      headers: { default: new Header({ children: [new Paragraph('机密页眉2026')] }) },
      footers: { default: new Footer({ children: [new Paragraph('第 1 页共 N 页')] }) },
      children: [
        new Paragraph({ text: '合作框架协议', heading: HeadingLevel.TITLE }),
        new Paragraph({
          children: [
            new TextRun({ text: '甲方：', bold: true }),
            new TextRun({ text: '张' }),
            new TextRun({ text: '三（', italics: true }),
            new TextRun({ text: '身份证号略）' })
          ]
        }),
        new Table({
          rows: [
            new TableRow({ children: [new TableCell({ children: [new Paragraph('条款')] }), new TableCell({ children: [new Paragraph('内容')] })] }),
            new TableRow({ children: [new TableCell({ children: [new Paragraph('价格')] }), new TableCell({ children: [new Paragraph('100元')] })] })
          ]
        }),
        new Paragraph('其他约定事项保持不变。')
      ]
    }]
  })
  fs.writeFileSync(filePath, await Packer.toBuffer(doc))
}

test('parseEditInstruction reads replace and append, rejects conversion and translation phrasing', () => {
  assert.deepEqual(parseEditInstruction('把张三替换成李四'), [{ type: 'replace', from: '张三', to: '李四' }])
  assert.deepEqual(parseEditInstruction('把合同里的"价格"改为"200元"'), [{ type: 'replace', from: '合同里的价格', to: '200元' }])
  assert.equal(parseEditInstruction('把文档改成pdf'), null)
  assert.equal(parseEditInstruction('提取文字并改成pdf'), null)
  assert.equal(parseEditInstruction('把内容改成英文'), null)
  const append = parseEditInstruction('在文档末尾追加：第三条 双方另行约定')
  assert.equal(append[0].type, 'append')
  assert.ok(append[0].lines.join(' ').includes('第三条'))
})

test('classifyTask routes deterministic docx edits local and keeps convert/translation behavior', () => {
  const doc = [{ path: '合同.docx' }]
  assert.deepEqual(classifyTask(doc, '把合同里的张三替换成李四', 'auto'), {
    kind: 'docx-edit',
    outputFormat: 'docx',
    requiresAi: false,
    summary: '本地无损编辑 DOCX',
    editOperations: [{ type: 'replace', from: '合同里的张三', to: '李四' }]
  })
  assert.equal(classifyTask(doc, '提取文字并改成pdf', 'auto').kind, 'convert')
  assert.equal(classifyTask(doc, '把内容改成英文', 'auto').requiresAi, true)
})

test('editDocx replaces text spanning runs and appends, leaving styles, table, header and footer intact', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-edit-'))
  try {
    const fixture = path.join(tempDir, '合同.docx')
    const output = path.join(tempDir, '合同-out.docx')
    await buildComplexFixture(fixture)
    const originalBytes = fs.readFileSync(fixture)

    const summary = await editDocx(fixture, output, [
      { type: 'replace', from: '张三', to: '李四' },
      { type: 'append', lines: ['# 补充条款', '第一条 本条款为测试追加。'] }
    ])
    assert.match(summary, /替换 1 处/)

    const [before, after] = await Promise.all([JSZip.loadAsync(originalBytes), JSZip.loadAsync(fs.readFileSync(output))])
    const beforeDoc = await before.file('word/document.xml').async('string')
    const afterDoc = await after.file('word/document.xml').async('string')
    assert.notEqual(afterDoc, beforeDoc)
    const visible = [...afterDoc.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('')
    assert.ok(visible.includes('李四'))
    assert.ok(!visible.includes('张三'))
    assert.ok(visible.includes('补充条款'))
    assert.ok(visible.includes('第一条 本条款为测试追加。'))
    assert.ok(afterDoc.includes('<w:tbl>'), '表格结构必须保留')
    assert.ok(afterDoc.includes('Heading1'), '追加标题使用 Heading1 样式')

    for (const name of ['word/styles.xml', 'word/header1.xml', 'word/footer1.xml']) {
      const beforeEntry = before.file(name)
      const afterEntry = after.file(name)
      if (!beforeEntry) continue
      assert.equal(await afterEntry.async('string'), await beforeEntry.async('string'), `${name} 必须逐字不变`)
    }

    const text = await mammoth.extractRawText({ path: output })
    assert.ok(text.value.includes('李四'))
    assert.ok(text.value.includes('补充条款'))
    assert.deepEqual(fs.readFileSync(fixture), originalBytes, '原文件不得被改动')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('service.run executes a docx edit task fully local and records history', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-edit-run-'))
  try {
    const fixture = path.join(tempDir, '合同.docx')
    await buildComplexFixture(fixture)
    const service = new DocumentWorkspaceService({
      outputRoot: path.join(tempDir, 'outputs'),
      historyRoot: path.join(tempDir, 'history'),
      complete: async () => { throw new Error('不应调用模型') },
      renderPdf: async () => { throw new Error('不应渲染 PDF') }
    })
    const result = await service.run([fixture], '把合同里的张三替换成李四；在文档末尾追加：补充条款如下', 'auto')
    assert.equal(result.success, true)
    assert.equal(result.plan.kind, 'docx-edit')
    assert.equal(result.plan.requiresAi, false)
    assert.ok(result.outputs[0].endsWith('-AgentPlay处理版.docx'))
    const text = await mammoth.extractRawText({ path: result.outputs[0] })
    assert.ok(text.value.includes('李四'))
    assert.ok(text.value.includes('补充条款'))
    const history = fs.readFileSync(path.join(tempDir, 'history', 'history.jsonl'), 'utf8')
    assert.match(history, /docx-edit/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('missing replacement text fails without touching the original file', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-edit-miss-'))
  try {
    const fixture = path.join(tempDir, '合同.docx')
    const output = path.join(tempDir, '合同-out.docx')
    await buildComplexFixture(fixture)
    const originalBytes = fs.readFileSync(fixture)
    await assert.rejects(() => editDocx(fixture, output, [{ type: 'replace', from: '不存在的名字', to: '李四' }]), /没有找到要替换的文字/)
    assert.equal(fs.existsSync(output), false)
    assert.deepEqual(fs.readFileSync(fixture), originalBytes)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('parseEditInstruction reads track mode, inserts and comments', () => {
  assert.deepEqual(parseEditInstruction('以修订模式把张三替换成李四'), [{ type: 'replace', from: '张三', to: '李四', mode: 'track' }])
  assert.deepEqual(parseEditInstruction('把张三替换成李四(修订模式)'), [{ type: 'replace', from: '张三', to: '李四', mode: 'track' }])
  assert.deepEqual(parseEditInstruction('在第2段后插入：新条款内容'), [{ type: 'insert', anchor: 2, position: 'after', lines: ['新条款内容'] }])
  const anchorInsert = parseEditInstruction('在其他约定前插入：签约地点待定')
  assert.deepEqual(anchorInsert, [{ type: 'insert', anchor: '其他约定', position: 'before', lines: ['签约地点待定'] }])
  assert.deepEqual(parseEditInstruction('给价格加批注：需要法务复核'), [{ type: 'comment', anchor: '价格', text: '需要法务复核' }])
  assert.equal(parseEditInstruction('在文档末尾追加：第三条规定')[0].type, 'append')
})

test('track-mode replace emits w:ins/w:del and hides deleted text from the plain layer', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-track-'))
  try {
    const fixture = path.join(tempDir, '合同.docx')
    const output = path.join(tempDir, '合同-track.docx')
    await buildComplexFixture(fixture)
    await editDocx(fixture, output, [{ type: 'replace', from: '张三', to: '李四', mode: 'track' }])
    const archive = await JSZip.loadAsync(fs.readFileSync(output))
    const xml = await archive.file('word/document.xml').async('string')
    assert.ok(xml.includes('<w:del '), '必须有 w:del')
    assert.ok(xml.includes('<w:ins '), '必须有 w:ins')
    assert.ok(xml.includes('<w:delText xml:space="preserve">张三</w:delText>'))
    assert.ok(xml.includes('<w:t xml:space="preserve">李四</w:t>'))
    const plainVisible = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('')
    assert.ok(!plainVisible.includes('张三'), '修订模式下纯文本层不得再含被删文字')
    assert.ok(plainVisible.includes('李四'))
    const beforeHeader = await (await JSZip.loadAsync(fs.readFileSync(fixture))).file('word/header1.xml').async('string')
    assert.equal(await archive.file('word/header1.xml').async('string'), beforeHeader, '页眉必须逐字不变')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('insert by index and by anchor places paragraphs at the right position', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-insert-'))
  try {
    const fixture = path.join(tempDir, '合同.docx')
    const output = path.join(tempDir, '合同-insert.docx')
    await buildComplexFixture(fixture)
    await editDocx(fixture, output, [
      { type: 'insert', anchor: 1, position: 'after', lines: ['签约地点：待定'] },
      { type: 'insert', anchor: '其他约定', position: 'before', lines: ['【插入的分隔】'] }
    ])
    const archive = await JSZip.loadAsync(fs.readFileSync(output))
    const xml = await archive.file('word/document.xml').async('string')
    const order = ['合作框架协议', '签约地点：待定', '甲方：', '【插入的分隔】', '其他约定事项保持不变。']
    const positions = order.map((text) => xml.indexOf(text))
    assert.ok(positions.every((position) => position >= 0), '所有段落都应在文档中')
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, '段落顺序必须正确')
    assert.ok(xml.includes('<w:tbl>'), '表格结构必须保留')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('comments create the full comments part, ranges, content type and relationship', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-comment-'))
  try {
    const fixture = path.join(tempDir, '合同.docx')
    const output = path.join(tempDir, '合同-comment.docx')
    await buildComplexFixture(fixture)
    await editDocx(fixture, output, [{ type: 'comment', anchor: '价格', text: '需要法务复核' }])
    const [before, after] = await Promise.all([JSZip.loadAsync(fs.readFileSync(fixture)), JSZip.loadAsync(fs.readFileSync(output))])
    const commentsXml = await after.file('word/comments.xml').async('string')
    assert.ok(commentsXml.includes('需要法务复核'))
    assert.ok(commentsXml.includes('w:author="AgentPlay"'))
    const xml = await after.file('word/document.xml').async('string')
    assert.ok(xml.includes('<w:commentRangeStart w:id="0"/>'))
    assert.ok(xml.includes('<w:commentRangeEnd w:id="0"/>'))
    assert.ok(xml.includes('<w:commentReference w:id="0"/>'))
    assert.ok((await after.file('[Content_Types].xml').async('string')).includes('comments+xml'))
    assert.ok((await after.file('word/_rels/document.xml.rels').async('string')).includes('comments'))
    for (const name of ['word/styles.xml', 'word/header1.xml', 'word/footer1.xml']) {
      assert.equal(await after.file(name).async('string'), await before.file(name).async('string'), `${name} 必须逐字不变`)
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('service.run handles a mixed track-replace, comment and insert task fully local', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-mixed-'))
  try {
    const fixture = path.join(tempDir, '合同.docx')
    await buildComplexFixture(fixture)
    const service = new DocumentWorkspaceService({
      outputRoot: path.join(tempDir, 'outputs'),
      historyRoot: path.join(tempDir, 'history'),
      complete: async () => { throw new Error('不应调用模型') },
      renderPdf: async () => { throw new Error('不应渲染 PDF') }
    })
    const result = await service.run([fixture], '以修订模式把张三替换成李四\n给价格加批注：需法务复核\n在第1段后插入：签约地点待定', 'auto')
    assert.equal(result.success, true)
    assert.equal(result.plan.kind, 'docx-edit')
    assert.match(result.summary, /以修订模式替换 1 处文字/)
    assert.match(result.summary, /后插入 1 段/)
    assert.match(result.summary, /添加 1 条批注/)
    const archive = await JSZip.loadAsync(fs.readFileSync(result.outputs[0]))
    const xml = await archive.file('word/document.xml').async('string')
    assert.ok(xml.includes('<w:ins '))
    assert.ok((await archive.file('word/comments.xml').async('string')).includes('需法务复核'))
    assert.ok(xml.indexOf('签约地点待定') > xml.indexOf('合作框架协议'))
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('parseEditInstruction reads paragraph removal by index and by text', () => {
  assert.deepEqual(parseEditInstruction('删除第2段'), [{ type: 'remove', anchor: 2 }])
  assert.deepEqual(parseEditInstruction('删除包含"机密"的段落'), [{ type: 'remove', anchor: '机密' }])
  const mixed = parseEditInstruction('删除第1段\n把张三替换成李四')
  assert.equal(mixed.length, 2)
  assert.equal(mixed[0].type, 'remove')
  assert.equal(mixed[1].type, 'replace')
})

test('remove paragraphs by index and by text, leaving everything else intact', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-remove-'))
  try {
    const fixture = path.join(tempDir, '合同.docx')
    const output = path.join(tempDir, '合同-out.docx')
    await buildComplexFixture(fixture)
    const originalBytes = fs.readFileSync(fixture)
    const summary = await editDocx(fixture, output, [{ type: 'remove', anchor: 2 }])
    assert.match(summary, /删除 1 个段落/)
    let archive = await JSZip.loadAsync(fs.readFileSync(output))
    let xml = await archive.file('word/document.xml').async('string')
    assert.ok(!xml.includes('张'))
    assert.ok(xml.includes('合作框架协议'))
    assert.ok(xml.includes('<w:tbl>'))

    const output2 = path.join(tempDir, '合同-out2.docx')
    await editDocx(fixture, output2, [{ type: 'remove', anchor: '其他约定' }])
    archive = await JSZip.loadAsync(fs.readFileSync(output2))
    xml = await archive.file('word/document.xml').async('string')
    assert.ok(!xml.includes('其他约定事项保持不变'))
    assert.deepEqual(fs.readFileSync(fixture), originalBytes)

    await assert.rejects(() => editDocx(fixture, path.join(tempDir, 'x.docx'), [{ type: 'remove', anchor: '根本不存在的词xyz' }]), /没有找到要删除的段落/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
