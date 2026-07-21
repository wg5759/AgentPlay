const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const JSZip = require('jszip')
const { Document, HeadingLevel, Packer, Paragraph, TextRun } = require('docx')
const { parseImageEditInstruction } = require('../electron/image-convert-service')
const { insertImageIntoDocx, imageSize } = require('../electron/docx-image')
const { DocumentWorkspaceService, classifyTask } = require('../electron/document-workspace-service')

const PNG_2X3_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAB56wx6AAAAC0lEQVR42mNk+M9QzwAEjQ0dgwAAAABJRU5ErkJggg=='

function tinyBmp(width, height) {
  const rowSize = (width * 3 + 3) & ~3
  const pixelBytes = rowSize * height
  const buffer = Buffer.alloc(54 + pixelBytes)
  buffer.write('BM', 0)
  buffer.writeUInt32LE(54 + pixelBytes, 2)
  buffer.writeUInt32LE(54, 10)
  buffer.writeUInt32LE(40, 14)
  buffer.writeInt32LE(width, 18)
  buffer.writeInt32LE(height, 22)
  buffer.writeUInt16LE(1, 26)
  buffer.writeUInt16LE(24, 28)
  return buffer
}

test('图片任务解析：格式、比例、宽度、质量与无关输入', () => {
  assert.deepEqual(parseImageEditInstruction('转成webp'), { format: 'webp', scale: null, maxWidth: null, quality: null })
  assert.deepEqual(parseImageEditInstruction('压缩到一半'), { format: null, scale: 0.5, maxWidth: null, quality: null })
  assert.deepEqual(parseImageEditInstruction('宽度调到800，质量 80%'), { format: null, scale: null, maxWidth: 800, quality: 0.8 })
  assert.equal(parseImageEditInstruction('总结一下内容'), null)
})

test('imageSize 读取 PNG/JPEG/BMP 尺寸', () => {
  assert.deepEqual(imageSize(Buffer.from(PNG_2X3_BASE64, 'base64'), '.png'), { width: 2, height: 3 })
  assert.deepEqual(imageSize(tinyBmp(7, 5), '.bmp'), { width: 7, height: 5 })
})

test('图片相关任务分类：转换、插图、提取、拒绝无格式要求', () => {
  assert.equal(classifyTask([{ path: '照片.jpg' }], '转成webp', 'auto').kind, 'image-convert')
  assert.deepEqual(classifyTask([{ path: '照片.jpg' }], '压缩到一半', 'auto').imageEdit.scale, 0.5)
  assert.throws(() => classifyTask([{ path: '照片.jpg' }], '总结一下', 'auto'), /图片任务请说明/)
  const pair = [{ path: '报告.docx' }, { path: '照片.jpg' }]
  assert.deepEqual(classifyTask(pair, '把这张图插到文档末尾', 'auto'), { kind: 'docx-insert-image', outputFormat: 'docx', requiresAi: false, summary: '本地 DOCX 插图', anchor: null })
  assert.equal(classifyTask(pair, '把图插到"第三章"后面', 'auto').anchor, '第三章')
  assert.equal(classifyTask([{ path: '报告.docx' }], '提取图片', 'auto').kind, 'extract-images')
})

async function buildDocx(filePath) {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: '插图测试文档', heading: HeadingLevel.TITLE }),
        new Paragraph({ children: [new TextRun('第三章 交付条款')] }),
        new Paragraph('其他内容。')
      ]
    }]
  })
  fs.writeFileSync(filePath, await Packer.toBuffer(doc))
}

test('DOCX 插图：media、关系、drawing 全套，锚点定位，原件不动', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-image-'))
  try {
    const docPath = path.join(tempDir, '文档.docx')
    const outPath = path.join(tempDir, '文档-out.docx')
    const imagePath = path.join(tempDir, 'pic.png')
    await buildDocx(docPath)
    fs.writeFileSync(imagePath, Buffer.from(PNG_2X3_BASE64, 'base64'))
    const originalBytes = fs.readFileSync(docPath)

    const result = await insertImageIntoDocx(docPath, imagePath, outPath, { anchor: '第三章' })
    assert.deepEqual({ width: result.width, height: result.height }, { width: 2, height: 3 })
    const archive = await JSZip.loadAsync(fs.readFileSync(outPath))
    const mediaName = Object.keys(archive.files).find((name) => /^word\/media\/image\d+\.png$/.test(name))
    assert.ok(mediaName, '必须有图片部件')
    const rels = await archive.file('word/_rels/document.xml.rels').async('string')
    assert.ok(rels.includes('relationships/image'))
    const xml = await archive.file('word/document.xml').async('string')
    assert.ok(xml.includes('<w:drawing>'))
    assert.ok(xml.indexOf('第三章') < xml.indexOf('<w:drawing>'), '图片必须落在锚点段落之后')
    const before = await JSZip.loadAsync(originalBytes)
    assert.equal(await archive.file('word/styles.xml').async('string'), await before.file('word/styles.xml').async('string'))
    assert.deepEqual(fs.readFileSync(docPath), originalBytes)

    await assert.rejects(() => insertImageIntoDocx(docPath, imagePath, path.join(tempDir, 'x.docx'), { anchor: '不存在的章节' }), /没有找到锚点/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('提取文档内嵌图片到目录并记录历史', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-images-'))
  try {
    const docPath = path.join(tempDir, '文档.docx')
    const outPath = path.join(tempDir, '文档-out.docx')
    const imagePath = path.join(tempDir, 'pic.png')
    await buildDocx(docPath)
    fs.writeFileSync(imagePath, Buffer.from(PNG_2X3_BASE64, 'base64'))
    await insertImageIntoDocx(docPath, imagePath, outPath, {})

    const service = new DocumentWorkspaceService({
      outputRoot: path.join(tempDir, 'outputs'),
      historyRoot: path.join(tempDir, 'history'),
      complete: async () => { throw new Error('不应调用模型') },
      renderPdf: async () => { throw new Error('不应渲染') }
    })
    const result = await service.run([outPath], '提取图片', 'auto')
    assert.equal(result.success, true)
    assert.equal(result.plan.kind, 'extract-images')
    const targetDir = result.outputs[0]
    const files = fs.readdirSync(targetDir)
    assert.equal(files.length, 1)
    assert.deepEqual(fs.readFileSync(path.join(targetDir, files[0])), Buffer.from(PNG_2X3_BASE64, 'base64'))
    const history = fs.readFileSync(path.join(tempDir, 'history', 'history.jsonl'), 'utf8')
    assert.match(history, /extract-images/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('DOCX 插图任务经 service.run 全本地闭环', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'insert-image-run-'))
  try {
    const docPath = path.join(tempDir, '文档.docx')
    const imagePath = path.join(tempDir, 'pic.png')
    await buildDocx(docPath)
    fs.writeFileSync(imagePath, Buffer.from(PNG_2X3_BASE64, 'base64'))
    const service = new DocumentWorkspaceService({
      outputRoot: path.join(tempDir, 'outputs'),
      historyRoot: path.join(tempDir, 'history'),
      complete: async () => { throw new Error('不应调用模型') },
      renderPdf: async () => { throw new Error('不应渲染') }
    })
    const result = await service.run([docPath, imagePath], '把这张图插到"第三章"后面', 'auto')
    assert.equal(result.success, true)
    assert.equal(result.plan.kind, 'docx-insert-image')
    const archive = await JSZip.loadAsync(fs.readFileSync(result.outputs[0]))
    assert.ok((await archive.file('word/document.xml').async('string')).includes('<w:drawing>'))
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
