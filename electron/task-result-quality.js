const fs = require('fs')
const path = require('path')
const { fingerprintArtifact } = require('./artifact-fingerprint')

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.wmv', '.flv', '.ts'])
const OFFICE_ZIP_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.epub'])
const HARD_FAILURES = new Set([
  'RESULT_FAILED', 'ARTIFACT_MISSING', 'ARTIFACT_EMPTY', 'INVALID_FORMAT', 'SUBTITLE_EMPTY',
  'TARGET_LANGUAGE_MISSING', 'PARTIAL_BATCH', 'NO_BATCH_RESULTS', 'DURATION_MISMATCH', 'SEGMENT_RECEIPT_INCOMPLETE', 'PROJECT_CAPSULE_MISSING',
  'FRAME_PROOF_MISSING', 'FRAME_PROOF_UNAVAILABLE', 'FRAME_PROOF_INCOMPLETE', 'FRAME_BOUNDARY_MISMATCH',
  'EFFECT_RECEIPT_MISMATCH', 'EFFECT_CHANGE_MISSING', 'DIMENSION_MISMATCH',
  'REFRAME_OUTPUT_MISMATCH', 'TRACKING_EVIDENCE_MISSING', 'SUBJECT_COVERAGE_LOW',
  'VISUAL_REPAIR_PROOF_MISSING', 'STABILIZATION_NOT_IMPROVED', 'COLOR_REPAIR_NOT_IMPROVED', 'COMPARISON_MISSING',
  'STYLE_BLUEPRINT_MISSING', 'STYLE_STRUCTURE_MISMATCH', 'COPYRIGHT_BOUNDARY_FAILED',
  'UNIFIED_VISUAL_QC_FAILED', 'UNIFIED_AUDIO_QC_FAILED',
  'AUDIO_PROOF_MISSING', 'AUDIO_SILENT', 'AUDIO_CHANGE_MISSING', 'AUDIO_OVERLOAD', 'AUDIO_FADE_PROOF_MISSING',
  'LOUDNESS_PROOF_MISSING', 'LOUDNESS_MISMATCH',
  'MULTITRACK_PROOF_MISSING', 'TRACK_ALIGNMENT_MISMATCH', 'TRACK_AUTOMATION_MISSING', 'DUCKING_RECEIPT_MISSING',
  'AUDIO_REPAIR_PROOF_MISSING', 'DENOISE_NOT_IMPROVED', 'DC_NOT_IMPROVED', 'SILENCE_REPAIR_MISMATCH', 'SEPARATION_PROOF_MISSING', 'SEPARATION_WARNING_MISSING',
  'BEAT_EVIDENCE_MISSING', 'BEAT_CUT_NOT_VISIBLE', 'HIGHLIGHT_DENSITY_MISMATCH', 'MUSIC_ALIGNMENT_MISSING', 'TAIL_FADE_MISSING',
  'SPEAKER_EVIDENCE_MISSING', 'WORD_TIMING_MISSING', 'KARAOKE_PROOF_MISSING', 'KEYWORD_EMPHASIS_MISSING', 'SUBTITLE_SAFE_AREA_FAILED',
  'BRAND_TITLE_MISSING', 'BRAND_CHAPTERS_MISSING', 'BRAND_PERSON_MISSING', 'BRAND_CORNER_MISSING', 'BRAND_OUTRO_MISSING',
  'SUBTITLE_TRANSFORM_MISMATCH', 'SUBTITLE_TRANSFORM_LANGUAGE_MISSING', 'SUBTITLE_TRANSFORM_STYLE_MISSING',
  'SUBTITLE_LAYOUT_FONT_FAILED', 'SUBTITLE_LAYOUT_LINES_FAILED', 'SUBTITLE_LAYOUT_WRAPPING_FAILED', 'SUBTITLE_LAYOUT_OCCLUSION_FAILED', 'SUBTITLE_LAYOUT_POSITION_FAILED',
  'SUBTITLE_PREVIEW_BURN_PARITY_FAILED',
  'AI_ASSET_RECEIPT_MISSING', 'AI_ASSET_PROVENANCE_MISMATCH', 'AI_ASSET_SOURCE_UPLOAD_VIOLATION', 'AI_ASSET_MEDIA_INVALID', 'AI_ASSET_APPROVAL_MISSING', 'AI_ASSET_RECOVERY_REPEAT',
  'DELIVERY_RECEIPT_MISSING', 'DELIVERY_RECEIPT_MISMATCH', 'SOURCE_RECEIPT_MISSING',
  'BUNDLE_INCOMPLETE', 'BUNDLE_INCONSISTENT', 'WORKFLOW_RECEIPT_INCOMPLETE',
  'BATCH_EDIT_RECEIPT_MISSING', 'BATCH_EDIT_ISOLATION_FAILED',
  'EDIT_GOVERNANCE_RECEIPT_MISSING', 'EDIT_GOVERNANCE_BYPASS'
])

function uniqueOutputs(result = {}) {
  const values = Array.isArray(result.outputs) ? result.outputs : result.outputPath ? [result.outputPath] : result.srtPath ? [result.srtPath] : []
  return [...new Set(values.map((value) => path.resolve(String(value || ''))).filter(Boolean))]
}

function hasVideoSignature(ext, sample) {
  if (['.mp4', '.mov', '.m4v'].includes(ext)) return sample.length >= 12 && sample.subarray(4, 8).toString('ascii') === 'ftyp'
  if (['.mkv', '.webm'].includes(ext)) return sample.length >= 4 && sample.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  if (ext === '.avi') return sample.length >= 12 && sample.subarray(0, 4).toString('ascii') === 'RIFF' && sample.subarray(8, 11).toString('ascii') === 'AVI'
  if (ext === '.wmv') return sample.length >= 4 && sample.subarray(0, 4).equals(Buffer.from([0x30, 0x26, 0xb2, 0x75]))
  if (ext === '.flv') return sample.length >= 3 && sample.subarray(0, 3).toString('ascii') === 'FLV'
  if (ext === '.ts') return sample.length >= 1 && sample[0] === 0x47 && (sample.length < 189 || sample[188] === 0x47)
  return false
}

function inspectArtifact(filePath) {
  try {
    const stat = fs.statSync(filePath)
    if (stat.isDirectory()) return { exists: true, nonEmpty: fs.readdirSync(filePath).length > 0, formatOk: true, bytes: 0, kind: 'directory' }
    if (!stat.isFile()) return { exists: true, nonEmpty: false, formatOk: false, bytes: 0, kind: 'other' }
    const bytes = stat.size
    if (bytes <= 0) return { exists: true, nonEmpty: false, formatOk: false, bytes, kind: 'file' }
    const ext = path.extname(filePath).toLowerCase()
    const header = Buffer.alloc(Math.min(bytes, 256 * 1024))
    const descriptor = fs.openSync(filePath, 'r')
    let received = 0
    try {
      while (received < header.length) {
        const count = fs.readSync(descriptor, header, received, header.length - received, received)
        if (!count) break
        received += count
      }
    } finally { fs.closeSync(descriptor) }
    const sample = header.subarray(0, received)
    let formatOk = true
    if (OFFICE_ZIP_EXTENSIONS.has(ext)) formatOk = sample.subarray(0, 2).toString('binary') === 'PK'
    else if (ext === '.pdf') formatOk = sample.subarray(0, 4).toString('ascii') === '%PDF'
    else if (ext === '.srt') formatOk = /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(sample.toString('utf8'))
    else if (VIDEO_EXTENSIONS.has(ext)) formatOk = hasVideoSignature(ext, sample)
    return { exists: true, nonEmpty: true, formatOk, bytes, kind: 'file', ext, text: ext === '.srt' ? sample.toString('utf8') : '' }
  } catch {
    return { exists: false, nonEmpty: false, formatOk: false, bytes: 0, kind: 'missing' }
  }
}

function reason(code, message, repairable = false, detail = '') {
  return { code, message, repairable: Boolean(repairable), ...(detail ? { detail } : {}) }
}

function audioExportQcStatus(result = {}) {
  const qc = result.audioExportQc
  const matched = qc?.schemaVersion === 1
    && qc?.method === 'unified-audio-export-qc-v1'
    && qc?.verdict === 'matched'
    && qc.clipping?.verdict === 'matched'
    && String(qc.loudness?.verdict || '').startsWith('matched')
    && qc.avSync?.verdict === 'matched'
    && String(qc.silence?.verdict || '').startsWith('matched')
    && qc.copyright?.verdict === 'documented'
    && Array.isArray(qc.copyright?.sources)
    && qc.copyright.sources.length > 0
  const detail = matched
    ? `${qc.loudness.integratedLufs} LUFS / ${qc.clipping.truePeakDbtp} dBTP；声画起点差${qc.avSync.startDeltaSeconds}秒；静音最长${qc.silence.maximumSilenceSeconds}秒；来源${qc.copyright.sources.length}项`
    : ''
  return { matched, detail }
}

function evaluateTaskResult(type, result = {}, spec = {}) {
  const checks = []
  const reasons = []
  const add = (id, label, ratio, weight, failure = null, detail = '') => {
    const bounded = Math.max(0, Math.min(1, Number(ratio) || 0))
    const passed = bounded >= 1
    checks.push({ id, label, passed, weight, score: Math.round(weight * bounded), ...(detail ? { detail } : {}) })
    if (!passed && failure) reasons.push(failure)
  }
  const success = result?.success !== false
  const outputs = uniqueOutputs(result)
  const artifacts = outputs.map((outputPath) => ({ path: outputPath, ...inspectArtifact(outputPath) }))
  const artifactRatio = artifacts.length ? artifacts.filter((item) => item.exists && item.nonEmpty).length / artifacts.length : 0
  const formatRatio = artifacts.length ? artifacts.filter((item) => item.exists && item.nonEmpty && item.formatOk).length / artifacts.length : 0
  const firstMissing = artifacts.find((item) => !item.exists)
  const firstEmpty = artifacts.find((item) => item.exists && !item.nonEmpty)
  const firstInvalid = artifacts.find((item) => item.exists && item.nonEmpty && !item.formatOk)
  const artifactFailure = firstMissing
    ? reason('ARTIFACT_MISSING', '成果文件不存在或已被移动', true, firstMissing.path)
    : firstEmpty ? reason('ARTIFACT_EMPTY', '成果文件为空或目录没有内容', true, firstEmpty.path)
      : outputs.length ? null : reason('ARTIFACT_MISSING', '任务没有产生可验证的成果文件', true)
  const formatFailure = firstInvalid ? reason('INVALID_FORMAT', '成果文件格式或结构无效', true, firstInvalid.path) : null
  const taskType = String(type || '')

  if (taskType === 'media.dedup') {
    add('declared-success', '执行状态', success ? 1 : 0, 20, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('scan-count', '扫描计数', Number.isFinite(Number(result.filesScanned)) && Number(result.filesScanned) >= 0 ? 1 : 0, 40, reason('SCAN_COUNT_MISSING', '缺少扫描文件计数', true))
    add('duplicate-list', '重复结果结构', Array.isArray(result.duplicates) ? 1 : 0, 40, reason('DUPLICATE_LIST_MISSING', '缺少重复文件结果列表', true))
  } else if (taskType === 'media.batch-edit') {
    const receipt = result.batchEditReceipt
    const items = Array.isArray(receipt?.items) ? receipt.items : []
    const expected = Array.isArray(spec.items) ? spec.items.length : 0
    const successes = items.filter((item) => item?.state === 'succeeded')
    const failures = items.filter((item) => item?.state === 'failed')
    const terminal = expected >= 2 && items.length === expected && receipt?.everyItemTerminal === true && Number(receipt?.total) === expected
    const countsMatch = Number(receipt?.successCount) === successes.length && Number(receipt?.failureCount) === failures.length && successes.length + failures.length === expected
    const successPaths = new Set(successes.map((item) => path.resolve(String(item?.outputPath || ''))))
    const outputMatch = outputs.length === successes.length && outputs.every((outputPath) => successPaths.has(path.resolve(outputPath)))
    const successOk = successes.every((item) => Number(item?.qualityScore) === 100 && /^[a-f0-9]+$/i.test(String(item?.sourceFingerprint || '')) && inspectArtifact(item.outputPath).formatOk)
    const failuresIsolated = failures.every((item) => item?.failure?.code && item?.failure?.message && !item?.outputPath)
    const receiptOk = receipt?.schemaVersion === 1 && receipt?.method === 'independent-media-edit-batch-v1' && receipt?.planDigest === spec.planDigest && ['matched', 'complete-with-isolated-failures'].includes(receipt?.verdict)
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '批量编辑返回失败状态', false))
    add('batch-edit-receipt', '批量编辑冻结回执', receiptOk ? 1 : 0, 20, reason('BATCH_EDIT_RECEIPT_MISSING', '缺少有效的批量编辑冻结回执', false))
    add('terminal-items', '逐条终态与计数', terminal && countsMatch ? 1 : 0, 20, reason('BATCH_EDIT_ISOLATION_FAILED', '批量编辑没有逐条进入独立终态', false))
    add('successful-artifacts', '成功项逐条质量', successOk && outputMatch && successes.length > 0 ? 1 : 0, 30, reason('BATCH_EDIT_ISOLATION_FAILED', '成功项的成果、来源指纹或质量分不完整', false))
    add('failed-isolation', '失败项隔离', failuresIsolated ? 1 : 0, 20, reason('BATCH_EDIT_ISOLATION_FAILED', '失败项仍携带成果或缺少稳定失败原因', false))
  } else if (taskType === 'media.batch') {
    const results = Array.isArray(result.results) ? result.results : []
    const expected = Math.max(results.length, Array.isArray(spec.sources) ? spec.sources.length : 0)
    const succeeded = results.filter((item) => item?.success && item?.outputPath).length
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('batch-results', '逐项结果', expected > 0 ? results.length / expected : 0, 20, reason('NO_BATCH_RESULTS', '批量任务没有完整逐项结果', true))
    add('batch-success', '批量成功率', expected > 0 ? succeeded / expected : 0, 50, reason('PARTIAL_BATCH', `批量任务只完成 ${succeeded}/${expected} 项`, true))
    add('artifacts', '成果文件', artifactRatio, 20, artifactFailure)
  } else if (taskType === 'outcome.workflow') {
    const workflowReceipt = result.workflowReceipt
    const steps = Array.isArray(workflowReceipt?.steps) ? workflowReceipt.steps : []
    const validSteps = steps.filter((item) => item?.state === 'completed' && Array.isArray(item?.outputs) && item.outputs.length > 0 && item.outputs.every((outputPath) => {
      const artifact = inspectArtifact(outputPath)
      return artifact.exists && artifact.nonEmpty && artifact.formatOk
    }))
    const stepIds = new Set(validSteps.map((item) => item.id))
    const workflowComplete = workflowReceipt?.schemaVersion === 1
      && workflowReceipt?.kind === 'agentplay.outcome-workflow-receipt'
      && /^[a-f0-9]{64}$/i.test(String(workflowReceipt?.source?.sha256 || ''))
      && stepIds.has('evidence-analysis')
      && stepIds.has('consistent-package')
    const receipt = result.deliveryReceipt
    const receiptArtifacts = Array.isArray(receipt?.artifacts) ? receipt.artifacts : []
    const deliveryPaths = new Set(receiptArtifacts.map((item) => path.resolve(String(item?.path || ''))))
    const deliveryOk = receipt?.schemaVersion === 1
      && receipt?.kind === 'agentplay.delivery-receipt'
      && outputs.length === receiptArtifacts.length
      && outputs.every((outputPath) => deliveryPaths.has(path.resolve(outputPath)))
      && receiptArtifacts.every((item) => {
        try { return fingerprintArtifact(item.path).sha256 === item.sha256 } catch { return false }
      })
    const projectRequired = Boolean(spec.projectId)
    const projectOk = !projectRequired || (result.projectCapsule?.schemaVersion === 1 && String(result.projectCapsule?.projectId || '').startsWith('project-') && Number(result.projectCapsule?.revision) >= 1 && String(result.projectCapsule?.currentPath || ''))
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '最终成果文件', artifactRatio, 25, artifactFailure)
    add('format', '最终成果格式', formatRatio, 10, formatFailure)
    add('workflow-receipt', '逐步成果回执', workflowComplete ? 1 : 0, 25, reason('WORKFLOW_RECEIPT_INCOMPLETE', '成果工作流缺少完整的上游分析或最终打包回执', true))
    add('delivery-receipt', '最终交付回执', deliveryOk ? 1 : 0, 20, !receipt ? reason('DELIVERY_RECEIPT_MISSING', '缺少最终成果交付回执', true) : reason('DELIVERY_RECEIPT_MISMATCH', '最终成果与交付回执不一致', true))
    add('project-capsule', '项目胶囊与当前版本', projectOk ? 1 : 0, 10, reason('PROJECT_CAPSULE_MISSING', '成果没有进入统一项目胶囊或缺少当前版本', true))
  } else if (taskType === 'document.run' && result.chatOnly) {
    add('declared-success', '执行状态', success ? 1 : 0, 20, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('chat-result', '回答内容', String(result.summary || '').trim().length >= 8 ? 1 : 0, 50, reason('EMPTY_CHAT_RESULT', '回答内容为空或过短', true))
    add('history', '历史记录', result.historyId ? 1 : 0, 30, reason('HISTORY_MISSING', '结果尚未写入任务历史', true))
  } else if (taskType === 'project.evidence-qa') {
    const receipt = result.evidenceReceipt
    const claims = Array.isArray(result.claims) ? result.claims : []
    const evidence = Array.isArray(result.evidence) ? result.evidence : []
    const schemaOk = receipt?.schemaVersion === 1 && receipt?.kind === 'agentplay.cross-material-answer-receipt'
    const sourceOk = schemaOk && Number(receipt.sourceCount) >= 2
    const labelsOk = schemaOk && receipt.allClaimsLabeled === true && claims.length > 0 && claims.every((item) => ['confirmed', 'inference', 'unknown'].includes(item?.status))
    const citationsOk = schemaOk && receipt.confirmedCitationsValid === true && claims.filter((item) => item.status === 'confirmed').every((item) => Array.isArray(item.evidenceIds) && item.evidenceIds.length > 0)
    const evidenceOk = evidence.every((item) => item?.kind === 'agentplay.evidence-reference' && item.source && item.locatorLabel)
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('source-count', '跨素材来源', sourceOk ? 1 : 0, 25, reason('EVIDENCE_MISSING', '跨素材问答未覆盖至少两个来源', false))
    add('claim-labels', '已确认/推断/未知标记', labelsOk ? 1 : 0, 25, reason('CLAIM_STATUS_MISSING', '回答存在未标记可确认程度的主张', false))
    add('citation-validity', '已确认结论引用', citationsOk ? 1 : 0, 25, reason('EVIDENCE_MISSING', '已确认结论缺少有效证据引用', false))
    add('evidence-locators', '来源定位结构', evidenceOk ? 1 : 0, 15, reason('EVIDENCE_LOCATOR_INVALID', '证据缺少可回开的来源定位', false))
  } else if (taskType === 'subtitle.generate') {
    const text = artifacts.map((item) => item.text || '').join('\n')
    const cueCount = (text.match(/-->/g) || []).length
    const target = String(result.targetLang || spec.targetLang || '')
    const hasTarget = target === '英文' ? /[A-Za-z]/.test(text) : target === '中文' ? /[\u3400-\u9fff]/.test(text) : cueCount > 0
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '字幕文件', artifactRatio, 40, artifactFailure)
    add('format', '字幕结构', formatRatio, 20, formatFailure || reason('SUBTITLE_EMPTY', '字幕文件没有有效时间轴', true))
    add('subtitle-cues', '字幕条目', cueCount > 0 ? 1 : 0, 20, reason('SUBTITLE_EMPTY', '字幕文件没有有效字幕条目', true))
    add('target-language', '目标语言', hasTarget ? 1 : 0, 10, reason('TARGET_LANGUAGE_MISSING', `字幕中没有检测到${target || '目标语言'}文本`, true))
  } else if (taskType === 'analysis.run') {
    const semanticScore = Math.max(0, Math.min(100, Number(result.domainQuality?.score) || 0))
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '报告文件', artifactRatio, 30, artifactFailure)
    add('format', '报告结构', formatRatio, 10, formatFailure)
    add('history', '历史记录', result.historyId ? 1 : 0, 10, reason('HISTORY_MISSING', '报告尚未写入历史记录', true))
    add('evidence', '证据覆盖', Number(result.cueCount || 0) + Number(result.frameCount || 0) > 0 ? 1 : 0, 10, reason('EVIDENCE_MISSING', '报告缺少字幕或画面证据计数', false))
    add('semantic-quality', '专业内容质量', semanticScore / 100, 20, reason('SEMANTIC_QUALITY_LOW', '报告专业内容质量未达到标准', false, (result.domainQuality?.reasons || []).join('；')))
    add('summary', '结果说明', String(result.summary || '').trim() ? 1 : 0, 10, reason('SUMMARY_MISSING', '缺少结果说明', true))
  } else if (taskType === 'document.run') {
    const receipt = result.deliveryReceipt
    const receiptArtifacts = Array.isArray(receipt?.artifacts) ? receipt.artifacts : []
    const receiptSources = Array.isArray(receipt?.sources) ? receipt.sources : []
    const receiptSchemaOk = receipt?.schemaVersion === 1 && receipt?.kind === 'agentplay.delivery-receipt'
    const receiptPaths = new Set(receiptArtifacts.map((item) => path.resolve(String(item?.path || ''))))
    const artifactsMatch = receiptSchemaOk
      && outputs.length === receiptArtifacts.length
      && outputs.every((outputPath) => receiptPaths.has(path.resolve(outputPath)))
      && receiptArtifacts.every((item) => {
        try { return /^[a-f0-9]{64}$/i.test(String(item?.sha256 || '')) && fingerprintArtifact(item.path).sha256 === item.sha256 } catch { return false }
      })
    const expectedSources = Array.isArray(spec.sources) ? spec.sources.length : 0
    const provenanceOk = receiptSchemaOk
      && (expectedSources === 0 ? /^[a-f0-9]{64}$/i.test(String(receipt.instructionSha256 || '')) : receiptSources.length === expectedSources)
      && receiptSources.every((item) => /^[a-f0-9]{64}$/i.test(String(item?.sha256 || '')))
    const isBundle = result.plan?.kind === 'ai-bundle' || Boolean(receipt?.bundle)
    const requestedFormats = Array.isArray(receipt?.bundle?.requestedFormats) ? receipt.bundle.requestedFormats : []
    const completedFormats = new Set(Array.isArray(receipt?.bundle?.completedFormats) ? receipt.bundle.completedFormats : [])
    const failedFormats = receipt?.bundle?.failedFormats && typeof receipt.bundle.failedFormats === 'object' ? receipt.bundle.failedFormats : {}
    const bundleComplete = !isBundle || (
      receipt.status === 'complete'
      && requestedFormats.length >= 2
      && requestedFormats.every((format) => completedFormats.has(format))
      && Object.keys(failedFormats).length === 0
    )
    const bundleConsistent = !isBundle || (
      receipt?.bundle?.consistency?.verdict === 'matched'
      && receipt?.bundle?.consistency?.sharedSourceLedger === true
      && /^[a-f0-9]{64}$/i.test(String(receipt?.bundle?.sourceLedgerSha256 || ''))
      && receiptArtifacts.every((item) => item.sourceLedgerSha256 === receipt.bundle.sourceLedgerSha256 && Array.isArray(item.factIds) && item.factIds.length > 0)
    )
    const projectRequired = Boolean(spec.projectId)
    const projectOk = !projectRequired || (result.projectCapsule?.schemaVersion === 1 && String(result.projectCapsule?.projectId || '').startsWith('project-') && Number(result.projectCapsule?.revision) >= 1 && String(result.projectCapsule?.currentPath || ''))
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '成果文件', artifactRatio, 20, artifactFailure)
    add('format', '文件结构', formatRatio, 10, formatFailure)
    add('history', '历史记录', result.historyId ? 1 : 0, 10, reason('HISTORY_MISSING', '成果尚未写入历史记录', true))
    add('summary', '结果说明', String(result.summary || '').trim() ? 1 : 0, 5, reason('SUMMARY_MISSING', '缺少结果说明', true))
    add('provenance-receipt', '来源与成果哈希回执', artifactsMatch && provenanceOk ? 1 : 0, 20,
      !receiptSchemaOk ? reason('DELIVERY_RECEIPT_MISSING', '缺少可核对的来源与成果交付回执', true)
        : !artifactsMatch ? reason('DELIVERY_RECEIPT_MISMATCH', '成果文件与交付回执不一致或已被改写', true)
          : reason('SOURCE_RECEIPT_MISSING', '交付回执没有覆盖全部来源', true))
    add('bundle-completeness', '成果包完整性', bundleComplete ? 1 : 0, 10, reason('BUNDLE_INCOMPLETE', '成果包存在未完成格式，不能按完整交付处理', true))
    add('bundle-consistency', '成果包共用冻结事实底稿', bundleConsistent ? 1 : 0, 10, reason('BUNDLE_INCONSISTENT', '成果包没有通过共享事实底稿一致性校验', true))
    add('project-capsule', '项目胶囊与当前版本', projectOk ? 1 : 0, 5, reason('PROJECT_CAPSULE_MISSING', '成果没有进入统一项目胶囊或缺少当前版本', true))
  } else if (taskType === 'media.visual-repair') {
    const receipt = result.repairReceipt
    const expectedDuration = Number(spec.decision?.repair?.durationSeconds); const tolerance = Math.max(0.1, Number(spec.decision?.verification?.toleranceSeconds) || 0.35)
    const durationOk = expectedDuration > 0 && Number(result.durationSeconds) > 0 && Math.abs(Number(result.durationSeconds) - expectedDuration) <= tolerance
    const stabilizationOk = spec.decision?.repair?.stabilize ? ['improved', 'not-needed'].includes(receipt?.stabilization?.verdict) && Number(receipt?.stabilization?.before?.frameCount) >= 0 : receipt?.stabilization?.requested === false
    const rotationOk = receipt?.rotation?.matched === true && Number(receipt.rotation.degrees) === Number(spec.decision?.repair?.rotationDegrees) && Number(receipt.rotation.dimensions?.width) === Number(spec.decision?.repair?.expectedDimensions?.width) && Number(receipt.rotation.dimensions?.height) === Number(spec.decision?.repair?.expectedDimensions?.height)
    const colorOk = spec.decision?.repair?.autoColor ? receipt?.color?.verdict === 'improved' && Number(receipt?.color?.afterDistance) < Number(receipt?.color?.beforeDistance) : receipt?.color?.requested === false
    const comparisonOk = outputs.length === 2 && path.resolve(String(receipt?.comparison?.path || '')) === path.resolve(outputs[1]) && Number(receipt?.comparison?.dimensions?.width) > 0 && Number(receipt?.comparison?.dimensions?.height) > 0
    const findings = Array.isArray(receipt?.lowQualityFindings) ? receipt.lowQualityFindings : []
    const reviewOnlyOk = JSON.stringify(findings) === JSON.stringify(spec.decision?.repair?.lowQualityFindings || []) && findings.every((item) => item.action === 'review-only')
    const projectCapsule = result.projectCapsule
    const hasProjectCapsule = projectCapsule?.schemaVersion === 1 && String(projectCapsule.projectId || '').startsWith('edit-') && projectCapsule.canUndo === true && path.resolve(String(projectCapsule.currentPath || '')) === path.resolve(outputs[0] || '')
    const visualQcOk = result.visualQc?.strategy === 'unified-visual-export-qc-v1' && result.visualQc?.passed === true && Array.isArray(result.visualQc?.artifacts) && result.visualQc.artifacts.length === 2
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '画面修复任务返回失败状态', false))
    add('artifacts', '修复版与对比版', outputs.length === 2 ? artifactRatio : 0, 10, artifactFailure || reason('COMPARISON_MISSING', '缺少修复版或前后对比版', true))
    add('formats', '视频文件结构', outputs.length === 2 ? formatRatio : 0, 10, formatFailure || reason('INVALID_FORMAT', '画面修复成果格式无效', true))
    add('duration', '时长保持', durationOk ? 1 : 0, 10, reason('DURATION_MISMATCH', '画面修复成果时长与原片不一致', true))
    add('stabilization', '防抖运动证明', stabilizationOk ? 1 : 0, 10, reason(stabilizationOk ? 'VISUAL_REPAIR_PROOF_MISSING' : 'STABILIZATION_NOT_IMPROVED', '防抖后运动幅度没有可验证改善', true))
    add('rotation', '旋转与尺寸', rotationOk ? 1 : 0, 10, reason('DIMENSION_MISMATCH', '旋转角度或成果尺寸与冻结决策不一致', true))
    add('color', '曝光与偏色改善', colorOk ? 1 : 0, 10, reason('COLOR_REPAIR_NOT_IMPROVED', '曝光/偏色统计没有改善', true))
    add('comparison', '处理前后对比', comparisonOk ? 1 : 0, 5, reason('COMPARISON_MISSING', '前后对比视频缺失或无效', true))
    add('review-only', '低质量片段仅提示', reviewOnlyOk ? 1 : 0, 5, reason('VISUAL_REPAIR_PROOF_MISSING', '低质量片段提示与冻结方案不一致', true))
    add('project-capsule', '可撤销项目', hasProjectCapsule ? 1 : 0, 5, reason('PROJECT_CAPSULE_MISSING', '画面修复成果没有进入可撤销项目', true))
    add('unified-visual-qc', '统一视觉导出质量门', visualQcOk ? 1 : 0, 15, reason('UNIFIED_VISUAL_QC_FAILED', '修复版/对比版没有通过分辨率、比例、黑边、黑帧、编码与完整解码检查', true))
  } else if (taskType === 'media.smart-reframe') {
    const expected = spec.decision?.reframe?.outputs || []
    const versions = Array.isArray(result.versions) ? result.versions : []
    const versionsMatch = expected.length === 3 && versions.length === 3 && expected.every((item, index) => item.aspect === versions[index]?.aspect && Number(item.width) === Number(versions[index]?.dimensions?.width) && Number(item.height) === Number(versions[index]?.dimensions?.height))
    const tolerance = Math.max(0.1, Number(spec.decision?.verification?.toleranceSeconds) || 0.35)
    const duration = Number(spec.decision?.reframe?.durationSeconds)
    const durationsMatch = duration > 0 && versions.length === 3 && versions.every((item) => Math.abs(Number(item.durationSeconds) - duration) <= tolerance)
    const tracking = result.trackingReceipt
    const evidenceOk = tracking?.strategy === 'vision-keyframes-linear-follow-v1' && tracking?.frameCount === 5 && Number(tracking?.minimumConfidence) >= 0.75 && String(tracking?.subject?.description || '') === String(spec.decision?.reframe?.subject?.description || '')
    const coverageOk = Number(tracking?.minimumSubjectCoverage) >= Number(spec.decision?.verification?.minimumSubjectCoverage || 0.75)
    const projectCapsule = result.projectCapsule
    const hasProjectCapsule = projectCapsule?.schemaVersion === 1 && String(projectCapsule.projectId || '').startsWith('edit-') && projectCapsule.canUndo === true && outputs.some((outputPath) => path.resolve(outputPath) === path.resolve(String(projectCapsule.currentPath || '')))
    const visualQcOk = result.visualQc?.strategy === 'unified-visual-export-qc-v1' && result.visualQc?.passed === true && result.visualQc?.artifacts?.length === 3
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '智能构图任务返回失败状态', false))
    add('artifacts', '三个构图成果', outputs.length === 3 ? artifactRatio : 0, 15, artifactFailure || reason('REFRAME_OUTPUT_MISMATCH', '智能构图没有交付三个成果', true))
    add('formats', '视频文件结构', outputs.length === 3 ? formatRatio : 0, 10, formatFailure || reason('INVALID_FORMAT', '智能构图成果格式无效', true))
    add('aspects', '三比例尺寸', versionsMatch ? 1 : 0, 15, reason('REFRAME_OUTPUT_MISMATCH', '16:9、9:16或1:1成果尺寸与冻结决策不一致', true))
    add('duration', '三版时长一致', durationsMatch ? 1 : 0, 10, reason('DURATION_MISMATCH', '智能构图成果时长与原片不一致', true))
    add('tracking', '冻结主体轨迹', evidenceOk ? 1 : 0, 10, reason('TRACKING_EVIDENCE_MISSING', '主体关键帧、置信度或目标对象与冻结决策不一致', true))
    add('coverage', '主体画幅覆盖', coverageOk ? 1 : 0, 10, reason('SUBJECT_COVERAGE_LOW', '主体在至少一个目标画幅中覆盖不足', true))
    add('project-capsule', '可撤销项目', hasProjectCapsule ? 1 : 0, 5, reason('PROJECT_CAPSULE_MISSING', '智能构图首个成果没有进入可撤销项目', true))
    add('unified-visual-qc', '统一视觉导出质量门', visualQcOk ? 1 : 0, 15, reason('UNIFIED_VISUAL_QC_FAILED', '三比例成果没有通过分辨率、比例、黑边、黑帧、编码与完整解码检查', true))
  } else if (taskType === 'media.edit-visual-effects') {
    const receipt = result.effectReceipt
    const expectedKinds = spec.decision?.verification?.expectedEffectKinds || []
    const kindsMatch = Array.isArray(receipt?.effectKinds) && expectedKinds.length > 0 && JSON.stringify(receipt.effectKinds) === JSON.stringify(expectedKinds)
    const durationOk = Number(result.durationSeconds) > 0 && Number(result.expectedDurationSeconds) > 0 && Math.abs(Number(result.durationSeconds) - Number(result.expectedDurationSeconds)) <= Math.max(0.1, Number(spec.decision?.verification?.toleranceSeconds) || 0.35)
    const dimensionsOk = receipt?.dimensionMatch === true && Number(receipt?.outputDimensions?.width) > 0 && Number(receipt?.outputDimensions?.height) > 0
    const changed = receipt?.changed === true && Number(receipt?.representativeSample?.meanAbsDiff) > 0.2
    const projectCapsule = result.projectCapsule
    const hasProjectCapsule = projectCapsule?.schemaVersion === 1 && String(projectCapsule.projectId || '').startsWith('edit-') && projectCapsule.canUndo === true && outputs.some((outputPath) => path.resolve(outputPath) === path.resolve(String(projectCapsule.currentPath || '')))
    const visualQcOk = result.visualQc?.strategy === 'unified-visual-export-qc-v1' && result.visualQc?.passed === true && result.visualQc?.artifacts?.length === 1
    const isBrandPackage = spec.decision?.brandPackage?.strategy === 'ass-brand-package-v1'
    if (isBrandPackage) {
      const proof = result.brandPackageProof
      const proofOk = proof?.schemaVersion === 1 && proof?.method === 'brand-package-pixel-proof-v1' && proof?.verdict === 'matched' && proof?.templateId === spec.decision.brandPackage.template?.id
      const expectedElements = new Set(spec.decision.verification?.expectedBrandElements || [])
      const titleOk = !expectedElements.has('title') || (proofOk && proof.elements?.title?.visible === true)
      const expectedChapterCount = Number(spec.decision.brandPackage.chapters?.length || 0)
      const chaptersOk = !expectedElements.has('chapters') || (proofOk && expectedChapterCount > 0 && Number(proof.elements?.chapters?.count) === expectedChapterCount && Number(proof.elements?.chapters?.visibleCount) === expectedChapterCount)
      const personOk = !expectedElements.has('person') || (proofOk && proof.elements?.person?.visible === true)
      const cornerOk = !expectedElements.has('corner') || (proofOk && proof.elements?.corner?.visible === true)
      const outroOk = !expectedElements.has('outro') || (proofOk && proof.elements?.outro?.visible === true)
      add('declared-success', '执行状态', success ? 1 : 0, 5, reason('RESULT_FAILED', '品牌包装任务返回失败状态', false))
      add('artifact', '品牌包装成片', artifactRatio, 10, artifactFailure)
      add('brand-contract', '冻结品牌模板', kindsMatch && proofOk ? 1 : 0, 10, reason('EFFECT_RECEIPT_MISMATCH', '品牌模板或效果回执与冻结决策不一致', true))
      add('duration', '成片时长', durationOk ? 1 : 0, 10, reason('DURATION_MISMATCH', '品牌包装成片时长与原片不一致', true))
      add('dimensions', '原画幅分辨率', dimensionsOk ? 1 : 0, 10, reason('DIMENSION_MISMATCH', '品牌包装改变了原片分辨率', true))
      add('brand-title', '标题像素', titleOk ? 1 : 0, 8, reason('BRAND_TITLE_MISSING', '最终成片没有形成标题像素证据', true))
      add('brand-chapters', '章节条像素', chaptersOk ? 1 : 0, 8, reason('BRAND_CHAPTERS_MISSING', '最终成片章节条数量或像素证据不完整', true))
      add('brand-person', '人物条像素', personOk ? 1 : 0, 8, reason('BRAND_PERSON_MISSING', '最终成片没有形成人物条像素证据', true))
      add('brand-corner', '角标像素', cornerOk ? 1 : 0, 8, reason('BRAND_CORNER_MISSING', '最终成片没有形成角标像素证据', true))
      add('brand-outro', '片尾像素', outroOk ? 1 : 0, 8, reason('BRAND_OUTRO_MISSING', '最终成片没有形成片尾像素证据', true))
      add('project-capsule', '可撤销项目', hasProjectCapsule ? 1 : 0, 5, reason('PROJECT_CAPSULE_MISSING', '品牌包装成果没有进入可撤销项目', true))
      add('unified-visual-qc', '统一视觉导出质量门', visualQcOk ? 1 : 0, 10, reason('UNIFIED_VISUAL_QC_FAILED', '品牌包装成果没有通过编码、分辨率、黑边、黑帧与完整解码检查', true))
    } else {
      add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '视觉效果任务返回失败状态', false))
      add('artifact', '成片文件', artifactRatio, 15, artifactFailure)
      add('effects', '冻结效果清单', kindsMatch ? 1 : 0, 15, reason('EFFECT_RECEIPT_MISMATCH', '成片回执与冻结视觉效果清单不一致', true))
      add('duration', '成片时长', durationOk ? 1 : 0, 15, reason('DURATION_MISMATCH', '视觉效果成片时长不符合冻结决策', true))
      add('dimensions', '分辨率与裁切', dimensionsOk ? 1 : 0, 10, reason('DIMENSION_MISMATCH', '视觉效果成果分辨率与冻结决策不一致', true))
      add('pixel-change', '代表帧变化', changed ? 1 : 0, 10, reason('EFFECT_CHANGE_MISSING', '代表帧没有检测到视觉效果变化', true))
      add('project-capsule', '可撤销项目', hasProjectCapsule ? 1 : 0, 10, reason('PROJECT_CAPSULE_MISSING', '视觉效果成果没有进入可撤销项目', true))
      add('unified-visual-qc', '统一视觉导出质量门', visualQcOk ? 1 : 0, 15, reason('UNIFIED_VISUAL_QC_FAILED', '视觉效果成果没有通过分辨率、比例、黑边、黑帧、编码与完整解码检查', true))
    }
  } else if (taskType === 'media.edit-audio-mix') {
    const unifiedAudioQc = audioExportQcStatus(result)
    const expectedDuration = Number(result.expectedDurationSeconds || 0)
    const actualDuration = Number(result.durationSeconds || 0)
    const tolerance = Math.max(0.05, Number(spec.decision?.verification?.toleranceSeconds) || 0.2)
    const durationOk = expectedDuration > 0 && actualDuration > 0 && Math.abs(actualDuration - expectedDuration) <= tolerance
    const expectedTracks = Array.isArray(spec.decision?.audioMix?.tracks) ? spec.decision.audioMix.tracks : []
    const timelineReceipt = Array.isArray(result.timelineReceipt) ? result.timelineReceipt : []
    const timelineOk = timelineReceipt.length === expectedTracks.length + 1 && timelineReceipt.every((item) => String(item?.sourceRange || '').length > 0 && String(item?.outputRange || '').length > 0)
    const proof = result.audioMixProof
    const proofSchemaOk = proof?.schemaVersion === 1 && proof?.method === 'decoded-multitrack-pcm-v1'
    const tracksAligned = proofSchemaOk && proof.verdict === 'matched' && Array.isArray(proof.tracks) && proof.tracks.length === expectedTracks.length && proof.tracks.every((item, index) => item.id === expectedTracks[index].id && item.role === expectedTracks[index].role && item.aligned === true)
    const outputOk = proofSchemaOk && proof.output?.nonSilent === true && proof.output?.overloadFree === true && Number.isFinite(Number(proof.output?.samplePeakDbfs))
    const automationExpected = Number(spec.decision?.audioMix?.dialogue?.automation?.length || 0) + expectedTracks.reduce((sum, track) => sum + Number(track.automation?.length || 0), 0)
    const automationOk = proofSchemaOk && Number(proof.automation?.requested) === automationExpected && Number(proof.automation?.configured) === automationExpected
    const duckExpected = proof?.dialogue?.configured ? expectedTracks.filter((track) => track.duckAgainstDialogue === true && spec.decision?.audioMix?.dialogue?.enabled === true).length : 0
    const duckOk = proofSchemaOk && Number(proof.ducking?.configuredTracks) === duckExpected
    const loudnessRequired = spec.decision?.audioMix?.master?.loudness?.enabled === true
    const loudnessProof = result.loudnessProof
    const loudnessOk = !loudnessRequired || (loudnessProof?.schemaVersion === 1 && loudnessProof?.method === 'ebur128-post-encode-v1' && loudnessProof?.verdict === 'matched' && Number.isFinite(Number(loudnessProof.integratedLufs)) && Number.isFinite(Number(loudnessProof.truePeakDbtp)))
    const projectCapsule = result.projectCapsule
    const projectOk = projectCapsule?.schemaVersion === 1 && String(projectCapsule.projectId || '').startsWith('edit-') && String(projectCapsule.versionId || '').startsWith('version-') && projectCapsule.canUndo === true && outputs.some((outputPath) => path.resolve(outputPath) === path.resolve(String(projectCapsule.currentPath || '')))
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '多轨音频任务返回失败状态', false))
    add('artifact', '多轨成片', artifactRatio, 10, artifactFailure)
    add('format', '视频格式', formatRatio && artifacts.every((item) => VIDEO_EXTENSIONS.has(item.ext)) ? 1 : 0, 10, formatFailure || reason('INVALID_FORMAT', '多轨成果不是受支持的视频格式', true))
    add('duration', '成片时长', durationOk ? 1 : 0, 15, reason('DURATION_MISMATCH', '多轨成片时长与源片不一致', true))
    add('timeline', '轨道时间线', timelineOk ? 1 : 0, 10, reason('TIMELINE_RECEIPT_MISSING', '多轨时间线回执与冻结轨道数量不一致', true))
    add('track-proof', '轨道声音与对齐证明', tracksAligned && outputOk ? 1 : 0, 10, !proofSchemaOk ? reason('MULTITRACK_PROOF_MISSING', '缺少最终成片的多轨PCM证明', true) : !tracksAligned ? reason('TRACK_ALIGNMENT_MISMATCH', '至少一条音乐、环境声或音效没有通过目标时间对齐', true) : reason('AUDIO_OVERLOAD', '多轨成片静音或样本峰值不安全', true), proofSchemaOk ? `${proof.tracks.filter((item) => item.aligned).length}/${expectedTracks.length} 轨对齐` : '')
    add('automation-ducking', '分段音量与对白闪避', automationOk && duckOk ? 1 : 0, 10, !automationOk ? reason('TRACK_AUTOMATION_MISSING', '分段音量自动化回执不完整', true) : reason('DUCKING_RECEIPT_MISSING', '对白闪避回执与冻结轨道不一致', true))
    add('loudness', '编码后响度', loudnessOk ? 1 : 0, 5, !loudnessProof ? reason('LOUDNESS_PROOF_MISSING', '缺少编码后响度回执', true) : reason('LOUDNESS_MISMATCH', '多轨总线编码后响度未达标', true))
    add('project', '可撤销项目', projectOk ? 1 : 0, 10, reason('PROJECT_CAPSULE_MISSING', '多轨成果没有进入可撤销编辑项目', true))
    add('unified-audio-qc', '统一声音导出质量门', unifiedAudioQc.matched ? 1 : 0, 10, reason('UNIFIED_AUDIO_QC_FAILED', '多轨成果没有同时通过削波、响度、声画同步、异常静音和版权来源检查', true), unifiedAudioQc.detail)
  } else if (taskType === 'media.rhythm-edit') {
    const unifiedAudioQc = audioExportQcStatus(result)
    const rhythm = spec.decision?.rhythm || {}
    const receipt = result.rhythmReceipt
    const proof = result.beatProof
    const expectedDuration = Number(rhythm.outputDurationSeconds || 0)
    const actualDuration = Number(result.durationSeconds || 0)
    const tolerance = Math.max(0.05, Number(spec.decision?.verification?.toleranceSeconds) || 0.2)
    const durationOk = expectedDuration >= 6 && actualDuration > 0 && Math.abs(expectedDuration - actualDuration) <= tolerance
    const receiptOk = receipt?.schemaVersion === 1 && receipt?.strategy === 'beat-synced-jump-cut-v1' && receipt.pace === rhythm.pace && Number(receipt.bpm) === Number(rhythm.bpm) && Number(receipt.supportRatio) >= 0.45 && Array.isArray(receipt.cutTimes) && receipt.cutTimes.length === rhythm.cutTimes?.length
    const proofOk = proof?.schemaVersion === 1 && proof?.method === 'decoded-beat-cut-proof-v1'
    const visibleOk = proofOk && Number(proof.visibleCutRatio) >= Number(spec.decision?.verification?.minimumVisibleCutRatio || 0.5)
    const highlightOk = proofOk && proof.highlight?.denserThanOutside === true && Number(proof.highlight?.densityRatio) <= 0.8
    const musicOk = proofOk && Number(proof.musicCorrelation) >= 0.02
    const tailOk = proofOk && proof.tail?.audioFaded === true && proof.tail?.videoFaded === true
    const project = result.projectCapsule
    const projectOk = project?.schemaVersion === 1 && String(project.projectId || '').startsWith('edit-') && project.canUndo === true && outputs.some((item) => path.resolve(item) === path.resolve(String(project.currentPath || '')))
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '节拍剪辑任务返回失败状态', false))
    add('artifact', '节拍成片', artifactRatio && artifacts.every((item) => VIDEO_EXTENSIONS.has(item.ext)) ? 1 : 0, 5, artifactFailure || reason('INVALID_FORMAT', '节拍成果不是受支持的视频格式', true))
    add('duration', '冻结时间线', durationOk ? 1 : 0, 5, reason('DURATION_MISMATCH', '节拍成片时长与冻结时间线不一致', true))
    add('beat-evidence', '真实节拍网格', receiptOk ? 1 : 0, 10, reason('BEAT_EVIDENCE_MISSING', '缺少解码PCM节拍、BPM或网格支持率回执', true))
    add('visible-cuts', '切点画面变化', visibleOk ? 1 : 0, 15, reason('BEAT_CUT_NOT_VISIBLE', '真实节拍切点没有形成足够可见的镜头变化', true))
    add('highlight-density', '高潮切镜密度', highlightOk ? 1 : 0, 15, reason('HIGHLIGHT_DENSITY_MISMATCH', '音乐高潮区切镜没有比普通段更密', true))
    add('music-alignment', '成片音乐对齐', musicOk ? 1 : 0, 10, reason('MUSIC_ALIGNMENT_MISSING', '成片高潮区没有检测到冻结音乐的PCM相关证据', true))
    add('natural-tail', '片尾自然收束', tailOk ? 1 : 0, 10, reason('TAIL_FADE_MISSING', '片尾画面或声音没有在冻结强拍处完成淡出', true))
    add('project', '可撤销项目', projectOk ? 1 : 0, 10, reason('PROJECT_CAPSULE_MISSING', '节拍剪辑成果没有进入可撤销项目', true))
    add('unified-audio-qc', '统一声音导出质量门', unifiedAudioQc.matched ? 1 : 0, 10, reason('UNIFIED_AUDIO_QC_FAILED', '节拍剪辑成果没有同时通过削波、响度、声画同步、异常静音和版权来源检查', true), unifiedAudioQc.detail)
  } else if (taskType === 'media.audio-repair') {
    const unifiedAudioQc = audioExportQcStatus(result)
    const repair = spec.decision?.audioRepair || {}
    const expectedOutputs = repair.separation?.enabled ? 3 : 1
    const outputCountOk = outputs.length === expectedOutputs && artifactRatio === 1
    const expectedDuration = Number(result.expectedDurationSeconds || 0); const actualDuration = Number(result.durationSeconds || 0)
    const durationOk = expectedDuration > 0 && actualDuration > 0 && Math.abs(expectedDuration - actualDuration) <= Math.max(0.05, Number(spec.decision?.verification?.toleranceSeconds) || 0.2)
    const proof = result.audioRepairProof
    const proofSchemaOk = proof?.schemaVersion === 1 && proof?.method === 'decoded-audio-repair-v1'
    const denoiseOk = !repair.denoise?.enabled || ['improved', 'not-needed'].includes(proof?.denoise?.verdict)
    const dcOk = !repair.dcRemoval?.enabled || ['improved', 'not-needed'].includes(proof?.dcRemoval?.verdict)
    const silenceOk = !repair.silenceRepair?.enabled || (['filled', 'not-needed'].includes(proof?.silenceRepair?.verdict) && proof?.silenceRepair?.restoresSpeech === false)
    const repairProofOk = proofSchemaOk && denoiseOk && dcOk && silenceOk
    const separation = result.separationProof
    const separationOk = !repair.separation?.enabled || (separation?.schemaVersion === 1 && separation?.method === 'stereo-mid-side-v1' && separation?.verdict === 'matched-with-artifact-warning' && separation?.outputs?.length === 2 && separation?.distinct === true)
    const warningOk = !repair.separation?.enabled || (String(separation?.artifactWarning || '').includes('不是AI专业分轨') && separation?.claims?.professionalAiSeparation === false && separation?.claims?.mayContainBleed === true)
    const loudness = result.loudnessProof
    const loudnessOk = !repair.loudness?.enabled || (loudness?.schemaVersion === 1 && loudness?.method === 'ebur128-post-encode-v1' && loudness?.verdict === 'matched')
    const project = result.projectCapsule
    const projectOk = project?.schemaVersion === 1 && String(project.projectId || '').startsWith('edit-') && project.canUndo === true && outputs.some((item) => path.resolve(item) === path.resolve(String(project.currentPath || '')))
    const proofFailure = !proofSchemaOk ? reason('AUDIO_REPAIR_PROOF_MISSING', '缺少修复前后PCM证明', true) : !denoiseOk ? reason('DENOISE_NOT_IMPROVED', '降噪没有取得可测改善', true) : !dcOk ? reason('DC_NOT_IMPROVED', '去直流没有取得可测改善', true) : reason('SILENCE_REPAIR_MISMATCH', '短静音底噪修复不完整或冒充恢复语音', true)
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '音频修复任务返回失败状态', false))
    add('artifacts', '修复版与分离轨', outputCountOk ? 1 : 0, 10, artifactFailure || reason('BUNDLE_INCOMPLETE', `期望 ${expectedOutputs} 个音频修复成果`, true))
    add('duration', '声画时长', durationOk ? 1 : 0, 10, reason('DURATION_MISMATCH', '音频修复成片时长与源片不一致', true))
    add('repair-proof', '降噪/去直流/短静音证明', repairProofOk ? 1 : 0, 10, proofFailure)
    add('silence-honesty', '静音修复边界', silenceOk ? 1 : 0, 10, reason('SILENCE_REPAIR_MISMATCH', '静音修复必须明确只补连续底噪、不恢复丢失语音', true))
    add('separation', '基础人声/伴奏分离', separationOk ? 1 : 0, 15, reason('SEPARATION_PROOF_MISSING', '基础分离缺少两条不同且非静音的立体声成果', true))
    add('separation-warning', '分离伪影提示', warningOk ? 1 : 0, 5, reason('SEPARATION_WARNING_MISSING', '基础分离没有说明串音、变薄和非AI专业分轨边界', true))
    add('loudness', '编码后响度', loudnessOk ? 1 : 0, 10, reason('LOUDNESS_MISMATCH', '音频修复编码后响度未达标', true))
    add('project', '可撤销项目', projectOk ? 1 : 0, 10, reason('PROJECT_CAPSULE_MISSING', '音频修复成果没有进入可撤销项目', true))
    add('unified-audio-qc', '统一声音导出质量门', unifiedAudioQc.matched ? 1 : 0, 10, reason('UNIFIED_AUDIO_QC_FAILED', '音频修复成果没有同时通过削波、响度、声画同步、异常静音和版权来源检查', true), unifiedAudioQc.detail)
  } else if (taskType === 'media.edit-music') {
    const unifiedAudioQc = audioExportQcStatus(result)
    const expectedDuration = Number(result.expectedDurationSeconds || 0)
    const actualDuration = Number(result.durationSeconds || 0)
    const tolerance = Math.max(0.05, Number(spec.decision?.verification?.toleranceSeconds) || 0.2)
    const durationOk = expectedDuration > 0 && actualDuration > 0 && Math.abs(actualDuration - expectedDuration) <= tolerance
    const timelineReceipt = Array.isArray(result.timelineReceipt) ? result.timelineReceipt : []
    const selectionExpected = Boolean(spec.decision?.audio?.selection)
    const hasTimelineReceipt = timelineReceipt.some((item) => (selectionExpected ? String(item?.sourceRange || '').includes('→') : String(item?.sourceRange || '') === '音乐文件全段' || String(item?.sourceRange || '').includes('→')) && String(item?.outputRange || '').includes('→'))
    const audioProof = result.audioProof
    const proofSchemaOk = audioProof?.schemaVersion === 1 && audioProof?.method === 'decoded-pcm-s16le-v1'
    const nonSilent = proofSchemaOk && audioProof.output?.hasAudio === true && audioProof.output?.nonSilent === true
    const changed = proofSchemaOk && audioProof.change?.verdict === 'changed' && Number(audioProof.change?.changedWindows) > 0
    const overloadFree = proofSchemaOk && audioProof.output?.overloadFree === true && Number.isFinite(Number(audioProof.output?.samplePeakDbfs))
    const fadeInRequired = Number(spec.decision?.audio?.fadeInSeconds ?? 1) > 0
    const fadeOutRequired = Number(spec.decision?.audio?.fadeOutSeconds ?? 1.5) > 0
    const fadesOk = proofSchemaOk
      && (!fadeInRequired || audioProof.fades?.fadeIn?.verdict === 'matched')
      && (!fadeOutRequired || audioProof.fades?.fadeOut?.verdict === 'matched')
    const proofOk = proofSchemaOk && audioProof.verdict === 'matched' && nonSilent && changed && overloadFree && fadesOk
    let audioFailure = null
    if (!proofSchemaOk) audioFailure = reason('AUDIO_PROOF_MISSING', '缺少解码后的声音质量证明，不能只凭音轨存在判定配乐成功', true)
    else if (!nonSilent) audioFailure = reason('AUDIO_SILENT', '成片音轨存在但采样结果为静音或近似静音', true)
    else if (!changed) audioFailure = reason('AUDIO_CHANGE_MISSING', '成片声音与原声采样没有可确认的变化，无法证明背景音乐已混入', true)
    else if (!overloadFree) audioFailure = reason('AUDIO_OVERLOAD', '成片声音样本峰值达到或超过安全上限', true)
    else if (!fadesOk) audioFailure = reason('AUDIO_FADE_PROOF_MISSING', '背景音乐淡入淡出窗口没有通过声音采样核对', true)
    const loudnessRequired = spec.decision?.audio?.loudness?.enabled === true
    const loudnessProof = result.loudnessProof
    const loudnessSchemaOk = loudnessProof?.schemaVersion === 1 && loudnessProof?.method === 'ebur128-post-encode-v1'
    const loudnessOk = !loudnessRequired || (loudnessSchemaOk && loudnessProof.verdict === 'matched' && Number.isFinite(Number(loudnessProof.integratedLufs)) && Number.isFinite(Number(loudnessProof.truePeakDbtp)))
    const loudnessFailure = !loudnessRequired
      ? null
      : !loudnessSchemaOk
        ? reason('LOUDNESS_PROOF_MISSING', '缺少 AAC 编码后的 EBU R128 响度与 true peak 回执', true)
        : reason('LOUDNESS_MISMATCH', `编码后响度未达到冻结目标：${loudnessProof.integratedLufs ?? '未知'} LUFS / ${loudnessProof.truePeakDbtp ?? '未知'} dBTP`, true)
    const projectCapsule = result.projectCapsule
    const hasProjectCapsule = projectCapsule?.schemaVersion === 1
      && String(projectCapsule.projectId || '').startsWith('edit-')
      && String(projectCapsule.versionId || '').startsWith('version-')
      && Number(projectCapsule.versionCount) >= 2
      && Number(projectCapsule.cursor) >= 1
      && projectCapsule.canUndo === true
      && outputs.some((outputPath) => path.resolve(outputPath) === path.resolve(String(projectCapsule.currentPath || '')))
    const proofDetail = proofSchemaOk
      ? `样本峰值 ${Number(audioProof.output?.samplePeakDbfs).toFixed(2)} dBFS；${Number(audioProof.change?.changedWindows) || 0}/${Number(audioProof.change?.comparedWindows) || 0} 个窗口确认变化`
      : ''
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '配乐视频', artifactRatio, 10, artifactFailure)
    add('format', '视频格式', formatRatio && artifacts.every((item) => VIDEO_EXTENSIONS.has(item.ext)) ? 1 : 0, 10, formatFailure || reason('INVALID_FORMAT', '配乐成果不是受支持的视频格式', true))
    add('duration-receipt', '成品时长', durationOk ? 1 : 0, 10, reason('DURATION_MISMATCH', `成品时长与源片不一致：期望 ${expectedDuration || 0} 秒，实际 ${actualDuration || 0} 秒`, true))
    add('timeline-receipt', '配乐范围回执', hasTimelineReceipt ? 1 : 0, 10, reason('TIMELINE_RECEIPT_MISSING', '缺少背景音乐覆盖范围回执', true))
    add('audio-proof', '声音质量证明', proofOk ? 1 : 0, 15, audioFailure, proofDetail)
    add('loudness-proof', '编码后响度', loudnessOk ? 1 : 0, 15, loudnessFailure, loudnessSchemaOk ? `${loudnessProof.integratedLufs} LUFS；true peak ${loudnessProof.truePeakDbtp} dBTP` : '')
    add('project-capsule', '可撤销项目', hasProjectCapsule ? 1 : 0, 10, reason('PROJECT_CAPSULE_MISSING', '缺少可撤销的编辑项目版本回执', true))
    add('unified-audio-qc', '统一声音导出质量门', unifiedAudioQc.matched ? 1 : 0, 10, reason('UNIFIED_AUDIO_QC_FAILED', '配乐成果没有同时通过削波、响度、声画同步、异常静音和版权来源检查', true), unifiedAudioQc.detail)
  } else if (taskType === 'media.edit-trim' || taskType === 'media.edit-remove' || taskType === 'media.edit-concat' || taskType === 'media.edit-concat-sources' || taskType === 'media.edit-burn-subtitles' || taskType === 'media.edit-mux-subtitles') {
    const expectedDuration = Number(result.expectedDurationSeconds || spec.decision?.timeline?.durationSeconds || 0)
    const actualDuration = Number(result.durationSeconds || 0)
    const tolerance = Math.max(0.05, Number(spec.decision?.verification?.toleranceSeconds) || 0.2)
    const durationOk = expectedDuration > 0 && actualDuration > 0 && Math.abs(actualDuration - expectedDuration) <= tolerance
    const timelineReceipt = Array.isArray(result.timelineReceipt) ? result.timelineReceipt : []
    const mappedTimelineReceipts = timelineReceipt.filter((item) => String(item?.sourceRange || '').includes('→') && String(item?.outputRange || '').includes('→'))
    const expectedSegmentCount = taskType === 'media.edit-concat' && Array.isArray(spec.decision?.timeline?.segments)
      ? spec.decision.timeline.segments.length
      : taskType === 'media.edit-concat-sources' && Array.isArray(spec.decision?.sources) ? spec.decision.sources.length : 0
    const hasTimelineReceipt = expectedSegmentCount > 0
      ? timelineReceipt.length === expectedSegmentCount && mappedTimelineReceipts.length === expectedSegmentCount
      : mappedTimelineReceipts.length > 0
    const requiresFrameProof = taskType === 'media.edit-trim' || taskType === 'media.edit-remove' || taskType === 'media.edit-concat' || taskType === 'media.edit-concat-sources'
    const frameProof = result.frameProof
    const frameProofVerdict = String(frameProof?.verdict || '')
    const expectedFrameBoundaryCount = taskType === 'media.edit-trim' ? 1 : taskType === 'media.edit-concat' || taskType === 'media.edit-concat-sources' ? expectedSegmentCount : taskType === 'media.edit-remove' ? mappedTimelineReceipts.length : 0
    const frameProofComplete = taskType === 'media.edit-trim'
      ? Boolean(frameProof?.first && frameProof?.last)
      : Array.isArray(frameProof?.boundaries) && frameProof.boundaries.length === expectedFrameBoundaryCount && frameProof.boundaries.every((item) => item?.first && item?.last)
    let frameProofRatio = 1
    let frameProofFailure = null
    if (requiresFrameProof) {
      if (!frameProof) {
        frameProofRatio = 0
        frameProofFailure = reason('FRAME_PROOF_MISSING', '缺少首尾帧边界证明，不能确认剪辑点', true)
      } else if (frameProofVerdict === 'unavailable') {
        frameProofRatio = 0
        frameProofFailure = reason('FRAME_PROOF_UNAVAILABLE', '无法生成首尾帧边界证明，不能确认剪辑点', true)
      } else if (frameProofVerdict === 'mismatch') {
        frameProofRatio = 0
        frameProofFailure = reason('FRAME_BOUNDARY_MISMATCH', '成片首尾帧与决策切割点不符', true)
      } else if (!frameProofComplete) {
        frameProofRatio = 0
        frameProofFailure = reason('FRAME_PROOF_INCOMPLETE', `帧边界证明不完整：期望 ${expectedFrameBoundaryCount} 个片段，实际 ${Array.isArray(frameProof.boundaries) ? frameProof.boundaries.length : 0} 个`, true)
      } else if (frameProofVerdict === 'matched') {
        frameProofRatio = 1
      } else if (frameProofVerdict === 'inconclusive') {
        frameProofRatio = 0.5
        frameProofFailure = reason('FRAME_BOUNDARY_INCONCLUSIVE', '画面内容过于相似，首尾帧证据无法唯一判定；已保留时长与时间线核验结果', false)
      } else {
        frameProofRatio = 0
        frameProofFailure = reason('FRAME_PROOF_UNAVAILABLE', '无法生成首尾帧边界证明，不能确认剪辑点', true)
      }
    }
    const frameProofDetail = requiresFrameProof && frameProof
      ? Array.isArray(frameProof.boundaries) && frameProof.boundaries.length
        ? `${frameProof.boundaries.slice(0, 4).map((item, index) => `片段${index + 1}首差异 ${item.first?.matchDiff ?? '未知'}、余量 ${item.first?.margin ?? '未知'}；末差异 ${item.last?.matchDiff ?? '未知'}、余量 ${item.last?.margin ?? '未知'}`).join('｜')}${frameProof.boundaries.length > 4 ? `｜另${frameProof.boundaries.length - 4}个片段见完整回执` : ''}`
        : `首帧差异 ${frameProof.first?.matchDiff ?? '未知'}、余量 ${frameProof.first?.margin ?? '未知'}；尾帧差异 ${frameProof.last?.matchDiff ?? '未知'}、余量 ${frameProof.last?.margin ?? '未知'}`
      : ''
    const timelineFailure = expectedSegmentCount > 0
      ? reason('SEGMENT_RECEIPT_INCOMPLETE', `拼接时间线回执不完整：期望 ${expectedSegmentCount} 段，实际 ${mappedTimelineReceipts.length} 段`, true)
      : reason('TIMELINE_RECEIPT_MISSING', '缺少可核对的源片段与成品时间线回执', true)
    const projectCapsule = result.projectCapsule
    const hasProjectCapsule = projectCapsule?.schemaVersion === 1
      && String(projectCapsule.projectId || '').startsWith('edit-')
      && String(projectCapsule.versionId || '').startsWith('version-')
      && Number(projectCapsule.versionCount) >= 2
      && Number(projectCapsule.cursor) >= 1
      && projectCapsule.canUndo === true
      && outputs.some((outputPath) => path.resolve(outputPath) === path.resolve(String(projectCapsule.currentPath || '')))
    const professionalRequired = taskType === 'media.edit-burn-subtitles' && spec.decision?.subtitle?.professional?.enabled === true
    const parityRequired = taskType === 'media.edit-burn-subtitles' && spec.decision?.verification?.requirePreviewBurnParity === true
    const parityProof = result.subtitlePreviewBurnProof
    const parityCues = Array.isArray(parityProof?.cues) ? parityProof.cues : []
    const parityOutput = outputs[0] ? path.resolve(outputs[0]) : ''
    const parityOk = !parityRequired || (
      parityProof?.schemaVersion === 1
      && parityProof?.method === 'single-render-subtitle-preview-burn-v1'
      && parityProof?.verdict === 'matched'
      && parityProof?.sameArtifact === true
      && Number(parityProof?.cueCount) > 0
      && parityCues.length === Number(parityProof.cueCount)
      && parityCues.every((item) => item?.matched === true && /^[a-f0-9]{64}$/i.test(String(item?.previewCueSha256 || '')) && item.previewCueSha256 === item.finalCueSha256)
      && path.resolve(String(parityProof?.preview?.path || '')) === parityOutput
      && path.resolve(String(parityProof?.final?.path || '')) === parityOutput
      && /^[a-f0-9]{64}$/i.test(String(parityProof?.preview?.artifactSha256 || ''))
      && parityProof.preview.artifactSha256 === parityProof.final.artifactSha256
      && /^[a-f0-9]{64}$/i.test(String(parityProof?.cueLedgerSha256 || ''))
    )
    const professionalPlan = result.professionalSubtitle
    const professionalProof = result.professionalSubtitleProof
    const speakerOk = professionalProof?.schemaVersion === 1 && professionalProof?.method === 'professional-subtitle-render-proof-v1' && professionalProof?.verdict === 'matched' && professionalProof.speakerEvidence?.method === 'decoded-pcm-acoustic-cluster-v1' && Number(professionalProof.speakerEvidence?.speakerCount) >= 1 && Number(professionalProof.speakerEvidence?.speakerCount) <= 4 && professionalProof.speakerEvidence?.anonymousLabels === true
    const wordTimingOk = professionalProof?.wordTimingEvidence?.method === 'whisper.cpp-dtw-v1' && professionalProof.wordTimingEvidence?.exactCueAlignment === true && Number(professionalProof.wordTimingEvidence?.wordCount) > 0 && Number(professionalProof.wordTimingEvidence?.minimumConfidence) >= 0.15
    const karaokeOk = professionalProof?.karaokeEvidence?.mode === 'ass-kf' && Number(professionalProof.karaokeEvidence?.tagCount) === Number(professionalProof.wordTimingEvidence?.wordCount) && Number(professionalProof.karaokeEvidence?.matchedWordCount) === Number(professionalProof.wordTimingEvidence?.wordCount)
    const keywordOk = Array.isArray(professionalProof?.keywordEvidence?.terms) && professionalProof.keywordEvidence.terms.length > 0 && Number(professionalProof.keywordEvidence?.emphasisCount) >= 1
    const safeAreaOk = professionalProof?.safeArea?.strategy === 'frame-band-complexity-v1' && professionalProof.safeArea?.subtitleInChosenZone === true && Number(professionalProof.safeArea?.sampledFrames) > 0 && professionalProof.safeArea?.chosenZone === professionalPlan?.safeArea?.chosenZone
    add('declared-success', '执行状态', success ? 1 : 0, parityRequired ? 5 : 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '剪辑视频', artifactRatio, parityRequired ? (professionalRequired ? 5 : 15) : professionalRequired ? 10 : requiresFrameProof ? 20 : 25, artifactFailure)
    add('format', '视频格式', formatRatio && artifacts.every((item) => VIDEO_EXTENSIONS.has(item.ext)) ? 1 : 0, parityRequired ? 5 : professionalRequired ? 5 : 10, formatFailure || reason('INVALID_FORMAT', '剪辑成果不是受支持的视频格式', true))
    add('duration-receipt', '成品时长', durationOk ? 1 : 0, parityRequired ? (professionalRequired ? 5 : 10) : professionalRequired ? 10 : 20, reason('DURATION_MISMATCH', `成品时长与决策不一致：期望 ${expectedDuration || 0} 秒，实际 ${actualDuration || 0} 秒`, true))
    add('timeline-receipt', '时间线回执', hasTimelineReceipt ? 1 : 0, parityRequired ? (professionalRequired ? 5 : 10) : professionalRequired ? 5 : 10, timelineFailure)
    if (requiresFrameProof) add('frame-proof', '帧边界证明', frameProofRatio, 10, frameProofFailure, frameProofDetail)
    add('project-capsule', '可撤销项目', hasProjectCapsule ? 1 : 0, parityRequired ? (professionalRequired ? 5 : 10) : professionalRequired ? 10 : requiresFrameProof ? 20 : 25, reason('PROJECT_CAPSULE_MISSING', '缺少可撤销的编辑项目版本回执', true))
    if (parityRequired) add('subtitle-preview-burn-parity', '字幕预览与最终烧录逐条一致', parityOk ? 1 : 0, professionalRequired ? 20 : 45, reason('SUBTITLE_PREVIEW_BURN_PARITY_FAILED', '预览与最终烧录不是同一冻结成果，或至少一条字幕的文字、时间、换行、样式、位置不一致', true), parityOk ? `${parityProof.cueCount}条字幕；同一成果SHA-256 ${String(parityProof.final.artifactSha256).slice(0, 12)}…` : '')
    if (professionalRequired) {
      add('speaker-evidence', '匿名说话人声纹聚类', speakerOk ? 1 : 0, 10, reason('SPEAKER_EVIDENCE_MISSING', '缺少真实PCM声纹聚类证据，不能猜测说话人', true))
      add('word-timing', '真实逐词时间', wordTimingOk ? 1 : 0, 10, reason('WORD_TIMING_MISSING', '逐词时间未与字幕逐字对齐或不是Whisper DTW证据', true))
      add('karaoke', '逐词高亮与卡拉OK', karaokeOk ? 1 : 0, 10, reason('KARAOKE_PROOF_MISSING', 'ASS卡拉OK标签数量与真实逐词证据不一致', true))
      add('keyword-emphasis', '关键词强调', keywordOk ? 1 : 0, 10, reason('KEYWORD_EMPHASIS_MISSING', '关键词没有绑定到真实逐词时间并产生强调', true))
      add('subtitle-safe-area', '字幕安全区避让', safeAreaOk ? 1 : 0, 10, reason('SUBTITLE_SAFE_AREA_FAILED', '字幕像素没有落在真实画面分析选择的安全区', true))
    }
  } else if (taskType === 'media.subtitle-layout-variants') {
    const proof = result.layoutProof; const expected = spec.decision?.subtitleLayout?.profiles || []; const profiles = Array.isArray(proof?.profiles) ? proof.profiles : []
    const contractOk = proof?.schemaVersion === 1 && proof?.method === 'subtitle-layout-pixel-proof-v1' && proof?.verdict === 'matched' && profiles.length === expected.length && expected.every((item, index) => profiles[index]?.id === item.id && Number(profiles[index]?.width) === Number(item.width) && Number(profiles[index]?.height) === Number(item.height))
    const fontPassed = contractOk && profiles.every((item) => Number(item.fontRatio) >= 0.045 && Number(item.fontRatio) <= 0.06)
    const linesPassed = contractOk && profiles.every((item) => Number(item.maximumObservedLines) >= 1 && Number(item.maximumObservedLines) <= 2)
    const wrappingPassed = contractOk && profiles.every((item) => item.wrappingMatched === true)
    const occlusionPassed = contractOk && profiles.every((item) => item.occlusionSafe === true)
    const positionPassed = contractOk && profiles.every((item) => item.positionMatched === true && Number(item.pixelDifference) >= 0.004)
    const projectCapsule = result.projectCapsule; const hasProjectCapsule = projectCapsule?.schemaVersion === 1 && String(projectCapsule.projectId || '').startsWith('edit-') && projectCapsule.canUndo === true && outputs.includes(String(projectCapsule.currentPath || ''))
    add('declared-success', '执行状态', success ? 1 : 0, 5, reason('RESULT_FAILED', '响应式字幕布局任务返回失败', false))
    add('artifacts', '布局成果', outputs.length === expected.length ? artifactRatio : 0, 15, artifactFailure || reason('ARTIFACT_MISSING', '没有交付全部字幕布局文件', true))
    add('formats', 'ASS格式', formatRatio && artifacts.every((item) => item.ext === '.ass') ? 1 : 0, 10, formatFailure || reason('INVALID_FORMAT', '响应式字幕布局不是ASS格式', true))
    add('layout-contract', '画幅与分辨率合同', contractOk ? 1 : 0, 10, reason('SUBTITLE_LAYOUT_WRAPPING_FAILED', '布局成果与冻结画幅/分辨率不一致', true))
    add('layout-font', '字号比例', fontPassed ? 1 : 0, 11, reason('SUBTITLE_LAYOUT_FONT_FAILED', '至少一个布局的字号比例不合格', true))
    add('layout-lines', '两行上限', linesPassed ? 1 : 0, 11, reason('SUBTITLE_LAYOUT_LINES_FAILED', '至少一个布局超过两行或没有字幕行', true))
    add('layout-wrapping', '自然断句', wrappingPassed ? 1 : 0, 11, reason('SUBTITLE_LAYOUT_WRAPPING_FAILED', '至少一个布局断句超出行宽', true))
    add('layout-occlusion', '遮挡避让', occlusionPassed ? 1 : 0, 11, reason('SUBTITLE_LAYOUT_OCCLUSION_FAILED', '至少一个布局没有选择较安全的画面区域', true))
    add('layout-position', '移动位置像素', positionPassed ? 1 : 0, 11, reason('SUBTITLE_LAYOUT_POSITION_FAILED', '至少一个布局的字幕像素没有落在冻结位置', true))
    add('project-capsule', '可撤销项目', hasProjectCapsule ? 1 : 0, 5, reason('PROJECT_CAPSULE_MISSING', '字幕布局成果没有进入可撤销项目', true))
  } else if (taskType === 'media.transform-subtitles') {
    const proof = result.transformProof
    const expectedKinds = spec.decision?.verification?.expectedOperationKinds || []
    const contractOk = proof?.schemaVersion === 1 && proof?.method === 'subtitle-transform-proof-v1' && proof?.verdict === 'matched' && JSON.stringify(proof.operationKinds) === JSON.stringify(expectedKinds)
    const structureOk = contractOk && proof.exactStructure === true && Number(proof.sourceCueCount) > 0 && Number(proof.outputCueCount) > 0 && Number(proof.outputCueCount) === Number(result.outputCueCount)
    const countsOk = Number(proof?.replacementsApplied) === Number(spec.decision?.subtitleTransform?.replacements?.length || 0) && Number(proof?.mergesApplied) === Number(spec.decision?.subtitleTransform?.merges?.length || 0) && Number(proof?.splitsApplied) === Number(spec.decision?.subtitleTransform?.splits?.length || 0)
    const languageExpected = expectedKinds.includes('translate'); const languageOk = !languageExpected || (proof?.translation?.matched === true && ['中文', '英文'].includes(String(proof?.translation?.targetLang || '')))
    const styleExpected = expectedKinds.includes('style'); const styleOk = !styleExpected || (proof?.style?.matched === true && proof?.style?.preset === spec.decision?.subtitleTransform?.style?.preset)
    const projectCapsule = result.projectCapsule
    const hasProjectCapsule = projectCapsule?.schemaVersion === 1 && String(projectCapsule.projectId || '').startsWith('edit-') && projectCapsule.canUndo === true && outputs.some((outputPath) => path.resolve(outputPath) === path.resolve(String(projectCapsule.currentPath || '')))
    const expectedExt = spec.decision?.output?.container === 'ass' ? '.ass' : '.srt'
    add('declared-success', '执行状态', success ? 1 : 0, 5, reason('RESULT_FAILED', '批量字幕任务返回失败状态', false))
    add('artifacts', '字幕成果', artifactRatio, 15, artifactFailure)
    add('format', '字幕格式', formatRatio && artifacts.every((item) => item.ext === expectedExt) ? 1 : 0, 10, formatFailure || reason('INVALID_FORMAT', `批量字幕成果不是${expectedExt}格式`, true))
    add('transform-contract', '冻结操作清单', contractOk ? 1 : 0, 15, reason('SUBTITLE_TRANSFORM_MISMATCH', '执行回执与冻结批量字幕操作不一致', true))
    add('transform-structure', '条目与时间结构', structureOk ? 1 : 0, 20, reason('SUBTITLE_TRANSFORM_MISMATCH', '合并、拆分或调时后的条目结构不一致', true))
    add('transform-counts', '改字/合并/拆分计数', countsOk ? 1 : 0, 10, reason('SUBTITLE_TRANSFORM_MISMATCH', '实际变换次数与冻结合同不一致', true))
    add('transform-language', '目标语言', languageOk ? 1 : 0, 10, reason('SUBTITLE_TRANSFORM_LANGUAGE_MISSING', '批量字幕成果没有形成请求的目标语言', true))
    add('transform-style', '目标样式', styleOk ? 1 : 0, 10, reason('SUBTITLE_TRANSFORM_STYLE_MISSING', '批量字幕成果没有形成冻结样式', true))
    add('project-capsule', '可撤销项目', hasProjectCapsule ? 1 : 0, 5, reason('PROJECT_CAPSULE_MISSING', '批量字幕成果没有进入可撤销项目', true))
  } else if (taskType === 'media.shift-subtitles') {
    const cueCount = Number(result.cueCount)
    const sourceCueCount = Number(result.sourceCueCount)
    const droppedCueCount = Number(result.droppedCueCount || 0)
    const cueReceiptOk = Number.isFinite(cueCount) && cueCount > 0 && Number.isFinite(sourceCueCount) && sourceCueCount - droppedCueCount === cueCount
    const projectCapsule = result.projectCapsule
    const hasProjectCapsule = projectCapsule?.schemaVersion === 1
      && String(projectCapsule.projectId || '').startsWith('edit-')
      && String(projectCapsule.versionId || '').startsWith('version-')
      && Number(projectCapsule.versionCount) >= 2
      && projectCapsule.canUndo === true
      && outputs.some((outputPath) => path.resolve(outputPath) === path.resolve(String(projectCapsule.currentPath || '')))
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '字幕成果', artifactRatio, 25, artifactFailure)
    add('format', '字幕结构', formatRatio && artifacts.every((item) => item.ext === '.srt' || item.ext === '.vtt') ? 1 : 0, 15, formatFailure || reason('INVALID_FORMAT', '调时成果不是有效的 srt/vtt 字幕', true))
    add('cue-receipt', '条目回执', cueReceiptOk ? 1 : 0, 25, reason('CUE_RECEIPT_MISMATCH', `字幕条目回执不一致：源 ${sourceCueCount || 0} 条、丢弃 ${droppedCueCount} 条、成果 ${cueCount || 0} 条`, true))
    add('project-capsule', '可撤销项目', hasProjectCapsule ? 1 : 0, 25, reason('PROJECT_CAPSULE_MISSING', '缺少可撤销的编辑项目版本回执', true))
  } else if (taskType === 'media.translate-subtitles') {
    const cueCount = Number(result.cueCount)
    const sourceCueCount = Number(result.sourceCueCount)
    const cueReceiptOk = Number.isFinite(cueCount) && cueCount > 0 && Number.isFinite(sourceCueCount) && sourceCueCount > 0 && cueCount >= sourceCueCount
    const targetLang = String(result.targetLang || '')
    const projectCapsule = result.projectCapsule
    const hasProjectCapsule = projectCapsule?.schemaVersion === 1
      && String(projectCapsule.projectId || '').startsWith('edit-')
      && String(projectCapsule.versionId || '').startsWith('version-')
      && Number(projectCapsule.versionCount) >= 2
      && projectCapsule.canUndo === true
      && outputs.some((outputPath) => path.resolve(outputPath) === path.resolve(String(projectCapsule.currentPath || '')))
    const artifactText = artifacts.map((item) => item.text || '').join('\n')
    const hasTargetText = targetLang === '英文' ? /[A-Za-z]/.test(artifactText) : /[一-鿿]/.test(artifactText)
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '字幕成果', artifactRatio, 25, artifactFailure)
    add('format', '字幕结构', formatRatio && artifacts.every((item) => item.ext === '.srt') ? 1 : 0, 15, formatFailure || reason('INVALID_FORMAT', '翻译成果不是有效的 srt 字幕', true))
    add('cue-receipt', '条目回执', cueReceiptOk ? 1 : 0, 15, reason('CUE_RECEIPT_MISMATCH', `翻译条目回执不一致：源 ${sourceCueCount || 0} 条、成果 ${cueCount || 0} 条`, true))
    add('target-language', '目标语言', hasTargetText ? 1 : 0, 10, reason('TARGET_LANGUAGE_MISSING', `字幕中没有检测到${targetLang || '目标语言'}文本`, true))
    add('project-capsule', '可撤销项目', hasProjectCapsule ? 1 : 0, 25, reason('PROJECT_CAPSULE_MISSING', '缺少可撤销的编辑项目版本回执', true))
  } else if (taskType === 'media.edit-subtitle-cues') {
    const cueCount = Number(result.cueCount)
    const sourceCueCount = Number(result.sourceCueCount)
    const cueEdit = spec.decision?.cueEdit
    const expectedCueCount = cueEdit?.operation === 'replace'
      ? sourceCueCount
      : sourceCueCount - (Number(cueEdit?.endIndex) - Number(cueEdit?.startIndex) + 1)
    const cueReceiptOk = Number.isFinite(cueCount) && cueCount > 0 && Number.isFinite(expectedCueCount) && cueCount === expectedCueCount
    const projectCapsule = result.projectCapsule
    const hasProjectCapsule = projectCapsule?.schemaVersion === 1
      && String(projectCapsule.projectId || '').startsWith('edit-')
      && String(projectCapsule.versionId || '').startsWith('version-')
      && Number(projectCapsule.versionCount) >= 2
      && projectCapsule.canUndo === true
      && outputs.some((outputPath) => path.resolve(outputPath) === path.resolve(String(projectCapsule.currentPath || '')))
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '字幕成果', artifactRatio, 25, artifactFailure)
    add('format', '字幕结构', formatRatio && artifacts.every((item) => item.ext === '.srt' || item.ext === '.vtt') ? 1 : 0, 15, formatFailure || reason('INVALID_FORMAT', '校对成果不是有效的 srt/vtt 字幕', true))
    add('cue-receipt', '条目回执', cueReceiptOk ? 1 : 0, 25, reason('CUE_RECEIPT_MISMATCH', `校对条目回执不一致：期望 ${expectedCueCount || 0} 条，实际 ${cueCount || 0} 条`, true))
    add('project-capsule', '可撤销项目', hasProjectCapsule ? 1 : 0, 25, reason('PROJECT_CAPSULE_MISSING', '缺少可撤销的编辑项目版本回执', true))
  } else if (taskType === 'creative.asset-bundle') {
    const receipt = result.aiAssetReceipt
    const expectedKinds = spec.decision?.requestedKinds || []
    const artifactEntries = Array.isArray(receipt?.artifacts) ? receipt.artifacts : []
    const kindsOk = expectedKinds.length > 0 && JSON.stringify(receipt?.requestedKinds) === JSON.stringify(expectedKinds) && artifactEntries.length === expectedKinds.length && artifactEntries.every((item, index) => item.kind === expectedKinds[index])
    const provenanceOk = receipt?.schemaVersion === 1 && receipt?.kind === 'agentplay.ai-asset-bundle-receipt' && receipt?.verdict === 'matched' && receipt?.model?.local === false && artifactEntries.every((item) => item.aiGenerated === true && /^[a-f0-9]{64}$/i.test(String(item.sha256 || '')) && String(item.generationMethod || '').length > 0)
    const hashesOk = provenanceOk && artifactEntries.every((item) => { try { return fingerprintArtifact(item.path).sha256 === item.sha256 } catch { return false } })
    const manifestOk = receipt?.manifest?.path && outputs.includes(path.resolve(String(receipt.manifest.path))) && (() => { try { return fingerprintArtifact(receipt.manifest.path).sha256 === receipt.manifest.sha256 } catch { return false } })()
    const approvalOk = receipt?.approvalAction === 'paid' && (spec.approvalContract?.action === 'paid' || spec.approval?.action === 'paid')
    const privacyOk = receipt?.sourceMediaUploaded === false
    const proof = receipt?.mediaProof || {}
    const shotOk = !expectedKinds.includes('shot') || (Number(proof.shot?.durationSeconds) > 0 && Number(proof.shot?.width) >= 640 && Number(proof.shot?.height) >= 360)
    const voiceOk = !expectedKinds.includes('voice') || (Number(proof.voice?.durationSeconds) > 0 && proof.voice?.hasAudio === true && proof.voice?.nonSilent === true && Number(proof.voice?.samplePeakDbfs) > -60)
    const soundOk = !expectedKinds.includes('sound-effect') || (Number(proof.soundEffect?.durationSeconds) > 0 && proof.soundEffect?.hasAudio === true && proof.soundEffect?.nonSilent === true && Number(proof.soundEffect?.samplePeakDbfs) > -60)
    const narration = artifactEntries.find((item) => item.kind === 'narration')
    const narrationOk = !expectedKinds.includes('narration') || (() => { try { return fs.readFileSync(narration.path, 'utf8').trim().length >= 4 } catch { return false } })()
    const recoveryOk = Number(receipt?.recovery?.repeatedCloudCalls) === 0
    add('declared-success', '执行状态', success ? 1 : 0, 5, reason('RESULT_FAILED', 'AI素材任务返回失败状态', false))
    add('artifacts', '四类素材与来源清单', artifactRatio, 15, artifactFailure)
    add('approval', '统一上云/付费审批', approvalOk ? 1 : 0, 10, reason('AI_ASSET_APPROVAL_MISSING', 'AI素材任务没有绑定本次付费/上云审批', false))
    add('kinds', '冻结素材种类', kindsOk ? 1 : 0, 10, reason('AI_ASSET_RECEIPT_MISSING', '交付素材种类与冻结请求不一致', true))
    add('provenance', 'AI生成来源与哈希', provenanceOk && hashesOk && manifestOk ? 1 : 0, 25, reason('AI_ASSET_PROVENANCE_MISMATCH', '至少一项素材缺少AI来源、哈希或来源清单不一致', true))
    add('media-proof', '真实可用素材', shotOk && narrationOk && voiceOk && soundOk ? 1 : 0, 20, reason('AI_ASSET_MEDIA_INVALID', '补镜头、旁白、配音或音效至少一项不可真实使用', true))
    add('privacy', '源媒体不上云', privacyOk ? 1 : 0, 10, reason('AI_ASSET_SOURCE_UPLOAD_VIOLATION', '任务错误上传了源视频或没有留下不上云证明', false))
    add('recovery', '恢复零重复调用', recoveryOk ? 1 : 0, 5, reason('AI_ASSET_RECOVERY_REPEAT', '恢复阶段重复调用了已完成的云端素材步骤', false))
  } else if (taskType === 'creative.recut-short') {
    const blueprint = result.styleBlueprint
    const receipt = result.styleReuseReceipt
    const shots = Array.isArray(result.styleShots) ? result.styleShots : []
    const blueprintOk = blueprint?.schemaVersion === 1 && blueprint?.strategy === 'abstract-style-blueprint-v1' && /^[a-f0-9]{64}$/i.test(String(blueprint?.sourceReportSha256 || '')) && blueprint?.sourceSpecificTextExcluded === true
    const structureOk = receipt?.structureMatched === true && shots.length >= 2 && shots.length === Number(result.clips) && shots.every((shot, index) => Number(shot.duration) === Number(blueprint?.rhythm?.durations?.[index]) && shot.shotSize === blueprint?.shotSizes?.[index] && shot.movement === blueprint?.movements?.[index])
    const copyrightOk = receipt?.rawReportSentToShotModel === false && receipt?.referenceImagesSent === 0 && receipt?.promptSafetyPassed === true && Array.isArray(receipt?.promptSha256) && receipt.promptSha256.length === shots.length && receipt.promptSha256.every((item) => /^[a-f0-9]{64}$/i.test(String(item)))
    const visualQcOk = result.visualQc?.strategy === 'unified-visual-export-qc-v1' && result.visualQc?.passed === true && result.visualQc?.artifacts?.length === 1
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '原创风格重构任务返回失败状态', false))
    add('artifact', '原创重构成片', artifactRatio, 20, artifactFailure)
    add('format', '成片结构', formatRatio, 10, formatFailure)
    add('blueprint', '抽象风格蓝图', blueprintOk ? 1 : 0, 15, reason('STYLE_BLUEPRINT_MISSING', '缺少不含专有表达的抽象风格蓝图', false))
    add('structure', '节奏景别运镜匹配', structureOk ? 1 : 0, 15, reason('STYLE_STRUCTURE_MISMATCH', '生成镜头没有遵循冻结的节奏/景别/运镜结构', false))
    add('copyright', '版权与原创边界', copyrightOk ? 1 : 0, 15, reason('COPYRIGHT_BOUNDARY_FAILED', '拉片正文、参考帧或专有表达可能进入了镜头生成', false))
    add('unified-visual-qc', '统一视觉导出质量门', visualQcOk ? 1 : 0, 15, reason('UNIFIED_VISUAL_QC_FAILED', '原创重构成片没有通过分辨率、比例、黑边、黑帧、编码与完整解码检查', true))
  } else if (taskType === 'media.compress') {
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '视频成果', artifactRatio, 50, artifactFailure)
    add('format', '视频格式', formatRatio && artifacts.every((item) => VIDEO_EXTENSIONS.has(item.ext)) ? 1 : 0, 20, formatFailure || reason('INVALID_FORMAT', '压缩成果不是受支持的视频格式', true))
    add('size-receipt', '大小回执', Number(result.afterBytes || artifacts[0]?.bytes || 0) > 0 ? 1 : 0, 20, reason('SIZE_RECEIPT_MISSING', '缺少压缩后大小回执', true))
  } else if (taskType.startsWith('download.') || taskType.startsWith('creative.')) {
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '成果文件', artifactRatio, 50, artifactFailure)
    add('format', '成果格式', formatRatio, 20, formatFailure)
    add('output-receipt', '成果回执', outputs.length ? 1 : 0, 20, reason('OUTPUT_RECEIPT_MISSING', '缺少成果路径回执', true))
  } else {
    add('declared-success', '执行状态', success ? 1 : 0, 30, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('result', '可验证结果', result.chatOnly || artifactRatio ? 1 : 0, 50, artifactFailure)
    add('summary', '结果说明', String(result.summary || '').trim() ? 1 : 0, 20, reason('SUMMARY_MISSING', '缺少结果说明', true))
  }

  if (spec.editGovernance) {
    const receipt = result.editGovernanceReceipt
    const run = receipt?.run
    const step = Array.isArray(run?.steps) ? run.steps[0] : null
    const governanceOk = receipt?.schemaVersion === 1
      && receipt?.strategy === 'shared-media-edit-governance-receipt-v1'
      && receipt?.verdict === 'matched'
      && receipt?.governanceDigest === spec.editGovernance.digest
      && receipt?.taskType === taskType
      && run?.status === 'completed'
      && Number(run?.budget?.turns) === 1
      && Number(run?.budget?.toolCalls) === 1
      && Number(run?.budget?.toolCalls) <= Number(run?.budget?.maxToolCalls)
      && step?.status === 'completed'
      && step?.evidence?.verified === true
      && (spec.editGovernance.approval?.required !== true || receipt?.approval?.status === 'approved')
    add('edit-governance', '统一编辑路由、审批、预算、账本与恢复', governanceOk ? 1 : 0, 0, !receipt ? reason('EDIT_GOVERNANCE_RECEIPT_MISSING', '缺少统一编辑治理回执', false) : reason('EDIT_GOVERNANCE_BYPASS', '编辑任务绕过了统一路由、审批、预算、运行账本或恢复协议', false))
  }
  const score = checks.reduce((sum, item) => sum + item.score, 0)
  const threshold = 80
  const uniqueReasons = [...new Map(reasons.filter(Boolean).map((item) => [item.code, item])).values()]
  const hardFailure = uniqueReasons.some((item) => HARD_FAILURES.has(item.code))
  const passed = score >= threshold && !hardFailure
  return {
    version: 1,
    profile: taskType === 'analysis.run' ? 'semantic-and-technical' : taskType === 'project.evidence-qa' ? 'semantic-evidence' : 'technical',
    score,
    threshold,
    passed,
    level: passed ? (uniqueReasons.length ? 'warning' : 'pass') : 'fail',
    reasons: uniqueReasons,
    checks,
    artifacts: artifacts.map(({ text, ...item }) => item)
  }
}

function classifyTaskFailure(error) {
  const message = error instanceof Error ? error.message : String(error || '任务执行失败')
  if (/超出.*(?:时长|范围)|结束时间.*(?:超出|大于)|out of (?:bounds|range)/i.test(message)) return { code: 'MEDIA_RANGE_OUT_OF_BOUNDS', message, retryable: false }
  if (/context size|context length|上下文|token.*(?:exceed|limit)|exceed.*token/i.test(message)) return { code: 'MODEL_CONTEXT_EXCEEDED', message: '模型上下文容量不足，请减少内容或切换大上下文模型', retryable: true }
  if (/源.*(?:变化|不存在|移动)|source.*(?:changed|missing)|fingerprint/i.test(message)) return { code: 'SOURCE_CHANGED', message: '源文件已变化或不存在，请重新选择后执行', retryable: false }
  if (/ffmpeg|ffprobe|whisper|组件.*(?:缺少|未安装)|component.*missing/i.test(message)) return { code: 'COMPONENT_MISSING', message: '所需本地组件未安装或不可用，请先完成组件安装', retryable: true }
  if (/授权|approval|credential|api key|凭证/i.test(message)) return { code: 'AUTHORIZATION_REQUIRED', message: '任务需要重新确认授权或配置凭证', retryable: true }
  if (/network|fetch failed|timed? ?out|econn|socket|网络/i.test(message)) return { code: 'NETWORK_FAILURE', message: '网络或远端服务暂时不可用，可稍后重试', retryable: true }
  if (/cancel|取消|abort/i.test(message)) return { code: 'CANCELLED', message: '任务已取消', retryable: true }
  return { code: 'EXECUTION_FAILED', message, retryable: true }
}

module.exports = { evaluateTaskResult, classifyTaskFailure, inspectArtifact, uniqueOutputs, hasVideoSignature }
