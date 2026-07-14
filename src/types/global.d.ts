// 桌面端 Electron 注入的全局 API 类型声明
interface AiPlayerPlayerAPI {
  loadFile: (p: string) => Promise<boolean>
  play: () => Promise<boolean>
  pause: () => Promise<boolean>
  seek: (s: number) => Promise<boolean>
    setVolume: (v: number) => Promise<boolean>
    loadSubtitle: (p: string) => Promise<boolean>
    onEvent: (cb: (data: MpvEvent) => void) => () => void
}

interface AiPlayerAPI {
  platform: string
  isElectron: boolean
  version: string
  player?: AiPlayerPlayerAPI
  sync?: {
    url: () => Promise<string | null>
    setPeer: (url: string) => Promise<boolean>
    upload: () => Promise<{ success?: boolean; error?: string; count?: number }>
    download: () => Promise<{ success?: boolean; error?: string; count?: number }>
  }
  cast?: {
    scan: () => Promise<Array<{ id: string; name: string; location: string; controlUrl: string }>>
    cast: (deviceId: string, filePath: string) => Promise<{ success: boolean; action?: string; error?: string }>
  }
  tmdb?: {
    search: (name: string) => Promise<{ title: string; poster: string | null; overview: string; year: string | null } | null>
  }
  wifi?: {
    url: () => Promise<string | null>
  }
  print?: {
    file: (filePath: string) => Promise<{ success: boolean; action?: string; error?: string }>
  }
  files?: {
    scan: (dir?: string) => Promise<Array<{ name: string; path: string; ext: string; size: number }>>
    defaultDir: () => Promise<string>
  }
  ai?: {
    chat: (messages: Array<{ role: string; content: string }>) => Promise<{
      text: string
      toolResults: Array<{
        tool: string
        args: Record<string, unknown>
        result: unknown
      }>
    }>
  }
}

interface MpvEvent {
  event: string
  data: { name?: string; data?: unknown }
}

interface Window {
  aiPlayer?: AiPlayerAPI
}
