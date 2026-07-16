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
  openPanel: () => void
  closePanel: () => void
  toggleListening: () => void
  setInputText: (t: string) => void
  addMessage: (role: 'user' | 'agent', text: string) => void
  send: () => Promise<void>
}

export const useAgentStore = create<AgentState>((set, get) => ({
  open: false,
  listening: false,
  inputText: '',
  messages: [],
  thinking: false,
  openPanel: () => set({ open: true }),
  closePanel: () => set({ open: false }),
  toggleListening: () => set((s) => ({ listening: !s.listening })),
  setInputText: (t) => set({ inputText: t }),
  addMessage: (role, text) => set((s) => ({ messages: [...s.messages, { role, text }] })),
  send: async () => {
    const text = get().inputText.trim()
    if (!text) return
    get().addMessage('user', text)
    set({ inputText: '', thinking: true })
    get().addMessage('agent', '思考中…')

    const history = get()
      .messages.filter((m) => m.text !== '思考中…')
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))

    // 桌面端：调云端 Agent（function calling 控制播放）
    if (window.aiPlayer?.ai) {
      try {
        const apiKey = localStorage.getItem('aiplayer_api_key') || undefined
        const result = await window.aiPlayer.ai.chat(history, apiKey)
        set((s) => ({ messages: s.messages.filter((m) => m.text !== '思考中…') }))
        let reply = result.text
        if (result.toolResults.length > 0) {
          const ps = usePlayerStore.getState()
          const descs: string[] = []
          for (const t of result.toolResults) {
            const r = t.result as { action?: string; value?: unknown; desc?: string }
            if (r.desc) descs.push(r.desc)
            if (r.action === 'pause') usePlayerStore.setState({ isPlaying: false })
            else if (r.action === 'resume') usePlayerStore.setState({ isPlaying: true })
            else if (r.action === 'seek' && typeof r.value === 'number') ps.seek(r.value)
            else if (r.action === 'set_volume' && typeof r.value === 'number') ps.setVolume(r.value)
            else if (r.action === 'set_subtitle' && typeof r.value === 'boolean') usePlayerStore.setState({ subtitleVisible: r.value })
          }
          if (descs.length) reply += `\n[已执行] ${descs.join('；')}`
        }
        set({ thinking: false })
        get().addMessage('agent', reply)
      } catch (e) {
        set({ thinking: false })
        get().addMessage('agent', `[错误] ${e instanceof Error ? e.message : String(e)}`)
      }
    } else {
      // Web 端/无 API：占位
      set({ thinking: false })
      get().addMessage('agent', `[Web 端占位] 你说了："${text}"。桌面端 Agent 引擎可控制播放。`)
    }
  }
}))
