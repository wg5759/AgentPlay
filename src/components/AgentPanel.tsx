import { useState } from 'react'
import { useAgentStore } from '../stores/agentStore'

export default function AgentPanel() {
  const { messages, inputText, setInputText, send, closePanel, listening, toggleListening } =
    useAgentStore()
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('aiplayer_api_key') || '')
  const [tmdbKey, setTmdbKey] = useState(() => localStorage.getItem('aiplayer_tmdb_key') || '')
  const saveKey = () => {
    localStorage.setItem('aiplayer_api_key', apiKey)
    localStorage.setItem('aiplayer_tmdb_key', tmdbKey)
  }

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

        {!apiKey && (
          <div className="px-4 py-3 border-b border-white/10">
            <p className="text-xs text-gray-400 mb-2">配置 API Key（DeepSeek 或火山方舟）</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-...（DeepSeek 或火山方舟）"
                className="flex-1 bg-black/40 rounded px-2 py-1 text-xs outline-none"
              />
              <button onClick={saveKey} className="px-3 py-1 bg-player-accent rounded text-xs">
                保存
              </button>
              <input
                type="text"
                value={tmdbKey}
                onChange={(e) => setTmdbKey(e.target.value)}
                placeholder="TMDB key（可选，海报刮削）"
                className="flex-1 bg-black/40 rounded px-2 py-1 text-xs outline-none mt-1"
              />
            </div>
          </div>
        )}

        {/* 输入框（置顶） */}
        <div className="px-4 py-3 border-b border-white/10 flex gap-2">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder="打字或点麦克风说话…"
            className="flex-1 bg-black/40 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 ring-player-accent"
          />
          <button onClick={send} className="px-4 py-2 bg-player-accent rounded-lg text-sm">
            发送
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
