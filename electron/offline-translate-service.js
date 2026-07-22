// 离线翻译服务：OPUS-MT（en→zh）经 @huggingface/transformers + onnxruntime-node 在本机运行。
// 模型文件由"离线翻译组件包"下载到 userData/translate-pack/models，纯本地、零 Key。
// 通过 jsonComplete() 适配字幕翻译链（与云端 llmComplete 同一接口），离线优先、云端兜底。
const fs = require('fs')
const path = require('path')

const MODEL_ID = 'Xenova/opus-mt-en-zh'
const REQUIRED_FILES = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx'
]

// 拉丁字母明显多于中日韩文字即视为"英文为主"（字幕粗判，够路由用）
function isMostlyLatin(text) {
  const value = String(text || '').replace(/<[^>]+>|\{[^}]*\}/g, ' ')
  const latin = (value.match(/[a-zA-Z]/g) || []).length
  const cjk = (value.match(/[一-鿿぀-ヿ가-힯]/g) || []).length
  return latin > 0 && latin > cjk * 2
}

// 只有"目标中文 + 源文本以英文为主"才适合离线 en→zh 模型；其它语言对交给云端
function shouldUseOffline(entries, targetLang = '中文') {
  if (!/^中/.test(String(targetLang || ''))) return false
  const list = (Array.isArray(entries) ? entries : []).slice(0, 20)
  if (!list.length) return false
  const latinCount = list.filter((entry) => isMostlyLatin(entry.text)).length
  return latinCount / list.length >= 0.6
}

class OfflineTranslateService {
  constructor({ modelRoot, pipelineFactory } = {}) {
    this.modelRoot = modelRoot ? path.resolve(modelRoot) : modelRoot
    this.pipelineFactory = pipelineFactory || null
    this.pipelinePromise = null
  }

  modelDir() {
    return path.join(this.modelRoot, ...MODEL_ID.split('/'))
  }

  availability() {
    const dir = this.modelDir()
    const missing = REQUIRED_FILES.filter((file) => {
      try {
        return !fs.statSync(path.join(dir, ...file.split('/'))).isFile()
      } catch {
        return true
      }
    })
    return {
      available: missing.length === 0,
      missing,
      modelDir: dir,
      reason: missing.length ? `离线翻译模型未安装（缺 ${missing.length} 个文件）` : ''
    }
  }

  async ensurePipeline() {
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        if (this.pipelineFactory) return this.pipelineFactory()
        if (!this.availability().available) throw new Error('离线翻译组件未安装，请先在模型接入中心下载')
        const { pipeline, env } = await import('@huggingface/transformers')
        env.allowRemoteModels = false
        env.localModelPath = this.modelRoot + path.sep
        return pipeline('translation', MODEL_ID, { dtype: 'q8' })
      })()
      this.pipelinePromise.catch(() => { this.pipelinePromise = null })
    }
    return this.pipelinePromise
  }

  // 逐句翻译（保持输入顺序与数量）；signal 在句间检查，中止时抛"已取消"
  async translateLines(texts, { signal } = {}) {
    const translator = await this.ensurePipeline()
    const outputs = []
    for (const text of texts) {
      if (signal?.aborted) throw new Error('翻译已取消')
      const value = String(text || '').trim()
      if (!value) {
        outputs.push('')
        continue
      }
      const result = await translator(value)
      const translated = String(result?.[0]?.translation_text || '').trim()
      if (!translated) throw new Error('离线翻译没有返回内容')
      outputs.push(translated)
    }
    return outputs
  }

  // 适配字幕翻译链的 complete 接口：解析 prompt 尾部的 {"items":[...]}，离线逐句翻译后回传同构 JSON
  async jsonComplete({ prompt, signal } = {}) {
    const jsonStart = String(prompt || '').indexOf('{"items"')
    if (jsonStart < 0) throw new Error('离线翻译只支持字幕批量任务')
    const items = JSON.parse(String(prompt).slice(jsonStart)).items
    if (!Array.isArray(items) || !items.length) throw new Error('字幕批量任务为空')
    const translated = await this.translateLines(items.map((item) => item.text), { signal })
    return {
      text: JSON.stringify({ translations: items.map((item, index) => ({ i: item.i, text: translated[index] })) }),
      provider: 'offline-opus-mt',
      model: MODEL_ID
    }
  }
}

module.exports = {
  MODEL_ID,
  OfflineTranslateService,
  isMostlyLatin,
  shouldUseOffline
}
