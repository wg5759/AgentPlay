const crypto = require('crypto')

class ScreenCaptureService {
  constructor(getWindow) {
    this.getWindow = getWindow
  }

  async capture() {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) throw new Error('AI 播放器窗口不可用')
    // 模态面板本身不应遮住被观察的播放器画面。只执行固定脚本，且无用户输入拼接。
    await win.webContents.executeJavaScript(`new Promise((resolve) => {
      document.querySelectorAll('[data-ai-capture-hide]').forEach((node) => {
        node.dataset.aiPreviousDisplay = node.style.display
        node.style.display = 'none'
      })
      document.querySelectorAll('input[type="password"], [autocomplete="cc-number"], [autocomplete="cc-csc"], [autocomplete="one-time-code"], [data-ai-sensitive]').forEach((node) => {
        node.dataset.aiPreviousVisibility = node.style.visibility
        node.dataset.aiCaptureMasked = 'true'
        node.style.visibility = 'hidden'
      })
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    })`)
    let image
    try {
      image = await win.webContents.capturePage()
    } finally {
      await win.webContents.executeJavaScript(`document.querySelectorAll('[data-ai-capture-hide]').forEach((node) => {
        node.style.display = node.dataset.aiPreviousDisplay || ''
        delete node.dataset.aiPreviousDisplay
      })
      document.querySelectorAll('[data-ai-capture-masked="true"]').forEach((node) => {
        node.style.visibility = node.dataset.aiPreviousVisibility || ''
        delete node.dataset.aiPreviousVisibility
        delete node.dataset.aiCaptureMasked
      })`)
    }
    let size = image.getSize()
    if (!size.width || !size.height) throw new Error('窗口截图为空')
    if (size.width > 1280) {
      image = image.resize({ width: 1280, quality: 'good' })
      size = image.getSize()
    }
    const dataUrl = image.toDataURL()
    if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('窗口截图格式无效')
    if (dataUrl.length > 16 * 1024 * 1024) throw new Error('窗口截图超过内存传输上限')
    return {
      frameId: crypto.randomUUID(),
      width: size.width,
      height: size.height,
      createdAt: Date.now(),
      dataUrl
    }
  }
}

module.exports = { ScreenCaptureService }
