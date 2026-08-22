import { useEffect, useRef } from 'react'
import type { AgentTask } from '../../stores/agentStore'
import { usePlayerStore } from '../../stores/playerStore'
import type { WorkspaceTaskInput, WorkspaceTaskRetry } from '../../taskLifecycle'
import type { AgentAttachment, PendingTaskKind } from './types'

type CurrentRef<T> = { current: T }
type RecutOffer = { reportText: string; mediaName: string }
type BatchInput = { instruction: string; targets: AgentAttachment[] }
type CompressInput = {
  instruction: string
  sourcePath: string
  targetMb: number
  mode: 'compress' | 'remux'
}
type TrimInput = {
  instruction: string
  sourcePath: string
  startSeconds: number
  endSeconds: number
  operation?: 'trim' | 'remove' | 'concat' | 'music' | 'subtitle' | 'shift' | 'mux' | 'translate' | 'cue-edit'
  segments?: Array<{ startSeconds: number; endSeconds: number }>
}

type MediaCreativeTaskOptions = {
  busyRef: CurrentRef<boolean>
  requestIdRef: CurrentRef<string>
  executionTaskIdRef: CurrentRef<string>
  pendingTaskRef: CurrentRef<PendingTaskKind>
  startTask: (input: WorkspaceTaskInput) => string
  setTaskBusy: (value: boolean) => void
  setTaskStatus: (value: string) => void
  setTaskOutputs: (value: string[]) => void
  bindCancelableRequest: (requestId: string) => void
  releaseCancelableRequest: (requestId: string) => void
  completeExecutionTask: (patch?: Partial<AgentTask>) => void
  failExecutionTask: (error: string) => void
  executionWasCancelled: () => boolean
  addMessage: (role: 'user' | 'agent', text: string) => void
  setInputText: (value: string) => void
  attachments: AgentAttachment[]
  clearRecutOffer: () => void
}

const VIDEO_GENERATION_INTENT = /^生成(一段|一个|一条|个|段|条)?视频|^做(一段|一个|一条|个|段|条)?视频|^来(一段|一条)视频/
const AUDIO_VIDEO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.wma', '.mp4', '.mkv', '.mov', '.webm', '.ts', '.m4v', '.wmv', '.flv'])
const VIDEO_PLAY_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.ts', '.m4v', '.wmv', '.flv', '.avi'])
// 剪辑成果也可能是字幕等非视频文件（如字幕调时产出的 .srt），这类成果只给回执不自动进播放器
const isPlayableVideoPath = (value: string) => VIDEO_PLAY_EXTENSIONS.has((/\.[^.\\/]+$/.exec(String(value || ''))?.[0] || '').toLowerCase())
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.ts', '.m4v', '.wmv', '.flv', '.avi'])
const sameLocalPath = (left: string, right: string) => left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase()

export default function useMediaCreativeTasks(options: MediaCreativeTaskOptions) {
  const {
    busyRef, requestIdRef, executionTaskIdRef, pendingTaskRef, startTask,
    setTaskBusy, setTaskStatus, setTaskOutputs, bindCancelableRequest,
    releaseCancelableRequest, completeExecutionTask, failExecutionTask,
    executionWasCancelled, addMessage, setInputText, attachments,
    clearRecutOffer
  } = options
  const recutInputRef = useRef<RecutOffer | null>(null)
  const batchInputRef = useRef<BatchInput>({ instruction: '', targets: [] })
  const compressInputRef = useRef<CompressInput>({ instruction: '', sourcePath: '', targetMb: 25, mode: 'compress' })
  const trimInputRef = useRef<TrimInput>({ instruction: '', sourcePath: '', startSeconds: 0, endSeconds: 0 })
  const pendingEditClarificationRef = useRef<MediaEditClarification | null>(null)
  const videoGenInstructionRef = useRef('')
  const dedupInstructionRef = useRef('')

  useEffect(() => {
    const off = window.aiPlayer?.media?.onDedupProgress((event) => {
      if (event.requestId !== requestIdRef.current) return
      if (event.phase === 'scanning') {
        setTaskStatus(`正在扫描媒体库 · 已发现 ${event.filesScanned || 0} 个媒体文件`)
        return
      }
      if (event.phase === 'hashing') {
        const total = event.totalFiles || 0
        const done = event.processedFiles || 0
        const percent = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0
        setTaskStatus(total > 0 ? `正在核对文件内容 ${done}/${total} · ${percent}%` : '正在筛选可能重复的文件')
      }
    })
    return off
  }, [])

  const runRecutShort = async (input: RecutOffer | null, retrying = false) => {
    if (!input || busyRef.current) return
    busyRef.current = true
    recutInputRef.current = input
    clearRecutOffer()
    if (!retrying) addMessage('user', '🎬 生成重构短片')
    executionTaskIdRef.current = startTask({
      kind: 'creative', label: '生成重构短片', phase: 'running', status: '正在准备镜头脚本…',
      instruction: '生成重构短片', source: input.mediaName, retry: { kind: 'recut' }
    })
    const requestId = `recut-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    pendingTaskRef.current = 'recut'
    bindCancelableRequest(requestId)
    const off = window.aiPlayer?.studio?.onRecutProgress?.((event) => {
      if (event.requestId === requestId || !event.requestId) setTaskStatus(event.stage)
    })
    try {
      const result = await window.aiPlayer?.studio?.recutShort({ ...input, requestId, workspaceTaskId: executionTaskIdRef.current })
      if (!result?.success || !result.outputPath) throw new Error(result?.error || '重构短片生成失败')
      completeExecutionTask({ outputs: [result.outputPath], summary: '任务已完成' })
      addMessage('agent', `重构短片已生成（${result.clips || 3} 个 AI 镜头拼接），正在为你播放：${result.outputPath}`)
      window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: result.outputPath }))
    } catch (error) {
      if (executionWasCancelled()) return
      const message = error instanceof Error ? error.message : String(error)
      failExecutionTask(message)
      addMessage('agent', `[错误] ${message}`)
    } finally {
      off?.()
      releaseCancelableRequest(requestId)
      busyRef.current = false
    }
  }

  const runVideoGenTask = async (text: string, retrying = false) => {
    if (!text || busyRef.current) return
    busyRef.current = true
    videoGenInstructionRef.current = text
    if (!retrying) {
      addMessage('user', text)
      setInputText('')
    }
    const prompt = (text.split(/[：:，,]/).slice(1).join('，') || text.replace(VIDEO_GENERATION_INTENT, '')).trim() || '一段有科技感的抽象动画'
    const seconds = Math.max(1, Math.min(8, Number(/(\d+)\s*秒/.exec(text)?.[1]) || 4))
    executionTaskIdRef.current = startTask({
      kind: 'creative', label: 'AI 生成视频', phase: 'running', status: `正在生成 ${seconds} 秒视频（约 1-2 分钟）…`,
      instruction: text, retry: { kind: 'video-gen', instruction: text }
    })
    const requestId = `video-gen-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    pendingTaskRef.current = 'video-gen'
    bindCancelableRequest(requestId)
    try {
      const result = await window.aiPlayer?.studio?.generateVideo({ prompt, duration: seconds, requestId, workspaceTaskId: executionTaskIdRef.current, instruction: text })
      if (!result?.success || !result.outputPath) throw new Error(result?.error || '视频生成失败')
      completeExecutionTask({ outputs: [result.outputPath], summary: '任务已完成' })
      addMessage('agent', `视频已生成（${result.numFrames || ''} 帧），正在为你播放：${result.outputPath}`)
      window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: result.outputPath }))
    } catch (error) {
      if (executionWasCancelled()) return
      const message = error instanceof Error ? error.message : String(error)
      failExecutionTask(message)
      addMessage('agent', `[错误] ${message}`)
    } finally {
      releaseCancelableRequest(requestId)
      busyRef.current = false
    }
  }

  const runBatchTask = async (text: string, targetOverride?: AgentAttachment[]) => {
    if (!text || busyRef.current) return
    const kind = /转写/.test(text) ? 'transcribe' : 'compress'
    const targets = targetOverride || attachments.filter((file) => (kind === 'transcribe' ? AUDIO_VIDEO_EXTENSIONS : VIDEO_EXTENSIONS).has(file.ext))
    if (!targets.length) {
      addMessage('agent', kind === 'transcribe' ? '附件里没有可转写的音视频文件' : '附件里没有可压缩的视频文件')
      return
    }
    busyRef.current = true
    batchInputRef.current = { instruction: text, targets: [...targets] }
    if (!targetOverride) {
      addMessage('user', text)
      setInputText('')
    }
    const label = kind === 'transcribe' ? `批量转写 ${targets.length} 个文件` : `批量压缩 ${targets.length} 个视频`
    executionTaskIdRef.current = startTask({
      kind: 'media', label, phase: 'running', status: '准备中…', instruction: text,
      source: targets.map((file) => file.name).join('、'), retry: { kind: 'batch', instruction: text }
    })
    const requestId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    pendingTaskRef.current = 'batch'
    bindCancelableRequest(requestId)
    const off = window.aiPlayer?.mediaBatch?.onProgress?.((event) => {
      if (event.requestId === requestId || !event.requestId) setTaskStatus(`（${event.done}/${event.total}）${event.name}`)
    })
    try {
      const result = await window.aiPlayer?.mediaBatch?.run({ tokens: targets.map((file) => file.token), kind, requestId, workspaceTaskId: executionTaskIdRef.current })
      if (!result?.success) throw new Error(result?.error || '批量任务失败')
      const succeeded = (result.results || []).filter((item) => item.success)
      const failed = (result.results || []).filter((item) => !item.success)
      const outputs = succeeded.map((item) => item.outputPath).filter(Boolean) as string[]
      completeExecutionTask({ outputs, summary: `${label}完成：成功 ${succeeded.length}/${targets.length}` })
      addMessage('agent', `${label}完成：成功 ${succeeded.length}/${targets.length}${failed.length ? `；失败 ${failed.length} 个（${failed[0]?.error || ''}）` : ''}`)
    } catch (error) {
      if (executionWasCancelled()) return
      const message = error instanceof Error ? error.message : String(error)
      failExecutionTask(message)
      addMessage('agent', `[错误] ${message}`)
    } finally {
      off?.()
      releaseCancelableRequest(requestId)
      busyRef.current = false
    }
  }

  const runEditHistoryTask = async (text: string): Promise<boolean> => {
    if (!text) return false
    const currentPath = usePlayerStore.getState().videoSrc
    if (!currentPath || /^(https?|blob):/i.test(currentPath) || !window.aiPlayer?.mediaTools?.planHistory) return false
    try {
      const plan = await window.aiPlayer.mediaTools.planHistory({ instruction: text, currentPath })
      if (!plan?.matched || !plan.action) return false
      addMessage('user', text)
      setInputText('')
      if (busyRef.current) {
        addMessage('agent', '当前任务还在处理中，完成后再撤销或重做，避免切换到错误版本。')
        return true
      }
      const result = await window.aiPlayer.mediaTools.navigateHistory({ instruction: text, currentPath })
      if (!result?.success || !result.currentPath) {
        addMessage('agent', `[错误] ${result?.error || '没有可以切换的编辑版本'}`)
        return true
      }
      const position = Number(result.cursor) + 1
      addMessage('agent', `${result.summary || '已切换编辑版本'}\n项目版本：${position}/${result.versionCount || position}；所有版本文件均保留。`)
      if (isPlayableVideoPath(result.currentPath)) window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: result.currentPath }))
      return true
    } catch (error) {
      addMessage('agent', `[错误] ${error instanceof Error ? error.message : String(error)}`)
      return true
    }
  }

  const runTrimTask = async (text: string, override?: TrimInput): Promise<boolean> => {
    if (!text) return false
    const currentPath = override?.sourcePath || usePlayerStore.getState().videoSrc
    const pendingClarification = override ? null : pendingEditClarificationRef.current
    if (pendingClarification && (!currentPath || !sameLocalPath(currentPath, pendingClarification.sourcePath))) {
      pendingEditClarificationRef.current = null
      addMessage('user', text)
      setInputText('')
      addMessage('agent', '当前视频已经切换，刚才未完成的剪辑追问已取消；请对当前视频重新说明。')
      return true
    }
    const sourcePath = pendingClarification?.sourcePath || currentPath
    if (!sourcePath || /^(https?|blob):/i.test(sourcePath) || !window.aiPlayer?.mediaTools?.planEdit) return false
    let startSeconds = override?.startSeconds || 0
    let endSeconds = override?.endSeconds || 0
    let operation: 'trim' | 'remove' | 'concat' | 'music' | 'subtitle' | 'shift' | 'mux' | 'translate' | 'cue-edit' = override?.operation || 'trim'
    let segments = override?.segments || []
    let sourceCount = 0
    let executionInstruction = text
    if (!override) {
      try {
        const plan = await window.aiPlayer.mediaTools.planEdit({ instruction: text, sourcePath, ...(pendingClarification ? { clarificationId: pendingClarification.id } : {}) })
        if (pendingClarification && plan?.error) {
          pendingEditClarificationRef.current = null
          addMessage('user', text)
          setInputText('')
          addMessage('agent', `[错误] ${plan.error}`)
          return true
        }
        if (plan?.cancelled) {
          pendingEditClarificationRef.current = null
          addMessage('user', text)
          setInputText('')
          addMessage('agent', '好的，已取消这次剪辑，没有创建任务，也没有改动文件。')
          return true
        }
        if (plan?.clarification) {
          pendingEditClarificationRef.current = plan.clarification
          addMessage('user', text)
          setInputText('')
          addMessage('agent', plan.clarification.question)
          return true
        }
        const decision = plan?.decision
        if (!plan?.matched || !decision || !['media.trim', 'media.remove-segment', 'media.concat-segments', 'media.add-music', 'media.concat-sources', 'media.burn-subtitles', 'media.shift-subtitles', 'media.mux-subtitles', 'media.translate-subtitles', 'media.edit-subtitle-cues'].includes(decision.kind)) {
          pendingEditClarificationRef.current = null
          return false
        }
        pendingEditClarificationRef.current = null
        executionInstruction = decision.instruction || text
        operation = decision.kind === 'media.add-music' ? 'music' : decision.kind === 'media.burn-subtitles' ? 'subtitle' : decision.kind === 'media.mux-subtitles' ? 'mux' : decision.kind === 'media.translate-subtitles' ? 'translate' : decision.kind === 'media.edit-subtitle-cues' ? 'cue-edit' : decision.kind === 'media.shift-subtitles' ? 'shift' : decision.kind === 'media.remove-segment' ? 'remove' : decision.kind === 'media.concat-segments' || decision.kind === 'media.concat-sources' ? 'concat' : 'trim'
        startSeconds = Number(decision.timeline?.startSeconds || decision.timeline?.segments?.[0]?.sourceStartSeconds || 0)
        endSeconds = Number(decision.timeline?.endSeconds || decision.timeline?.segments?.at(-1)?.sourceEndSeconds || 0)
        segments = (decision.timeline?.segments || []).map((segment) => ({ startSeconds: segment.sourceStartSeconds, endSeconds: segment.sourceEndSeconds }))
        sourceCount = decision.kind === 'media.concat-sources' ? (decision.sources?.length || 0) : 0
      } catch {
        return false
      }
    }
    if (busyRef.current) return true
    const input: TrimInput = { instruction: executionInstruction, sourcePath, startSeconds, endSeconds, operation, segments }
    trimInputRef.current = input
    busyRef.current = true
    if (!override) {
      addMessage('user', text)
      setInputText('')
    }
    const actionLabel = operation === 'music' ? '配乐（对白闪避）' : operation === 'subtitle' ? '烧录硬字幕' : operation === 'mux' ? '封装软字幕' : operation === 'translate' ? '翻译字幕' : operation === 'cue-edit' ? '字幕校对' : operation === 'shift' ? '字幕时间调移' : operation === 'concat' ? (sourceCount > 0 ? `按顺序合并 ${sourceCount} 个素材` : `按顺序拼接 ${segments.length} 个片段`) : operation === 'remove' ? `删除 ${startSeconds}–${endSeconds} 秒` : `保留 ${startSeconds}–${endSeconds} 秒`
    executionTaskIdRef.current = startTask({
      kind: 'media', label: actionLabel, phase: 'running',
      status: operation === 'music' ? '正在按音乐选段与循环策略混音，并做两遍响度归一和编码后复测…' : operation === 'subtitle' ? '正在把字幕逐条烧录进画面并核验成品时长与音轨…' : operation === 'mux' ? '正在把字幕封装成可开关的软字幕轨（不重编码）并核验…' : operation === 'translate' ? '正在逐句翻译字幕并核对译文与条目数…' : operation === 'cue-edit' ? '正在按条目校订字幕并逐条复核…' : operation === 'shift' ? '正在按秒数平移整条字幕时间轴并逐条复核…' : operation === 'concat' ? (sourceCount > 0 ? '正在统一分辨率与音轨、按顺序拼接多个素材并核验成品…' : '正在按口述顺序重排片段、拼接连续音画并核验成品…') : operation === 'remove' ? '正在删除片段、重建连续音画时间线并核验成品…' : '正在按原画面比例精确剪辑，并核验成品时长…', instruction: executionInstruction, source: sourcePath,
      retry: { kind: 'trim', instruction: executionInstruction, sourcePath }
    })
    const requestId = `trim-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    pendingTaskRef.current = 'trim'
    bindCancelableRequest(requestId)
    try {
      const result = await window.aiPlayer.mediaTools.trim({ sourcePath, instruction: executionInstruction, requestId, workspaceTaskId: executionTaskIdRef.current })
      if (!result?.success || !result.outputPath) throw new Error(result?.error || '视频剪辑失败')
      const timeline = (result.timelineReceipt || []).map((item) => `${item.operation}：${operation === 'music' ? '音乐' : '源片'} ${item.sourceRange}；成片 ${item.outputRange}`).join('\n')
      const summary = result.summary || (result.music
        ? `已生成配乐版新视频：音乐音量 ${Math.round((result.music.volume || 0.15) * 100)}%${result.music.duck ? '，人声自动压低音乐（对白闪避）' : ''}；原文件未改动`
        : `已生成 ${Number(result.durationSeconds || 0).toFixed(3)} 秒新视频；原文件未改动`)
      const capsule = result.projectCapsule
      const projectHint = capsule
        ? `\n编辑项目：第 ${capsule.cursor + 1}/${capsule.versionCount} 版；可直接说“撤销刚才的剪辑”。`
        : ''
      completeExecutionTask({ outputs: [result.outputPath], summary })
      addMessage('agent', `${summary}${timeline ? `\n时间线：\n${timeline}` : ''}${projectHint}\n成果：${result.outputPath}`)
      if (isPlayableVideoPath(result.outputPath)) window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: result.outputPath }))
      return true
    } catch (error) {
      if (executionWasCancelled()) return true
      const message = error instanceof Error ? error.message : String(error)
      failExecutionTask(message)
      addMessage('agent', `[错误] ${message}`)
      return true
    } finally {
      releaseCancelableRequest(requestId)
      busyRef.current = false
    }
  }

  const runCompressTask = async (text: string, override?: CompressInput) => {
    if (!text || busyRef.current) return
    const sourcePath = override?.sourcePath || usePlayerStore.getState().videoSrc
    if (!sourcePath || /^(https?|blob):/i.test(sourcePath)) {
      addMessage('agent', '压缩/转码只支持本地视频文件；请先用「打开」选一个本地视频')
      return
    }
    const mode = override?.mode || (/转码|转成 ?mp4|转换为 ?mp4/.test(text) ? 'remux' : 'compress')
    const targetMb = mode === 'remux' ? 0 : override?.targetMb ?? Math.max(5, Math.min(500, Number(/(\d+)\s*(?:MB|mb|兆)/.exec(text)?.[1]) || 25))
    const input: CompressInput = { instruction: text, sourcePath, targetMb, mode }
    compressInputRef.current = input
    busyRef.current = true
    if (!override) {
      addMessage('user', text)
      setInputText('')
    }
    executionTaskIdRef.current = startTask({
      kind: 'media', label: mode === 'remux' ? '转码为 MP4' : `压缩到 ${targetMb}MB`, phase: 'running',
      status: mode === 'remux' ? '正在转封装（不重编码，秒级）…' : '正在压缩（时长越久越慢）…',
      instruction: text, source: sourcePath,
      retry: { kind: 'compress', instruction: text, sourcePath, targetMb, mode }
    })
    const requestId = `compress-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    pendingTaskRef.current = 'compress'
    bindCancelableRequest(requestId)
    try {
      const result = await window.aiPlayer?.mediaTools?.compress({ sourcePath, targetMb, mode, requestId, workspaceTaskId: executionTaskIdRef.current })
      if (!result?.success || !result.outputPath) throw new Error(result?.error || '处理失败')
      const before = ((result.beforeBytes || 0) / 1024 / 1024).toFixed(1)
      const after = ((result.afterBytes || 0) / 1024 / 1024).toFixed(1)
      completeExecutionTask({ outputs: [result.outputPath], summary: '任务已完成' })
      addMessage('agent', `${mode === 'remux' ? '转码' : '压缩'}完成：${before}MB → ${after}MB，已另存为 ${result.outputPath}（原文件未动）`)
    } catch (error) {
      if (executionWasCancelled()) return
      const message = error instanceof Error ? error.message : String(error)
      failExecutionTask(message)
      addMessage('agent', `[错误] ${message}`)
    } finally {
      releaseCancelableRequest(requestId)
      busyRef.current = false
    }
  }

  const runDedupTask = async (instruction: string, retrying = false, directoryPath = '') => {
    if (!instruction || busyRef.current) return
    busyRef.current = true
    dedupInstructionRef.current = instruction
    pendingTaskRef.current = 'dedup'
    const requestId = crypto.randomUUID()
    executionTaskIdRef.current = startTask({ kind: 'utility', label: '重复文件检查', instruction, retry: { kind: 'dedup', instruction, directoryPath } })
    bindCancelableRequest(requestId)
    if (!retrying) {
      addMessage('user', instruction)
      setInputText('')
    }
    setTaskBusy(true)
    setTaskStatus('正在扫描媒体库找重复文件')
    setTaskOutputs([])
    try {
      const result = await window.aiPlayer?.media?.dedup({ requestId, workspaceTaskId: executionTaskIdRef.current, ...(directoryPath ? { directoryPath } : {}) })
      if (!result) throw new Error('桌面端重复文件扫描不可用')
      if (result.cancelled || executionWasCancelled()) return
      if (!result.success) throw new Error(result.error || '重复文件扫描失败')
      const results = result.duplicates
      if (!results.length) {
        addMessage('agent', '没有发现内容重复的文件 ✓')
        completeExecutionTask({ summary: `已扫描 ${result.filesScanned} 个媒体文件，没有发现内容重复` })
      } else {
        const lines = results.slice(0, 10).map((item, index) => `${index + 1}. ${item.name}`).join('\n')
        const more = results.length > 10 ? `\n…共 ${results.length} 组` : ''
        addMessage('agent', `发现 ${results.length} 组内容重复（下面是重复副本，点开可直接查看）：\n${lines}${more}`)
        completeExecutionTask({ outputs: results.slice(0, 5).map((item) => item.duplicate), summary: `发现 ${results.length} 组内容重复` })
      }
    } catch (error) {
      if (executionWasCancelled()) return
      const message = error instanceof Error ? error.message : String(error)
      failExecutionTask(message)
      addMessage('agent', `[错误] ${message}`)
    } finally {
      releaseCancelableRequest(requestId)
      busyRef.current = false
      setTaskBusy(false)
      setTaskStatus('')
    }
  }

  useEffect(() => {
    const onAgentMediaTask = (event: Event) => {
      const detail = (event as CustomEvent<{ action?: string; value?: { targetMb?: number; mode?: 'compress' | 'remux'; startSeconds?: number; endSeconds?: number; segments?: Array<{ startSeconds: number; endSeconds: number }>; direction?: 'undo' | 'redo' } }>).detail || {}
      if (detail.action === 'start_batch_transcribe') {
        void runBatchTask('全部转写')
        return
      }
      if (detail.action === 'start_compress_video') {
        const mode = detail.value?.mode === 'remux' ? 'remux' : 'compress'
        const targetMb = Math.max(5, Number(detail.value?.targetMb) || 25)
        void runCompressTask(mode === 'remux' ? '转码成 mp4' : `压缩到 ${targetMb}MB`)
        return
      }
      if (detail.action === 'start_trim_video') {
        const startSeconds = Math.max(0, Number(detail.value?.startSeconds) || 0)
        const endSeconds = Math.max(0, Number(detail.value?.endSeconds) || 0)
        void runTrimTask(`保留第${startSeconds}秒到第${endSeconds}秒`)
        return
      }
      if (detail.action === 'start_remove_video_segment') {
        const startSeconds = Math.max(0, Number(detail.value?.startSeconds) || 0)
        const endSeconds = Math.max(0, Number(detail.value?.endSeconds) || 0)
        void runTrimTask(`删除第${startSeconds}秒到第${endSeconds}秒`)
        return
      }
      if (detail.action === 'start_concat_video_segments') {
        const segments = (detail.value?.segments || []).filter((segment) => Number.isFinite(segment.startSeconds) && Number.isFinite(segment.endSeconds) && segment.startSeconds >= 0 && segment.endSeconds > segment.startSeconds)
        if (segments.length >= 2) void runTrimTask(`按顺序拼接${segments.map((segment) => `第${segment.startSeconds}秒到第${segment.endSeconds}秒`).join('和')}`)
        return
      }
      if (detail.action === 'start_edit_history') {
        void runEditHistoryTask(detail.value?.direction === 'redo' ? '重做刚才撤销的剪辑' : '撤销刚才的剪辑')
        return
      }
      if (detail.action === 'start_duplicate_scan') void runDedupTask('重复文件检查')
    }
    window.addEventListener('ai-player-agent-media-task', onAgentMediaTask)
    return () => window.removeEventListener('ai-player-agent-media-task', onAgentMediaTask)
  })

  const isVideoGenerationIntent = (text: string) => VIDEO_GENERATION_INTENT.test(text) && Boolean(window.aiPlayer?.studio?.generateVideo)

  const retryActiveTask = () => {
    switch (pendingTaskRef.current) {
      case 'recut':
        if (!recutInputRef.current) return false
        void runRecutShort(recutInputRef.current, true)
        return true
      case 'video-gen':
        if (!videoGenInstructionRef.current) return false
        void runVideoGenTask(videoGenInstructionRef.current, true)
        return true
      case 'batch':
        if (!batchInputRef.current.instruction || !batchInputRef.current.targets.length) return false
        void runBatchTask(batchInputRef.current.instruction, batchInputRef.current.targets)
        return true
      case 'compress':
        if (!compressInputRef.current.sourcePath) return false
        void runCompressTask(compressInputRef.current.instruction, compressInputRef.current)
        return true
      case 'trim':
        if (!trimInputRef.current.sourcePath) return false
        void runTrimTask(trimInputRef.current.instruction, trimInputRef.current)
        return true
      case 'dedup':
        if (!dedupInstructionRef.current) return false
        void runDedupTask(dedupInstructionRef.current, true)
        return true
      default:
        return false
    }
  }

  const retryStoredTask = (retry: WorkspaceTaskRetry) => {
    if (retry.kind === 'trim' && retry.sourcePath && retry.instruction) {
      const planAndRetry = async () => {
        const plan = await window.aiPlayer?.mediaTools?.planEdit({ instruction: retry.instruction || '', sourcePath: retry.sourcePath || '' })
        const decision = plan?.decision
        if (!plan?.matched || !decision || !['media.trim', 'media.remove-segment', 'media.concat-segments', 'media.add-music', 'media.concat-sources', 'media.burn-subtitles', 'media.shift-subtitles', 'media.mux-subtitles', 'media.translate-subtitles', 'media.edit-subtitle-cues'].includes(decision.kind)) {
          addMessage('agent', '[错误] 原剪辑指令已无法还原成唯一时间线，请从原视频重新说明要保留、删除或按顺序拼接的时间段。')
          return
        }
        void runTrimTask(retry.instruction || '', {
          instruction: retry.instruction || '', sourcePath: retry.sourcePath || '',
          startSeconds: Number(decision.timeline?.startSeconds || decision.timeline?.segments?.[0]?.sourceStartSeconds || 0),
          endSeconds: Number(decision.timeline?.endSeconds || decision.timeline?.segments?.at(-1)?.sourceEndSeconds || 0),
          operation: decision.kind === 'media.add-music' ? 'music' : decision.kind === 'media.burn-subtitles' ? 'subtitle' : decision.kind === 'media.mux-subtitles' ? 'mux' : decision.kind === 'media.translate-subtitles' ? 'translate' : decision.kind === 'media.edit-subtitle-cues' ? 'cue-edit' : decision.kind === 'media.shift-subtitles' ? 'shift' : decision.kind === 'media.remove-segment' ? 'remove' : decision.kind === 'media.concat-segments' || decision.kind === 'media.concat-sources' ? 'concat' : 'trim',
          segments: (decision.timeline?.segments || []).map((segment) => ({ startSeconds: segment.sourceStartSeconds, endSeconds: segment.sourceEndSeconds }))
        })
      }
      void planAndRetry()
      return true
    }
    if (retry.kind === 'compress' && retry.sourcePath) {
      usePlayerStore.getState().setMedia(retry.sourcePath.split(/[\\/]/).pop() || '待处理视频', retry.sourcePath)
      const mode = retry.mode || 'compress'
      const instruction = retry.instruction || (mode === 'remux' ? '转码成 mp4' : `压到 ${retry.targetMb || 25}MB`)
      void runCompressTask(instruction, { instruction, sourcePath: retry.sourcePath, targetMb: retry.targetMb || (mode === 'remux' ? 0 : 25), mode })
      return true
    }
    if (retry.kind === 'video-gen' && retry.instruction) {
      void runVideoGenTask(retry.instruction, true)
      return true
    }
    if (retry.kind === 'dedup') {
      void runDedupTask(retry.instruction || '重复文件检查', true, retry.directoryPath || '')
      return true
    }
    return false
  }

  return {
    isVideoGenerationIntent,
    runRecutShort,
    runVideoGenTask,
    runBatchTask,
    runEditHistoryTask,
    runTrimTask,
    runCompressTask,
    runDedupTask,
    retryActiveTask,
    retryStoredTask
  }
}
