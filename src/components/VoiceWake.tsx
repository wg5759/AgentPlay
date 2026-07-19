import { useEffect } from 'react'
import { useAgentStore } from '../stores/agentStore'

interface SpeechRecognitionInstance {
  continuous: boolean
  lang: string
  interimResults: boolean
  onresult: (e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void
  onerror: (() => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

export default function VoiceWake({ enabled }: { enabled: boolean }) {
  const openPanel = useAgentStore((s) => s.openPanel)
  const panelOpen = useAgentStore((s) => s.open)

  useEffect(() => {
    if (!enabled || panelOpen) return
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionInstance
      webkitSpeechRecognition?: new () => SpeechRecognitionInstance
    }
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition
    if (!SR) {
      console.warn('[VoiceWake] 不支持 Web Speech API，语音唤醒不可用')
      return
    }
    const rec = new SR()
    rec.continuous = true
    rec.lang = 'zh-CN'
    rec.interimResults = false
    let active = true
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i][0].transcript
        if (/嘿[，,\s]*播放器/.test(text)) {
          openPanel()
        }
      }
    }
    let retries = 0
    const MAX_RETRIES = 5
    rec.onerror = () => {
      if (active && retries++ < MAX_RETRIES) {
        setTimeout(() => { try { rec.start() } catch { /* */ } }, 1000 * retries)
      }
    }
    rec.onend = () => {
      if (active && retries < MAX_RETRIES) {
        setTimeout(() => { try { rec.start() } catch { /* */ } }, 500)
      }
    }
    try {
      rec.start()
      console.log('[VoiceWake] 语音唤醒已启动，说"嘿播放器"唤起 Agent')
    } catch {
      console.warn('[VoiceWake] 启动失败（可能需授权麦克风）')
    }
    return () => {
      active = false
      try { rec.stop() } catch { /* */ }
    }
  }, [enabled, openPanel, panelOpen])

  return null
}
