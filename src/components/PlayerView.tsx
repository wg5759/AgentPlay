import { useEffect, useRef } from 'react'
import PlayerControls from './PlayerControls'
import { usePlayerStore } from '../stores/playerStore'

interface Props {
  onBack: () => void
}

export default function PlayerView({ onBack }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const mpvTimeRef = useRef(0) // mpv 最后报告的位置（区分用户拖拽与事件更新）
  const mediaName = usePlayerStore((s) => s.mediaName)
  const videoSrc = usePlayerStore((s) => s.videoSrc)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const volume = usePlayerStore((s) => s.volume)
  const currentTime = usePlayerStore((s) => s.currentTime)
  const setControlsVisible = usePlayerStore((s) => s.setControlsVisible)
  const setDuration = usePlayerStore((s) => s.setDuration)
  const seek = usePlayerStore((s) => s.seek)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isDesktop = window.aiPlayer?.isElectron === true
  const player = window.aiPlayer?.player

  // 桌面端：mpv 加载文件
  useEffect(() => {
    if (!isDesktop || !player || !videoSrc) return
    player.loadFile(videoSrc)
    if (isPlaying) player.play()
  }, [videoSrc])

  // 桌面端：播放/暂停
  useEffect(() => {
    if (!isDesktop || !player) return
    if (isPlaying) player.play()
    else player.pause()
  }, [isPlaying])

  // 桌面端：音量
  useEffect(() => {
    if (!isDesktop || !player) return
    player.setVolume(volume)
  }, [volume])

  // 桌面端：用户拖进度条 -> mpv seek（与 mpvTimeRef 差异>1s 才跳，避免事件循环）
  useEffect(() => {
    if (!isDesktop || !player) return
    if (Math.abs(currentTime - mpvTimeRef.current) > 1) {
      player.seek(currentTime)
      mpvTimeRef.current = currentTime
    }
  }, [currentTime])

  // 桌面端：监听 mpv 事件
  useEffect(() => {
    if (!isDesktop || !player) return
    const off = player.onEvent((evt) => {
      if (evt.event !== 'property' || !evt.data) return
      const { name, data } = evt.data
      if (name === 'time-pos' && typeof data === 'number') {
        mpvTimeRef.current = data
        seek(data)
      } else if (name === 'duration' && typeof data === 'number') {
        setDuration(data)
      } else if (name === 'eof-reached' && data === true) {
        usePlayerStore.setState({ isPlaying: false })
      }
    })
    return off
  }, [])

  // Web 端：HTML5 video 播放/暂停
  useEffect(() => {
    if (isDesktop) return
    const v = videoRef.current
    if (!v) return
    if (isPlaying) v.play().catch(() => {})
    else v.pause()
  }, [isPlaying, videoSrc])

  // Web 端：音量
  useEffect(() => {
    if (isDesktop) return
    if (videoRef.current) videoRef.current.volume = volume / 100
  }, [volume])

  // Web 端：拖进度条跳转
  useEffect(() => {
    if (isDesktop) return
    const v = videoRef.current
    if (v && Math.abs(v.currentTime - currentTime) > 1) v.currentTime = currentTime
  }, [currentTime])

  const handleMouseMove = () => {
    setControlsVisible(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setControlsVisible(false), 3000)
  }

  // 拖拽文件：字幕->加载字幕，视频->播放
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (!file) return
    const ext = (file.name.split('.').pop() || '').toLowerCase()
    if (['srt', 'ass', 'ssa', 'vtt'].includes(ext) && isDesktop && player) {
      const filePath = (file as File & { path: string }).path
      player.loadSubtitle(filePath)
      return
    }
    if (isDesktop) {
      const filePath = (file as File & { path: string }).path
      usePlayerStore.getState().setMedia(file.name, filePath)
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
      {isDesktop ? (
        // 桌面端：mpv 独立窗口播放，此处显示占位（窗口嵌入待 V1 优化）
        <div className="text-gray-500 text-center">
          <p className="text-2xl mb-2">{mediaName ?? '未选择媒体'}</p>
          <p className="text-sm">
            {videoSrc ? 'mpv 播放中（独立窗口）' : '从媒体库选择或拖拽文件'}
          </p>
        </div>
      ) : videoSrc ? (
        // Web 端：HTML5 video
        <video
          ref={videoRef}
          src={videoSrc}
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
        className="absolute top-4 left-4 px-3 py-1 bg-player-surface/80 rounded text-sm hover:bg-player-surface"
      >
        ← 媒体库
      </button>

      <PlayerControls />
    </div>
  )
}
