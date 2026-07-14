import { usePlayerStore } from '../stores/playerStore'
import { useAgentStore } from '../stores/agentStore'

// 极简控制条：6 个控件（播放/进度/音量/字幕/全屏/麦克风）
// 悬停浮现，3 秒无操作自动隐藏（全屏沉浸）
export default function PlayerControls() {
  const {
    isPlaying, togglePlay,
    volume, setVolume,
    currentTime, duration, seek,
    subtitleVisible, toggleSubtitle,
    isFullscreen, toggleFullscreen,
    controlsVisible
  } = usePlayerStore()
  const openPanel = useAgentStore((s) => s.openPanel)

  const fmt = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  return (
    <div
      className={`absolute bottom-0 left-0 right-0 px-6 py-3 bg-gradient-to-t from-black/90 to-transparent transition-opacity duration-300 ${
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
          onChange={(e) => seek(Number(e.target.value))}
          className="flex-1 h-1 accent-player-accent"
        />
        <span className="text-xs text-gray-400 w-10">{fmt(duration)}</span>
      </div>

      {/* 5 按钮 + 麦克风 */}
      <div className="flex items-center gap-4">
        {/* 1. 播放/暂停 */}
        <button
          onClick={togglePlay}
          className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-white/10 text-xl"
        >
          {isPlaying ? '⏸' : '▶'}
        </button>

        {/* 2. 音量 */}
        <div className="flex items-center gap-2">
          <span className="text-lg">🔊</span>
          <input
            type="range"
            min={0}
            max={100}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="w-20 h-1 accent-player-accent"
          />
        </div>

        {/* 3. 字幕 */}
        <button
          onClick={toggleSubtitle}
          className={`px-3 py-1 rounded text-sm ${subtitleVisible ? 'text-white' : 'text-gray-500'}`}
        >
          字幕
        </button>

        {/* 4. 全屏 */}
        <button
          onClick={() => {
            toggleFullscreen()
            if (document.fullscreenElement) document.exitFullscreen()
            else document.documentElement.requestFullscreen().catch(() => {})
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
