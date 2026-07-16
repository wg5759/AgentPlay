const { BrowserWindow } = require('electron')
const path = require('path')

async function printFile(filePath) {
  const win = new BrowserWindow({ show: false, sandbox: true, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  const ext = path.extname(filePath).toLowerCase()
  try {
    if (ext === '.pdf') {
      await win.loadFile(filePath)
    } else {
      const escaped = filePath.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const html = '<img src="file://' + escaped + '" style="max-width:100%">'
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    }
    win.webContents.print({ printBackground: true })
    setTimeout(() => win.close(), 2000)
    return { success: true, action: '已发送打印' }
  } catch (e) {
    win.close()
    return { success: false, error: String(e) }
  }
}

module.exports = { printFile }
