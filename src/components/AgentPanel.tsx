import { useEffect, useRef, useState } from 'react'
import { useAgentStore, type AgentTask } from '../stores/agentStore'
import { usePlayerStore } from '../stores/playerStore'
import type { LinkChoice } from '../link-choice-policy.mjs'
import UiIcon from './UiIcon'
import TaskCenter from './TaskCenter'
import AgentComposer from './agent-panel/AgentComposer'
import AgentHome from './agent-panel/AgentHome'
import RuntimeSettings from './agent-panel/RuntimeSettings'
import { buildSuggestedActions } from './agent-panel/suggestions'
import type { AgentAttachment, AgentHistoryRecord, DocumentCapabilities, PendingTaskKind } from './agent-panel/types'
import { createIntentRouter } from './agent-panel/intentRouter'
import { createTaskCommandDispatcher } from './agent-panel/taskCommandDispatcher'
import useDocumentAnalysisTasks from './agent-panel/useDocumentAnalysisTasks'
import useLinkMediaTasks from './agent-panel/useLinkMediaTasks'
import useMediaCreativeTasks from './agent-panel/useMediaCreativeTasks'
import useVoiceInput from './agent-panel/useVoiceInput'
import useIncomingFiles from './agent-panel/useIncomingFiles'
import usePersistentTaskRuntime from './agent-panel/usePersistentTaskRuntime'
import useContinueTask from './agent-panel/useContinueTask'
import useCrossMaterialQaTasks from './agent-panel/useCrossMaterialQaTasks'
import { selectDocumentPreviewPath, selectPrimaryPreviewPath } from '../document-preview-routing.mjs'
export default function AgentPanel() {
  const { messages, inputText, setInputText, send, cancel, thinking, listening, toggleListening, setListening, addMessage } =
    useAgentStore()
  const focusNonce = useAgentStore((s) => s.focusNonce)
  const agentMode = useAgentStore((s) => s.agentMode)
  const setAgentMode = useAgentStore((s) => s.setAgentMode)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [focusNonce])
  const [showHistory, setShowHistory] = useState(false)
  const [showTaskCenter, setShowTaskCenter] = useState(false)
  const [linkChoice, setLinkChoice] = useState<LinkChoice | null>(null)
  const [recutOffer, setRecutOffer] = useState<{ reportText: string; mediaName: string } | null>(null)
  const attachments = useAgentStore((s) => s.attachments)
  const setAttachments = useAgentStore((s) => s.setAttachments)
  const [docCaps, setDocCaps] = useState<DocumentCapabilities | null>(null)
  const task = useAgentStore((s) => s.task)
  const setActiveTask = useAgentStore((s) => s.setTask)
  const updateTask = useAgentStore((s) => s.updateTask)
  const startTask = useAgentStore((s) => s.startTask)
  const tasks = useAgentStore((s) => s.tasks)
  const selectTask = useAgentStore((s) => s.selectTask)
  const executionTaskIdRef = useRef('')
  const docRequestIdRef = useRef('')
  usePersistentTaskRuntime(docRequestIdRef)
  const [cancellableTaskId, setCancellableTaskId] = useState('')
  const executionTask = tasks.find((item) => item.id === executionTaskIdRef.current) || task
  const mutateTask = (patch: Partial<AgentTask>) => {
    if (executionTaskIdRef.current) updateTask(executionTaskIdRef.current, patch)
    else setActiveTask(patch)
  }
  const completeExecutionTask = async (patch: Partial<AgentTask> = {}) => {
    const taskId = executionTaskIdRef.current
    const current = useAgentStore.getState().tasks.find((item) => item.id === taskId)
    if (current?.phase === 'cancelled') return
    const outputs = Array.isArray(patch.outputs) ? patch.outputs : current?.outputs || []
    let evidence = patch.evidence || current?.evidence || []
    if (outputs.length > 0 && window.aiPlayer?.system?.verifyPaths) {
      const receipts = await window.aiPlayer.system.verifyPaths(outputs)
      const outputEvidence = outputs.map((output, index) => {
        const receipt = receipts.find((item) => item.path === output)
        return {
          id: `file-${Date.now()}-${index + 1}`,
          kind: 'file' as const,
          label: receipt?.exists ? '成果文件已验证' : '成果文件待验证',
          value: output,
          verified: receipt?.exists === true,
          createdAt: Date.now(),
          ...(typeof receipt?.bytes === 'number' ? { bytes: receipt.bytes } : {})
        }
      })
      evidence = [...evidence, ...outputEvidence].filter((item, index, items) => (
        items.findIndex((candidate) => candidate.kind === item.kind && candidate.value === item.value) === index
      ))
    }
    const latest = useAgentStore.getState().tasks.find((item) => item.id === taskId)
    if (latest?.phase === 'cancelled') return
    const completed = { ...patch, outputs, evidence, phase: 'completed' as const, running: false, status: '', error: '' }
    if (taskId) updateTask(taskId, completed)
    else setActiveTask(completed)
  }
  const failExecutionTask = (error: string, patch: Partial<AgentTask> = {}) => {
    const current = useAgentStore.getState().tasks.find((item) => item.id === executionTaskIdRef.current)
    if (current?.phase === 'cancelled') return
    mutateTask({ ...patch, phase: 'failed', running: false, status: '', outputs: patch.outputs || [], error })
  }
  const executionWasCancelled = () => useAgentStore.getState().tasks
    .some((item) => item.id === executionTaskIdRef.current && item.phase === 'cancelled')
  const docBusy = executionTask.running
  const docStatus = executionTask.status
  const docOutputs = executionTask.outputs
  const setDocBusy = (value: boolean) => mutateTask({ running: value })
  const setDocStatus = (value: string) => mutateTask({ status: value })
  const setDocOutputs = (value: string[]) => mutateTask({ outputs: value })
  const [needsApproval, setNeedsApproval] = useState(false)
  const [cloudApproved, setCloudApproved] = useState(false)
  const [outputFormat, setOutputFormat] = useState('auto')
  const docBusyRef = useRef(false)
  const runDocTaskRef = useRef<(forceApprove?: boolean) => Promise<void>>(async () => {})
  const runAnalysisTaskRef = useRef<(forceApprove?: boolean) => Promise<void>>(async () => {})
  const runDownloadTaskRef = useRef<(url: string, instruction: string, direct?: boolean) => Promise<void>>(async () => {})
  const runLinkAnalysisTaskRef = useRef<(url: string, instruction: string, forceApprove?: boolean) => Promise<void>>(async () => {})
  const routeTextSendRef = useRef<(textOverride?: string) => Promise<void>>(async () => {})
  const pendingTaskRef = useRef<PendingTaskKind>('doc')
  const bindCancelableRequest = (requestId: string) => {
    docRequestIdRef.current = requestId
    setCancellableTaskId(executionTaskIdRef.current)
  }
  const releaseCancelableRequest = (requestId: string) => {
    if (docRequestIdRef.current !== requestId) return
    docRequestIdRef.current = ''
    setCancellableTaskId('')
  }
  const [showServiceEdit, setShowServiceEdit] = useState(false)

  // 新消息与流式更新自动滚到最底（否则第三四条回复发出后视野还停在第二条）
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  useEffect(() => {
    const handler = () => {
      setShowServiceEdit(true)
    }
    window.addEventListener('ai-player-open-backstage', handler)
    return () => window.removeEventListener('ai-player-open-backstage', handler)
  }, [])

  useEffect(() => {
    const off = window.aiPlayer?.mediaDownload?.onStatus((event) => {
      if (event.requestId === docRequestIdRef.current) setDocStatus(event.status)
    })
    return off
  }, [])

  useEffect(() => {
    // 冷启动竞态修复：Explorer 动词带来的附件先落在 store，面板一挂载就消费
    const pending = useAgentStore.getState().pendingDocs
    if (pending?.length) {
      setAttachments((current) => [...current, ...pending])
      const previewPath = selectDocumentPreviewPath(pending)
      if (previewPath) window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: previewPath }))
      useAgentStore.getState().setPendingDocs(null)
      void window.aiPlayer?.documents?.capabilities().then((caps) => { if (caps) setDocCaps((current) => current || caps) })
    }
    const handler = (event: Event) => {
      const docs = (event as CustomEvent<AgentAttachment[]>).detail
      if (!Array.isArray(docs) || docs.length === 0) return
      useAgentStore.getState().openPanel()
      setAttachments((current) => [...current, ...docs])
      const previewPath = selectDocumentPreviewPath(docs)
      if (previewPath) window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: previewPath }))
      void window.aiPlayer?.documents?.capabilities().then((caps) => { if (caps) setDocCaps((current) => current || caps) })
    }
    window.addEventListener('ai-player-attach-docs', handler)
    return () => window.removeEventListener('ai-player-attach-docs', handler)
  }, [])

  // 在线媒体库/外部入口发来的拉片请求：与对话窗粘贴链接完全同一条链路
  useEffect(() => {
    const handler = (event: Event) => {
      const url = (event as CustomEvent<{ url: string }>).detail?.url
      if (!url) return
      useAgentStore.getState().openPanel()
      void runLinkAnalysisTaskRef.current(url, '')
    }
    window.addEventListener('ai-player-link-analysis', handler)
    return () => window.removeEventListener('ai-player-link-analysis', handler)
  }, [])

  const { handleDropFiles, handlePasteFiles } = useIncomingFiles({
    addMessage,
    appendAttachments: (files) => setAttachments((current) => [...current, ...files]),
    documentCapabilities: docCaps,
    setDocumentCapabilities: setDocCaps
  })

  useEffect(() => {
    const openTaskCenter = () => setShowTaskCenter(true)
    window.addEventListener('agentplay-open-task-center', openTaskCenter)
    return () => window.removeEventListener('agentplay-open-task-center', openTaskCenter)
  }, [])
  const [history, setHistory] = useState<AgentHistoryRecord[]>([])
  useEffect(() => {
    if (messages.length === 0 && attachments.length === 0) {
      void window.aiPlayer?.documents?.history?.().then((items) => { if (items) setHistory(items) })
    }
  }, [messages.length, attachments.length])

  // 按附件类型给出推荐动作：点一下 = 自动填指令并直接执行，不用组织语言
  const suggestedActions = buildSuggestedActions(attachments)

  const runSuggested = (text: string) => {
    setInputText(text)
    window.setTimeout(() => void runDocTaskRef.current(), 0)
  }

  // 屏幕指路：截图发给视觉模型，在屏幕上画出操作标注，步骤同时回到对话里
  const runGuide = async () => {
    const question = inputText.trim()
    if (question) setInputText('')
    addMessage('user', question ? `🎯 屏幕指路：${question}` : '🎯 屏幕指路')
    addMessage('agent', '正在截取屏幕并分析，稍等几秒…')
    const result = await window.aiPlayer?.guide?.annotate(question)
    if (!result) {
      addMessage('agent', '[错误] 指路功能在当前环境不可用')
      return
    }
    if (!result.success) {
      addMessage('agent', `[错误] ${result.error}`)
      return
    }
    const lines = (result.steps || []).map((step, index) => `${index + 1}. ${step.text}`).join('\n')
    addMessage('agent', `${result.annotated ? '已在屏幕上画出标注（15 秒后自动消失）：' : '操作步骤：'}\n${lines}`)
  }

  const openAny = async () => {
    const result = await window.aiPlayer?.chat?.openAny?.()
    if (!result) return
    const previewPath = selectPrimaryPreviewPath(result.media, result.documents)
    if (previewPath) window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: previewPath }))
    if (result.documents?.length) {
      setAttachments((current) => [...current, ...result.documents])
      if (!docCaps) {
        const caps = await window.aiPlayer?.documents?.capabilities()
        if (caps) setDocCaps(caps)
      }
    }
  }

  const {
    runDocumentTask: runDocTask,
    resumeLocalDocumentTask,
    runAnalysisTask,
    runOutcomeWorkflow,
    setAnalysisFormat,
    resumePendingTask: resumeDocumentAnalysis,
    retryActiveTask: retryActiveDocumentAnalysis,
    retryStoredAnalysisTask,
    retryStoredOutcomeTask
  } = useDocumentAnalysisTasks({
    busyRef: docBusyRef,
    requestIdRef: docRequestIdRef,
    executionTaskIdRef,
    pendingTaskRef,
    startTask,
    mutateTask,
    setTaskBusy: setDocBusy,
    setTaskStatus: setDocStatus,
    setTaskOutputs: setDocOutputs,
    bindCancelableRequest,
    releaseCancelableRequest,
    completeExecutionTask,
    failExecutionTask,
    executionWasCancelled,
    addMessage,
    inputText,
    setInputText,
    attachments,
    clearAttachments: () => setAttachments([]),
    documentCapabilities: docCaps,
    setDocumentCapabilities: setDocCaps,
    outputFormat,
    cloudApproved,
    requestCloudApproval: () => setNeedsApproval(true),
    clearCloudApproval: () => { setNeedsApproval(false); setCloudApproved(false) },
    offerRecut: setRecutOffer
  })
  runDocTaskRef.current = runDocTask
  runAnalysisTaskRef.current = runAnalysisTask

  const { runCrossMaterialQuestion, resumeCrossMaterialQuestion, retryActiveCrossMaterialQuestion } = useCrossMaterialQaTasks({
    busyRef: docBusyRef, requestIdRef: docRequestIdRef, executionTaskIdRef, pendingTaskRef, startTask, mutateTask,
    setTaskBusy: setDocBusy, setTaskStatus: setDocStatus, bindCancelableRequest, releaseCancelableRequest,
    completeExecutionTask, failExecutionTask, executionWasCancelled, addMessage, setInputText, attachments,
    cloudApproved, requestCloudApproval: () => setNeedsApproval(true), clearCloudApproval: () => { setNeedsApproval(false); setCloudApproved(false) }
  })

  const {
    isVideoGenerationIntent,
    runRecutShort,
    runVideoGenTask,
    runBatchTask,
    runEditHistoryTask,
    runTrimTask,
    runCompressTask,
    runDedupTask,
    retryActiveTask: retryActiveMediaCreative,
    retryStoredTask: retryStoredMediaCreative
  } = useMediaCreativeTasks({
    busyRef: docBusyRef,
    requestIdRef: docRequestIdRef,
    executionTaskIdRef,
    pendingTaskRef,
    startTask,
    setTaskBusy: setDocBusy,
    setTaskStatus: setDocStatus,
    setTaskOutputs: setDocOutputs,
    bindCancelableRequest,
    releaseCancelableRequest,
    completeExecutionTask,
    failExecutionTask,
    executionWasCancelled,
    addMessage,
    setInputText,
    attachments,
    clearRecutOffer: () => setRecutOffer(null)
  })

  const routeTextSend = createIntentRouter({
    inputText, attachments, agentMode, addMessage, setInputText, setLinkChoice,
    isVideoGenerationIntent, runBatchTask, runCrossMaterialQuestion, runVideoGenTask, runEditHistoryTask, runTrimTask,
    runCompressTask, runDedupTask, runDocumentTask: runDocTask, runOutcomeWorkflow, setAnalysisFormat,
    runAnalysisTask, send
  })
  routeTextSendRef.current = routeTextSend

  const {
    runDownloadTask,
    runLinkAnalysisTask,
    importSiteCookies,
    loginSite,
    resumeLinkAnalysis,
    retryActiveLinkTask
  } = useLinkMediaTasks({
    busyRef: docBusyRef,
    executionTaskIdRef,
    pendingTaskRef,
    startTask,
    mutateTask,
    setTaskBusy: setDocBusy,
    setTaskStatus: setDocStatus,
    setTaskOutputs: setDocOutputs,
    bindCancelableRequest,
    releaseCancelableRequest,
    completeExecutionTask,
    failExecutionTask,
    executionWasCancelled,
    addMessage,
    setInputText,
    cloudApproved,
    requestCloudApproval: () => setNeedsApproval(true),
    offerRecut: setRecutOffer
  })
  runDownloadTaskRef.current = runDownloadTask
  runLinkAnalysisTaskRef.current = runLinkAnalysisTask

  const { retryStoredTask, retryForegroundTask, cancelActiveTask } = createTaskCommandDispatcher({
    pendingTaskRef, requestIdRef: docRequestIdRef, cancellableTaskId,
    closeTaskCenter: () => setShowTaskCenter(false), updateTask, mutateTask,
    addMessage, releaseCancelableRequest, runDownloadTask, runLinkAnalysisTask,
    retryStoredAnalysisTask, retryStoredOutcomeTask, retryStoredMediaCreative, retryActiveLinkTask,
    retryActiveDocumentAnalysis, retryActiveCrossMaterialQuestion, retryActiveMediaCreative
  })

  const continueFromTask = useContinueTask({ selectTask, closeTaskCenter: () => setShowTaskCenter(false), setAttachments, setInputText, inputRef })

  const handleSend = () => {
    void routeTextSend()
  }

  useVoiceInput({
    listening,
    setListening,
    setInputText,
    setStatus: setDocStatus,
    addMessage,
    routeTextRef: routeTextSendRef
  })

  const mediaName = usePlayerStore((state) => state.mediaName)
  const hasForegroundTask = Boolean(executionTaskIdRef.current && (docBusy || docOutputs.length > 0 || executionTask.error))
  const isQuietHome = messages.length === 0 && attachments.length === 0 && !linkChoice && !hasForegroundTask

  return (
    <div className={'agent-panel' + (isQuietHome ? ' agent-panel-home' : '') + (mediaName ? ' agent-panel-focus' : '')}>
      <div
        className="flex-1 min-h-0 flex flex-col"
        onDrop={(e) => void handleDropFiles(e)}
        onPaste={(event) => void handlePasteFiles(event)}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
      >
        {mediaName && (
          <div className="agent-contextbar">
            <div className="agent-context-copy"><span>围绕当前内容继续</span><strong>{mediaName}</strong></div>
            <button type="button" onClick={() => setShowServiceEdit((value) => !value)} className="agent-quiet-button" title="运行与隐私">
              <UiIcon name="shield" size={16} /><span>运行与隐私</span>
            </button>
          </div>
        )}

        <RuntimeSettings
          open={showServiceEdit}
          onClose={() => setShowServiceEdit(false)}
          onGuide={() => void runGuide()}
          addMessage={addMessage}
          agentMode={agentMode}
          onAgentModeChange={setAgentMode}
        />
        {showTaskCenter && (
          <TaskCenter onClose={() => setShowTaskCenter(false)} onRetry={retryStoredTask} onContinue={(selectedTask) => void continueFromTask(selectedTask)} onCancel={() => void cancelActiveTask()} cancellableTaskId={cancellableTaskId} />
        )}
        {attachments.length > 0 && (
          <div className="px-4 py-2 border-b border-white/10 flex flex-wrap items-center gap-2">
            {attachments.map((file) => (
              <span key={file.token} data-agent-attachment={file.name} className="flex items-center gap-2 rounded-lg border border-blue-400/20 bg-blue-500/10 px-2 py-1 text-xs text-blue-200">
                <span className="font-semibold uppercase">{file.ext.slice(1)}</span>
                <span className="max-w-40 truncate">{file.name}</span>
                <button onClick={() => setAttachments((current) => current.filter((item) => item.token !== file.token))} className="text-blue-300 hover:text-white">✕</button>
              </span>
            ))}
            <select value={outputFormat} onChange={(event) => setOutputFormat(event.target.value)} className="ml-auto rounded border border-white/10 bg-player-surface px-2 py-1 text-xs text-gray-300 outline-none">
              <option value="auto">输出：自动判断</option>
              <option value="docx">Word (.docx)</option>
              <option value="xlsx">Excel (.xlsx)</option>
              <option value="pptx">PPT (.pptx)</option>
              <option value="pdf">PDF</option>
              <option value="md">Markdown</option>
              <option value="txt">纯文本</option>
            </select>
          </div>
        )}
        {recutOffer && (
          <div className="px-4 py-2 border-b border-white/10 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-gray-500">拉片完成，下一步：</span>
            <button
              onClick={() => void runRecutShort(recutOffer)}
              className="rounded-full border border-violet-400/40 bg-violet-500/10 px-3 py-1 text-xs text-violet-300 hover:bg-violet-500/20"
            >生成重构短片（3 个 AI 镜头拼接）</button>
            <button onClick={() => setRecutOffer(null)} className="px-2 py-1 text-xs text-gray-500 hover:text-white">✕</button>
          </div>
        )}
        {linkChoice && (
          <div className="mx-4 my-2 rounded-2xl border border-player-accent/40 bg-player-accent/10 p-4">
            <p className="mb-3 text-center text-sm font-medium text-gray-100">这个链接想怎么处理？</p>
            <div className="flex gap-3">
              <button
                onClick={() => { const choice = linkChoice; setLinkChoice(null); void runDownloadTaskRef.current(choice.url, '', choice.direct) }}
                className="flex-1 rounded-xl bg-player-accent px-4 py-3 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                <UiIcon name="open" size={17} /> 仅下载
                <span className="mt-0.5 block text-[11px] font-normal opacity-75">存到本地，不做分析</span>
              </button>
              {linkChoice.canAnalyze ? (
                <button
                  onClick={() => { const choice = linkChoice; setLinkChoice(null); void runLinkAnalysisTaskRef.current(choice.url, '') }}
                  className="flex-1 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white transition-opacity hover:opacity-90"
                >
                  <UiIcon name="analysis" size={17} /> 下载并拉片
                  <span className="mt-0.5 block text-[11px] font-normal opacity-75">下载后自动出深度报告</span>
                </button>
              ) : null}
            </div>
            <button onClick={() => setLinkChoice(null)} className="mt-2 block w-full text-center text-[11px] text-gray-500 hover:text-gray-300">先不处理</button>
          </div>
        )}
        {suggestedActions.length > 0 && (
          <div className="px-4 py-2 border-b border-white/10 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-gray-500">建议下一步：</span>
            {suggestedActions.map((action) => (
              <button key={action.label} disabled={docBusy} onClick={() => runSuggested(action.text)} className="rounded-full border border-player-accent/40 bg-player-accent/10 px-3 py-1 text-xs text-player-accent hover:bg-player-accent/20 disabled:opacity-40">
                {action.label}
              </button>
            ))}
          </div>
        )}
        {needsApproval && (
          <div className="flex items-center gap-2 border-b border-amber-400/20 bg-amber-400/[0.06] px-4 py-2 text-xs text-amber-100">
            <label className="flex flex-1 cursor-pointer items-center gap-2">
              <input type="checkbox" checked={cloudApproved} onChange={(event) => setCloudApproved(event.target.checked)} />
              {pendingTaskRef.current === 'cross-qa' && executionTask.status ? executionTask.status : '允许把本次任务内容发送给云端大上下文模型；不勾选则保留附件并可继续使用本地分段处理'}
            </label>
            {pendingTaskRef.current === 'doc' && <button disabled={docBusy} onClick={() => { setNeedsApproval(false); setCloudApproved(false); void resumeLocalDocumentTask() }} className="rounded bg-white/10 px-3 py-1 text-white disabled:opacity-40">本地分段</button>}
            <button disabled={!cloudApproved || docBusy} onClick={() => { setNeedsApproval(false); if (pendingTaskRef.current === 'link-analysis') void resumeLinkAnalysis(); else if (pendingTaskRef.current === 'cross-qa') void resumeCrossMaterialQuestion(); else void resumeDocumentAnalysis() }} className="rounded bg-amber-600 px-3 py-1 text-white disabled:opacity-40">允许云端并继续</button>
          </div>
        )}


        {/* 消息列表 */}
        <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {messages.length === 0 && attachments.length === 0 && (
            <AgentHome
              history={history}
              expanded={showHistory}
              onToggleHistory={() => setShowHistory((value) => !value)}
              onSelectExample={(text, format) => {
                setInputText(text)
                setOutputFormat(format)
                inputRef.current?.focus()
              }}
            />
          )}
          {messages.length === 0 && attachments.length > 0 && (
            <p className="text-gray-500 text-sm text-center mt-8">附件已就绪，说对它们要做什么…</p>
          )}
          {hasForegroundTask && (
            <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/[0.07] p-3 select-text">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-emerald-100">{executionTask.label || '任务'}</span>
                {docBusy && <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-400" />}
              </div>
              {docBusy && (() => {
                const progress = /（(\d+)\/(\d+)）/.exec(docStatus || '')
                const percent = progress ? Math.round((Number(progress[1]) / Number(progress[2])) * 100) : null
                return (
                  <>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/40">
                      <div className={`h-full bg-blue-500 transition-all ${percent === null ? 'animate-pulse' : ''}`} style={{ width: `${percent ?? 30}%` }} />
                    </div>
                    <p className="mt-1 text-xs text-slate-300">{docStatus || '正在处理…'}</p>
                  </>
                )
              })()}
              {executionTask.error && (
                <div className="mt-1 flex items-center justify-between gap-2">
                  <p className="min-w-0 text-xs text-red-300">{executionTask.error}</p>
                  <div className="flex shrink-0 items-center gap-2">
                    {/cookies|登录态/i.test(executionTask.error) && (
                      <><button onClick={() => void loginSite()} className="rounded bg-emerald-500/20 px-3 py-1 text-xs text-emerald-100 hover:bg-emerald-500/30">扫码登录</button><button onClick={() => void importSiteCookies()} className="rounded bg-orange-500/20 px-3 py-1 text-xs text-orange-100 hover:bg-orange-500/30">导入 Cookies</button></>
                    )}
                    <button onClick={retryForegroundTask} className="rounded bg-white/10 px-3 py-1 text-xs text-white hover:bg-white/20">重试</button>
                  </div>
                </div>
              )}
              {docOutputs.length > 0 && <div className="mt-1 space-y-1">{docOutputs.map((output) => (
                <div key={output} className="flex items-center gap-1">
                  <button onClick={() => void window.aiPlayer?.system?.openPath(output)} className="min-w-0 flex-1 truncate rounded bg-black/20 px-2 py-1.5 text-left text-xs text-emerald-200 hover:bg-black/30" title={output}>打开结果：{output}</button>
                  <button onClick={() => void window.aiPlayer?.system?.showInFolder(output)} title="在文件夹中定位（方便转发/拖走）" className="shrink-0 rounded bg-white/10 px-2 py-1.5 text-xs hover:bg-white/20">📂</button>
                </div>
              ))}</div>}
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div
                data-chat-message={m.role}
                className={m.role === 'user'
                  ? 'max-w-[85%] select-text cursor-text rounded-2xl rounded-br-md bg-player-accent/20 border border-player-accent/25 px-3.5 py-2 text-sm text-white whitespace-pre-wrap break-words'
                  : 'max-w-[85%] select-text cursor-text rounded-2xl rounded-bl-md bg-white/[0.04] border border-white/5 px-3.5 py-2 text-sm text-gray-300 whitespace-pre-wrap break-words'}
              >
                {thinking && i === messages.length - 1 && m.role === 'agent' ? (
                  <span className="flex items-center gap-2.5">
                    <span className="ai-wave" aria-hidden="true"><i /><i /><i /><i /><i /></span>
                    <span>{m.text}</span>
                  </span>
                ) : m.text}
              </div>
            </div>
          ))}
        </div>
        <AgentComposer
          inputRef={inputRef}
          inputText={inputText}
          onInputChange={setInputText}
          onSend={handleSend}
          onOpenAny={() => void openAny()}
          onToggleSettings={() => setShowServiceEdit((value) => !value)}
          onToggleTaskCenter={() => setShowTaskCenter((value) => !value)}
          onToggleListening={toggleListening}
          onStopThinking={cancel}
          onCancelTask={() => void cancelActiveTask()}
          listening={listening}
          thinking={thinking}
          busy={docBusy}
          cancellable={Boolean(cancellableTaskId)}
          attachmentCount={attachments.length}
          mediaName={mediaName}
          taskCount={tasks.length}
          quietHome={isQuietHome}
        />
      </div>
    </div>
  )
}
