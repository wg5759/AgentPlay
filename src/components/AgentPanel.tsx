import { useEffect, useRef, useState } from 'react'
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
  const { messages, inputText, setInputText, send, cancel, thinking, closePanel, listening, toggleListening, setListening, addMessage } =
    useAgentStore()
  const [attachments, setAttachments] = useState<Array<{ token: string; name: string; ext: string; size: number }>>([])
  const [docCaps, setDocCaps] = useState<{ modelConfigured: boolean; modelLocal: boolean; providerName: string; model: string } | null>(null)
  const [docBusy, setDocBusy] = useState(false)
  const [docStatus, setDocStatus] = useState('')
  const [docOutputs, setDocOutputs] = useState<string[]>([])
  const [needsApproval, setNeedsApproval] = useState(false)
  const [cloudApproved, setCloudApproved] = useState(false)
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  const docRequestIdRef = useRef('')
  const runDocTaskRef = useRef<(forceApprove?: boolean) => Promise<void>>(async () => {})
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
    const off = window.aiPlayer?.documents?.onStatus((event) => {
      if (event.requestId === docRequestIdRef.current) setDocStatus(event.status)
    })
    return off
  }, [])

  const openAny = async () => {
    const result = await window.aiPlayer?.chat?.openAny?.()
    if (!result) return
    if (result.media?.length) {
      window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: result.media[0] }))
      closePanel()
    }
    if (result.documents?.length) {
      setAttachments((current) => [...current, ...result.documents])
      if (!docCaps) {
        const caps = await window.aiPlayer?.documents?.capabilities()
        if (caps) setDocCaps(caps)
      }
    }
  }

  const runDocTask = async (forceApprove = false) => {
    const api = window.aiPlayer?.documents
    const instruction = inputText.trim()
    if (!api || !instruction || docBusy) return
    const files = attachments
    addMessage('user', `${instruction}\n（附件：${files.map((file) => file.name).join('、')}）`)
    setInputText('')
    setDocBusy(true)
    setDocStatus('正在分析任务')
    setDocOutputs([])
    try {
      const caps = docCaps || (await api.capabilities()) || null
      if (caps && !docCaps) setDocCaps(caps)
      const tokens = files.map((file) => file.token)
      const preview = await api.plan({ tokens, instruction, outputFormat: 'auto' })
      if (preview.requiresAi && caps && !caps.modelConfigured) {
        throw new Error('这个任务需要模型理解或生成内容，请先在模型接入中心配置模型。')
      }
      if (preview.requiresAi && caps && !caps.modelLocal && !(cloudApproved || forceApprove)) {
        setNeedsApproval(true)
        return
      }
      const requestId = `document-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      docRequestIdRef.current = requestId
      const result = await api.run({ tokens, instruction, outputFormat: 'auto', cloudApproved: cloudApproved || forceApprove, requestId })
      if (!result.success) throw new Error(result.error || '文档处理失败')
      addMessage('agent', result.summary || '处理完成')
      setDocOutputs(result.outputs || [])
      setAttachments([])
      setNeedsApproval(false)
      setCloudApproved(false)
    } catch (error) {
      addMessage('agent', `[错误] ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setDocBusy(false)
      setDocStatus('')
    }
  }
  runDocTaskRef.current = runDocTask

  const cancelDocTask = async () => {
    if (docRequestIdRef.current) await window.aiPlayer?.documents?.cancel(docRequestIdRef.current)
    setDocStatus('正在取消')
  }

  const handleSend = () => {
    if (attachments.length > 0) {
      void runDocTask()
      return
    }
    void send()
  }

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
        if (attachmentsRef.current.length > 0) void runDocTaskRef.current()
        else void useAgentStore.getState().send()
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

        {attachments.length > 0 && (
          <div className="px-4 py-2 border-b border-white/10 flex flex-wrap gap-2">
            {attachments.map((file) => (
              <span key={file.token} className="flex items-center gap-2 rounded-lg border border-blue-400/20 bg-blue-500/10 px-2 py-1 text-xs text-blue-200">
                <span className="font-semibold uppercase">{file.ext.slice(1)}</span>
                <span className="max-w-40 truncate">{file.name}</span>
                <button onClick={() => setAttachments((current) => current.filter((item) => item.token !== file.token))} className="text-blue-300 hover:text-white">✕</button>
              </span>
            ))}
          </div>
        )}
        {needsApproval && (
          <div className="flex items-center gap-2 border-b border-amber-400/20 bg-amber-400/[0.06] px-4 py-2 text-xs text-amber-100">
            <label className="flex flex-1 cursor-pointer items-center gap-2">
              <input type="checkbox" checked={cloudApproved} onChange={(event) => setCloudApproved(event.target.checked)} />
              允许把本次所选文件内容发送给当前云端模型
            </label>
            <button disabled={!cloudApproved || docBusy} onClick={() => { setNeedsApproval(false); void runDocTask(true) }} className="rounded bg-amber-600 px-3 py-1 text-white disabled:opacity-40">继续执行</button>
          </div>
        )}

        {/* 输入框（置顶） */}
        <div className="px-4 py-3 border-b border-white/10 flex gap-2">
          <button onClick={openAny} title="打开文件（视频、音频、图片或文档）" className="w-9 h-9 shrink-0 rounded-lg bg-white/10 hover:bg-white/15 flex items-center justify-center text-base">📎</button>
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !thinking && !docBusy && handleSend()}
            placeholder={attachments.length ? '说对这些附件要做什么…' : '打字或点麦克风说话…'}
            className="flex-1 bg-black/40 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 ring-player-accent"
          />
          <button onClick={docBusy ? cancelDocTask : thinking ? cancel : handleSend} className={`px-4 py-2 rounded-lg text-sm ${docBusy || thinking ? 'bg-red-600' : 'bg-player-accent'}`}>
            {docBusy || thinking ? '停止' : '发送'}
          </button>
        </div>

        {/* 消息列表 */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {messages.length === 0 && (
            <p className="text-gray-500 text-sm text-center mt-8">
              说点什么，或点 📎 打开视频和文档
            </p>
          )}
          {(docBusy || docOutputs.length > 0) && (
            <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/[0.07] p-3">
              {docBusy && <p className="text-xs text-slate-300"><span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-blue-400" />{docStatus || '正在处理…'}</p>}
              {docOutputs.length > 0 && <div className="mt-1 space-y-1">{docOutputs.map((output) => (
                <button key={output} onClick={() => void window.aiPlayer?.system?.openPath(output)} className="block w-full truncate rounded bg-black/20 px-2 py-1.5 text-left text-xs text-emerald-200 hover:bg-black/30" title={output}>打开结果：{output}</button>
              ))}</div>}
            </div>
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
