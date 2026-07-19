import { useEffect, useState } from 'react'
import { useAgentStore } from '../stores/agentStore'

interface SpeechRecognitionResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>
}

interface SpeechRecognitionInstance {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null
  onerror: (() => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

export default function AgentPanel() {
  const { messages, inputText, setInputText, send, cancel, thinking, closePanel, listening, toggleListening, setListening } =
    useAgentStore()
  const [tmdbKey, setTmdbKey] = useState(() => localStorage.getItem('aiplayer_tmdb_key') || '')
  const [subtitleKey, setSubtitleKey] = useState(() => localStorage.getItem('aiplayer_subtitle_key') || '')
  const [showServiceEdit, setShowServiceEdit] = useState(false)
  const [modelLabel, setModelLabel] = useState('尚未配置模型')
  const saveOtherServices = () => {
    localStorage.setItem('aiplayer_tmdb_key', tmdbKey)
    localStorage.setItem('aiplayer_subtitle_key', subtitleKey)
    setShowServiceEdit(false)
  }

  useEffect(() => {
    window.aiPlayer?.models?.config('chat').then((config) => {
      if (config) setModelLabel(`${config.providerId} / ${config.model}${config.hasApiKey ? ' · Key 已加密保存' : ''}`)
    })
  }, [])

  useEffect(() => {
    if (!listening) return
    const speechWindow = window as typeof window & {
      SpeechRecognition?: new () => SpeechRecognitionInstance
      webkitSpeechRecognition?: new () => SpeechRecognitionInstance
    }
    const Recognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition
    if (!Recognition) {
      setListening(false)
      return
    }
    const recognition = new Recognition()
    recognition.lang = 'zh-CN'
    recognition.continuous = false
    recognition.interimResults = false
    recognition.onresult = (event) => {
      const text = event.results[0]?.[0]?.transcript?.trim()
      if (text) {
        useAgentStore.getState().setInputText(text)
        void useAgentStore.getState().send()
      }
    }
    recognition.onerror = () => setListening(false)
    recognition.onend = () => setListening(false)
    try {
      recognition.start()
    } catch {
      setListening(false)
    }
    return () => {
      try { recognition.stop() } catch { /* already stopped */ }
    }
  }, [listening, setListening])

  return (
    <div
      className="absolute inset-0 z-50 flex items-end justify-center bg-black/40"
      onClick={closePanel}
    >
      <div
        className="w-full max-w-lg h-96 mb-20 bg-player-surface/95 backdrop-blur-md rounded-2xl border border-white/10 flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <span className="text-sm text-gray-300">AI Agent</span>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleListening}
              className={`w-8 h-8 rounded-full flex items-center justify-center ${
                listening ? 'bg-red-500 animate-pulse' : 'bg-player-accent'
              }`}
            >
              🎙️
            </button>
            <button onClick={closePanel} className="text-gray-400 hover:text-white">
              ✕
            </button>
          </div>
        </div>

        <div className="px-4 py-2 border-b border-white/10 flex items-center justify-between gap-3">
          <span className="text-xs text-gray-500 truncate">{modelLabel}</span>
          <div className="flex items-center gap-3 shrink-0">
            <button onClick={() => window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'model-center' }))} className="text-xs text-player-accent">模型接入中心</button>
            <button onClick={() => window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'computer-use' }))} className="text-xs text-amber-400">电脑观察</button>
            <button onClick={() => setShowServiceEdit((value) => !value)} className="text-xs text-gray-400">海报/字幕 Key</button>
          </div>
        </div>
        {showServiceEdit && (
          <div className="px-4 py-3 border-b border-white/10">
            <p className="text-xs text-gray-400 mb-2">可选的媒体信息服务</p>
            <div className="grid grid-cols-1 gap-2">
              <input
                type="password"
                value={tmdbKey}
                onChange={(e) => setTmdbKey(e.target.value)}
                placeholder="TMDB key（可选，海报刮削）"
                className="w-full bg-black/40 rounded px-2 py-1 text-xs outline-none"
              />
              <input
                type="password"
                value={subtitleKey}
                onChange={(e) => setSubtitleKey(e.target.value)}
                placeholder="OpenSubtitles API key（可选）"
                className="w-full bg-black/40 rounded px-2 py-1 text-xs outline-none"
              />
              <button onClick={saveOtherServices} className="px-3 py-1 bg-player-accent rounded text-xs">
                保存配置
              </button>
            </div>
          </div>
        )}

        {/* 输入框（置顶） */}
        <div className="px-4 py-3 border-b border-white/10 flex gap-2">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !thinking && send()}
            placeholder="打字或点麦克风说话…"
            className="flex-1 bg-black/40 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 ring-player-accent"
          />
          <button onClick={thinking ? cancel : send} className={`px-4 py-2 rounded-lg text-sm ${thinking ? 'bg-red-600' : 'bg-player-accent'}`}>
            {thinking ? '停止' : '发送'}
          </button>
        </div>

        {/* 消息列表 */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {messages.length === 0 && (
            <p className="text-gray-500 text-sm text-center mt-8">
              说点什么，比如"放上周的纪录片"
            </p>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              className={`text-sm ${m.role === 'user' ? 'text-white text-right' : 'text-gray-300'}`}
            >
              {m.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
