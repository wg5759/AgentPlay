import { usePlayerStore } from './stores/playerStore'

export interface AgentToolActionResult {
  success?: boolean
  error?: string
  action?: string
  value?: unknown
  desc?: string
  verified?: boolean
  execution?: 'main' | 'renderer'
}

export interface AgentToolReceipt {
  tool: string
  success: boolean
  verified: boolean
  label: string
  evidence: string
}

export async function applyAgentToolResult(tool: string, result: AgentToolActionResult): Promise<AgentToolReceipt> {
  if (result.success === false || result.error) {
    return { tool, success: false, verified: false, label: result.desc || tool, evidence: result.error || '工具执行失败' }
  }
  if (result.execution === 'main' && result.verified === true) {
    return { tool, success: true, verified: true, label: result.desc || tool, evidence: '主进程结果已验证' }
  }

  const player = usePlayerStore.getState()
  try {
    switch (result.action) {
      case 'pause':
        usePlayerStore.setState({ isPlaying: false })
        await window.aiPlayer?.player?.pause()
        return { tool, success: true, verified: usePlayerStore.getState().isPlaying === false, label: result.desc || '暂停', evidence: '播放器状态：已暂停' }
      case 'resume':
        usePlayerStore.setState({ isPlaying: true })
        await window.aiPlayer?.player?.play()
        return { tool, success: true, verified: usePlayerStore.getState().isPlaying === true, label: result.desc || '继续播放', evidence: '播放器状态：播放中' }
      case 'seek': {
        const value = Number(result.value) || 0
        player.seek(value)
        await window.aiPlayer?.player?.seek(value)
        return { tool, success: true, verified: Math.abs(usePlayerStore.getState().currentTime - value) < 0.1, label: result.desc || '跳转', evidence: `播放位置：${value} 秒` }
      }
      case 'set_volume': {
        const value = Number(result.value) || 0
        player.setVolume(value)
        await window.aiPlayer?.player?.setVolume(value)
        return { tool, success: true, verified: usePlayerStore.getState().volume === value, label: result.desc || '设置音量', evidence: `播放器音量：${value}` }
      }
      case 'set_subtitle': {
        const value = Boolean(result.value)
        usePlayerStore.setState({ subtitleVisible: value })
        await window.aiPlayer?.player?.setSubtitleVisible(value)
        return { tool, success: true, verified: usePlayerStore.getState().subtitleVisible === value, label: result.desc || '设置字幕', evidence: `字幕状态：${value ? '显示' : '隐藏'}` }
      }
      case 'set_speed': {
        const value = Number(result.value) || 1
        player.setPlaybackRate(value)
        await window.aiPlayer?.player?.setSpeed(value)
        return { tool, success: true, verified: usePlayerStore.getState().playbackRate === value, label: result.desc || '设置倍速', evidence: `播放倍速：${value}` }
      }
      case 'set_picture_mode': {
        const value = String(result.value || 'fit') as 'original' | 'fit' | 'fill' | 'stretch'
        player.setPictureMode(value)
        window.dispatchEvent(new CustomEvent('ai-player-action', { detail: `picture-${value}` }))
        return { tool, success: true, verified: usePlayerStore.getState().pictureMode === value, label: result.desc || '设置画面', evidence: `画面模式：${value}` }
      }
      case 'set_window_preset':
        window.dispatchEvent(new CustomEvent('ai-player-action', { detail: `window-${String(result.value || 'original')}` }))
        return { tool, success: true, verified: false, label: result.desc || '设置窗口', evidence: '窗口命令已发送，需以可见窗口状态确认' }
      case 'screenshot':
        window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'screenshot' }))
        return { tool, success: true, verified: false, label: result.desc || '截图', evidence: '已打开保存流程，保存文件后才算完成' }
      case 'load_subtitle': {
        const ok = await window.aiPlayer?.player?.loadSubtitle(String(result.value || ''))
        return { tool, success: Boolean(ok), verified: Boolean(ok), label: result.desc || '加载字幕', evidence: ok ? '播放内核已接收字幕' : '播放内核未确认字幕' }
      }
      case 'print_file': {
        const printed = await window.aiPlayer?.print?.file(String(result.value || ''))
        return { tool, success: printed?.success === true, verified: printed?.success === true, label: result.desc || '打印', evidence: printed?.success ? '打印流程已由主进程确认' : printed?.error || '打印未确认' }
      }
      case 'start_batch_transcribe':
      case 'start_compress_video':
      case 'start_trim_video':
      case 'start_remove_video_segment':
      case 'start_edit_history':
      case 'start_duplicate_scan':
        window.dispatchEvent(new CustomEvent('ai-player-agent-media-task', {
          detail: { action: result.action, value: result.value || {} }
        }))
        return { tool, success: true, verified: false, label: result.desc || tool, evidence: '已进入统一工作区任务入口；成果落盘后再验证' }
      case 'start_advanced_document_ocr':
        window.dispatchEvent(new CustomEvent('ai-player-agent-document-task', {
          detail: { action: result.action, value: result.value || {} }
        }))
        return { tool, success: true, verified: false, label: result.desc || tool, evidence: '已进入高级文档解析任务入口；识别结果落盘后再验证' }
      case 'start_cross_material_qa':
        window.dispatchEvent(new CustomEvent('ai-player-agent-cross-material', { detail: result.value || {} }))
        return { tool, success: true, verified: false, label: result.desc || tool, evidence: '已进入跨素材证据问答；回答通过引用校验后再确认' }
      default:
        return { tool, success: true, verified: result.verified === true, label: result.desc || tool, evidence: result.verified ? '工具结果已验证' : '工具返回结果，但没有可复查状态' }
    }
  } catch (error) {
    return { tool, success: false, verified: false, label: result.desc || tool, evidence: error instanceof Error ? error.message : String(error) }
  }
}
