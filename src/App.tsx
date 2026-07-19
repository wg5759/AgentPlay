import { useState, useEffect } from 'react'
import PlayerView from './components/PlayerView'
import MediaLibrary from './components/MediaLibrary'
import AgentPanel from './components/AgentPanel'
import VoiceWake from './components/VoiceWake'
import { useAgentStore } from './stores/agentStore'
import { usePlayerStore } from './stores/playerStore'
import ErrorBoundary from './components/ErrorBoundary'
import ModelCenter from './components/ModelCenter'
import ComputerUsePanel from './components/ComputerUsePanel'
import AnalysisStudio from './components/AnalysisStudio'

function AppInner() {
  const [view, setView] = useState<'library' | 'player'>('library')
  const [libraryRoot, setLibraryRoot] = useState<string | undefined>()
  const [modelCenterOpen, setModelCenterOpen] = useState(false)
  const [computerUseOpen, setComputerUseOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [analysisStudioOpen, setAnalysisStudioOpen] = useState(false)
  const [voiceWakeEnabled, setVoiceWakeEnabled] = useState(() => localStorage.getItem('aiplayer_voice_wake_enabled') === 'true')
  const agentOpen = useAgentStore((s) => s.open)

  const toggleVoiceWake = () => {
    setVoiceWakeEnabled((enabled) => {
      const next = !enabled
      localStorage.setItem('aiplayer_voice_wake_enabled', String(next))
      return next
    })
  }

  useEffect(() => {
    const legacyKey = localStorage.getItem('aiplayer_api_key')
    if (legacyKey && window.aiPlayer?.models) {
      void window.aiPlayer.models.config().then((saved) => {
        if (!saved.hasApiKey) {
          return window.aiPlayer?.models?.save({
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
      setView('player')
    })
    return off
  }, [])

  useEffect(() => {
    const menu = window.aiPlayer?.menu
    if (!menu) return
    const offFile = menu.onOpenFile((filePath) => {
      usePlayerStore.getState().setMedia(filePath.split(/[\\/]/).pop() || filePath, filePath)
      setView('player')
      menu.confirmOpenFile?.(filePath)
    })
    const offFolder = menu.onOpenFolder((dirPath) => {
      setLibraryRoot(dirPath)
      setView('library')
    })
    const offAgent = menu.onAgent(() => useAgentStore.getState().openPanel())
    const offAction = menu.onAction((action) => {
      if (action === 'agent') useAgentStore.getState().openPanel()
      else if (action === 'model-center') {
        setComputerUseOpen(false)
        setModelCenterOpen(true)
      }
      else if (action === 'computer-use') setComputerUseOpen(true)
      else if (action === 'analysis-studio') {
        setComputerUseOpen(false)
        setModelCenterOpen(false)
        setAnalysisStudioOpen(true)
      }
      else if (action === 'voice-wake-toggle') toggleVoiceWake()
      else if (action === 'shortcuts') setShortcutsOpen(true)
      else if (action === 'open-file') {
        void window.aiPlayer?.dialog?.openFile().then((filePath) => {
          if (!filePath) return
          usePlayerStore.getState().setMedia(filePath.split(/[\\/]/).pop() || filePath, filePath)
          setView('player')
        })
      } else {
        const libraryActions = ['network-source', 'record', 'dedup', 'organize', 'plugins', 'poster', 'devices']
        if (libraryActions.includes(action) && view !== 'library') {
          setView('library')
          setTimeout(() => window.dispatchEvent(new CustomEvent('ai-player-action', { detail: action })), 0)
        } else {
          window.dispatchEvent(new CustomEvent('ai-player-action', { detail: action }))
        }
      }
    })
    return () => {
      offFile()
      offFolder()
      offAgent()
      offAction()
    }
  }, [view])

  useEffect(() => {
    const folderHandler = (event: Event) => {
      setLibraryRoot((event as CustomEvent<string>).detail)
      setView('library')
    }
    const actionHandler = (event: Event) => {
      const action = (event as CustomEvent<string>).detail
      if (action === 'model-center') {
        setComputerUseOpen(false)
        setModelCenterOpen(true)
      }
      if (action === 'computer-use') setComputerUseOpen(true)
      if (action === 'analysis-studio') setAnalysisStudioOpen(true)
      if (action === 'voice-wake-toggle') toggleVoiceWake()
    }
    window.addEventListener('ai-player-open-folder', folderHandler)
    window.addEventListener('ai-player-action', actionHandler)
    return () => {
      window.removeEventListener('ai-player-open-folder', folderHandler)
      window.removeEventListener('ai-player-action', actionHandler)
    }
  }, [])

  const playMedia = (name: string, path: string) => {
    usePlayerStore.getState().setMedia(name, path)
    setView('player')
  }

  return (
    <div className="w-screen h-screen flex flex-col bg-player-bg overflow-hidden">
      {view === 'library' ? (
        <MediaLibrary onPlay={playMedia} rootDir={libraryRoot} />
      ) : (
        <PlayerView onBack={() => setView('library')} />
      )}
      <VoiceWake enabled={voiceWakeEnabled} />
      {voiceWakeEnabled && (
        <button
          onClick={toggleVoiceWake}
          className="fixed left-3 bottom-3 z-[65] rounded-full bg-emerald-700/90 px-3 py-1.5 text-xs text-white shadow-lg"
          title="点击关闭语音唤醒"
        >
          🎙 语音唤醒已开启
        </button>
      )}
      {agentOpen && <AgentPanel />}
      {computerUseOpen && <ComputerUsePanel onClose={() => setComputerUseOpen(false)} />}
      {modelCenterOpen && <ModelCenter onClose={() => setModelCenterOpen(false)} />}
      {analysisStudioOpen && <AnalysisStudio onClose={() => setAnalysisStudioOpen(false)} />}
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
    </div>
  )
}

export default function App() {
  return <ErrorBoundary><AppInner /></ErrorBoundary>
}
