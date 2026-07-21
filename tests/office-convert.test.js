const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } = require('docx')
const { DocumentWorkspaceService, classifyTask } = require('../electron/document-workspace-service')
const { OfficeConvertService } = require('../electron/office-convert-service')

async function buildFixture(filePath) {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: '高保真探针合同', heading: HeadingLevel.TITLE }),
        new Paragraph({ children: [new TextRun({ text: '加粗条款', bold: true }), new TextRun('与'), new TextRun({ text: '斜体备注', italics: true })] }),
        new Table({
          rows: [
            new TableRow({ children: [new TableCell({ children: [new Paragraph('项目')] }), new TableCell({ children: [new Paragraph('金额')] })] }),
            new TableRow({ children: [new TableCell({ children: [new Paragraph('服务费')] }), new TableCell({ children: [new Paragraph('100元')] })] })
          ]
        })
      ]
    }]
  })
  fs.writeFileSync(filePath, await Packer.toBuffer(doc))
}

function localService(tempDir, officeConvert) {
  return new DocumentWorkspaceService({
    outputRoot: path.join(tempDir, 'outputs'),
    historyRoot: path.join(tempDir, 'history'),
    complete: async () => { throw new Error('不应调用模型') },
    renderPdf: async () => { throw new Error('不应渲染 PDF') },
    officeConvert
  })
}

test('高保真意图路由到本机引擎转换，普通转换保持原路径', () => {
  const docx = [{ path: '合同.docx' }]
  assert.deepEqual(classifyTask(docx, '把这份合同高保真转成PDF', 'auto'), {
    kind: 'office-convert', outputFormat: 'pdf', requiresAi: false, summary: '调用本机 Office 引擎高保真转换'
  })
  assert.equal(classifyTask(docx, '提取文字并改成pdf', 'auto').kind, 'convert')
  assert.equal(classifyTask(docx, '原样导出PDF', 'auto').kind, 'office-convert')
  assert.equal(classifyTask([{ path: '数据.xlsx' }], '高保真转成PDF', 'auto').kind, 'office-convert')
})

test('office-convert 走注入的引擎；无引擎时明确故障关闭并提示普通转换', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-convert-'))
  try {
    const fixture = path.join(tempDir, '合同.docx')
    await buildFixture(fixture)
    const service = localService(tempDir, {
      convertToPdf: async (source, target) => {
        assert.equal(source, fixture)
        fs.writeFileSync(target, '%PDF-1.4\n%%EOF')
        return { engine: 'Word', bytes: 11 }
      }
    })
    const result = await service.run([fixture], '把这份合同高保真转成PDF', 'auto')
    assert.equal(result.success, true)
    assert.equal(result.plan.kind, 'office-convert')
    assert.match(result.summary, /Word 引擎高保真转换/)
    assert.ok(fs.existsSync(result.outputs[0]))

    const noEngine = localService(tempDir, null)
    await assert.rejects(() => noEngine.run([fixture], '把这份合同高保真转成PDF', 'auto'), /普通转换/)

    const unavailable = localService(tempDir, {
      convertToPdf: async () => { throw new Error('高保真转换需要本机安装 Office、WPS 或 LibreOffice；当前未检测到可用引擎（可改用普通转换）') }
    })
    await assert.rejects(() => unavailable.run([fixture], '把这份合同高保真转成PDF', 'auto'), /未检测到可用引擎/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('本机 Office 引擎真实转换复杂 DOCX 为高保真 PDF（仅 Windows 且引擎可用）', async (t) => {
  if (process.platform !== 'win32') return t.skip('仅 Windows 可用本机 Office 引擎')
  const service = new OfficeConvertService()
  const status = await service.detect()
  if (!status.available) return t.skip(`本机无转换引擎：${status.reason}`)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-convert-e2e-'))
  try {
    const fixture = path.join(tempDir, '合同.docx')
    const target = path.join(tempDir, '合同.pdf')
    await buildFixture(fixture)
    const result = await service.convertToPdf(fixture, target)
    assert.ok(result.bytes > 10000)
    const { getDocumentProxy, extractText } = require('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(target)))
    try {
      const { totalPages, text } = await extractText(pdf, { mergePages: true })
      assert.ok(totalPages >= 1)
      assert.match(String(text), /高保真探针合同/)
      assert.match(String(text), /服务费/)
    } finally {
      if (typeof pdf.destroy === 'function') void pdf.destroy()
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
