declare module '*.mjs' {
  export const PLAYER_CHROME_HIDE_DELAY_MS: number
  export function shouldAutoHideControls(input: { hasMedia?: boolean; playing: boolean; blocked?: boolean }): boolean
}

// 桌面端 Electron 注入的全局 API 类型声明
interface AiPlayerPlayerAPI {
  info: () => Promise<{ ready: boolean; embedded: boolean; available: boolean }>
  loadFile: (p: string) => Promise<boolean>
  play: () => Promise<boolean>
  pause: () => Promise<boolean>
  seek: (s: number) => Promise<boolean>
  setVolume: (v: number) => Promise<boolean>
  setSpeed: (v: number) => Promise<boolean>
  setPictureMode: (mode: 'original' | 'fit' | 'fill' | 'stretch') => Promise<boolean>
  loadSubtitle: (p: string) => Promise<boolean>
  setSubtitleVisible: (v: boolean) => Promise<boolean>
  stop: () => Promise<boolean>
  screenshot: (suggestedName: string) => Promise<boolean>
  setPlayerArea: (rect: { x: number; y: number; width: number; height: number }) => void
  showContainer: () => void
  hideContainer: () => void
  onEvent: (cb: (data: MpvEvent) => void) => () => void
  onRemeasure: (cb: () => void) => () => void
}

interface AiPlayerAPI {
  platform: string
  isElectron: boolean
  version: string
  player?: AiPlayerPlayerAPI
  sync?: {
    url: () => Promise<string | null>
    stop: () => Promise<boolean>
    setPeer: (url: string) => Promise<boolean>
    upload: () => Promise<{ success?: boolean; error?: string; count?: number }>
    download: () => Promise<{ success?: boolean; error?: string; count?: number }>
    getProgress: (key: string) => Promise<{ position: number; preferences?: { volume?: number; subtitleVisible?: boolean }; updatedAt: number } | null>
    setProgress: (key: string, position: number, preferences: { volume: number; subtitleVisible: boolean }) => Promise<boolean>
  }
  cast?: {
    scan: () => Promise<Array<{ id: string; name: string; location: string; controlUrl: string }>>
    cast: (deviceId: string, filePath: string) => Promise<{ success: boolean; action?: string; error?: string }>
  }
  tmdb?: {
    search: (name: string, apiKey?: string) => Promise<{ success: boolean; data?: { title: string; poster: string | null; overview: string; year: string | null }; error?: string }>
  }
  wifi?: {
    url: () => Promise<string | null>
    pin: () => Promise<string | null>
    stop: () => Promise<boolean>
  }
  dlna?: {
    serverUrl: () => Promise<string | null>
    stopServer: () => Promise<boolean>
  }
  plugin?: {
    list: () => Promise<Array<{ name: string; version?: string; description?: string; tools?: unknown[]; error?: string; file: string }>>
    openFolder: () => Promise<{ success: boolean; error?: string }>
  }
  media?: {
    analyze: (dir?: string) => Promise<{
      files: Array<{ name: string; path: string; ext: string; type: string; size: number; tags: string[]; group: string }>
      clusters: Record<string, unknown[]>
    }>
    dedup: (dir?: string) => Promise<Array<{ original: string; duplicate: string; name: string }>>
    suggest: (dir?: string) => Promise<Array<{ tag: string; count: number; files: string[]; suggestion: string }>>
  }
  studio?: {
    capabilities: () => Promise<{ platform: string; multimodalPlanning: boolean; cloudImage: boolean; cloudVoice: boolean; systemVoice: boolean; advancedRender: boolean; renderBinary: string | null }>
    context: (mediaPath: string) => Promise<{
      subtitlePath: string | null
      cues: Array<{ start: number; end: number; text: string }>
      transcript: string
    }>
    offlineAnalysis: (input: {
      mediaName: string | null
      duration: number
      markers: Array<{
        id: string
        at: number
        thumbnail?: string
        shotSize: string
        movement: string
        function: string
        emotion: string
        note: string
      }>
      cues: Array<{ start: number; end: number; text: string }>
    }) => Promise<string>
    exportProject: (project: Record<string, unknown>) => Promise<{ success: boolean; cancelled?: boolean; outputPath?: string }>
    render: (input: {
      mediaName: string | null
      sourcePath: string
      segments: Array<{ start: number; end: number }>
    }) => Promise<{ success: boolean; cancelled?: boolean; outputPath?: string; bytes?: number }>
    creativePlan: (input: Record<string, unknown>) => Promise<{
      version: number
      title: string
      hook: string
      narration: string
      musicBrief: string
      subtitleStyle: 'clean' | 'impact' | 'documentary'
      deepAnalysis: { narrative: string; visual: string; editing: string; audio: string; hook: string; weaknesses: string[] }
      modality: 'text-evidence' | 'vision+text-evidence'
      provider?: string
      model?: string
      visualEvidenceCount?: number
      visualFallbackReason?: string
      riskNotes: string[]
      shots: Array<{
        id: string
        kind: 'source' | 'generated'
        segmentId: string
        duration: number
        title: string
        prompt: string
        narration: string
        caption: string
        assetPath: string
        status: string
      }>
    }>
    generateImage: (input: { id: string; prompt: string; model?: string; size?: string }) => Promise<{ success: boolean; outputPath: string; bytes: number }>
    generateVoice: (input: { text: string; engine: 'system' | 'cloud'; model?: string; voice?: string; rate?: number }) => Promise<{ success: boolean; outputPath: string; bytes: number; engine: string }>
    selectAsset: (kind: 'image' | 'audio') => Promise<string | null>
    renderCreative: (input: Record<string, unknown>) => Promise<{ success: boolean; cancelled?: boolean; outputPath?: string; bytes?: number; shots?: number; duration?: number }>
    cancelRender: () => Promise<boolean>
  }
  receiver?: {
    start: () => Promise<boolean>
    stop: () => Promise<boolean>
    onPlay: (cb: (url: string) => void) => () => void
  }
  menu?: {
    onAction: (cb: (action: string) => void) => () => void
    onOpenFile: (cb: (filePath: string) => void) => () => void
    confirmOpenFile?: (filePath: string) => void
    onOpenFolder: (cb: (dirPath: string) => void) => () => void
    onAgent: (cb: () => void) => () => void
  }
  contextMenu?: {
    show: (state: { hasMedia: boolean; isPlaying: boolean; subtitleVisible: boolean; pictureMode: string; playbackRate: number }) => void
  }
  windowControls?: {
    setPreset: (preset: 'original' | 'half' | 'fill' | 'fullscreen', mediaSize?: { width: number; height: number }) => Promise<boolean>
    setPlaybackChromeVisible: (visible: boolean) => Promise<boolean>
    isPlaybackChromeVisible: () => Promise<boolean>
    onFullscreenChanged: (cb: (fullscreen: boolean) => void) => () => void
  }
  screenshot?: {
    save: (dataUrl: string, suggestedName: string) => Promise<boolean>
  }
  models?: {
    providers: () => Promise<Array<{
      id: string; name: string; region: string; protocol: 'openai' | 'anthropic' | 'gemini';
      baseUrl: string; models: string[]; requiresKey: boolean; modelHint?: string; warning?: string;
      computerUseProtocol?: 'fara-native';
      bundled?: boolean;
      roles: Array<'chat' | 'computerUse'>;
      capabilities: { streaming?: boolean; tools?: boolean; vision?: boolean; computerUse?: boolean }
    }>>
    config: (role?: 'chat' | 'computerUse') => Promise<{ schemaVersion: number; role: 'chat' | 'computerUse'; providerId: string; providerName: string; model: string; baseUrl: string; hasApiKey: boolean; keyStorage: string; capabilities: Record<string, boolean | number> }>
    save: (config: { role?: 'chat' | 'computerUse'; providerId: string; model: string; baseUrl: string; apiKey?: string; clearApiKey?: boolean }) => Promise<{ providerId: string; model: string; baseUrl: string; hasApiKey: boolean }>
    list: (config: { role?: 'chat' | 'computerUse'; providerId: string; model: string; baseUrl: string; apiKey?: string; useSavedKey?: boolean }) => Promise<{ success: boolean; models: string[]; error?: string }>
    test: (config: { role?: 'chat' | 'computerUse'; providerId: string; model: string; baseUrl: string; apiKey?: string; useSavedKey?: boolean }) => Promise<{ success: boolean; message: string }>
    discoverLocal: (role?: 'chat' | 'computerUse') => Promise<Array<{ id: string; role: 'chat' | 'computerUse'; name: string; providerId: string; baseUrl: string; status: 'ready'; models: string[] }>>
    bundledStatus: () => Promise<BundledModelStatus>
    startBundled: () => Promise<BundledModelStatus>
    stopBundled: () => Promise<BundledModelStatus>
  }
  computerUse?: {
    suggest: (task: string, requestId: string) => Promise<{
      requestId: string; mode: 'observe-only'; warning: string;
      observation: { frameId: string; width: number; height: number; dataUrl: string; createdAt: number };
      recommendation: { frameId: string; reason: string; action: { type: string; x?: number; y?: number; button?: string; text?: string; deltaY?: number; key?: string } }
    }>
    cancel: (requestId: string) => Promise<boolean>
    onStatus: (cb: (event: { requestId: string; status: string }) => void) => () => void
  }
  subtitle?: {
    search: (name: string, apiKey?: string) => Promise<{ success: boolean; data?: Array<{ id: string; fileId: number; fileName: string; language: string; release: string }>; error?: string }>
    download: (fileId: number, apiKey?: string) => Promise<{ success: boolean; path?: string; fileName?: string; error?: string }>
  }
  xlsx?: {
    preview: (filePath: string) => Promise<{ success: boolean; html?: string; error?: string }>
  }
  docx?: {
    preview: (filePath: string) => Promise<{ success: boolean; html?: string; error?: string }>
  }
  dialog?: {
    openFile: () => Promise<string | null>
    openFolder: () => Promise<string | null>
  }
  system?: {
    openPath: (filePath: string) => Promise<{ success: boolean; error?: string }>
  }
  print?: {
    file: (filePath: string) => Promise<{ success: boolean; action?: string; error?: string }>
    text: (filePath: string) => Promise<{ success: boolean; action?: string; error?: string }>
  }
  files?: {
    scan: (dir?: string) => Promise<Array<{ name: string; path: string; ext: string; size: number }>>
    defaultDir: () => Promise<string>
    readText: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>
    readDataUrl: (filePath: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>
  }
  ai?: {
    chat: (messages: Array<{ role: string; content: string }>, context?: {
      name: string | null
      path: string | null
      currentTime: number
      duration: number
      volume: number
      lastAudibleVolume: number
      playbackRate: number
      pictureMode: 'original' | 'fit' | 'fill' | 'stretch'
      subtitleVisible: boolean
      isFullscreen: boolean
    }, requestId?: string) => Promise<{
      requestId: string
      text: string
      cancelled?: boolean
      toolResults: Array<{
        tool: string
        args: Record<string, unknown>
        result: unknown
      }>
    }>
    cancel: (requestId: string) => Promise<boolean>
    onStream: (cb: (event: { requestId: string; status?: string; delta?: string }) => void) => () => void
  }
}

interface MpvEvent {
  event: string
  data: { name?: string; data?: unknown }
}

interface Window {
  aiPlayer?: AiPlayerAPI
}

interface BundledModelStatus {
  state: 'stopped' | 'verifying' | 'loading' | 'ready' | 'error'
  running: boolean
  assetsPresent: boolean
  modelName: string
  modelSizeMb: number
  providerId: string
  baseUrl: string
  model: string
  idleReleaseMinutes: number
  lastNotice: string
  lastError: string
  hardware: {
    totalMemoryGb: number
    availableMemoryGb: number
    logicalCpus: number
    eligible: boolean
    tier: 'unsupported' | 'limited' | 'recommended'
    reason: string
    contextSize: number
    threads: number
    batchThreads: number
  }
}
