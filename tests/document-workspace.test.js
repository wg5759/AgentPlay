const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ExcelJS = require('exceljs')
const { PDFDocument } = require('pdf-lib')
const {
  DocumentWorkspaceService,
  classifyTask,
  extractText,
  parseExplicitFormula,
  validateFormula
} = require('../electron/document-workspace-service')

function workspace(tempDir, complete = async () => { throw new Error('不应调用模型') }) {
  return new DocumentWorkspaceService({
    outputRoot: path.join(tempDir, 'outputs'),
    historyRoot: path.join(tempDir, 'history'),
    complete,
    renderPdf: async (_html, outputPath) => fs.writeFileSync(outputPath, '%PDF-1.4\n%%EOF\n')
  })
}

test('document task classification keeps deterministic work local', () => {
  const pdfFiles = [{ path: 'a.pdf' }, { path: 'b.pdf' }]
  assert.deepEqual(classifyTask(pdfFiles, '把这些 PDF 合并', 'auto'), {
    kind: 'pdf-merge', outputFormat: 'pdf', requiresAi: false, summary: '合并 2 个 PDF'
  })
  const xlsx = [{ path: 'sales.xlsx' }]
  assert.equal(classifyTask(xlsx, '清理空格并按手机号列去重', 'auto').requiresAi, false)
  assert.equal(classifyTask(xlsx, '在 G 列生成毛利率公式', 'auto').requiresAi, true)
  assert.deepEqual(parseExplicitFormula('在 G 列填入公式：=IFERROR((D2-E2)/D2,0)'), {
    column: 'G', formula: '=IFERROR((D2-E2)/D2,0)'
  })
  assert.equal(validateFormula('=IFERROR((D2-E2)/D2,0)'), 'IFERROR((D2-E2)/D2,0)')
  assert.throws(() => validateFormula('=WEBSERVICE("https://example.com")'), /已拒绝/)
  assert.throws(() => validateFormula("=cmd|' /C calc'!A0"), /已拒绝/)
})

test('plain text converts to a real versioned docx without changing the source', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-docx-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'notes.txt')
  fs.writeFileSync(source, '# 标题\n- 第一项\n正文', 'utf8')
  const result = await workspace(dir).run([source], '转换为 Word，保持原内容', 'docx')
  assert.equal(result.success, true)
  assert.equal(result.plan.requiresAi, false)
  assert.equal(fs.readFileSync(source, 'utf8'), '# 标题\n- 第一项\n正文')
  assert.equal(path.extname(result.outputs[0]), '.docx')
  assert.equal(fs.readFileSync(result.outputs[0]).subarray(0, 2).toString(), 'PK')
  assert.equal(fs.existsSync(path.join(dir, 'history', 'history.jsonl')), true)
})

test('spreadsheet cleanup removes duplicates and fills formulas in a new workbook', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-xlsx-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'sales.xlsx')
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('销售')
  sheet.addRow(['手机号', '客户', '地区', '收入', '成本', '备注', '毛利率'])
  sheet.addRow([' 13800138000 ', '甲', '上海', 100, 40, '', ''])
  sheet.addRow(['13800138000', '重复', '上海', 100, 50, '', ''])
  sheet.addRow(['13900139000', '乙', '北京', 200, 80, '', ''])
  await book.xlsx.writeFile(source)

  const result = await workspace(dir).run(
    [source],
    '清理所有文本首尾空格，按手机号列去重，在 G 列填入公式：=IFERROR((D2-E2)/D2,0)',
    'xlsx'
  )
  const output = new ExcelJS.Workbook()
  await output.xlsx.readFile(result.outputs[0])
  const resultSheet = output.getWorksheet('销售')
  assert.equal(resultSheet.rowCount, 3)
  assert.equal(resultSheet.getCell('A2').value, '13800138000')
  assert.equal(resultSheet.getCell('G2').value.formula, 'IFERROR((D2-E2)/D2,0)')
  assert.equal(resultSheet.getCell('G3').value.formula, 'IFERROR((D3-E3)/D3,0)')
})

test('PDF merge and split produce valid page counts', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-pdf-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const first = await PDFDocument.create()
  first.addPage([200, 200])
  const second = await PDFDocument.create()
  second.addPage([300, 300])
  second.addPage([300, 300])
  const firstPath = path.join(dir, 'a.pdf')
  const secondPath = path.join(dir, 'b.pdf')
  fs.writeFileSync(firstPath, await first.save())
  fs.writeFileSync(secondPath, await second.save())

  const service = workspace(dir)
  const merged = await service.run([firstPath, secondPath], '按顺序合并这些 PDF', 'pdf')
  const mergedPdf = await PDFDocument.load(fs.readFileSync(merged.outputs[0]))
  assert.equal(mergedPdf.getPageCount(), 3)
  const split = await service.run([merged.outputs[0]], '把 PDF 每页拆分', 'pdf')
  assert.equal(split.outputs.length, 3)
  for (const outputPath of split.outputs) {
    const page = await PDFDocument.load(fs.readFileSync(outputPath))
    assert.equal(page.getPageCount(), 1)
  }
})

test('AI plan can generate a reopenable PPTX', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-pptx-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const complete = async () => ({
    text: JSON.stringify({
      title: '季度复盘', summary: '已生成两页演示稿', outputFormat: 'pptx', content: '', sheets: [],
      slides: [
        { title: '季度复盘', bullets: ['收入增长', '成本下降'], notes: '开场说明' },
        { title: '下一步', bullets: ['扩大有效渠道', '控制获客成本'], notes: '' }
      ]
    })
  })
  const result = await workspace(dir, complete).run([], '生成一份季度复盘 PPT', 'pptx')
  assert.equal(result.success, true)
  assert.equal(path.extname(result.outputs[0]), '.pptx')
  assert.equal(fs.readFileSync(result.outputs[0]).subarray(0, 2).toString(), 'PK')
  assert.match(await extractText(result.outputs[0]), /收入增长/)
})

test('desktop menu, preload bridge and unified chat expose the document pipeline end to end', () => {
  const root = path.join(__dirname, '..')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8')
  const app = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8')
  const panel = fs.readFileSync(path.join(root, 'src', 'components', 'AgentPanel.tsx'), 'utf8')
  assert.match(main, /AI 对话窗/)
  assert.match(main, /ipcMain\.handle\('documents:select-files'/)
  assert.match(main, /ipcMain\.handle\('documents:run'/)
  assert.match(preload, /documents:\s*\{/)
  assert.match(preload, /ipcRenderer\.invoke\('documents:run'/)
  assert.doesNotMatch(app, /<DocumentWorkspace/)
  assert.match(panel, /api\.run\(\{ tokens, instruction, outputFormat/)
  assert.match(panel, /允许把本次所选文件内容发送给当前云端模型/)
})

test('PDF text extraction reads embedded text and rejects image-only PDFs honestly', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-pdf-'))
  try {
    const doc = await PDFDocument.create()
    const page = doc.addPage([612, 792])
    page.drawText('Hello AgentPlay PDF extraction 12345', { x: 50, y: 700, size: 14 })
    const pdfPath = path.join(tempDir, 'sample.pdf')
    fs.writeFileSync(pdfPath, await doc.save())
    const text = await extractText(pdfPath)
    assert.match(text, /Hello AgentPlay PDF extraction 12345/)
    assert.match(text, /第 1 页/)

    const imageOnly = await PDFDocument.create()
    imageOnly.addPage([612, 792])
    const emptyPath = path.join(tempDir, 'empty.pdf')
    fs.writeFileSync(emptyPath, await imageOnly.save())
    await assert.rejects(() => extractText(emptyPath), /没有可提取的文字层/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('legacy .doc files are accepted by the workspace and fail honestly when unreadable', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-doc-'))
  try {
    const service = workspace(tempDir)
    const docPath = path.join(tempDir, '老式文档.doc')
    fs.writeFileSync(docPath, '这不是真正的 OLE 文档')
    assert.equal(service.inspect([docPath])[0].ext, '.doc')
    await assert.rejects(() => extractText(docPath))
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('ODF, RTF and HTML documents extract readable text', async () => {
  const JSZip = require('jszip')
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-formats-'))
  try {
    const zip = new JSZip()
    zip.file('content.xml', '<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>你好 ODF 世界</text:p><text:p>第二行内容</text:p></office:text></office:body></office:document-content>')
    const odtPath = path.join(tempDir, '文档.odt')
    fs.writeFileSync(odtPath, await zip.generateAsync({ type: 'nodebuffer' }))
    const odtText = await extractText(odtPath)
    assert.match(odtText, /你好 ODF 世界/)
    assert.match(odtText, /第二行内容/)

    const rtfPath = path.join(tempDir, '文档.rtf')
    fs.writeFileSync(rtfPath, '{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}你好 RTF \\par 第二行 \\u27979 ?}')
    const rtfText = await extractText(rtfPath)
    assert.match(rtfText, /你好 RTF/)
    assert.match(rtfText, /第二行/)
    assert.match(rtfText, /测/)
    assert.doesNotMatch(rtfText, /fonttbl|Arial/)

    const htmlPath = path.join(tempDir, '页面.html')
    fs.writeFileSync(htmlPath, '<html><head><style>.x{color:red}</style><script>evil()</script></head><body><p>页面 <b>正文</b></p><br>第二行</body></html>')
    const htmlText = await extractText(htmlPath)
    assert.match(htmlText, /页面 正文/)
    assert.match(htmlText, /第二行/)
    assert.doesNotMatch(htmlText, /evil|color/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('"改成/变成" routes to local convert while language retargeting stays an AI task', async () => {
  const doc = [{ path: '资料.doc' }]
  assert.deepEqual(classifyTask(doc, '提取文字并改成pdf', 'auto'), {
    kind: 'convert', outputFormat: 'pdf', requiresAi: false, summary: '转换为 PDF'
  })
  assert.equal(classifyTask(doc, '整理一下变成Word', 'auto').kind, 'convert')
  assert.equal(classifyTask(doc, '把内容改成英文', 'auto').requiresAi, true)
  assert.equal(classifyTask(doc, '提取文字并翻译成英文', 'auto').requiresAi, true)
})

test('rtf to pdf conversion runs fully local end to end', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-convert-'))
  try {
    const service = workspace(tempDir)
    const rtfPath = path.join(tempDir, '会议记录.rtf')
    fs.writeFileSync(rtfPath, '{\\rtf1\\ansi 季度总结 \\par 第一条 \\par 第二条}')
    const result = await service.run([rtfPath], '提取文字并改成pdf', 'auto')
    assert.equal(result.success, true)
    assert.equal(result.plan.kind, 'convert')
    assert.equal(result.plan.requiresAi, false)
    assert.ok(result.outputs[0].endsWith('-AgentPlay处理版.pdf'))
    assert.ok(fs.existsSync(result.outputs[0]))
    const history = fs.readFileSync(path.join(tempDir, 'history', 'history.jsonl'), 'utf8')
    assert.match(history, /提取文字并改成pdf/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('PDF 删页与提取页：分类、执行与边界', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-pages-'))
  try {
    const doc = await PDFDocument.create()
    doc.addPage([612, 792])
    doc.addPage([612, 792])
    doc.addPage([612, 792])
    const pdfPath = path.join(tempDir, '三页.pdf')
    fs.writeFileSync(pdfPath, await doc.save())
    const service = workspace(tempDir)

    const removePlan = classifyTask([{ path: '三页.pdf' }], '删除第2页', 'auto')
    assert.deepEqual(removePlan, { kind: 'pdf-remove-pages', outputFormat: 'pdf', requiresAi: false, summary: '删除 PDF 指定页', pageList: [2] })
    const removed = await service.run([pdfPath], '删除第2页', 'auto')
    assert.equal(removed.success, true)
    let loaded = await PDFDocument.load(fs.readFileSync(removed.outputs[0]))
    assert.equal(loaded.getPageCount(), 2)

    const extractPlan = classifyTask([{ path: '三页.pdf' }], '只要第1到2页', 'auto')
    assert.deepEqual(extractPlan, { kind: 'pdf-extract-pages', outputFormat: 'pdf', requiresAi: false, summary: '提取 PDF 页码范围', from: 1, to: 2 })
    const extracted = await service.run([pdfPath], '只要第1到2页', 'auto')
    loaded = await PDFDocument.load(fs.readFileSync(extracted.outputs[0]))
    assert.equal(loaded.getPageCount(), 2)

    assert.deepEqual(classifyTask([{ path: '三页.pdf' }], '删除第2-3页', 'auto').pageList, [2, 3])
    await assert.rejects(() => service.run([pdfPath], '删除第1-3页', 'auto'), /不能删除全部页面/)
    await assert.rejects(() => service.run([pdfPath], '只要第2到9页', 'auto'), /页码范围无效/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('单元格改写：分类、数值与文本写入、越界拦截', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cellset-'))
  try {
    const filePath = path.join(tempDir, '销售.xlsx')
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('数据')
    sheet.addRow(['月份', '收入', '状态'])
    sheet.addRow(['1月', 100, '待审'])
    sheet.addRow(['2月', 200, '待审'])
    await workbook.xlsx.writeFile(filePath)
    const service = workspace(tempDir)

    assert.equal(classifyTask([{ path: '销售.xlsx' }], '把B2改成150', 'auto').kind, 'spreadsheet-edit')
    assert.equal(classifyTask([{ path: '销售.xlsx' }], '把表格改成pdf', 'auto').kind, 'convert')

    const result = await service.run([filePath], '把B2改成150', 'auto')
    assert.equal(result.success, true)
    assert.match(result.summary, /B2 改为 150/)
    const reopened = new ExcelJS.Workbook()
    await reopened.xlsx.readFile(result.outputs[0])
    const reopenedSheet = reopened.getWorksheet('数据')
    assert.equal(reopenedSheet.getCell('B2').value, 150)
    assert.equal(reopenedSheet.getCell('B3').value, 200)

    const textResult = await service.run([result.outputs[0]], '把C2改为已审', 'auto')
    const reopened2 = new ExcelJS.Workbook()
    await reopened2.xlsx.readFile(textResult.outputs[0])
    assert.equal(reopened2.getWorksheet('数据').getCell('C2').value, '已审')

    await assert.rejects(() => service.run([filePath], '把B99改成1', 'auto'), /行号超出范围/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
