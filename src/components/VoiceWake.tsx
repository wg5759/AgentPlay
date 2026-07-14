import { useEffect } from 'react'
import { useAgentStore } from '../stores/agentStore'

// 双唤醒机制：
// 1. 语音热词"嘿播放器"（桌面 faster-whisper / Web Web Speech API）-- 后台低功耗监听
// 2. 点麦克风（PlayerControls / AgentPanel 中触发）-- openPanel()
//
// MVP 占位：先检测能力，正式热词检测待 Phase 1 实现（避免持续录音耗电）
export default function VoiceWake() {
  const openPanel = useAgentStore((s) => s.openPanel)

  useEffect(() => {
    const hasWebSpeech =
      'SpeechRecognition' in window || 'webkitSpeechRecognition' in window
    if (!hasWebSpeech) {
      console.warn(
        '[VoiceWake] 当前环境不支持 Web Speech API，桌面端将用 faster-whisper 做热词检测'
      )
    }
    // TODO Phase 1: 持续监听"嘿播放器"热词，命中后 openPanel()
    // 桌面端：faster-whisper small 模型，VAD 触发，只识别热词
    // Web 端：Web Speech API continuous 模式
  }, [openPanel])

  return null // 无 UI，纯后台监听
}
