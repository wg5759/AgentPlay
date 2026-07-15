import { useEffect, useRef } from 'react'
import PlayerControls from './PlayerControls'
import { usePlayerStore } from '../stores/playerStore'

interface Props {
  onBack: () => void
}

export default function PlayerView({ onBack }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const mediaName = usePlayerStore((s) => s.mediaName)
  const videoSrc = usePlayerStore((s) => s.videoSrc)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const volume = usePlayerStore((s) => s.volume)
  const currentTime = usePlayerStore((s) => s.currentTime)
  const setControlsVisible = usePlayerStore((s) => s.setControlsVisible)
  const controlsVisible = usePlayerStore((s) => s.controlsVisible)
  const setDuration = usePlayerStore((s) => s.setDuration)
  const seek = usePlayerStore((s) => s.seek)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isDesktop = window.aiPlayer?.isElectron === true

  // 桌面端文件路径转 file:// URL，Web 端直接用 blob/http URL
  const videoUrl =
    isDesktop && videoSrc && !videoSrc.startsWith('http') && !videoSrc.startsWith('blob:')
      ? 'file:///' + videoSrc.replace(/\\/g, '/')
      : videoSrc

  useEffect(() => {
    const v = videoRef.current
    if (!v || !videoUrl) return
    if (isPlaying) v.play().catch(() => {})
    else v.pause()
  }, [isPlaying, videoUrl])

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume / 100
  }, [volume])

  useEffect(() => {
    const v = videoRef.current
    if (v && Math.abs(v.currentTime - currentTime) > 1) v.currentTime = currentTime
  }, [currentTime])

  const handleMouseMove = () => {
    setControlsVisible(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setControlsVisible(false), 3000)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (!file) return
    const ext = (file.name.split('.').pop() || '').toLowerCase()
    if (['srt', 'ass', 'ssa', 'vtt'].includes(ext) && isDesktop && window.aiPlayer?.player) {
      window.aiPlayer.player.loadSubtitle((file as File & { path: string }).path)
      return
    }
    if (isDesktop) {
      usePlayerStore.getState().setMedia(file.name, (file as File & { path: string }).path)
    } else if (file.type.startsWith('video')) {
      const oldSrc = usePlayerStore.getState().videoSrc
      if (oldSrc && oldSrc.startsWith('blob:')) URL.revokeObjectURL(oldSrc)
      usePlayerStore.getState().setMedia(file.name, URL.createObjectURL(file))
    }
  }

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current) }, [])

  return (
    <div
      className="flex-1 relative bg-black flex items-center justify-center"
      onMouseMove={handleMouseMove}
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      {videoUrl ? (
        <video
          ref={videoRef}
          src={videoUrl}
          className="max-w-full max-h-full"
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onTimeUpdate={(e) => seek(e.currentTarget.currentTime)}
          onEnded={() => usePlayerStore.setState({ isPlaying: false })}
          playsInline
        />
      ) : (
        <div className="text-gray-600 text-center">
          <p className="text-2xl mb-2">{mediaName ?? '未选择媒体'}</p>
          <p className="text-sm">拖拽视频文件到此处，或从媒体库选择</p>
        </div>
      )}

      <button
        onClick={onBack}
        className={`absolute top-4 left-4 px-3 py-1 bg-player-surface/80 rounded text-sm hover:bg-player-surface transition-opacity duration-300 ${
          controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        ← 媒体库
      </button>

      <PlayerControls />
    </div>
  )
}
