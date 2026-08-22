function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

class OutcomeWorkflowRunner {
  constructor({ outputsStillExist } = {}) {
    if (typeof outputsStillExist !== 'function') throw new Error('成果工作流需要成果存在性校验器')
    this.outputsStillExist = outputsStillExist
  }

  async run({ workflow, sourceReceipt, checkpoint = {}, status = () => {}, saveCheckpoint = () => {}, runAnalysis, runPackage } = {}) {
    if (!workflow || typeof runAnalysis !== 'function' || typeof runPackage !== 'function') throw new Error('成果工作流执行器不完整')
    let state = clone(checkpoint || {})
    const persist = (patch) => {
      state = { ...state, ...clone(patch) }
      saveCheckpoint(clone(state))
      return state
    }
    if (state.stage === 'workflow-complete' && state.result && this.outputsStillExist(state.result)) return state.result

    let analysisResult = state.analysisResult
    if (!analysisResult || !this.outputsStillExist(analysisResult)) {
      status('（1/2）正在获取字幕、画面与内容证据')
      analysisResult = await runAnalysis({
        resumeCheckpoint: state.analysisCheckpoint,
        onCheckpoint: (patch) => persist({ stage: 'analysis-running', analysisCheckpoint: { ...(state.analysisCheckpoint || {}), ...clone(patch) } })
      })
      persist({ stage: 'analysis-complete', analysisResult })
    }

    status('（2/2）正在把同一证据底稿编排成最终成果')
    const packageResult = await runPackage({
      analysisResult,
      resumeCheckpoint: state.documentCheckpoint,
      onCheckpoint: (patch) => persist({ stage: 'package-running', documentCheckpoint: { ...(state.documentCheckpoint || {}), ...clone(patch) } })
    })
    const result = {
      success: true,
      outputs: packageResult.outputs || [],
      summary: `已完成视频内容成果包：${workflow.deliverables.formats.map((item) => item.toUpperCase()).join('、')}`,
      historyId: packageResult.historyId,
      deliveryReceipt: packageResult.deliveryReceipt,
      workflowReceipt: {
        schemaVersion: 1,
        kind: 'agentplay.outcome-workflow-receipt',
        source: clone(sourceReceipt),
        steps: [
          { id: 'evidence-analysis', state: 'completed', outputs: analysisResult.outputs || [], historyId: analysisResult.historyId || '' },
          { id: 'consistent-package', state: 'completed', outputs: packageResult.outputs || [], historyId: packageResult.historyId || '' }
        ]
      }
    }
    persist({ stage: 'workflow-complete', analysisResult, result })
    return result
  }
}

module.exports = { OutcomeWorkflowRunner }
