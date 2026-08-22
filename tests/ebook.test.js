const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const JSZip = require('jszip')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'OnlineMediaLibrary.tsx'), 'utf8')
const reader = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'EbookReader.tsx'), 'utf8')
const onlineMedia = require('../electron/online-media-service')
const ebook = require('../electron/ebook-service')

async function buildEpubFixture(filePath) {
  const zip = new JSZip()
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>')
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?>
<package><manifest>
<item id="c1" href="ch1.xhtml"/><item id="c2" href="ch2.xhtml"/>
</manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`)
  zip.file('OEBPS/ch1.xhtml', '<html><body><h2>Chapter 1</h2><p>It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.</p><p>Second paragraph here with enough text to pass the filter length requirement easily.</p></body></html>')
  zip.file('OEBPS/ch2.xhtml', '<html><body><h2>Chapter 2</h2><p>However little known the feelings or views of such a man may be on his first entering a neighbourhood.</p><p>More content follows to make this chapter long enough for the filter.</p></body></html>')
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }))
}

test('epub parse follows spine order and strips xhtml', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epub-'))
  try {
    const file = path.join(dir, 'book.epub')
    await buildEpubFixture(file)
    const chapters = await ebook.parseEpubChapters(file)
    assert.equal(chapters.length, 2)
    assert.match(chapters[0].title, /Chapter 1/)
    assert.ok(chapters[0].text.includes('truth universally acknowledged'))
    assert.ok(!chapters[0].text.includes('<p>'), '标签必须剥掉')
    assert.ok(chapters[1].text.includes('entering a neighbourhood'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('gutenberg txt splits into chapters and drops the license wrapper', () => {
  const sample = `Header blurb\n*** START OF THIS PROJECT GUTENBERG EBOOK TEST ***\n\nCHAPTER 1\n${'One morning something happened. '.repeat(40)}\n\nCHAPTER 2\n${'Later that day things changed. '.repeat(40)}\n\n*** END OF THIS PROJECT GUTENBERG EBOOK ***\nLicense text`
  const chapters = ebook.parseTxtChapters(sample)
  assert.equal(chapters.length, 2)
  assert.match(chapters[0].text, /One morning/)
  assert.ok(!chapters[0].text.includes('GUTENBERG EBOOK TEST'), '序言标记必须剥掉')
  assert.ok(!chapters[1].text.includes('License text'), '尾部许可必须剥掉')
})

test('translation cache round-trips and isolates engines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebook-cache-'))
  try {
    assert.equal(ebook.readTranslationCache(dir, 'book1', 'offline', 0), null)
    ebook.writeTranslationCache(dir, 'book1', 'offline', 0, '译文本')
    assert.equal(ebook.readTranslationCache(dir, 'book1', 'offline', 0), '译文本')
    assert.equal(ebook.readTranslationCache(dir, 'book1', 'cloud', 0), null, '不同引擎缓存必须隔离')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ebook wiring: IPC, preload, reader UI with offline/cloud translate and bilingual view', () => {
  for (const verb of ['ebook:open', 'ebook:chapter', 'ebook:translate']) {
    assert.ok(main.includes(`ipcMain.handle('${verb}'`), verb)
  }
  assert.ok(main.includes("ipcMain.handle('onlineMedia:bookFiles'"))
  assert.ok(preload.includes('ebook: {'))
  assert.ok(preload.includes('bookFiles'))
  assert.match(panel, /电子书/)
  assert.match(panel, /EbookReader/)
  assert.match(reader, /离线免费/)
  assert.match(reader, /云模型精译/)
  // 云端翻译必须过同意闸
  assert.match(main, /ensureCloudConsent\('电子书章节原文将发送给云端模型用于翻译。'\)/)
})

test('ebook download has caller-bounded attempts that finish before an outer test timeout', async () => {
  assert.equal(typeof ebook.__test?.fetchBuffer, 'function')
  let calls = 0
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    calls += 1
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
  })
  const started = Date.now()
  await assert.rejects(() => ebook.__test.fetchBuffer('https://archive.org/test', { timeoutMs: 10, attempts: 2, retryDelayMs: 0, fetchImpl }), /下载超时/)
  assert.equal(calls, 2)
  assert.ok(Date.now() - started < 500, '内部有界重试必须早于外层测试硬超时结束')
})

test('real archive.org gutenberg: list book files, fetch epub and parse chapters', { timeout: 120000 }, async (t) => {
  let detail
  try {
    detail = await onlineMedia.listBookFiles('prideandprejudic01342gut', { timeoutMs: 15000, attempts: 2 })
  } catch (error) {
    t.skip(`网络不可用：${error.message}`)
    return
  }
  assert.ok(detail.files.length > 0, '公版书应有 epub/txt 文件')
  const epub = detail.files.find((file) => file.name.endsWith('.epub'))
  assert.ok(epub, '应有 epub 版本')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebook-real-'))
  try {
    let bookPath
    try {
      bookPath = await ebook.fetchBook(dir, 'prideandprejudic01342gut', epub.name, { timeoutMs: 15000, attempts: 2 })
    } catch (error) {
      t.skip(`镜像网络不可用：${error.message}`)
      return
    }
    assert.ok(fs.statSync(bookPath).size > 100000, '全书应真实下载')
    // 二次调用走缓存（不重复下载）
    const again = await ebook.fetchBook(dir, 'prideandprejudic01342gut', epub.name)
    assert.equal(again, bookPath)
    const chapters = await ebook.parseEpubChapters(bookPath)
    assert.ok(chapters.length > 10, `傲慢与偏见应解析出多章，实际 ${chapters.length}`)
    assert.ok(chapters.some((chapter) => chapter.text.includes('truth universally acknowledged')), '第一章应含名句')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
