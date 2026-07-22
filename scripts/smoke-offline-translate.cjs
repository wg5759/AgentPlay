// Electron 主进程冒烟：验证 onnxruntime-node 在 Electron 内建 Node 下能加载并翻译。
// 用法: node_modules/.bin/electron scripts/smoke-offline-translate.cjs [modelsRoot]
const { app } = require('electron')
const path = require('path')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')

app.whenReady().then(async () => {
  const modelsRoot = process.argv[2] || path.join(__dirname, '..', 'release', 'translate-pack', 'models')
  try {
    const { OfflineTranslateService } = require('../electron/offline-translate-service')
    const service = new OfflineTranslateService({ modelRoot: modelsRoot })
    const status = service.availability()
    if (!status.available) throw new Error(`组件不完整: ${status.reason}`)
    const [zh] = await service.translateLines(['Welcome back, everyone.'])
    console.log('SMOKE_TRANSLATION:', JSON.stringify(zh))
    if (!zh || !/[一-鿿]/.test(zh)) throw new Error(`译文不含中文: ${zh}`)
    console.log('SMOKE_OK')
    app.exit(0)
  } catch (error) {
    console.error('SMOKE_FAIL', error && error.message)
    app.exit(1)
  }
})
