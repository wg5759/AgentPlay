const { BrowserWindow } = require('electron')
const path = require('path')

async function printFile(filePath) {
  const win = new BrowserWindow({ show: false })
  const ext = path.extname(filePath).toLowerCase()
  try {
    if (ext === '.pdf') {
      await win.loadFile(filePath)
    } else {
      const html = '<img src="file://' + filePath + '" style="max-width:100%">'
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
