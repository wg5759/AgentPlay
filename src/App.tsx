import { useState, useEffect } from 'react'
import PlayerView from './components/PlayerView'
import MediaLibrary from './components/MediaLibrary'
import AgentPanel from './components/AgentPanel'
import Workbench from './components/Workbench'
import Sidebar from './components/Sidebar'
import { useAgentStore } from './stores/agentStore'
import { usePlayerStore } from './stores/playerStore'
import { useThemeStore, applyThemeToDocument } from './stores/themeStore'
import ErrorBoundary from './components/ErrorBoundary'
import ModelCenter from './components/ModelCenter'
import OnlineMediaLibrary from './components/OnlineMediaLibrary'
import SmartCastPanel from './components/SmartCastPanel'
import ComputerUsePanel from './components/ComputerUsePanel'
import { selectPrimaryPreviewPath } from './document-preview-routing.mjs'

interface ModelCenterIntent {
  providerId?: string
  model?: string
  reason?: string
}

function AppInner() {
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryRoot, setLibraryRoot] = useState<string | undefined>()
  const [libraryActionRequest, setLibraryActionRequest] = useState<{ id: number; action: string } | null>(null)
  const [modelCenterOpen, setModelCenterOpen] = useState(false)
  const [modelCenterIntent, setModelCenterIntent] = useState<ModelCenterIntent | null>(null)
  const [onlineMediaOpen, setOnlineMediaOpen] = useState(false)
  const [smartCastOpen, setSmartCastOpen] = useState(false)
  const [computerUseOpen, setComputerUseOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // 右栏：有播放内容即自动展开
  const videoSrc = usePlayerStore((s) => s.videoSrc)
  const rightOpen = Boolean(videoSrc)
  const theme = useThemeStore((s) => s.theme)

  useEffect(() => {
    applyThemeToDocument(theme)
  }, [theme])

  const playMedia = (name: string, path: string) => {
    usePlayerStore.getState().setMedia(name, path)
    setLibraryOpen(false)
  }

  // 两段式「打开」：Windows 组合对话框看不到文件，先在应用内问文件还是文件夹
  const [openModeOpen, setOpenModeOpen] = useState(false)
  useEffect(() => {
    const handler = () => setOpenModeOpen(true)
    window.addEventListener('ai-player-ask-open-mode', handler)
    return () => window.removeEventListener('ai-player-ask-open-mode', handler)
  }, [])

  const openFiles = async () => {
    setOpenModeOpen(false)
    const result = await window.aiPlayer?.chat?.openAny?.()
    if (!result) return
    if (result.documents?.length) {
      useAgentStore.getState().openPanel()
      window.dispatchEvent(new CustomEvent('ai-player-attach-docs', { detail: result.documents }))
    }
    const previewPath = selectPrimaryPreviewPath(result.media, result.documents)
    if (previewPath) {
      usePlayerStore.getState().setMedia(previewPath.split(/[\\/]/).pop() || previewPath, previewPath)
    }
  }

  const openFolder = async () => {
    setOpenModeOpen(false)
    const result = await window.aiPlayer?.home?.openFolder?.()
    for (const folder of result?.folders || []) {
      window.dispatchEvent(new CustomEvent('ai-player-open-folder', { detail: folder }))
    }
  }

  const closeRightPane = () => {
    // Exit before PlayerView unmounts and loses its native event listener.
    if (usePlayerStore.getState().theater || usePlayerStore.getState().isFullscreen) {
      if (window.aiPlayer?.windowControls) void window.aiPlayer.windowControls.setFullscreen(false)
      else if (document.fullscreenElement) void document.exitFullscreen()
    }
    void window.aiPlayer?.player?.stop()
    usePlayerStore.getState().clearMedia()
  }

  useEffect(() => {
    const legacyKey = localStorage.getItem('aiplayer_api_key')
    if (legacyKey && window.aiPlayer?.models) {
      void window.aiPlayer.models.config().then((saved) => {
        if (!saved.hasApiKey) {
          return window.aiPlayer?.models?.save({
            // 保留旧 deepseek-chat 语义，由主进程迁移为 V4 Flash 的非思考模式。
            providerId: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKey: legacyKey
          })
        }
        return undefined
      }).finally(() => localStorage.removeItem('aiplayer_api_key'))
    }
  }, [])

  useEffect(() => {
    if (!window.aiPlayer?.receiver) return
    const off = window.aiPlayer.receiver.onPlay((url) => {
      usePlayerStore.getState().setMedia(url.split('/').pop() || '投屏', url)
    })
    return off
  }, [])

  // 全局播放/窗口动作兜底：PlayerView 未挂载时（右栏关闭）菜单依然可用；挂载时让位给它
  useEffect(() => {
    const handler = (event: Event) => {
      if ((window as unknown as Record<string, unknown>).__playerActionMounted) return
      const action = (event as CustomEvent<string>).detail
      if (!action) return
      const state = usePlayerStore.getState()
      const player = window.aiPlayer?.player
      if (action.startsWith('window-')) {
        void window.aiPlayer?.windowControls?.setPreset(action.slice(7) as 'original' | 'half' | 'fill' | 'fullscreen')
        return
      }
      if (action === 'online-subtitle' || action === 'bilingual-subtitle' || action === 'live-translate-subtitle' || action === 'live-transcribe-subtitle') {
        if (state.videoSrc) {
          window.dispatchEvent(new CustomEvent('ai-player-action', { detail: action }))
        }
        return
      }
      if (!player) return
      if (action === 'play-toggle') {
        const next = !state.isPlaying
        state.togglePlay()
        void (next ? player.play() : player.pause())
      } else if (action === 'seek-backward' || action === 'seek-forward') {
        const target = Math.max(0, Math.min(state.duration || Infinity, state.currentTime + (action === 'seek-forward' ? 10 : -10)))
        state.seek(target)
        void player.seek(target)
      } else if (action === 'volume-up' || action === 'volume-down') {
        const value = Math.max(0, Math.min(100, state.volume + (action === 'volume-up' ? 5 : -5)))
        state.setVolume(value)
        void player.setVolume(value)
      } else if (action === 'mute-toggle') {
        state.toggleMute()
        void player.setVolume(usePlayerStore.getState().volume)
      } else if (action === 'subtitle-toggle') {
        state.toggleSubtitle()
        void player.setSubtitleVisible(usePlayerStore.getState().subtitleVisible)
      } else if (action.startsWith('speed-')) {
        const rate = Number(action.slice(6))
        state.setPlaybackRate(rate)
        void player.setSpeed(rate)
      } else if (action.startsWith('picture-')) {
        const mode = action.slice(8) as 'original' | 'fit' | 'fill' | 'stretch'
        state.setPictureMode(mode)
        void player.setPictureMode(mode)
      } else if (action === 'screenshot') {
        void player.screenshot(`${state.mediaName || 'screenshot'}-${Date.now()}.png`)
      }
    }
    window.addEventListener('ai-player-action', handler)
    return () => window.removeEventListener('ai-player-action', handler)
  }, [])

  useEffect(() => {
    const menu = window.aiPlayer?.menu
    if (!menu) return
    const offFile = menu.onOpenFile((filePath) => {
      usePlayerStore.getState().setMedia(filePath.split(/[\\/]/).pop() || filePath, filePath)
      menu.confirmOpenFile?.(filePath)
    })
    const offFolder = menu.onOpenFolder((dirPath) => {
      setLibraryRoot(dirPath)
      setLibraryOpen(true)
    })
    const offAgent = menu.onAgent(() => useAgentStore.getState().openPanel())
    const offDocumentOpen = window.aiPlayer?.documents?.onOpenExternal?.((seedFiles) => {
      setComputerUseOpen(false)
      setModelCenterOpen(false)
      if (useAgentStore.getState().open) {
        window.dispatchEvent(new CustomEvent('ai-player-attach-docs', { detail: seedFiles }))
      } else {
        useAgentStore.getState().setPendingDocs(seedFiles)
        useAgentStore.getState().openPanel()
      }
    })
    const offAction = menu.onAction((action) => {
      if (action === 'agent') useAgentStore.getState().openPanel()
      else if (action === 'model-center') {
        setComputerUseOpen(false)
        setModelCenterIntent(null)
        setModelCenterOpen(true)
      }
      else if (action === 'computer-use') setComputerUseOpen(true)
      else if (action === 'analysis-studio') {
        // 分析工作室退役：拉片统一走对话流（说"深度解剖这个视频"即可）
        setComputerUseOpen(false)
        setModelCenterOpen(false)
        useAgentStore.getState().openPanel()
      }
      else if (action === 'document-workspace') {
        setComputerUseOpen(false)
        setModelCenterOpen(false)
          useAgentStore.getState().openPanel()
      }
      else if (action === 'shortcuts') setShortcutsOpen(true)
      else if (action === 'open-file') {
        void window.aiPlayer?.dialog?.openFile().then((filePath) => {
          if (!filePath) return
          usePlayerStore.getState().setMedia(filePath.split(/[\\/]/).pop() || filePath, filePath)
        })
      } else {
        const libraryActions = ['network-source', 'record', 'dedup', 'organize', 'plugins', 'poster', 'devices']
        if (libraryActions.includes(action)) {
          setLibraryOpen(true)
          setLibraryActionRequest((current) => ({ id: (current?.id || 0) + 1, action }))
        } else {
          window.dispatchEvent(new CustomEvent('ai-player-action', { detail: action }))
        }
      }
    })
    return () => {
      offFile()
      offDocumentOpen?.()
      offFolder()
      offAgent()
      offAction()
    }
  }, [])

  useEffect(() => {
    const folderHandler = (event: Event) => {
      setLibraryRoot((event as CustomEvent<string>).detail)
      setLibraryOpen(true)
    }
    const actionHandler = (event: Event) => {
      const action = (event as CustomEvent<string>).detail
      const libraryActions = ['network-source', 'record', 'dedup', 'organize', 'plugins', 'poster', 'devices']
      if (libraryActions.includes(action)) {
        setLibraryOpen(true)
        setLibraryActionRequest((current) => ({ id: (current?.id || 0) + 1, action }))
      }
      if (action === 'model-center') {
        setComputerUseOpen(false)
        setModelCenterIntent(null)
        setModelCenterOpen(true)
      }
      if (action === 'computer-use') setComputerUseOpen(true)
      if (action === 'analysis-studio') useAgentStore.getState().openPanel()
      if (action === 'document-workspace') useAgentStore.getState().openPanel()
      if (action === 'agent-voice') {
        // 全局热键唤起：聚焦中栏输入并直接开麦（再按热键由系统层聚焦，不打断录音）
        const store = useAgentStore.getState()
        store.openPanel()
        if (!store.listening) store.toggleListening()
      }
    }
    const playFileHandler = (event: Event) => {
      const filePath = (event as CustomEvent<string>).detail
      if (!filePath) return
      usePlayerStore.getState().setMedia(filePath.split(/[\\/]/).pop() || filePath, filePath)
    }
    window.addEventListener('ai-player-open-folder', folderHandler)
    window.addEventListener('ai-player-play-file', playFileHandler)
    window.addEventListener('ai-player-action', actionHandler)
    return () => {
      window.removeEventListener('ai-player-open-folder', folderHandler)
      window.removeEventListener('ai-player-play-file', playFileHandler)
      window.removeEventListener('ai-player-action', actionHandler)
    }
  }, [])

  useEffect(() => {
    const openModelCenterForIntent = (event: Event) => {
      setComputerUseOpen(false)
      setModelCenterIntent((event as CustomEvent<ModelCenterIntent>).detail || null)
      setModelCenterOpen(true)
    }
    window.addEventListener('ai-player-open-model-center', openModelCenterForIntent)
    return () => window.removeEventListener('ai-player-open-model-center', openModelCenterForIntent)
  }, [])

  return (
    <>
      <Workbench
        rightOpen={rightOpen}
        sidebar={({ pinned, onTogglePin }) => (
          <Sidebar
            pinned={pinned}
            onTogglePin={onTogglePin}
            onOpenLibrary={() => setLibraryOpen(true)}
            onOpenModelCenter={() => { setComputerUseOpen(false); setModelCenterIntent(null); setModelCenterOpen(true) }}
            onOpenOnlineMedia={() => setOnlineMediaOpen(true)}
            onOpenSmartCast={() => setSmartCastOpen(true)}
          />
        )}
        center={<AgentPanel />}
        right={<PlayerView onBack={closeRightPane} />}
      />
      {libraryOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 flex items-stretch justify-center p-6" onClick={() => setLibraryOpen(false)}>
          <div className="w-full max-w-5xl theme-panel rounded-2xl flex flex-col overflow-hidden" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
              <h2 className="text-sm text-gray-300">媒体库</h2>
              <button onClick={() => setLibraryOpen(false)} className="text-gray-400 hover:text-white">✕</button>
            </div>
            <MediaLibrary onPlay={playMedia} rootDir={libraryRoot} actionRequest={libraryActionRequest} />
          </div>
        </div>
      )}
      {openModeOpen && (
        <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-6" onClick={() => setOpenModeOpen(false)}>
          <div className="w-72 theme-panel rounded-2xl p-5" onClick={(event) => event.stopPropagation()}>
            <p className="mb-4 text-center text-sm text-gray-200">要打开什么？</p>
            <div className="space-y-2">
              <button onClick={() => void openFiles()} className="w-full rounded-xl bg-player-accent px-4 py-3 text-left text-sm text-white transition-opacity hover:opacity-90">
                <span className="block font-medium">📄 选择文件</span>
                <span className="mt-0.5 block text-[11px] opacity-80">视频 / 音频 / 图片 / 文档</span>
              </button>
              <button onClick={() => void openFolder()} className="w-full rounded-xl bg-white/10 px-4 py-3 text-left text-sm text-gray-200 transition-colors hover:bg-white/15">
                <span className="block font-medium">📁 选择文件夹</span>
                <span className="mt-0.5 block text-[11px] text-gray-400">整个文件夹加入媒体库</span>
              </button>
            </div>
          </div>
        </div>
      )}
      {computerUseOpen && <ComputerUsePanel onClose={() => setComputerUseOpen(false)} />}
      {modelCenterOpen && <ModelCenter intent={modelCenterIntent} onClose={() => { setModelCenterOpen(false); setModelCenterIntent(null) }} />}
      {onlineMediaOpen && <OnlineMediaLibrary onClose={() => setOnlineMediaOpen(false)} />}
      {smartCastOpen && <SmartCastPanel onClose={() => setSmartCastOpen(false)} />}
      {shortcutsOpen && (
        <div className="fixed inset-0 z-[75] bg-black/70 flex items-center justify-center p-6" onClick={() => setShortcutsOpen(false)}>
          <div className="w-full max-w-md rounded-2xl bg-player-surface border border-white/10 p-6" onClick={(event) => event.stopPropagation()}>
            <div className="flex justify-between mb-4"><h2>播放器快捷键</h2><button onClick={() => setShortcutsOpen(false)}>✕</button></div>
            <div className="grid grid-cols-2 gap-y-3 text-sm text-gray-300">
              <span>空格</span><span>播放 / 暂停</span><span>← / →</span><span>后退 / 前进 10 秒</span>
              <span>↑ / ↓</span><span>音量 ±5</span><span>M</span><span>静音 / 恢复</span>
              <span>F / F11</span><span>全屏窗口</span><span>Ctrl+1 / 2 / 3</span><span>原始 / 半屏 / 铺满</span>
              <span>Ctrl+O</span><span>打开文件</span><span>Ctrl+Shift+S</span><span>截图</span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default function App() {
  return <ErrorBoundary><AppInner /></ErrorBoundary>
}
