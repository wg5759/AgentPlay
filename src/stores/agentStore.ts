import { create } from 'zustand'

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

    const history = get()
      .messages.filter((m) => m.text !== '思考中…')
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))

    // 桌面端：调云端 Agent（function calling 控制播放）
    if (window.aiPlayer?.ai) {
      try {
        const result = await window.aiPlayer.ai.chat(history)
        let reply = result.text
        if (result.toolResults.length > 0) {
          const actions = result.toolResults
            .map((t) =>
              t.result && typeof t.result === 'object' && 'action' in t.result
                ? String((t.result as { action: unknown }).action)
                : t.tool
            )
            .join('；')
          reply += `\n[已执行] ${actions}`
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
