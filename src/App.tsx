import { useState } from 'react'
import PlayerView from './components/PlayerView'
import MediaLibrary from './components/MediaLibrary'
import AgentPanel from './components/AgentPanel'
import VoiceWake from './components/VoiceWake'
import { useAgentStore } from './stores/agentStore'
import { usePlayerStore } from './stores/playerStore'

// MVP 占位：所有片名映射到示例视频（后续接媒体库扫描真实文件）
const SAMPLE_VIDEO =
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4'

export default function App() {
  const [view, setView] = useState<'library' | 'player'>('library')
  const agentOpen = useAgentStore((s) => s.open)
  const isDesktop = window.aiPlayer?.isElectron === true

  const playMedia = (name: string, path: string) => {
    usePlayerStore.getState().setMedia(name, isDesktop ? path : SAMPLE_VIDEO)
    setView('player')
  }

  return (
    <div className="w-screen h-screen flex flex-col bg-player-bg overflow-hidden">
      {view === 'library' ? (
        <MediaLibrary onPlay={playMedia} />
      ) : (
        <PlayerView onBack={() => setView('library')} />
      )}
      <VoiceWake />
      {agentOpen && <AgentPanel />}
    </div>
  )
}
