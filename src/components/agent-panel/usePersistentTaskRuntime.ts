import { useEffect } from 'react'
import { useAgentStore } from '../../stores/agentStore'
import type { WorkspaceTaskEvidence, WorkspaceTaskKind, WorkspaceTaskRetry } from '../../taskLifecycle'

type CurrentRef<T> = { current: T }

export default function usePersistentTaskRuntime(requestIdRef: CurrentRef<string>) {
  useEffect(() => {
    const surfacedOutputs = new Set<string>()
    const syncRuntimeTask = (runtimeTask: PersistentRuntimeTask, fromEvent = false) => {
      if (!runtimeTask?.workspaceTaskId || runtimeTask.id === requestIdRef.current) return
      const store = useAgentStore.getState()
      const existing = store.tasks.find((item) => item.id === runtimeTask.workspaceTaskId)
      const isDocument = runtimeTask.type === 'document.run'
      const isAnalysis = runtimeTask.type === 'analysis.run'
      const isOutcome = runtimeTask.type === 'outcome.workflow'
      const isSubtitle = runtimeTask.type === 'subtitle.generate'
      const isVideoGeneration = runtimeTask.type === 'creative.video-generate'
      const isRecut = runtimeTask.type === 'creative.recut-short'
      const isCreative = isVideoGeneration || isRecut
      const isBatch = runtimeTask.type === 'media.batch'
      const isCompress = runtimeTask.type === 'media.compress'
      const isTimelineEdit = runtimeTask.type === 'media.edit-trim' || runtimeTask.type === 'media.edit-remove' || runtimeTask.type === 'media.edit-concat' || runtimeTask.type === 'media.edit-music' || runtimeTask.type === 'media.edit-concat-sources' || runtimeTask.type === 'media.edit-burn-subtitles' || runtimeTask.type === 'media.edit-mux-subtitles'
      const isSubtitleShift = runtimeTask.type === 'media.shift-subtitles'
      const isSubtitleTranslate = runtimeTask.type === 'media.translate-subtitles'
      const isSubtitleCueEdit = runtimeTask.type === 'media.edit-subtitle-cues'
      const isDedup = runtimeTask.type === 'media.dedup'
      const isDownload = String(runtimeTask.type || '').startsWith('download.')
      const dedupRoot = runtimeTask.spec?.root as { path?: string } | undefined
      const sourceNames = Array.isArray(runtimeTask.spec?.sources)
        ? runtimeTask.spec.sources.map((item) => String(item?.path || '').split(/[\\/]/).pop() || '').filter(Boolean)
        : []
      const firstSourcePath = Array.isArray(runtimeTask.spec?.sources) ? String(runtimeTask.spec.sources[0]?.path || '') : ''
      const allOutputPaths = Array.isArray(runtimeTask.result?.outputs)
        ? runtimeTask.result.outputs.map(String)
        : runtimeTask.result?.outputPath ? [String(runtimeTask.result.outputPath)] : []
      const outputPaths = isDedup ? [] : allOutputPaths
      const deliveryReceipt = runtimeTask.result?.deliveryReceipt as {
        sources?: Array<{ name?: string; sha256?: string; bytes?: number }>
        bundle?: { requestedFormats?: string[]; sourceLedgerSha256?: string; consistency?: { verdict?: string } }
      } | undefined
      const workflowSource = (runtimeTask.result?.workflowReceipt as { source?: { path?: string; sha256?: string; size?: number } } | undefined)?.source
      const evidenceSources = isOutcome && workflowSource
        ? [{ name: String(workflowSource.path || '').split(/[\\/]/).pop() || '视频来源', sha256: workflowSource.sha256, bytes: workflowSource.size }]
        : (deliveryReceipt?.sources || [])
      const deliveryEvidence: WorkspaceTaskEvidence[] = evidenceSources.map((item, index) => ({
        id: `source-${runtimeTask.id}-${index + 1}`,
        kind: 'receipt' as const,
        label: isOutcome ? '工作流来源已验证' : '来源指纹已冻结',
        value: `${item.name || '来源文件'} · SHA-256 ${String(item.sha256 || '').slice(0, 12)}…`,
        verified: /^[a-f0-9]{64}$/i.test(String(item.sha256 || '')),
        createdAt: Number(runtimeTask.completedAt || runtimeTask.updatedAt || Date.now()),
        ...(typeof item.bytes === 'number' ? { bytes: item.bytes } : {})
      }))
      if (deliveryReceipt?.bundle) deliveryEvidence.push({
        id: `bundle-${runtimeTask.id}`,
        kind: 'receipt' as const,
        label: '成果包一致性已验证',
        value: `${deliveryReceipt.bundle.requestedFormats?.join('、') || '成套成果'} · 共用事实底稿 ${String(deliveryReceipt.bundle.sourceLedgerSha256 || '').slice(0, 12)}…`,
        verified: deliveryReceipt.bundle.consistency?.verdict === 'matched',
        createdAt: Number(runtimeTask.completedAt || runtimeTask.updatedAt || Date.now())
      })
      if (isOutcome) {
        const workflowSteps = (runtimeTask.result?.workflowReceipt as { steps?: Array<{ id?: string; state?: string }> } | undefined)?.steps || []
        deliveryEvidence.push({
          id: `outcome-steps-${runtimeTask.id}`,
          kind: 'receipt' as const,
          label: '逐步成果回执已完成',
          value: workflowSteps.map((step) => String(step.id || '')).filter(Boolean).join(' → '),
          verified: workflowSteps.length === 2 && workflowSteps.every((step) => step.state === 'completed'),
          createdAt: Number(runtimeTask.completedAt || runtimeTask.updatedAt || Date.now())
        })
      }
      const projectCapsule = runtimeTask.result?.projectCapsule as { projectId?: string; name?: string; revision?: number; materialCount?: number; artifactCount?: number; currentPath?: string } | undefined
      if (projectCapsule?.projectId) deliveryEvidence.push({
        id: `project-${runtimeTask.id}`,
        kind: 'state' as const,
        label: `项目第 ${Number(projectCapsule.revision) || 0} 版`,
        value: `${projectCapsule.name || 'AgentPlay 项目'} · 当前修改对象 ${String(projectCapsule.currentPath || '').split(/[\\/]/).pop() || ''}`,
        verified: true,
        createdAt: Number(runtimeTask.completedAt || runtimeTask.updatedAt || Date.now())
      })
      const batchKind = runtimeTask.spec?.kind === 'transcribe' ? 'transcribe' : 'compress'
      const compressMode = runtimeTask.spec?.mode === 'remux' ? 'remux' : 'compress'
      const trimDecision = runtimeTask.spec?.decision as { timeline?: { startSeconds?: number; endSeconds?: number; segments?: Array<{ sourceStartSeconds?: number; sourceEndSeconds?: number }> } } | undefined
      const outcomeWorkflow = runtimeTask.spec?.workflow as { instruction?: string } | undefined

      let kind: WorkspaceTaskKind = 'download'
      let label = runtimeTask.type === 'download.site' ? '站点视频下载' : '视频下载'
      let instruction = String(runtimeTask.spec?.url || '')
      let source = String(runtimeTask.spec?.url || '')
      let retry: WorkspaceTaskRetry | null = isDownload ? { kind: 'download', url: String(runtimeTask.spec?.url || ''), direct: runtimeTask.type === 'download.direct' } : null
      if (isDocument) {
        kind = 'doc'; label = '文档任务'; instruction = String(runtimeTask.spec?.instruction || ''); source = sourceNames.join('、')
        retry = { kind: 'doc', instruction, outputFormat: String(runtimeTask.spec?.outputFormat || 'auto') }
      } else if (isAnalysis) {
        kind = 'analysis'; label = '视频解剖'; instruction = String(runtimeTask.spec?.instruction || ''); source = firstSourcePath
        retry = { kind: 'analysis', instruction, sourcePath: firstSourcePath, outputFormat: String(runtimeTask.spec?.outputFormat || 'docx') }
      } else if (isOutcome) {
        kind = 'analysis'; label = '视频内容成果包'; instruction = String(outcomeWorkflow?.instruction || runtimeTask.spec?.instruction || ''); source = firstSourcePath
        retry = { kind: 'outcome', instruction, sourcePath: firstSourcePath }
      } else if (isSubtitle) {
        kind = 'media'; label = '自动翻译字幕'; instruction = `生成${runtimeTask.spec?.targetLang || '目标语言'}字幕`; source = firstSourcePath; retry = null
      } else if (isCreative) {
        kind = 'creative'; label = isRecut ? '生成重构短片' : 'AI 生成视频'; instruction = String(runtimeTask.spec?.instruction || runtimeTask.spec?.prompt || '')
        source = isRecut ? String(runtimeTask.spec?.mediaName || '') : ''; retry = isVideoGeneration ? { kind: 'video-gen', instruction } : null
      } else if (isBatch) {
        kind = 'media'; label = batchKind === 'transcribe' ? `批量转写 ${sourceNames.length} 个文件` : `批量压缩 ${sourceNames.length} 个视频`
        instruction = batchKind === 'transcribe' ? '全部转写' : '全部压缩'; source = sourceNames.join('、'); retry = null
      } else if (isTimelineEdit) {
        const start = Number(trimDecision?.timeline?.startSeconds) || 0
        const end = Number(trimDecision?.timeline?.endSeconds) || 0
        const removesSegment = runtimeTask.type === 'media.edit-remove'
        const concatenatesSegments = runtimeTask.type === 'media.edit-concat'
        const segmentCount = trimDecision?.timeline?.segments?.length || 0
        kind = 'media'; label = concatenatesSegments ? `拼接 ${segmentCount} 个片段` : `${removesSegment ? '删除' : '保留'} ${start}–${end} 秒`; instruction = String(runtimeTask.spec?.instruction || (concatenatesSegments ? `按顺序拼接 ${segmentCount} 个片段` : `${removesSegment ? '删除' : '保留'}第${start}秒到第${end}秒`)); source = firstSourcePath
        retry = { kind: 'trim', instruction, sourcePath: firstSourcePath }
      } else if (isSubtitleShift) {
        kind = 'media'; label = '字幕时间调移'; instruction = String(runtimeTask.spec?.instruction || '字幕时间调移'); source = firstSourcePath
        retry = { kind: 'trim', instruction, sourcePath: firstSourcePath }
      } else if (isSubtitleTranslate) {
        kind = 'media'; label = '翻译字幕'; instruction = String(runtimeTask.spec?.instruction || '翻译字幕'); source = firstSourcePath
        retry = { kind: 'trim', instruction, sourcePath: firstSourcePath }
      } else if (isSubtitleCueEdit) {
        kind = 'media'; label = '字幕校对'; instruction = String(runtimeTask.spec?.instruction || '字幕校对'); source = firstSourcePath
        retry = { kind: 'trim', instruction, sourcePath: firstSourcePath }
      } else if (isCompress) {
        kind = 'media'; label = compressMode === 'remux' ? '转码为 MP4' : `压缩到 ${Number(runtimeTask.spec?.targetMb) || 25}MB`
        instruction = compressMode === 'remux' ? '转码成 mp4' : `压缩到 ${Number(runtimeTask.spec?.targetMb) || 25}MB`; source = firstSourcePath
        retry = { kind: 'compress', instruction, sourcePath: firstSourcePath, targetMb: Number(runtimeTask.spec?.targetMb) || 25, mode: compressMode }
      } else if (isDedup) {
        kind = 'utility'; label = '重复文件检查'; instruction = '重复文件检查'; source = String(dedupRoot?.path || '')
        retry = { kind: 'dedup', instruction, directoryPath: source }
      }

      if (!existing) store.startTask({ id: runtimeTask.workspaceTaskId, kind, label, instruction, source, retry })
      if (runtimeTask.state === 'completed') {
        const fallbackSummary = isDocument ? '文档处理完成（已从检查点恢复）'
          : isAnalysis ? '视频解剖完成（已从检查点恢复）'
            : isOutcome ? '视频内容成果包完成（已从检查点恢复）'
            : isSubtitle ? '字幕生成完成（已从检查点恢复）'
              : isCreative ? '创作任务完成（已从检查点恢复）'
                : isBatch ? `批量${batchKind === 'transcribe' ? '转写' : '压缩'}完成（已从检查点恢复）`
                  : isTimelineEdit ? '视频剪辑完成（已从冻结时间线恢复）'
                    : isSubtitleShift ? '字幕调时完成（已从冻结决策恢复）'
                      : isSubtitleTranslate ? '字幕翻译完成（已从冻结决策恢复）'
                        : isSubtitleCueEdit ? '字幕校对完成（已从冻结决策恢复）'
                        : isCompress ? `${compressMode === 'remux' ? '转码' : '压缩'}完成（已从检查点恢复）`
                    : isDedup ? '重复文件检查完成（已从哈希检查点恢复）' : '视频下载完成（已从检查点恢复）'
        store.updateTask(runtimeTask.workspaceTaskId, {
          phase: 'completed', status: '', error: '', outputs: outputPaths, summary: String(runtimeTask.result?.summary || fallbackSummary),
          evidence: deliveryEvidence, quality: runtimeTask.quality || null, repairHistory: runtimeTask.repairHistory || [], failure: runtimeTask.failure || null
        })
        if ((isDownload || isCreative || isTimelineEdit) && fromEvent && outputPaths[0] && !surfacedOutputs.has(runtimeTask.id)) {
          surfacedOutputs.add(runtimeTask.id)
          window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: outputPaths[0] }))
        }
        return
      }
      if (runtimeTask.state === 'failed') {
        store.updateTask(runtimeTask.workspaceTaskId, {
          phase: 'failed', status: '', error: runtimeTask.failure?.message || runtimeTask.error || '任务恢复失败',
          quality: runtimeTask.quality || null, repairHistory: runtimeTask.repairHistory || [], failure: runtimeTask.failure || null
        })
        return
      }
      if (runtimeTask.state === 'cancelled') {
        store.updateTask(runtimeTask.workspaceTaskId, { phase: 'cancelled', status: '', error: runtimeTask.error || '任务已取消' })
        return
      }
      store.updateTask(runtimeTask.workspaceTaskId, {
        phase: runtimeTask.state === 'waiting_approval' ? 'waiting' : runtimeTask.state,
        status: runtimeTask.approval?.summary || runtimeTask.status || (runtimeTask.state === 'queued' ? '等待恢复' : '正在从检查点恢复'),
        error: '', quality: runtimeTask.quality || null, repairHistory: runtimeTask.repairHistory || [], failure: runtimeTask.failure || null
      })
    }
    const syncAll = () => {
      void window.aiPlayer?.taskRuntime?.list().then((items) => items.forEach((item) => syncRuntimeTask(item))).catch(() => {})
    }
    // Subscribe before checking current state. Checking first leaves a TOCTOU
    // window where hydration can finish between the check and subscription.
    const stopHydration = useAgentStore.persist.onFinishHydration(syncAll)
    if (useAgentStore.persist.hasHydrated()) syncAll()
    const syncOnTaskCenterOpen = () => syncAll()
    window.addEventListener('agentplay-open-task-center', syncOnTaskCenterOpen)
    const stopEvents = window.aiPlayer?.taskRuntime?.onEvent((task) => syncRuntimeTask(task, true))
    return () => {
      stopHydration()
      stopEvents?.()
      window.removeEventListener('agentplay-open-task-center', syncOnTaskCenterOpen)
    }
  }, [requestIdRef])
}
