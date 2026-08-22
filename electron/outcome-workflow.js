const path = require('path')

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.wmv', '.flv', '.ts'])

function requestedFormats(instruction) {
  const text = String(instruction || '')
  const formats = []
  if (/word|docx|报告/i.test(text)) formats.push('docx')
  if (/ppt|演示|汇报|幻灯片/i.test(text)) formats.push('pptx')
  if (/excel|xlsx|分析表|工作簿|电子表格/i.test(text)) formats.push('xlsx')
  if (/pdf/i.test(text)) formats.push('pdf')
  if (/markdown|\.md\b/i.test(text)) formats.push('md')
  return [...new Set(formats)]
}

function compileOutcomeWorkflow({ sourcePath, instruction } = {}) {
  const resolved = String(sourcePath || '').trim()
  const text = String(instruction || '').trim()
  if (!resolved || !VIDEO_EXTENSIONS.has(path.extname(resolved).toLowerCase())) return null
  if (!text || /(?:能不能|可以吗|可不可以|是否可以|怎么做|如何做).*(?:\?|？)?$/.test(text)) return null
  const formats = requestedFormats(text)
  if (formats.length < 2) return null
  if (!/拉片|解剖|分析|拆解|总结|内容|成果|报告|汇报/i.test(text)) return null
  return {
    schemaVersion: 1,
    kind: 'agentplay.outcome-workflow',
    instruction: text.slice(0, 4000),
    source: { kind: 'video', path: path.resolve(resolved), name: path.basename(resolved) },
    deliverables: { formats, language: 'zh-CN', consistency: 'shared-evidence-ledger' },
    steps: [
      { id: 'evidence-analysis', tool: 'video.evidence-analysis', dependsOn: [], output: 'analysis-draft' },
      { id: 'consistent-package', tool: 'document.consistent-bundle', dependsOn: ['evidence-analysis'], input: 'analysis-draft', outputs: formats }
    ],
    quality: { requireEveryStepReceipt: true, requireSourceFingerprint: true, requireDeliveryReceipt: true, overwriteSource: false }
  }
}

function assertOutcomeWorkflow(plan) {
  if (!plan || plan.schemaVersion !== 1 || plan.kind !== 'agentplay.outcome-workflow') throw new Error('成果工作流协议无效')
  if (plan.source?.kind !== 'video' || !VIDEO_EXTENSIONS.has(path.extname(String(plan.source?.path || '')).toLowerCase())) throw new Error('成果工作流来源无效')
  if (!Array.isArray(plan.deliverables?.formats) || plan.deliverables.formats.length < 2) throw new Error('成果工作流至少需要两个最终格式')
  if (!Array.isArray(plan.steps) || plan.steps.length !== 2 || plan.steps[0]?.id !== 'evidence-analysis' || plan.steps[1]?.id !== 'consistent-package') throw new Error('成果工作流步骤无效')
  if (plan.steps[1]?.dependsOn?.[0] !== 'evidence-analysis') throw new Error('成果工作流依赖关系无效')
  if (plan.quality?.overwriteSource !== false || plan.quality?.requireEveryStepReceipt !== true) throw new Error('成果工作流质量条件无效')
  return plan
}

module.exports = { compileOutcomeWorkflow, assertOutcomeWorkflow, requestedFormats }
