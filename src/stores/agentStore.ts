import { create } from 'zustand'
import { usePlayerStore } from './playerStore'

export interface AgentMessage {
  role: 'user' | 'agent'
  text: string
}

interface AgentState {
  open: boolean
  listening: boolean
  inputText: string
  messages: AgentMessage[]
  thinking: boolean
  activeRequestId: string | null
  openPanel: () => void
  closePanel: () => void
  toggleListening: () => void
  setListening: (v: boolean) => void
  setInputText: (t: string) => void
  addMessage: (role: 'user' | 'agent', text: string) => void
  send: () => Promise<void>
  cancel: () => void
}

export const useAgentStore = create<AgentState>((set, get) => ({
  open: false,
  listening: false,
  inputText: '',
  messages: [],
  thinking: false,
  activeRequestId: null,
  openPanel: () => set({ open: true }),
  closePanel: () => set({ open: false }),
  toggleListening: () => set((s) => ({ listening: !s.listening })),
  setListening: (v) => set({ listening: v }),
  setInputText: (t) => set({ inputText: t }),
  addMessage: (role, text) => set((s) => ({ messages: [...s.messages, { role, text }] })),
  cancel: () => {
    const requestId = get().activeRequestId
    if (requestId) void window.aiPlayer?.ai?.cancel(requestId)
  },
  send: async () => {
    const text = get().inputText.trim()
    if (!text) return
    get().addMessage('user', text)
    const requestId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    set({ inputText: '', thinking: true, activeRequestId: requestId })
    get().addMessage('agent', '思考中…')

    const history = get()
      .messages.filter((m) => m.text !== '思考中…')
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))

    // 桌面端：调云端 Agent（function calling 控制播放）
    if (window.aiPlayer?.ai) {
      let streamedText = ''
      const offStream = window.aiPlayer.ai.onStream((event) => {
        if (event.requestId !== requestId) return
        if (event.delta) streamedText += event.delta
        const statusText: Record<string, string> = {
          queued: '请求已排队…', connecting: '正在连接模型…', loading: '模型正在加载…',
          'loading-local-model': '正在校验并启动内置离线模型…'
        }
        set((state) => {
          const messages = [...state.messages]
          const last = messages[messages.length - 1]
          if (last?.role === 'agent') {
            messages[messages.length - 1] = { ...last, text: streamedText || statusText[event.status || ''] || last.text }
          }
          return { messages }
        })
      })
      try {
        const player = usePlayerStore.getState()
        const result = await window.aiPlayer.ai.chat(history, {
          name: player.mediaName,
          path: player.videoSrc,
          currentTime: player.currentTime,
          duration: player.duration,
          volume: player.volume,
          lastAudibleVolume: player.lastAudibleVolume,
          playbackRate: player.playbackRate,
          pictureMode: player.pictureMode,
          subtitleVisible: player.subtitleVisible,
          isFullscreen: player.isFullscreen
        }, requestId)
        let reply = result.text
        if ((result.toolResults || []).length > 0) {
          const ps = usePlayerStore.getState()
          const descs: string[] = []
          for (const t of result.toolResults || []) {
            const r = t.result as { action?: string; value?: unknown; desc?: string }
            if (r.desc) descs.push(r.desc)
            if (r.action === 'pause') {
              usePlayerStore.setState({ isPlaying: false })
              void window.aiPlayer?.player?.pause()
            } else if (r.action === 'resume') {
              usePlayerStore.setState({ isPlaying: true })
              void window.aiPlayer?.player?.play()
            } else if (r.action === 'seek' && typeof r.value === 'number') {
              ps.seek(r.value)
              void window.aiPlayer?.player?.seek(r.value)
            } else if (r.action === 'set_volume' && typeof r.value === 'number') {
              ps.setVolume(r.value)
              void window.aiPlayer?.player?.setVolume(r.value)
            } else if (r.action === 'set_subtitle' && typeof r.value === 'boolean') {
              usePlayerStore.setState({ subtitleVisible: r.value })
              void window.aiPlayer?.player?.setSubtitleVisible(r.value)
            } else if (r.action === 'set_speed' && typeof r.value === 'number') {
              ps.setPlaybackRate(r.value)
              void window.aiPlayer?.player?.setSpeed(r.value)
            } else if (r.action === 'set_picture_mode' && typeof r.value === 'string') {
              window.dispatchEvent(new CustomEvent('ai-player-action', { detail: `picture-${r.value}` }))
            } else if (r.action === 'set_window_preset' && typeof r.value === 'string') {
              window.dispatchEvent(new CustomEvent('ai-player-action', { detail: `window-${r.value}` }))
            } else if (r.action === 'screenshot') {
              window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'screenshot' }))
            } else if (r.action === 'load_subtitle' && typeof r.value === 'string') {
              void window.aiPlayer?.player?.loadSubtitle(r.value)
            } else if (r.action === 'print_file' && typeof r.value === 'string') {
              void window.aiPlayer?.print?.file(r.value)
            }
          }
          if (descs.length) reply += `\n[已执行] ${descs.join('；')}`
        }
        if (result.cancelled && !reply) reply = '已取消生成。'
        set((state) => {
          const messages = [...state.messages]
          const last = messages[messages.length - 1]
          if (last?.role === 'agent') messages[messages.length - 1] = { ...last, text: reply }
          return { messages, thinking: false, activeRequestId: null }
        })
      } catch (e) {
        set((state) => {
          const messages = [...state.messages]
          const last = messages[messages.length - 1]
          const errorText = `[错误] ${e instanceof Error ? e.message : String(e)}`
          if (last?.role === 'agent') messages[messages.length - 1] = { ...last, text: errorText }
          return { thinking: false, activeRequestId: null, messages }
        })
      } finally {
        offStream()
      }
    } else {
      set((state) => {
        const messages = [...state.messages]
        messages[messages.length - 1] = { role: 'agent', text: 'Web 端尚未连接 AI 服务；本地播放与文件预览仍可正常使用。' }
        return { thinking: false, activeRequestId: null, messages }
      })
    }
  }
}))
