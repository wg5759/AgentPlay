import { usePlayerStore } from '../stores/playerStore'
import { useAgentStore } from '../stores/agentStore'

interface Props {
  onInteractionStart?: () => void
  onInteractionEnd?: () => void
}

export default function PlayerControls({ onInteractionStart, onInteractionEnd }: Props) {
  const {
    isPlaying, togglePlay,
    volume, setVolume,
    currentTime, duration, seek,
    subtitleVisible, toggleSubtitle,
    isFullscreen, toggleFullscreen,
    controlsVisible, playbackRate, setPlaybackRate, toggleMute
  } = usePlayerStore()
  const openPanel = useAgentStore((s) => s.openPanel)

  const fmt = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  return (
    <div
      data-player-chrome="true"
      onPointerEnter={onInteractionStart}
      onPointerLeave={onInteractionEnd}
      onFocusCapture={onInteractionStart}
      onBlurCapture={onInteractionEnd}
      className={`absolute z-30 bottom-0 left-0 right-0 px-6 py-3 bg-gradient-to-t from-black/90 to-transparent transition-opacity duration-300 ${
        controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
    >
      {/* 进度条 */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs text-gray-400 w-10 text-right">{fmt(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={duration || 100}
          value={currentTime}
          onChange={(e) => {
            const value = Number(e.target.value)
            seek(value)
            void window.aiPlayer?.player?.seek(value)
          }}
          className="flex-1 h-1 accent-player-accent"
        />
        <span className="text-xs text-gray-400 w-10">{fmt(duration)}</span>
      </div>

      {/* 5 按钮 + 麦克风 */}
      <div className="flex items-center gap-4">
        {/* 1. 播放/暂停 */}
        <button
          title={isPlaying ? '暂停（空格）' : '播放（空格）'}
          onClick={() => {
            const nextPlaying = !usePlayerStore.getState().isPlaying
            togglePlay()
            if (nextPlaying) void window.aiPlayer?.player?.play()
            else void window.aiPlayer?.player?.pause()
          }}
          className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-white/10 text-xl"
        >
          {isPlaying ? '⏸' : '▶'}
        </button>

        {/* 2. 音量 */}
        <div className="flex items-center gap-2">
          <button
            title="静音（M）"
            onClick={() => {
              toggleMute()
              void window.aiPlayer?.player?.setVolume(usePlayerStore.getState().volume)
            }}
            className="text-lg"
          >{volume === 0 ? '🔇' : volume < 45 ? '🔉' : '🔊'}</button>
          <input
            type="range"
            min={0}
            max={100}
            value={volume}
            onChange={(e) => {
              const value = Number(e.target.value)
              setVolume(value)
              void window.aiPlayer?.player?.setVolume(value)
            }}
            className="w-20 h-1 accent-player-accent"
          />
        </div>

        <select
          title="播放速度"
          value={playbackRate}
          onChange={(e) => {
            const value = Number(e.target.value)
            setPlaybackRate(value)
            void window.aiPlayer?.player?.setSpeed(value)
          }}
          className="bg-black/40 rounded px-2 py-1 text-xs outline-none"
        >
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
        </select>

        {/* 3. 字幕 */}
        <button
          onClick={() => {
            const newVal = !usePlayerStore.getState().subtitleVisible
            toggleSubtitle()
            window.aiPlayer?.player?.setSubtitleVisible(newVal)
          }}
          className={`px-3 py-1 rounded text-sm ${subtitleVisible ? 'text-white' : 'text-gray-500'}`}
        >
          字幕
        </button>

        {/* 4. 全屏 */}
        <button
          onClick={() => {
            if (window.aiPlayer?.windowControls) void window.aiPlayer.windowControls.setPreset('fullscreen')
            else {
              toggleFullscreen()
              if (document.fullscreenElement) document.exitFullscreen()
              else document.documentElement.requestFullscreen().catch(() => {})
            }
          }}
          className="w-9 h-9 flex items-center justify-center rounded hover:bg-white/10"
        >
          {isFullscreen ? '🗗' : '⛶'}
        </button>

        {/* 5. 麦克风（点击唤醒 Agent） */}
        <button
          onClick={openPanel}
          className="ml-auto w-10 h-10 flex items-center justify-center rounded-full bg-player-accent/80 hover:bg-player-accent text-lg"
        >
          🎙️
        </button>
      </div>
    </div>
  )
}
