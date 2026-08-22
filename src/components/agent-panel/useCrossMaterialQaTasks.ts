import { useEffect, useRef } from 'react'
import type { AgentTask } from '../../stores/agentStore'
import { usePlayerStore } from '../../stores/playerStore'
import type { WorkspaceTaskInput } from '../../taskLifecycle'
import type { AgentAttachment, PendingTaskKind } from './types'

type CurrentRef<T> = { current: T }

type CrossMaterialQaOptions = {
  busyRef: CurrentRef<boolean>
  requestIdRef: CurrentRef<string>
  executionTaskIdRef: CurrentRef<string>
  pendingTaskRef: CurrentRef<PendingTaskKind>
  startTask: (input: WorkspaceTaskInput) => string
  mutateTask: (patch: Partial<AgentTask>) => void
  setTaskBusy: (value: boolean) => void
  setTaskStatus: (value: string) => void
  bindCancelableRequest: (requestId: string) => void
  releaseCancelableRequest: (requestId: string) => void
  completeExecutionTask: (patch?: Partial<AgentTask>) => void
  failExecutionTask: (error: string, patch?: Partial<AgentTask>) => void
  executionWasCancelled: () => boolean
  addMessage: (role: 'user' | 'agent', text: string) => void
  setInputText: (value: string) => void
  attachments: AgentAttachment[]
  cloudApproved: boolean
  requestCloudApproval: () => void
  clearCloudApproval: () => void
}

export default function useCrossMaterialQaTasks(options: CrossMaterialQaOptions) {
  const {
    busyRef, requestIdRef, executionTaskIdRef, pendingTaskRef, startTask, mutateTask,
    setTaskBusy, setTaskStatus, bindCancelableRequest, releaseCancelableRequest,
    completeExecutionTask, failExecutionTask, executionWasCancelled, addMessage,
    setInputText, attachments, cloudApproved, requestCloudApproval, clearCloudApproval
  } = options
  const questionRef = useRef('')
  const approvalRequestIdRef = useRef('')

  useEffect(() => window.aiPlayer?.crossMaterial?.onStatus((event) => {
    if (event.requestId === requestIdRef.current) setTaskStatus(event.status)
  }), [])

  const runCrossMaterialQuestion = async (questionInput: string, forceApprove = false): Promise<boolean> => {
    const api = window.aiPlayer?.crossMaterial
    const question = forceApprove ? questionRef.current : String(questionInput || '').trim()
    if (!api || !question || busyRef.current) return false
    const currentPath = (() => {
      const value = usePlayerStore.getState().videoSrc
      return value && !/^(https?|blob):/i.test(value) ? value : ''
    })()
    const tokens = attachments.map((file) => file.token)
    const detected = await api.detect({ tokens, currentPath, question })
    if (!detected.matched) return false
    busyRef.current = true
    questionRef.current = question
    if (!forceApprove) {
      addMessage('user', `${question}\n（核对 ${detected.sourceCount} 个来源）`)
      setInputText('')
    }
    pendingTaskRef.current = 'cross-qa'
    if (forceApprove && executionTaskIdRef.current) mutateTask({ phase: 'queued', error: '' })
    else executionTaskIdRef.current = startTask({ kind: 'analysis', label: '跨素材证据问答', instruction: question, source: `${detected.sourceCount} 个来源`, retry: { kind: 'cross-qa', instruction: question } })
    setTaskBusy(true)
    setTaskStatus('正在冻结来源和问题')
    let requestId = ''
    let waitingApproval = false
    try {
      requestId = forceApprove && approvalRequestIdRef.current
        ? approvalRequestIdRef.current
        : `cross-material-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      bindCancelableRequest(requestId)
      const result = await api.ask({ tokens, currentPath, question, cloudApproved: cloudApproved || forceApprove, requestId, workspaceTaskId: executionTaskIdRef.current })
      if (result.requiresApproval) {
        waitingApproval = true
        approvalRequestIdRef.current = requestId
        mutateTask({ phase: 'waiting', status: result.approval?.summary || '等待允许云端核对' })
        requestCloudApproval()
        return true
      }
      if (!result.success) throw new Error(result.error || '跨素材问答失败')
      approvalRequestIdRef.current = ''
      const sourceEvidence: AgentTask['evidence'] = (result.evidence || []).slice(0, 20).map((item, index) => ({
        id: `cross-source-${Date.now()}-${index + 1}`,
        kind: 'receipt' as const,
        label: item.locatorLabel || '来源定位',
        value: item.excerpt,
        verified: item.kind === 'agentplay.evidence-reference',
        createdAt: Date.now()
      }))
      if (result.projectCapsule) sourceEvidence.push({ id: `cross-project-${Date.now()}`, kind: 'state' as const, label: '项目证据问答已记录', value: `${result.projectCapsule.name} · 当前版本 ${result.projectCapsule.revision}`, verified: true, createdAt: Date.now() })
      addMessage('agent', result.summary || '跨素材核对完成')
      completeExecutionTask({ summary: result.summary || '跨素材核对完成', evidence: sourceEvidence, quality: result.quality || null })
      clearCloudApproval()
      return true
    } catch (error) {
      if (executionWasCancelled()) return true
      const message = error instanceof Error ? error.message : String(error)
      failExecutionTask(message)
      addMessage('agent', `[错误] ${message}`)
      return true
    } finally {
      if (requestId && !waitingApproval) {
        releaseCancelableRequest(requestId)
        if (approvalRequestIdRef.current === requestId) approvalRequestIdRef.current = ''
      }
      busyRef.current = false
      setTaskBusy(false)
      if (!waitingApproval) setTaskStatus('')
    }
  }

  useEffect(() => {
    const handler = (event: Event) => {
      const question = String((event as CustomEvent<{ question?: string }>).detail?.question || '')
      if (question) void runCrossMaterialQuestion(question)
    }
    window.addEventListener('ai-player-agent-cross-material', handler)
    return () => window.removeEventListener('ai-player-agent-cross-material', handler)
  }, [attachments, cloudApproved])

  return {
    runCrossMaterialQuestion,
    resumeCrossMaterialQuestion: () => runCrossMaterialQuestion(questionRef.current, true),
    retryActiveCrossMaterialQuestion: () => runCrossMaterialQuestion(questionRef.current, false)
  }
}
