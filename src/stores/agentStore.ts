import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { usePlayerStore } from './playerStore'
import { createWorkspaceTask, patchWorkspaceTask, progressFromStatus, recordWorkspaceTaskProgress, restoreWorkspaceTasks, retainWorkspaceTasks } from '../taskLifecycle'
import type { WorkspaceTask, WorkspaceTaskInput, WorkspaceTaskPhase } from '../taskLifecycle'
import { normalizeAgentMode } from '../../electron/agent-runtime-policy.mjs'
import type { AgentMode } from '../../electron/agent-runtime-policy.mjs'
import { applyAgentToolResult, type AgentToolReceipt } from '../agentToolExecutor'
import { dedupeAttachments } from '../attachment-policy.mjs'

export interface AgentMessage {
  id?: string
  role: 'user' | 'agent'
  text: string
}

export type AgentDocumentAttachment = {
  token: string
  name: string
  ext: string
  size: number
  previewPath?: string
}

// 可持久化任务账本：当前卡片只是被选中的任务，全部任务保留在 tasks 中。
export type AgentTask = WorkspaceTask

const EMPTY_TASK: AgentTask = {
  id: '', kind: 'doc', label: '', phase: 'waiting', running: false, status: '', progress: null,
  outputs: [], summary: '', error: '', instruction: '', source: '', retry: null,
  steps: [], evidence: [], budget: null,
  quality: null, repairHistory: [], failure: null,
  createdAt: 0, updatedAt: 0, completedAt: null
}
interface AgentState {
  open: boolean
  // 每次 openPanel 自增：中栏常驻布局下用它触发输入框聚焦
  focusNonce: number
  listening: boolean
  inputText: string
  messages: AgentMessage[]
  thinking: boolean
  activeRequestId: string | null
  pendingDocs: Array<{ token: string; name: string; ext: string; size: number; previewPath?: string }> | null
  attachments: AgentDocumentAttachment[]
  setAttachments: (
    next: AgentDocumentAttachment[] | ((current: AgentDocumentAttachment[]) => AgentDocumentAttachment[])
  ) => void
  agentMode: AgentMode
  task: AgentTask
  tasks: AgentTask[]
  activeTaskId: string | null
  startTask: (input: WorkspaceTaskInput) => string
  updateTask: (id: string, patch: Partial<AgentTask>) => void
  setTask: (patch: Partial<AgentTask>) => void
  finishTask: (patch?: Partial<AgentTask>) => void
  failTask: (error: string) => void
  cancelTask: () => void
  selectTask: (id: string) => void
  retryTask: (id: string) => AgentTask | null
  clearFinishedTasks: () => void
  resetTask: () => void
  setPendingDocs: (docs: AgentState['pendingDocs']) => void
  setAgentMode: (mode: AgentMode) => void
  openPanel: () => void
  closePanel: () => void
  toggleListening: () => void
  setListening: (v: boolean) => void
  setInputText: (t: string) => void
  addMessage: (role: 'user' | 'agent', text: string) => void
  send: (contextNote?: string, options?: { mode?: AgentMode; text?: string; documentTokens?: string[] }) => Promise<void>
  cancel: () => void
}

export const useAgentStore = create<AgentState>()(
  persist(
    (set, get) => ({
  open: false,
  focusNonce: 0,
  listening: false,
  inputText: '',
  messages: [],
  thinking: false,
  activeRequestId: null,
  attachments: [],
  agentMode: 'work',
  task: EMPTY_TASK,
  tasks: [],
  activeTaskId: null,
  pendingDocs: null,
  setAttachments: (next) => set((state) => ({
    attachments: dedupeAttachments(typeof next === 'function' ? next(state.attachments) : next)
  })),
  startTask: (input) => {
    const next = createWorkspaceTask({ ...input, phase: input.phase || 'queued' })
    set((state) => ({
      task: next,
      activeTaskId: next.id,
      tasks: retainWorkspaceTasks([next, ...state.tasks.filter((item) => item.id !== next.id)])
    }))
    return next.id
  },
  updateTask: (id, patch) => set((state) => {
    const current = state.tasks.find((item) => item.id === id)
    if (!current) return state
    let phase: WorkspaceTaskPhase = patch.phase || current.phase
    if (!patch.phase && patch.running === true) phase = 'running'
    if (!patch.phase && patch.running === false && current.phase === 'running') {
      const outputs = patch.outputs || current.outputs
      const error = patch.error || current.error
      phase = error ? 'failed' : outputs.length > 0 ? 'completed' : 'waiting'
    }
    const normalized: Partial<AgentTask> = { ...patch, phase }
    if (typeof patch.status === 'string') normalized.progress = progressFromStatus(patch.status)
    let next = patchWorkspaceTask(current, normalized)
    if (typeof patch.status === 'string') next = recordWorkspaceTaskProgress(next, patch.status)
    return {
      tasks: state.tasks.map((item) => item.id === id ? next : item),
      ...(state.activeTaskId === id ? { task: next } : {})
    }
  }),  setTask: (patch) => set((state) => {
    const current = state.task
    if (!current.id) return { task: { ...current, ...patch } }
    let phase: WorkspaceTaskPhase = patch.phase || current.phase
    if (!patch.phase && patch.running === true) phase = 'running'
    if (!patch.phase && patch.running === false && current.phase === 'running') {
      const outputs = patch.outputs || current.outputs
      const error = patch.error || current.error
      phase = error ? 'failed' : outputs.length > 0 ? 'completed' : 'waiting'
    }
    const normalized: Partial<AgentTask> = { ...patch, phase }
    if (typeof patch.status === 'string') normalized.progress = progressFromStatus(patch.status)
    let next = patchWorkspaceTask(current, normalized)
    if (typeof patch.status === 'string') next = recordWorkspaceTaskProgress(next, patch.status)
    return { task: next, tasks: state.tasks.map((item) => item.id === next.id ? next : item) }
  }),
  finishTask: (patch = {}) => set((state) => {
    if (!state.task.id) return state
    const next = patchWorkspaceTask(state.task, { ...patch, phase: 'completed', status: '', error: '' })
    return { task: next, tasks: state.tasks.map((item) => item.id === next.id ? next : item) }
  }),
  failTask: (error) => set((state) => {
    if (!state.task.id) return state
    const next = patchWorkspaceTask(state.task, { phase: 'failed', status: '', error })
    return { task: next, tasks: state.tasks.map((item) => item.id === next.id ? next : item) }
  }),
  cancelTask: () => set((state) => {
    if (!state.task.id) return state
    const next = patchWorkspaceTask(state.task, { phase: 'cancelled', status: '', error: '任务已取消' })
    return { task: next, tasks: state.tasks.map((item) => item.id === next.id ? next : item) }
  }),
  selectTask: (id) => set((state) => {
    const task = state.tasks.find((item) => item.id === id)
    return task ? { task, activeTaskId: id } : state
  }),
  retryTask: (id) => {
    const found = get().tasks.find((item) => item.id === id)
    if (!found) return null
    const next = patchWorkspaceTask(found, { phase: 'queued', running: false, status: '', progress: null, outputs: [], summary: '', error: '', quality: null, repairHistory: [], failure: null })
    set((state) => ({ task: next, activeTaskId: id, tasks: state.tasks.map((item) => item.id === id ? next : item) }))
    return next
  },
  clearFinishedTasks: () => set((state) => {
    const tasks = state.tasks.filter((item) => !['completed', 'failed', 'cancelled'].includes(item.phase))
    const active = tasks.find((item) => item.id === state.activeTaskId) || tasks[0] || EMPTY_TASK
    return { tasks, activeTaskId: active.id || null, task: active }
  }),
  resetTask: () => set({ task: EMPTY_TASK, activeTaskId: null }),
  setPendingDocs: (docs) => set({ pendingDocs: docs }),
  setAgentMode: (mode) => set({ agentMode: normalizeAgentMode(mode) }),
  openPanel: () => set((s) => ({ open: true, focusNonce: s.focusNonce + 1 })),
  closePanel: () => set({ open: false }),
  toggleListening: () => set((s) => ({ listening: !s.listening })),
  setListening: (v) => set({ listening: v }),
  setInputText: (t) => set({ inputText: t }),
  addMessage: (role, text) => set((s) => ({ messages: [...s.messages, { role, text }] })),
  cancel: () => {
    const requestId = get().activeRequestId
    if (requestId) void window.aiPlayer?.ai?.cancel(requestId)
  },
  send: async (contextNote = '', options = {}) => {
    const text = (options.text ?? get().inputText).trim()
    if (!text || get().thinking) return
    get().addMessage('user', text)
    const requestId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    set({ inputText: '', thinking: true, activeRequestId: requestId })
    set(state => ({ messages: [...state.messages, { id: requestId, role: 'agent', text: '思考中…' }] }))
    const updateReply = (reply: string, finished = false) => set(state => ({
      messages: state.messages.map(message => message.id === requestId ? { ...message, text: reply } : message),
      ...(finished && state.activeRequestId === requestId ? { thinking: false, activeRequestId: null } : {})
    }))

    const history = get()
      .messages.filter((m) => m.text !== '思考中…')
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
    if (contextNote.trim() && history.length > 0) {
      const latest = history[history.length - 1]
      history[history.length - 1] = { ...latest, content: `${latest.content}\n\n[当前任务上下文]\n${contextNote.trim()}` }
    }

    // 桌面端：调云端 Agent（function calling 控制播放）
    if (window.aiPlayer?.ai) {
      let streamedText = ''
      const offStream = window.aiPlayer.ai.onStream((event) => {
        if (event.requestId !== requestId) return
        if (event.delta) streamedText += event.delta
        const statusText: Record<string, string> = {
          queued: '请求已排队…', connecting: '正在连接模型…', loading: '模型正在加载…',
          'cli-connecting': '正在启动订阅通道（约 20-30 秒）…', 'cli-connected': '通道已连接，正在生成…',
          'cli-generating': '订阅模型生成中（约需 1–2 分钟）…',
          'loading-local-model': '正在校验并启动内置离线模型…',
          'reading-documents': '正在读取所选文档的相关内容…'
        }
        updateReply(streamedText || statusText[event.status || ''] || get().messages.find(message => message.id === requestId)?.text || '思考中…')
      })
      try {
        const player = usePlayerStore.getState()
        const result = await window.aiPlayer.ai.chat(history, {
          name: player.mediaName,
          path: player.videoSrc,
          currentTime: player.currentTime,
          duration: player.duration,
          volume: player.volume,
          lastAudibleVolume: player.lastAudibleVolume,
          playbackRate: player.playbackRate,
          pictureMode: player.pictureMode,
          subtitleVisible: player.subtitleVisible,
          isFullscreen: player.isFullscreen
        }, requestId, { mode: options.mode || get().agentMode, documentTokens: options.documentTokens })
        let reply = result.text
        if ((result.toolResults || []).length > 0) {
          const descs: string[] = []
          const receipts: AgentToolReceipt[] = []
          for (const t of result.toolResults || []) {
            const r = t.result as { success?: boolean; error?: string; action?: string; value?: unknown; desc?: string; verified?: boolean; execution?: 'main' | 'renderer' }
            if (r.desc) descs.push(r.desc)
            receipts.push(await applyAgentToolResult(t.tool, r))
          }
          if (receipts.length) {
            const verified = receipts.filter((receipt) => receipt.verified).length
            reply += `\n[执行收据] ${verified}/${receipts.length} 项已验证${descs.length ? `：${descs.join('；')}` : ''}`
          }
          const run = result.run
          if (run?.steps?.length) {
            const runTaskId = get().startTask({
              kind: 'utility',
              label: `Agent · ${result.mode === 'auto' ? '自动' : result.mode === 'work' ? '执行' : result.mode === 'plan' ? '规划' : '问答'}`,
              phase: 'running',
              instruction: text,
              source: player.mediaName || '',
              budget: run.budget,
              steps: run.steps.map((step, index) => ({
                id: step.id,
                label: step.label,
                phase: step.status === 'blocked' ? 'blocked' : step.status === 'failed' ? 'failed' : 'completed',
                detail: step.detail,
                evidence: receipts[index]?.evidence || step.evidence?.value || '',
                startedAt: step.startedAt,
                completedAt: step.completedAt
              })),
              evidence: receipts.map((receipt, index) => ({
                id: `receipt-${run.id}-${index + 1}`,
                kind: receipt.verified ? 'state' : 'receipt',
                label: receipt.label,
                value: receipt.evidence,
                verified: receipt.verified,
                createdAt: Date.now()
              }))
            })
            const failed = run.status === 'blocked' || run.status === 'failed' || receipts.some((receipt) => !receipt.success)
            get().updateTask(runTaskId, {
              phase: failed ? 'failed' : 'completed',
              summary: receipts.length ? `${receipts.filter((receipt) => receipt.verified).length}/${receipts.length} 项执行证据已验证` : '模型已完成回答',
              error: failed ? '部分步骤未完成，请查看执行收据' : ''
            })
          }
        }
        if (result.cancelled && !reply) reply = '已取消生成。'
        updateReply(reply, true)
      } catch (e) {
        updateReply(`[错误] ${e instanceof Error ? e.message : String(e)}`, true)
      } finally {
        offStream()
      }
    } else {
      updateReply('Web 端尚未连接 AI 服务；本地播放与文件预览仍可正常使用。', true)
    }
  }
    }),
    {
      name: 'agentplay-workspace-tasks',
      version: 3,
      partialize: (state) => ({ tasks: state.tasks, activeTaskId: state.activeTaskId, agentMode: state.agentMode }),
      merge: (persisted, current) => {
        const stored = persisted as Partial<AgentState>
        const tasks = restoreWorkspaceTasks(stored.tasks)
        const activeTaskId = tasks.some((item) => item.id === stored.activeTaskId)
          ? stored.activeTaskId || null
          : tasks[0]?.id || null
        return {
          ...current,
          agentMode: normalizeAgentMode(stored.agentMode),
          tasks,
          activeTaskId,
          task: tasks.find((item) => item.id === activeTaskId) || EMPTY_TASK
        }
      },
      onRehydrateStorage: () => (state) => {
        if (!state) return
        // merge() fail-closes unfinished work in memory. Persist that transition too,
        // otherwise localStorage keeps saying "running" until another store write.
        queueMicrotask(() => {
          const tasks = restoreWorkspaceTasks(state.tasks)
          const activeTaskId = tasks.some((item) => item.id === state.activeTaskId)
            ? state.activeTaskId
            : tasks[0]?.id || null
          const task = tasks.find((item) => item.id === activeTaskId) || EMPTY_TASK
          useAgentStore.setState({ tasks, activeTaskId, task })
        })
      }
    }
  )
)
