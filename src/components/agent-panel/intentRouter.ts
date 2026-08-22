import { usePlayerStore } from '../../stores/playerStore'
import { buildLinkChoice } from '../../link-choice-policy.mjs'
import type { LinkChoice } from '../../link-choice-policy.mjs'
import { canDispatchAgentTask } from '../../../electron/agent-runtime-policy.mjs'
import type { AgentMode } from '../../../electron/agent-runtime-policy.mjs'
import type { AgentAttachment } from './types'

type IntentRouterOptions = {
  inputText: string
  attachments: AgentAttachment[]
  agentMode: AgentMode
  addMessage: (role: 'user' | 'agent', text: string) => void
  setInputText: (value: string) => void
  setLinkChoice: (choice: LinkChoice | null) => void
  isVideoGenerationIntent: (text: string) => boolean
  runBatchTask: (text: string) => Promise<void>
  runCrossMaterialQuestion: (text: string) => Promise<boolean>
  runVideoGenTask: (text: string) => Promise<void>
  runEditHistoryTask: (text: string) => Promise<boolean>
  runTrimTask: (text: string) => Promise<boolean>
  runCompressTask: (text: string) => Promise<void>
  runDedupTask: (text: string) => Promise<void>
  runDocumentTask: () => Promise<void>
  runOutcomeWorkflow: () => Promise<void>
  setAnalysisFormat: (format: string) => void
  runAnalysisTask: () => Promise<void>
  send: (contextNote?: string) => Promise<void>
}

const BATCH_SCOPE_INTENT = /全部|批量|每个|逐一|一起/
const BATCH_ACTION_INTENT = /压缩|转写/
const COMPRESS_INTENT = /压缩|压到|视频太大|转码|转成 ?mp4|转换为 ?mp4/
const DEDUP_INTENT = /^去重|重复文件|查重/
const EDIT_WITHOUT_SOURCE_INTENT = /(?:剪一下|剪辑|裁剪|剪出|删除视频|删掉视频|(?:删除|删掉|保留|留下|拼接|重排)[\s\S]*(?:秒|分钟|片段))/
const LIBRARY_INTENTS: Array<[RegExp, string, string]> = [
  [/屏幕录制|开始录制|录屏/, 'record', '已打开屏幕录制（在媒体库页操作）'],
  [/整理建议|整理素材|素材整理/, 'organize', '正在生成素材整理建议'],
  [/^插件|^插件管理/, 'plugins', '已打开插件列表'],
  [/海报刮削|刮削海报|海报信息/, 'poster', '正在刮削海报信息']
]

export function createIntentRouter(options: IntentRouterOptions) {
  const {
    inputText, attachments, agentMode, addMessage, setInputText, setLinkChoice,
    isVideoGenerationIntent, runBatchTask, runCrossMaterialQuestion, runVideoGenTask, runEditHistoryTask, runTrimTask,
    runCompressTask, runDedupTask, runDocumentTask, runOutcomeWorkflow, setAnalysisFormat,
    runAnalysisTask, send
  } = options

  return async function routeTextSend(textOverride?: string) {
    const text = (textOverride ?? inputText).trim()
    const { videoSrc } = usePlayerStore.getState()
    if (!canDispatchAgentTask(agentMode)) {
      const context = [
        attachments.length > 0 ? `已附加文件：${attachments.map((file) => file.name).join('、')}` : '',
        videoSrc ? `当前媒体：${videoSrc}` : ''
      ].filter(Boolean).join('\n')
      await send(context)
      return
    }
    if (attachments.length > 0 && BATCH_SCOPE_INTENT.test(text) && BATCH_ACTION_INTENT.test(text) && window.aiPlayer?.mediaBatch) {
      await runBatchTask(text)
      return
    }
    if (await runCrossMaterialQuestion(text)) return
    if (attachments.length > 0) {
      await runDocumentTask()
      return
    }
    if (isVideoGenerationIntent(text)) {
      await runVideoGenTask(text)
      return
    }
    if ((!videoSrc || /^(https?|blob):/i.test(videoSrc)) && EDIT_WITHOUT_SOURCE_INTENT.test(text)) {
      addMessage('user', text)
      setInputText('')
      addMessage('agent', '请先打开或拖入要编辑的视频；素材明确后，我只会追问真正影响结果的一项。')
      return
    }
    if (videoSrc && !/^(https?|blob):/i.test(videoSrc) && window.aiPlayer?.mediaTools?.planHistory) {
      if (await runEditHistoryTask(text)) return
    }
    if (videoSrc && !/^(https?|blob):/i.test(videoSrc) && window.aiPlayer?.mediaTools?.planEdit) {
      if (await runTrimTask(text)) return
    }
    if (videoSrc && window.aiPlayer?.mediaTools && COMPRESS_INTENT.test(text)) {
      await runCompressTask(text)
      return
    }
    if (DEDUP_INTENT.test(text)) {
      await runDedupTask(text)
      return
    }
    const libraryHit = LIBRARY_INTENTS.find(([pattern]) => pattern.test(text))
    if (libraryHit) {
      addMessage('user', text)
      setInputText('')
      addMessage('agent', libraryHit[2])
      window.dispatchEvent(new CustomEvent('ai-player-action', { detail: libraryHit[1] }))
      return
    }
    if (text && window.aiPlayer?.linkContent) {
      try {
        const detected = await window.aiPlayer.linkContent.detect(text)
        if (detected?.matched && detected.url && !['video-site', 'media'].includes(detected.kind)) {
          addMessage('user', text)
          setInputText('')
          const result = await window.aiPlayer.linkContent.handle({ url: detected.url, instruction: text })
          if (!result.success) {
            addMessage('agent', result.controlled ? `这个链接需要登录、订阅或额外权限，不能绕过访问控制。\n${result.reason || ''}` : `[错误] ${result.error || '公开链接暂时无法处理'}`)
            return
          }
          if (result.outputPath) {
            const attached = await window.aiPlayer.chat?.attachPaths([result.outputPath])
            if (attached?.documents?.length) window.dispatchEvent(new CustomEvent('ai-player-attach-docs', { detail: attached.documents }))
          }
          const evidence = (result.evidence || []).slice(0, 3).map((item) => `- 网页第 ${String(item.locator?.paragraph || '?')} 段：${item.excerpt}`).join('\n')
          const body = result.action === 'translate' ? result.translated : result.excerpt
          addMessage('agent', [`已识别 ${result.kind || detected.kind}：${result.title || detected.host || detected.url}`, body || '', evidence, result.action === 'project' ? `已加入项目 ${result.projectCapsule?.projectId || ''}` : '', result.action === 'download' ? `已下载并作为附件打开：${result.outputPath}` : ''].filter(Boolean).join('\n'))
          return
        }
      } catch { /* 公开链接识别失败时继续原有视频下载或普通对话 */ }
    }
    if (text && window.aiPlayer?.mediaDownload) {
      try {
        const detection = await window.aiPlayer.mediaDownload.detect(text)
        if (detection?.matched && detection.url) {
          addMessage('user', text)
          setInputText('')
          setLinkChoice(buildLinkChoice(detection, text))
          return
        }
      } catch { /* 链接检测失败时继续当前视频分析 */ }
    }
    if (text && videoSrc && !/^(https?|blob):/i.test(videoSrc) && window.aiPlayer?.outcomeWorkflow) {
      try {
        const outcome = await window.aiPlayer.outcomeWorkflow.detect({ sourcePath: videoSrc, instruction: text })
        if (outcome?.matched) {
          await runOutcomeWorkflow()
          return
        }
      } catch { /* 多成果编排不可用时继续普通拉片或对话 */ }
    }
    if (text && videoSrc && !/^(https?|blob):/i.test(videoSrc) && window.aiPlayer?.analysis) {
      try {
        const detection = await window.aiPlayer.analysis.detect(text)
        if (detection?.matched) {
          setAnalysisFormat(detection.outputFormat)
          await runAnalysisTask()
          return
        }
      } catch { /* 视频检测失败时退回普通对话 */ }
    }
    void send()
  }
}
