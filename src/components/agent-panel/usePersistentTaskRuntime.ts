import { useEffect } from 'react'
import { useAgentStore } from '../../stores/agentStore'
import type { WorkspaceTaskEvidence, WorkspaceTaskKind, WorkspaceTaskRetry } from '../../taskLifecycle'

type CurrentRef<T> = { current: T }

export default function usePersistentTaskRuntime(requestIdRef: CurrentRef<string>) {
  useEffect(() => {
    const surfacedOutputs = new Set<string>()
    const syncRuntimeTask = (runtimeTask: PersistentRuntimeTask, fromEvent = false) => {
      if (!runtimeTask?.id || runtimeTask.id === requestIdRef.current) return
      runtimeTask = { ...runtimeTask, workspaceTaskId: runtimeTask.workspaceTaskId || runtimeTask.id }
      const store = useAgentStore.getState()
      if (runtimeTask.type === 'system.recovery') {
        const id = runtimeTask.workspaceTaskId
        const update = { phase: 'failed' as const, error: runtimeTask.error, failure: runtimeTask.failure || null }
        if (store.tasks.some(task => task.id === id)) store.updateTask(id, update)
        else store.startTask({ id, kind: 'utility', label: '后台任务需要恢复', ...update })
        return
      }
      const existing = store.tasks.find((item) => item.id === runtimeTask.workspaceTaskId)
      const isDocument = runtimeTask.type === 'document.run'
      const isAnalysis = runtimeTask.type === 'analysis.run'
      const isOutcome = runtimeTask.type === 'outcome.workflow'
      const isSubtitle = runtimeTask.type === 'subtitle.generate'
      const isAiAssets = runtimeTask.type === 'creative.asset-bundle'
      const isVideoGeneration = runtimeTask.type === 'creative.video-generate'
      const isRecut = runtimeTask.type === 'creative.recut-short'
      const isCreative = isVideoGeneration || isRecut
      const isBatch = runtimeTask.type === 'media.batch'
      const isBatchEdit = runtimeTask.type === 'media.batch-edit'
      const isCompress = runtimeTask.type === 'media.compress'
      const isVersionBundle = runtimeTask.type === 'media.version-bundle'
      const isVisualEffects = runtimeTask.type === 'media.edit-visual-effects'
      const restoredBrandPackage = (runtimeTask.spec?.decision as { brandPackage?: { template?: { label?: string } } } | undefined)?.brandPackage
      const isSmartReframe = runtimeTask.type === 'media.smart-reframe'
      const isVisualRepair = runtimeTask.type === 'media.visual-repair'
      const isRhythmEdit = runtimeTask.type === 'media.rhythm-edit'
      const isTimelineEdit = isRhythmEdit || runtimeTask.type === 'media.edit-trim' || runtimeTask.type === 'media.edit-remove' || runtimeTask.type === 'media.edit-concat' || runtimeTask.type === 'media.edit-music' || runtimeTask.type === 'media.edit-audio-mix' || runtimeTask.type === 'media.audio-repair' || runtimeTask.type === 'media.edit-concat-sources' || runtimeTask.type === 'media.edit-burn-subtitles' || runtimeTask.type === 'media.edit-mux-subtitles'
      const isSubtitleShift = runtimeTask.type === 'media.shift-subtitles'
      const isSubtitleTranslate = runtimeTask.type === 'media.translate-subtitles'
      const isSubtitleCueEdit = runtimeTask.type === 'media.edit-subtitle-cues'
      const isSubtitleTransform = runtimeTask.type === 'media.transform-subtitles'
      const isSubtitleLayout = runtimeTask.type === 'media.subtitle-layout-variants'
      const isDedup = runtimeTask.type === 'media.dedup'
      const isDownload = String(runtimeTask.type || '').startsWith('download.')
      const dedupRoot = runtimeTask.spec?.root as { path?: string } | undefined
      const batchEditSourceNames = Array.isArray(runtimeTask.spec?.items)
        ? (runtimeTask.spec.items as Array<{ sourceName?: string }>).map((item) => String(item?.sourceName || '')).filter(Boolean)
        : []
      const sourceNames = Array.isArray(runtimeTask.spec?.sources)
        ? runtimeTask.spec.sources.map((item) => String(item?.path || '').split(/[\\/]/).pop() || '').filter(Boolean)
        : batchEditSourceNames
      const firstSourcePath = Array.isArray(runtimeTask.spec?.sources) ? String(runtimeTask.spec.sources[0]?.path || '') : ''
      const allOutputPaths = Array.isArray(runtimeTask.result?.outputs)
        ? runtimeTask.result.outputs.map(String)
        : runtimeTask.result?.outputPath ? [String(runtimeTask.result.outputPath)] : runtimeTask.result?.srtPath ? [String(runtimeTask.result.srtPath)] : []
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
      const editGovernance = runtimeTask.spec?.editGovernance as { digest?: string; registry?: { executor?: string }; budget?: { maxTurns?: number; maxToolCalls?: number; maxElapsedMs?: number } } | undefined
      const editGovernanceReceipt = runtimeTask.result?.editGovernanceReceipt as { verdict?: string; governanceDigest?: string; run?: { budget?: { turns?: number; maxTurns?: number; toolCalls?: number; maxToolCalls?: number; elapsedMs?: number; maxElapsedMs?: number } } } | undefined
      const rawGovernanceBudget = editGovernanceReceipt?.run?.budget
      const governanceBudget = rawGovernanceBudget
        ? { turns: Number(rawGovernanceBudget.turns) || 0, maxTurns: Number(rawGovernanceBudget.maxTurns) || 1, toolCalls: Number(rawGovernanceBudget.toolCalls) || 0, maxToolCalls: Number(rawGovernanceBudget.maxToolCalls) || 1, elapsedMs: Number(rawGovernanceBudget.elapsedMs) || 0, maxElapsedMs: Number(rawGovernanceBudget.maxElapsedMs) || 0 }
        : editGovernance?.budget ? { turns: 0, maxTurns: Number(editGovernance.budget.maxTurns) || 1, toolCalls: 0, maxToolCalls: Number(editGovernance.budget.maxToolCalls) || 1, elapsedMs: 0, maxElapsedMs: Number(editGovernance.budget.maxElapsedMs) || 0 } : null
      if (editGovernance) deliveryEvidence.push({
        id: `edit-governance-${runtimeTask.id}`,
        kind: 'receipt' as const,
        label: '统一编辑治理回执',
        value: `${editGovernance.registry?.executor || runtimeTask.type} · 路由/审批/预算/账本/恢复${editGovernanceReceipt?.verdict === 'matched' ? '已核验' : '已冻结'}`,
        verified: editGovernanceReceipt?.verdict === 'matched' && editGovernanceReceipt.governanceDigest === editGovernance.digest,
        createdAt: Number(runtimeTask.completedAt || runtimeTask.updatedAt || Date.now())
      })
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
      const restoredPersonalSkill = (runtimeTask.spec?.decision as { personalEditSkill?: { name?: string } } | undefined)?.personalEditSkill
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
      } else if (isAiAssets) {
        const requested = ((runtimeTask.spec?.decision as { requestedKinds?: string[] } | undefined)?.requestedKinds || []).map((item) => ({ shot: '补镜头', narration: '旁白', voice: '配音', 'sound-effect': '音效' }[item] || item)).join('、')
        kind = 'creative'; label = `AI素材包${requested ? ` · ${requested}` : ''}`; instruction = String(runtimeTask.spec?.instruction || '生成AI素材包'); source = firstSourcePath
        retry = { kind: 'ai-assets', instruction, sourcePath: firstSourcePath }
      } else if (isCreative) {
        kind = 'creative'; label = isRecut ? '生成重构短片' : 'AI 生成视频'; instruction = String(runtimeTask.spec?.instruction || runtimeTask.spec?.prompt || '')
        source = isRecut ? String(runtimeTask.spec?.mediaName || '') : ''; retry = isVideoGeneration ? { kind: 'video-gen', instruction } : null
      } else if (isBatchEdit) {
        const receipt = runtimeTask.result?.batchEditReceipt as { total?: number; successCount?: number; failureCount?: number } | undefined
        kind = 'media'; label = `批量编辑 ${Number(receipt?.total) || sourceNames.length} 个视频`
        instruction = String(runtimeTask.spec?.instruction || '批量编辑'); source = sourceNames.join('、'); retry = null
      } else if (isBatch) {
        kind = 'media'; label = batchKind === 'transcribe' ? `批量转写 ${sourceNames.length} 个文件` : `批量压缩 ${sourceNames.length} 个视频`
        instruction = batchKind === 'transcribe' ? '全部转写' : '全部压缩'; source = sourceNames.join('、'); retry = null
      } else if (isVersionBundle) {
        kind = 'media'; label = '长视频多版本'; instruction = String(runtimeTask.spec?.instruction || '生成长视频多版本'); source = firstSourcePath
        retry = { kind: 'versions', instruction, sourcePath: firstSourcePath }
      } else if (isVisualEffects) {
        kind = 'media'; label = restoredBrandPackage ? `品牌包装 · ${restoredBrandPackage.template?.label || '品牌模板'}` : '专业画面效果'; instruction = String(runtimeTask.spec?.instruction || (restoredBrandPackage ? '生成品牌包装' : '应用视觉效果')); source = firstSourcePath
        retry = { kind: 'trim', instruction, sourcePath: firstSourcePath }
      } else if (isSmartReframe) {
        kind = 'media'; label = '三比例主体跟踪'; instruction = String(runtimeTask.spec?.instruction || '生成横屏、竖屏和方形版本'); source = firstSourcePath
        retry = { kind: 'trim', instruction, sourcePath: firstSourcePath }
      } else if (isVisualRepair) {
        kind = 'media'; label = '画面防抖与质量修复'; instruction = String(runtimeTask.spec?.instruction || '修复画面质量'); source = firstSourcePath
        retry = { kind: 'trim', instruction, sourcePath: firstSourcePath }
      } else if (isTimelineEdit) {
        const start = Number(trimDecision?.timeline?.startSeconds) || 0
        const end = Number(trimDecision?.timeline?.endSeconds) || 0
        const removesSegment = runtimeTask.type === 'media.edit-remove'
        const concatenatesSegments = runtimeTask.type === 'media.edit-concat'
        const segmentCount = trimDecision?.timeline?.segments?.length || 0
        const burnsSubtitles = runtimeTask.type === 'media.edit-burn-subtitles'
        kind = 'media'; label = burnsSubtitles ? '字幕预览与最终烧录逐条一致' : isRhythmEdit ? '节拍剪辑与高潮对齐' : concatenatesSegments ? `拼接 ${segmentCount} 个片段` : `${removesSegment ? '删除' : '保留'} ${start}–${end} 秒`; instruction = String(runtimeTask.spec?.instruction || (burnsSubtitles ? '预览并烧录字幕' : isRhythmEdit ? '按真实节拍切镜、高潮对齐并自然收束片尾' : concatenatesSegments ? `按顺序拼接 ${segmentCount} 个片段` : `${removesSegment ? '删除' : '保留'}第${start}秒到第${end}秒`)); source = firstSourcePath
        if (restoredPersonalSkill?.name) label += ` · ${restoredPersonalSkill.name}`
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
      } else if (isSubtitleTransform) {
        kind = 'media'; label = '批量字幕变换'; instruction = String(runtimeTask.spec?.instruction || '批量处理字幕'); source = firstSourcePath
        retry = { kind: 'trim', instruction, sourcePath: firstSourcePath }
      } else if (isSubtitleLayout) {
        kind = 'media'; label = '多比例字幕布局'; instruction = String(runtimeTask.spec?.instruction || '生成响应式字幕布局'); source = firstSourcePath
        retry = { kind: 'trim', instruction, sourcePath: firstSourcePath }
      } else if (isCompress) {
        kind = 'media'; label = compressMode === 'remux' ? '转码为 MP4' : `压缩到 ${Number(runtimeTask.spec?.targetMb) || 25}MB`
        instruction = compressMode === 'remux' ? '转码成 mp4' : `压缩到 ${Number(runtimeTask.spec?.targetMb) || 25}MB`; source = firstSourcePath
        retry = { kind: 'compress', instruction, sourcePath: firstSourcePath, targetMb: Number(runtimeTask.spec?.targetMb) || 25, mode: compressMode }
      } else if (isDedup) {
        kind = 'utility'; label = '重复文件检查'; instruction = '重复文件检查'; source = String(dedupRoot?.path || '')
        retry = { kind: 'dedup', instruction, directoryPath: source }
      }

      if (!existing) store.startTask({ id: runtimeTask.workspaceTaskId, kind, label, instruction, source, retry, budget: governanceBudget })
      if (runtimeTask.state === 'completed') {
        const fallbackSummary = isDocument ? '文档处理完成（已从检查点恢复）'
          : isAnalysis ? '视频解剖完成（已从检查点恢复）'
            : isOutcome ? '视频内容成果包完成（已从检查点恢复）'
            : isSubtitle ? '字幕生成完成（已从检查点恢复）'
              : isAiAssets ? 'AI素材包完成（已从来源与哈希检查点恢复）'
              : isCreative ? '创作任务完成（已从检查点恢复）'
                : isBatchEdit ? '批量编辑完成（成功项已交付，失败项已隔离）'
                : isBatch ? `批量${batchKind === 'transcribe' ? '转写' : '压缩'}完成（已从检查点恢复）`
                  : isVersionBundle ? '长视频多版本完成（已从共享证据检查点恢复）'
                  : isSmartReframe ? '三比例主体跟踪完成（已从冻结关键帧恢复）'
                  : isVisualRepair ? '画面质量修复完成（已从冻结修复决策恢复）'
                  : isVisualEffects ? (restoredBrandPackage ? '品牌包装完成（已从冻结模板恢复）' : '专业画面效果完成（已从冻结效果决策恢复）')
                  : isTimelineEdit ? '视频剪辑完成（已从冻结时间线恢复）'
                    : isSubtitleShift ? '字幕调时完成（已从冻结决策恢复）'
                      : isSubtitleTranslate ? '字幕翻译完成（已从冻结决策恢复）'
                        : isSubtitleCueEdit ? '字幕校对完成（已从冻结决策恢复）'
                          : isSubtitleTransform ? '批量字幕变换完成（已从冻结合同恢复）'
                            : isSubtitleLayout ? '多比例字幕布局完成（已从冻结布局恢复）'
                        : isCompress ? `${compressMode === 'remux' ? '转码' : '压缩'}完成（已从检查点恢复）`
                    : isDedup ? '重复文件检查完成（已从哈希检查点恢复）' : '视频下载完成（已从检查点恢复）'
        store.updateTask(runtimeTask.workspaceTaskId, {
          phase: 'completed', status: '', error: '', outputs: outputPaths, summary: String(runtimeTask.result?.summary || fallbackSummary),
          evidence: deliveryEvidence, budget: governanceBudget, quality: runtimeTask.quality || null, repairHistory: runtimeTask.repairHistory || [], failure: runtimeTask.failure || null
        })
        const aiShotPath = isAiAssets ? ((runtimeTask.result?.aiAssetReceipt as { artifacts?: Array<{ kind?: string; path?: string }> } | undefined)?.artifacts || []).find((item) => item.kind === 'shot')?.path : ''
        if ((isDownload || isCreative || isTimelineEdit || isBatchEdit || isVersionBundle || isVisualEffects || isSmartReframe || isVisualRepair || Boolean(aiShotPath)) && fromEvent && (aiShotPath || outputPaths[0]) && !surfacedOutputs.has(runtimeTask.id)) {
          surfacedOutputs.add(runtimeTask.id)
          window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: aiShotPath || outputPaths[0] }))
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
        error: '', budget: governanceBudget, quality: runtimeTask.quality || null, repairHistory: runtimeTask.repairHistory || [], failure: runtimeTask.failure || null
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
