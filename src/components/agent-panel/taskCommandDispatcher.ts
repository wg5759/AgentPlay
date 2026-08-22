import type { AgentTask } from '../../stores/agentStore'
import type { WorkspaceTaskRetry } from '../../taskLifecycle'
import type { PendingTaskKind } from './types'

type CurrentRef<T> = { current: T }

type TaskCommandOptions = {
  pendingTaskRef: CurrentRef<PendingTaskKind>
  requestIdRef: CurrentRef<string>
  cancellableTaskId: string
  closeTaskCenter: () => void
  updateTask: (id: string, patch: Partial<AgentTask>) => void
  mutateTask: (patch: Partial<AgentTask>) => void
  addMessage: (role: 'user' | 'agent', text: string) => void
  releaseCancelableRequest: (requestId: string) => void
  runDownloadTask: (url: string, instruction: string, direct?: boolean) => Promise<void>
  runLinkAnalysisTask: (url: string, instruction: string, forceApprove?: boolean) => Promise<void>
  retryStoredAnalysisTask: (retry: WorkspaceTaskRetry) => Promise<void> | undefined
  retryStoredOutcomeTask: (retry: WorkspaceTaskRetry) => Promise<void> | undefined
  retryStoredMediaCreative: (retry: WorkspaceTaskRetry) => boolean
  retryActiveLinkTask: () => Promise<void>
  retryActiveDocumentAnalysis: () => Promise<void>
  retryActiveCrossMaterialQuestion: () => Promise<boolean>
  retryActiveMediaCreative: () => boolean
}

export function createTaskCommandDispatcher(options: TaskCommandOptions) {
  const {
    pendingTaskRef, requestIdRef, cancellableTaskId, closeTaskCenter,
    updateTask, mutateTask, addMessage, releaseCancelableRequest,
    runDownloadTask, runLinkAnalysisTask, retryStoredAnalysisTask, retryStoredOutcomeTask,
    retryStoredMediaCreative, retryActiveLinkTask,
    retryActiveDocumentAnalysis, retryActiveCrossMaterialQuestion, retryActiveMediaCreative
  } = options

  const retryStoredTask = (record: AgentTask) => {
    const retry = record.retry
    if (!retry) return
    closeTaskCenter()
    if (retry.kind === 'download' && retry.url) {
      void runDownloadTask(retry.url, '', retry.direct !== false)
      return
    }
    if (retry.kind === 'link-analysis' && retry.url) {
      void runLinkAnalysisTask(retry.url, retry.instruction || '')
      return
    }
    if (retry.kind === 'analysis' && retry.sourcePath) {
      void retryStoredAnalysisTask(retry)
      return
    }
    if (retry.kind === 'outcome' && retry.sourcePath) {
      void retryStoredOutcomeTask(retry)
      return
    }
    if (retryStoredMediaCreative(retry)) return
    addMessage('agent', retry.kind === 'doc' || retry.kind === 'batch' || retry.kind === 'cross-qa'
      ? '这个任务需要重新授权原文件。请再次添加文件，原任务和结果记录不会丢失。'
      : '这个任务缺少可安全恢复的源数据，请从原素材重新发起。')
  }

  const retryForegroundTask = () => {
    mutateTask({ error: '' })
    switch (pendingTaskRef.current) {
      case 'download':
      case 'link-analysis':
        void retryActiveLinkTask()
        return
      case 'analysis':
      case 'outcome':
      case 'doc':
        void retryActiveDocumentAnalysis()
        return
      case 'cross-qa':
        void retryActiveCrossMaterialQuestion()
        return
      case 'dedup':
      case 'batch':
      case 'compress':
      case 'trim':
      case 'video-gen':
      case 'recut':
        if (!retryActiveMediaCreative()) addMessage('agent', '[错误] 当前任务缺少可安全重试的输入，请从原素材重新发起。')
    }
  }

  const cancelActiveTask = async () => {
    const requestId = requestIdRef.current
    const taskId = cancellableTaskId
    if (!requestId || !taskId) return
    const pending = pendingTaskRef.current
    try {
      let cancelled = false
      switch (pending) {
        case 'download':
        case 'link-analysis':
          cancelled = await window.aiPlayer?.mediaDownload?.cancel(requestId) || false
          break
        case 'analysis':
          cancelled = await window.aiPlayer?.analysis?.cancel(requestId) || false
          break
        case 'outcome':
          cancelled = await window.aiPlayer?.outcomeWorkflow?.cancel(requestId) || false
          break
        case 'dedup':
          cancelled = await window.aiPlayer?.media?.cancel(requestId) || false
          break
        case 'batch':
          cancelled = await window.aiPlayer?.mediaBatch?.cancel(requestId) || false
          break
        case 'compress':
        case 'trim':
          cancelled = await window.aiPlayer?.mediaTools?.cancel(requestId) || false
          break
        case 'video-gen':
        case 'recut':
          cancelled = await window.aiPlayer?.studio?.cancelTask(requestId) || false
          break
        case 'doc':
          cancelled = await window.aiPlayer?.documents?.cancel(requestId) || false
          break
        case 'cross-qa':
          cancelled = await window.aiPlayer?.crossMaterial?.cancel(requestId) || false
          break
      }
      if (!cancelled) throw new Error('后台没有确认取消，任务状态保持不变')
      updateTask(taskId, { phase: 'cancelled', status: '', error: '任务已取消' })
      addMessage('agent', '任务已取消，后台处理已停止。')
      releaseCancelableRequest(requestId)
    } catch (error) {
      addMessage('agent', `[错误] 无法取消任务：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { retryStoredTask, retryForegroundTask, cancelActiveTask }
}
