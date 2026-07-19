const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ExcelJS = require('exceljs')
const { buildSpreadsheetHtml, previewXlsx } = require('../electron/office-preview')
const { WifiTransfer } = require('../electron/wifi-transfer')

const root = path.join(__dirname, '..')
const source = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('LAN-facing services stay stopped until an explicit renderer request', () => {
  const main = source('electron/main.js')
  const startup = main.slice(main.indexOf('app.whenReady()'), main.indexOf('// mpv 事件转发'))

  assert.doesNotMatch(startup, /await\s+wifiTransfer\.start/)
  assert.doesNotMatch(startup, /await\s+syncService\.start/)
  assert.doesNotMatch(startup, /await\s+dlnaServer\.start/)
  assert.doesNotMatch(startup, /await\s+dlnaReceiver\.start/)
  assert.match(main, /ipcMain\.handle\('wifi:url',\s*async/)
  assert.match(main, /ipcMain\.handle\('sync:url',\s*async/)
  assert.match(main, /ipcMain\.handle\('dlna:serverUrl',\s*async/)
  assert.match(main, /ipcMain\.handle\('receiver:start',\s*async/)

  const library = source('src/components/MediaLibrary.tsx')
  assert.doesNotMatch(library, /useEffect\(\(\)\s*=>\s*\{[\s\S]{0,300}wifi\.url\(\)/)
  assert.match(library, /启用 WiFi 传文件/)
  assert.match(library, /启用跨设备同步/)
  assert.match(library, /启用接收投屏/)
})

test('voice wake is opt-in and visibly stoppable', () => {
  const app = source('src/App.tsx')
  const wake = source('src/components/VoiceWake.tsx')

  assert.match(app, /localStorage\.getItem\('aiplayer_voice_wake_enabled'\) === 'true'/)
  assert.match(app, /语音唤醒已开启/)
  assert.match(wake, /if \(!enabled \|\| panelOpen\) return/)
  assert.doesNotMatch(wake, /export default function VoiceWake\(\)/)
})

test('Office preview is sandboxed and spreadsheet cells are escaped', () => {
  const player = source('src/components/PlayerView.tsx')
  const pkg = JSON.parse(source('package.json'))

  assert.doesNotMatch(player, /dangerouslySetInnerHTML/)
  assert.match(player, /sandbox=""/)
  assert.match(player, /Content-Security-Policy/)
  assert.equal(pkg.dependencies.xlsx, undefined)
  assert.equal(pkg.dependencies.exceljs, '4.4.0')
  assert.equal(
    buildSpreadsheetHtml([['<img src=x onerror=alert(1)>']]),
    '<table><tbody><tr><td>&lt;img src=x onerror=alert(1)&gt;</td></tr></tbody></table>'
  )
})

test('ExcelJS reads a real xlsx workbook after the patched uuid override', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-xlsx-'))
  const filePath = path.join(dir, 'safe.xlsx')
  try {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Sheet1')
    sheet.addRow(['标题', '<script>alert(1)</script>'])
    await workbook.xlsx.writeFile(filePath)
    const result = await previewXlsx(filePath)
    assert.equal(result.success, true)
    assert.match(result.html, /标题/)
    assert.match(result.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
    assert.doesNotMatch(result.html, /<script>/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('WiFi upload authenticates before multipart parsing and never renders the PIN', async () => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-wifi-secure-'))
  const wifi = new WifiTransfer()
  wifi.port = 47000 + (process.pid % 1000)
  wifi.uploadDir = uploadDir
  wifi.getLanIp = () => '127.0.0.1'
  try {
    await wifi.start()
    const page = await (await fetch(wifi.getUrl())).text()
    assert.equal(page.includes(wifi.getPin()), false)
    assert.match(page, /X-AI-Player-PIN/)

    const rejected = new FormData()
    rejected.append('file', new Blob(['blocked']), 'blocked.txt')
    const rejectedResponse = await fetch(wifi.getUrl(), { method: 'POST', body: rejected })
    assert.equal(rejectedResponse.status, 403)
    assert.deepEqual(fs.readdirSync(uploadDir), [])

    const accepted = new FormData()
    accepted.append('file', new Blob(['allowed']), 'allowed.txt')
    const acceptedResponse = await fetch(wifi.getUrl(), {
      method: 'POST',
      headers: { 'X-AI-Player-PIN': wifi.getPin() },
      body: accepted
    })
    assert.equal(acceptedResponse.status, 200)
    assert.equal(fs.readFileSync(path.join(uploadDir, 'allowed.txt'), 'utf8'), 'allowed')
  } finally {
    wifi.stop()
    fs.rmSync(uploadDir, { recursive: true, force: true })
  }
})
